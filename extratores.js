// extratores.js
// Funções puras de extração de texto, usadas tanto pelos endpoints de
// upload (PDF/DOCX) quanto pelo módulo de e-mail (anexos).

const fs = require('fs');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const path = require('path');
const sharp = require('sharp');
const { createWorker } = require('tesseract.js');

const TEMPO_MAXIMO_OCR_MS = 45_000;
const TEMPO_MAXIMO_PREPARO_MS = 15_000;

// Larguras-alvo (em px) para o pré-processamento de imagem antes do OCR.
// Fotos de celular tiradas de longe ficam com o texto pequeno demais para o
// Tesseract; abaixo do mínimo nós ampliamos. Acima do máximo só deixa o OCR
// mais lento sem ganho de precisão, então reduzimos.
const LARGURA_MINIMA_OCR = 1600;
const LARGURA_MAXIMA_OCR = 3500;

// Largura-alvo (em px) ao rasterizar uma página de PDF pra rodar OCR nela.
// Alta o suficiente pra texto de código/enunciado ficar legível pro
// Tesseract, sem exagerar no tamanho do PNG gerado.
const LARGURA_ALVO_RENDER_PAGINA_PDF = 1900;

// Limite de páginas com imagem em que rodamos OCR num único PDF. Cada
// página custa alguns segundos de OCR; sem esse teto, um PDF muito grande
// e cheio de imagens poderia estourar o tempo máximo da função na Vercel
// (60s, ver vercel.json). Isso cobre folgadamente o caso de uso real
// (listas de exercícios de poucas páginas).
const MAX_PAGINAS_OCR_POR_PDF = 15;

// Ao rodar em ambientes serverless (Vercel), se os arquivos de idioma não
// foram empacotados corretamente pelo build, o OCR fica pendurado sem nunca
// resolver nem rejeitar. Verificamos aqui no boot e deixamos um log bem
// explícito, porque isso é praticamente impossível de diagnosticar só
// olhando o sintoma de "nunca termina" no navegador.
for (const arquivo of ['eng.traineddata', 'por.traineddata']) {
  const caminho = path.join(__dirname, arquivo);
  if (!fs.existsSync(caminho)) {
    console.error(`[ocr] ATENÇÃO: ${arquivo} não foi encontrado em ${caminho}. ` +
      'O OCR vai travar/falhar. Confira o "includeFiles" no vercel.json e se o arquivo ' +
      'foi realmente commitado no Git (não pode estar apenas local).');
  } else {
    console.log(`[ocr] ${arquivo} encontrado (${fs.statSync(caminho).size} bytes) em ${caminho}`);
  }
}

// Mesma checagem para os binários .wasm do motor do Tesseract. Esse arquivo
// é carregado dinamicamente (não via require estático), então o empacotador
// da Vercel não detecta essa dependência sozinho — precisa do "includeFiles"
// no vercel.json apontando pra node_modules/tesseract.js-core/*.wasm.
try {
  const dirCore = path.join(__dirname, 'node_modules', 'tesseract.js-core');
  const wasms = fs.readdirSync(dirCore).filter((f) => f.endsWith('.wasm'));
  if (wasms.length === 0) {
    console.error('[ocr] ATENÇÃO: nenhum arquivo .wasm encontrado em ' + dirCore +
      '. Confira o "includeFiles" no vercel.json.');
  } else {
    console.log(`[ocr] ${wasms.length} arquivo(s) .wasm do tesseract.js-core encontrados.`);
  }
} catch (err) {
  console.error('[ocr] ATENÇÃO: não foi possível checar node_modules/tesseract.js-core:', err.message);
}

// ---------------------------------------------------------------------
// OCR de imagens EMBUTIDAS em PDF (ex.: enunciado colado como print/foto
// dentro do arquivo, código-fonte em screenshot, etc.).
//
// O pdf-parse (e a extração de texto "nativo" de um PDF em geral) só lê o
// texto que existe de verdade na camada de texto do arquivo. Se o professor
// colou uma imagem (print de código, foto de um exercício escrito à mão
// etc.) dentro do PDF, esse conteúdo é só pixels pro pdf-parse — ele nunca
// aparecia no texto extraído, mesmo o app já tendo OCR pronto pra imagens
// soltas (extrairTextoImagem). Esta seção resolve isso: para cada página do
// PDF, verificamos se ela contém alguma imagem; se contiver, rasterizamos
// a página inteira (pdfjs-dist + @napi-rs/canvas, ambos sem dependências
// nativas problemáticas em serverless — mesma lógica de "binário
// pré-compilado" que já usamos com o sharp) e rodamos o mesmo pipeline de
// OCR (prepararImagemParaOcr + Tesseract) usado nas imagens soltas.
//
// Isso é tratado como um "extra" best-effort: se pdfjs-dist/@napi-rs/canvas
// não carregarem por qualquer motivo (ex.: binário nativo ausente no
// ambiente), ou se o OCR de alguma página falhar, caímos de volta pro
// comportamento antigo (só texto nativo do pdf-parse) em vez de quebrar o
// endpoint inteiro.
let _pdfjsLibPromise = null;
async function carregarPdfjsLib() {
  if (!_pdfjsLibPromise) {
    _pdfjsLibPromise = import('pdfjs-dist/legacy/build/pdf.mjs').catch((err) => {
      console.error('[pdf-ocr] não foi possível carregar pdfjs-dist (OCR de imagens dentro de PDF fica desativado):', err.message);
      return null;
    });
  }
  return _pdfjsLibPromise;
}

let _canvasLib; // undefined = ainda não tentou carregar; null = tentou e falhou
function carregarCanvasLib() {
  if (_canvasLib === undefined) {
    try {
      _canvasLib = require('@napi-rs/canvas');
    } catch (err) {
      console.error('[pdf-ocr] não foi possível carregar @napi-rs/canvas (OCR de imagens dentro de PDF fica desativado):', err.message);
      _canvasLib = null;
    }
  }
  return _canvasLib;
}

// Helper genérico: corre uma Promise contra um limite de tempo, com uma
// mensagem de erro específica para facilitar o diagnóstico nos logs.
function comLimiteDeTempo(promessa, ms, mensagemTimeout) {
  let temporizador;
  const limite = new Promise((_, rejeitar) => {
    temporizador = setTimeout(() => rejeitar(new Error(mensagemTimeout)), ms);
  });
  return Promise.race([promessa, limite]).finally(() => clearTimeout(temporizador));
}

// IMPORTANTE — por que o worker do Tesseract NÃO é reaproveitado entre
// requisições (como era antes):
//
// Em ambientes serverless (Vercel/Lambda) a plataforma pode "congelar" o
// processo do Node inteiro entre uma invocação e outra para economizar
// recursos, e só "descongela" quando chega uma nova requisição. O worker do
// Tesseract roda numa thread separada (worker_threads) que troca mensagens
// de forma assíncrona com a thread principal. Se o congelamento acontecer
// bem no meio dessa troca de mensagens, ao descongelar essa thread pode
// ficar num estado inconsistente e nunca mais responder — daí o sintoma de
// "fica carregando para sempre" que só acontecia com imagem (PDF/DOCX não
// usam nenhuma thread em segundo plano, por isso sempre funcionaram normal).
//
// A solução é tratar o OCR do mesmo jeito que o PDF/DOCX: tudo criado, usado
// e destruído dentro de uma única requisição, sem nada "sobrevivendo" entre
// chamadas. Isso custa ~1-3s a mais por imagem (recarregar os modelos toda
// vez), mas é o preço de ser confiável em serverless.
async function comWorkerOcrTemporario(fn) {
  console.log('[ocr] criando worker do Tesseract...');
  const worker = await createWorker(['por', 'eng'], 1, {
    // Os arquivos .traineddata ficam junto do projeto e são incluídos no
    // bundle da Vercel; assim o cold start não depende de download externo.
    langPath: __dirname,
    cachePath: path.join('/tmp', 'provafacil-tesseract-cache'),
    gzip: false,
    // IMPORTANTE: sem isso, uma imagem que o Tesseract não consegue ler
    // (arquivo corrompido, PNG com CRC inválido, etc.) faz a biblioteca
    // lançar um erro dentro do handler de mensagens do worker_threads em
    // vez de só rejeitar a Promise de recognize(). Sem um errorHandler,
    // esse erro derruba o processo Node inteiro (crash do servidor) antes
    // mesmo do try/catch do endpoint rodar. Com o errorHandler presente,
    // o erro fica só como uma rejeição normal da Promise, que conseguimos
    // capturar e transformar numa resposta 500 decente.
    errorHandler: (erro) => {
      console.error('[tesseract] erro interno do worker:', erro);
    },
  });
  console.log('[ocr] worker pronto, reconhecendo texto...');
  try {
    return await fn(worker);
  } finally {
    // Sempre encerra o worker ao final, com sucesso ou erro — é isso que
    // garante que nada fica "vivo" entre uma requisição e a próxima.
    try {
      await worker.terminate();
      console.log('[ocr] worker encerrado.');
    } catch (err) {
      console.error('[ocr] erro ao encerrar worker (ignorado):', err.message);
    }
  }
}

// Valida e prepara a imagem antes de mandar pro OCR. Isso resolve dois
// problemas de uma vez:
// 1) Arquivos corrompidos/ilegíveis são barrados aqui, com um erro claro,
//    em vez de travarem o Tesseract lá na frente.
// 2) O pré-processamento (rotação automática, escala de cinza, contraste e
//    reamostragem) aumenta bastante a taxa de acerto do OCR em fotos tiradas
//    com celular, que costumam vir tortas, pequenas ou com iluminação ruim.
async function prepararImagemParaOcr(buffer) {
  let metadados;
  try {
    metadados = await sharp(buffer, { failOn: 'none' }).metadata();
  } catch (err) {
    throw new Error(
      'Não foi possível ler o arquivo como imagem. Verifique se ele não está corrompido ' +
      'e se é realmente um JPG, PNG, WEBP, GIF, BMP ou TIFF.'
    );
  }

  if (!metadados.width || !metadados.height) {
    throw new Error(
      'A imagem enviada não tem dimensões válidas (pode estar corrompida ou vazia).'
    );
  }

  try {
    let pipeline = sharp(buffer, { failOn: 'none' }).rotate(); // corrige orientação via EXIF

    if (metadados.width < LARGURA_MINIMA_OCR) {
      pipeline = pipeline.resize({ width: LARGURA_MINIMA_OCR, withoutEnlargement: false });
    } else if (metadados.width > LARGURA_MAXIMA_OCR) {
      pipeline = pipeline.resize({ width: LARGURA_MAXIMA_OCR });
    }

    // Escala de cinza + normalização de contraste + leve nitidez: ajuda
    // muito em fotos com sombra, papel amarelado ou iluminação irregular.
    pipeline = pipeline.grayscale().normalize().sharpen();

    return await pipeline.png().toBuffer();
  } catch (err) {
    throw new Error(
      'A imagem foi lida, mas falhou ao ser preparada para o OCR. Tente novamente com ' +
      'outro arquivo ou um formato diferente.'
    );
  }
}

// Remove acentos, caixa e pontuação de uma linha só pra fins de comparação
// (não altera o texto que de fato vai pro resultado final).
function normalizarLinhaParaComparacao(linha) {
  return linha
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// Junta o texto nativo de uma página (extração normal, alta qualidade) com
// o texto que o OCR leu na mesma página rasterizada. Como o OCR "vê" a
// página inteira, ele frequentemente reconhece de novo um texto que já
// tínhamos capturado nativamente (ex.: o cabeçalho da prova, que é texto de
// verdade e só está na mesma página que uma imagem colada mais abaixo).
// Para não duplicar esse conteúdo, descartamos do OCR qualquer linha que já
// bate (ignorando acento/caixa/pontuação) com uma linha do texto nativo, e
// só acrescentamos o que é realmente novo (tipicamente, o texto que estava
// dentro da imagem).
function mesclarTextoNativoComOcrDaPagina(textoNativo, textoOcr) {
  const linhasNativas = new Set(
    textoNativo.split('\n').map(normalizarLinhaParaComparacao).filter(Boolean)
  );
  const linhasNovasDoOcr = textoOcr
    .split('\n')
    .filter((linha) => {
      const normalizada = normalizarLinhaParaComparacao(linha);
      return normalizada && !linhasNativas.has(normalizada);
    });
  if (!linhasNovasDoOcr.length) return textoNativo;
  return [textoNativo.trim(), linhasNovasDoOcr.join('\n')].filter(Boolean).join('\n');
}

// Reproduz o mesmo algoritmo do pdf-parse (v1.x) para montar o texto nativo
// de uma página a partir do getTextContent() do pdfjs: concatena os itens
// da mesma linha (mesma coordenada Y) e quebra linha quando o Y muda. Isso
// mantém a extração de texto "normal" idêntica à que já existia antes desta
// mudança — só estamos reaproveitando o pdfjs (já carregado para a parte de
// OCR) em vez do pdf-parse para gerar esse texto.
function extrairTextoNativoDaPagina(textContent) {
  let ultimoY;
  let texto = '';
  for (const item of textContent.items) {
    if (ultimoY === item.transform[5] || ultimoY === undefined) {
      texto += item.str;
    } else {
      texto += '\n' + item.str;
    }
    ultimoY = item.transform[5];
  }
  return texto;
}

async function paginaContemImagem(page, OPS) {
  const operacoesDeImagem = new Set([
    OPS.paintImageXObject,
    OPS.paintInlineImageXObject,
    OPS.paintImageMaskXObject,
    OPS.paintJpegXObject,
  ]);
  const listaDeOperacoes = await page.getOperatorList();
  return listaDeOperacoes.fnArray.some((fn) => operacoesDeImagem.has(fn));
}

async function renderizarPaginaComoPng(page, createCanvas) {
  const viewportBase = page.getViewport({ scale: 1 });
  const escala = Math.min(Math.max(LARGURA_ALVO_RENDER_PAGINA_PDF / viewportBase.width, 1.2), 4);
  const viewport = page.getViewport({ scale: escala });
  const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
  const contexto = canvas.getContext('2d');
  await page.render({ canvasContext: contexto, viewport, canvas }).promise;
  return canvas.toBuffer('image/png');
}

// Extração "avançada": usa pdfjs-dist diretamente (em vez do pdf-parse) pra
// poder, página por página, checar se há imagem embutida e rodar OCR nela
// quando houver. Retorna null quando pdfjs-dist/@napi-rs/canvas não estão
// disponíveis no ambiente — nesse caso extrairTextoPdf cai pro fallback
// simples (pdf-parse, texto nativo apenas), em vez de falhar.
async function extrairTextoPdfComOcrDeImagens(buffer) {
  const pdfjsLib = await carregarPdfjsLib();
  const canvasLib = carregarCanvasLib();
  if (!pdfjsLib || !canvasLib) return null;

  const { getDocument, OPS } = pdfjsLib;
  const { createCanvas } = canvasLib;

  const documento = await getDocument({
    data: new Uint8Array(buffer),
    disableFontFace: true,
    isEvalSupported: false,
    standardFontDataUrl: path.join(
      path.dirname(require.resolve('pdfjs-dist/package.json')),
      'standard_fonts/'
    ),
  }).promise;

  const totalPaginas = documento.numPages;
  const textoPorPagina = new Array(totalPaginas).fill('');
  const paginasComImagem = [];

  for (let i = 1; i <= totalPaginas; i++) {
    const page = await documento.getPage(i);
    textoPorPagina[i - 1] = extrairTextoNativoDaPagina(await page.getTextContent());
    if (await paginaContemImagem(page, OPS)) {
      paginasComImagem.push(i);
    }
  }

  if (paginasComImagem.length > 0) {
    const paginasParaProcessar = paginasComImagem.slice(0, MAX_PAGINAS_OCR_POR_PDF);
    console.log(`[pdf-ocr] ${paginasParaProcessar.length} de ${totalPaginas} página(s) contêm imagem; rodando OCR nelas...`);

    await comLimiteDeTempo(
      comWorkerOcrTemporario(async (worker) => {
        for (const numeroPagina of paginasParaProcessar) {
          try {
            const page = await documento.getPage(numeroPagina);
            const pngDaPagina = await renderizarPaginaComoPng(page, createCanvas);
            const pngPreparado = await prepararImagemParaOcr(pngDaPagina);
            const resultado = await worker.recognize(pngPreparado);
            console.log(`[pdf-ocr] página ${numeroPagina}: confiança ${Math.round(resultado.data.confidence)}%`);
            textoPorPagina[numeroPagina - 1] = mesclarTextoNativoComOcrDaPagina(
              textoPorPagina[numeroPagina - 1],
              resultado.data.text.trim()
            );
          } catch (err) {
            // Falha em UMA página (imagem corrompida, timeout pontual etc.)
            // não deve derrubar as outras páginas nem o texto nativo já
            // extraído — só loga e segue com o que já tem.
            console.error(`[pdf-ocr] falha ao rodar OCR na página ${numeroPagina} (mantendo só o texto nativo dela):`, err.message);
          }
        }
      }),
      TEMPO_MAXIMO_OCR_MS * Math.max(paginasParaProcessar.length, 1),
      'O OCR das imagens dentro do PDF excedeu o tempo limite.'
    );
  }

  return { texto: textoPorPagina.join('\n\n').trim(), paginas: totalPaginas };
}

async function extrairTextoPdf(buffer) {
  try {
    const resultado = await extrairTextoPdfComOcrDeImagens(buffer);
    if (resultado) return resultado;
  } catch (err) {
    console.error('[pdf] extração avançada (pdfjs + OCR de imagens embutidas) falhou; usando fallback simples só com texto nativo:', err.message);
  }
  const resultado = await pdfParse(buffer);
  return { texto: resultado.text.trim(), paginas: resultado.numpages };
}

async function extrairTextoDocx(buffer) {
  const resultado = await mammoth.extractRawText({ buffer });
  return { texto: resultado.value.trim(), avisos: resultado.messages.map((m) => m.message) };
}

async function extrairTextoImagem(buffer) {
  console.log(`[ocr] imagem recebida (${buffer.length} bytes), preparando...`);

  // Preparação com sharp tem seu próprio limite de tempo: sem isso, se o
  // sharp travasse por qualquer motivo, a requisição ficaria pendurada até
  // o timeout da própria plataforma (ex.: 504 na Vercel) sem nunca chegar
  // no nosso tratamento de erro.
  const bufferPreparado = await comLimiteDeTempo(
    prepararImagemParaOcr(buffer),
    TEMPO_MAXIMO_PREPARO_MS,
    'O preparo da imagem (redimensionar/normalizar) excedeu o limite de tempo. Tente um arquivo menor.'
  );
  console.log('[ocr] imagem preparada.');

  try {
    return await comLimiteDeTempo(
      comWorkerOcrTemporario(async (worker) => {
        const resultado = await worker.recognize(bufferPreparado);
        console.log(`[ocr] reconhecimento concluído, confiança ${Math.round(resultado.data.confidence)}%`);
        return {
          texto: resultado.data.text.trim(),
          confianca: Math.round(resultado.data.confidence),
        };
      }),
      TEMPO_MAXIMO_OCR_MS,
      'O OCR excedeu o limite de 45 segundos. Tente uma imagem menor ou mais nítida.'
    );
  } catch (err) {
    console.error('[ocr] erro durante o reconhecimento:', err);
    // O tesseract.js às vezes rejeita com uma string crua (ex.: "Error:
    // Error attempting to read image.") em vez de um objeto Error. Isso
    // fazia err.message ficar `undefined` lá no endpoint. Normalizamos aqui
    // para sempre virar um Error de verdade com uma mensagem legível.
    const mensagem = err instanceof Error ? err.message : String(err);
    throw new Error(
      mensagem.includes('read image') || mensagem.includes('pix')
        ? 'O Tesseract não conseguiu processar essa imagem. Tente uma foto mais nítida, com melhor iluminação, ou outro arquivo.'
        : mensagem
    );
  }
}

module.exports = { extrairTextoPdf, extrairTextoDocx, extrairTextoImagem, comLimiteDeTempo };
