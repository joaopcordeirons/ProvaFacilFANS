// extratores.js
// Funções puras de extração de texto, usadas tanto pelos endpoints de
// upload (PDF/DOCX) quanto pelo módulo de e-mail (anexos).

const fs = require('fs');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const path = require('path');
const sharp = require('sharp');
const { createWorker } = require('tesseract.js');
const { createCanvas } = require('@napi-rs/canvas');

const TEMPO_MAXIMO_OCR_MS = 45_000;
const TEMPO_MAXIMO_PREPARO_MS = 15_000;

// Larguras-alvo (em px) para o pré-processamento de imagem antes do OCR.
// Fotos de celular tiradas de longe ficam com o texto pequeno demais para o
// Tesseract; abaixo do mínimo nós ampliamos. Acima do máximo só deixa o OCR
// mais lento sem ganho de precisão, então reduzimos.
const LARGURA_MINIMA_OCR = 1600;
const LARGURA_MAXIMA_OCR = 3500;

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

async function extrairTextoDocx(buffer) {
  const resultado = await mammoth.extractRawText({ buffer });
  return { texto: resultado.value.trim(), avisos: resultado.messages.map((m) => m.message) };
}

async function extrairTextoImagem(buffer, opcoes = {}) {
  const tempoMaximoOcrMs = opcoes.tempoMaximoOcrMs || TEMPO_MAXIMO_OCR_MS;
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
      tempoMaximoOcrMs,
      `O OCR excedeu o limite de ${Math.round(tempoMaximoOcrMs / 1000)} segundos. Tente uma imagem menor ou mais nítida.`
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

// ---------- Fallback de OCR para PDFs com conteúdo colado como imagem ----------
//
// Alguns PDFs (ex.: um print/screenshot de código colado dentro do
// documento) têm texto "de verdade" só no cabeçalho/rodapé — o resto são
// só pixels. O pdf-parse não tem como ler isso, porque não é texto. Se o
// texto extraído for curto demais pra quantidade de páginas, renderizamos
// cada página como imagem e rodamos o mesmo OCR usado no upload de imagem.
//
// Isso roda dentro de um orçamento de tempo (a função na Vercel tem um
// limite de execução total) e de um número máximo de páginas — se estourar
// qualquer um dos dois, paramos e devolvemos o que já foi processado, com
// um aviso, em vez de travar a requisição inteira.
const LIMIAR_MEDIO_CARACTERES_POR_PAGINA = 150;
const ORCAMENTO_TOTAL_OCR_FALLBACK_MS = 35_000;
const TEMPO_MAXIMO_OCR_POR_PAGINA_MS = 25_000;
const TEMPO_MAXIMO_RENDER_PAGINA_MS = 15_000;
const PAGINAS_MAXIMAS_OCR_FALLBACK = 6;
const ESCALA_RENDER_PAGINA = 2.0; // resolução maior ajuda o OCR

async function renderizarPaginaComoImagem(pdfjsDoc, numeroPagina) {
  const pagina = await pdfjsDoc.getPage(numeroPagina);
  const viewport = pagina.getViewport({ scale: ESCALA_RENDER_PAGINA });
  const canvas = createCanvas(viewport.width, viewport.height);
  const contexto = canvas.getContext('2d');
  await pagina.render({ canvasContext: contexto, viewport }).promise;
  return canvas.toBuffer('image/png');
}

async function tentarOcrDeFallbackNoPdf(buffer, numeroDePaginas) {
  // pdfjs-dist é ESM; extratores.js é CommonJS, então o import precisa ser
  // dinâmico (funciona normalmente dentro de uma função async, mesmo em
  // arquivo CJS).
  let pdfjsLib;
  let doc;
  try {
    pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
    doc = await pdfjsLib.getDocument({ data: new Uint8Array(buffer), disableFontFace: true }).promise;
  } catch (err) {
    console.error('[pdf] falha ao abrir o PDF para renderização (fallback de OCR abortado):', err.message);
    return { texto: '', paginasProcessadas: 0, incompleto: false, erro: true };
  }

  const paginasParaProcessar = Math.min(doc.numPages, PAGINAS_MAXIMAS_OCR_FALLBACK);
  const inicio = Date.now();
  const blocos = [];
  let paginasProcessadas = 0;

  for (let i = 1; i <= paginasParaProcessar; i++) {
    if (Date.now() - inicio > ORCAMENTO_TOTAL_OCR_FALLBACK_MS) {
      console.warn(`[pdf] orçamento de tempo do OCR de fallback esgotado após ${paginasProcessadas} de ${doc.numPages} página(s).`);
      break;
    }
    try {
      const imagemPagina = await comLimiteDeTempo(
        renderizarPaginaComoImagem(doc, i),
        TEMPO_MAXIMO_RENDER_PAGINA_MS,
        `Renderização da página ${i} excedeu o tempo limite.`
      );
      const { texto: textoPagina } = await extrairTextoImagem(imagemPagina, { tempoMaximoOcrMs: TEMPO_MAXIMO_OCR_POR_PAGINA_MS });
      if (textoPagina) blocos.push(textoPagina);
      paginasProcessadas++;
    } catch (err) {
      console.error(`[pdf] falha no OCR da página ${i} (seguindo para a próxima):`, err.message);
    }
  }

  return {
    texto: blocos.join('\n\n').trim(),
    paginasProcessadas,
    incompleto: paginasProcessadas < doc.numPages,
    erro: false,
  };
}

async function extrairTextoPdf(buffer) {
  const resultado = await pdfParse(buffer);
  const textoDireto = resultado.text.trim();
  const mediaPorPagina = resultado.numpages > 0 ? textoDireto.length / resultado.numpages : textoDireto.length;

  // Texto suficiente já veio direto — nem tenta OCR (mais rápido, e evita
  // gastar tempo à toa em PDFs normais).
  if (mediaPorPagina >= LIMIAR_MEDIO_CARACTERES_POR_PAGINA) {
    return { texto: textoDireto, paginas: resultado.numpages };
  }

  // Pouco texto pra quantidade de páginas: suspeita de conteúdo colado
  // como imagem (print/screenshot dentro do PDF, comum quando alguém cola
  // um recorte de tela em vez de digitar). Tenta OCR de fallback, mas sem
  // travar a resposta se algo falhar — nesse caso volta só o texto direto.
  console.log(`[pdf] pouco texto extraído (${textoDireto.length} caractere(s) em ${resultado.numpages} página(s)) — tentando OCR de fallback.`);
  const fallback = await tentarOcrDeFallbackNoPdf(buffer, resultado.numpages);

  const partes = [textoDireto, fallback.texto].filter(Boolean);
  const avisos = [];
  if (fallback.texto) {
    avisos.push('Parte do conteúdo veio de OCR automático (o PDF tinha texto colado como imagem) — revise com atenção, o OCR erra mais que texto extraído direto.');
  }
  if (fallback.incompleto) {
    avisos.push(`Só deu tempo de processar ${fallback.paginasProcessadas} de ${resultado.numpages} página(s) por OCR — as demais podem estar faltando. Considere reenviar as páginas restantes pela aba "Imagem", uma de cada vez.`);
  }

  return {
    texto: partes.join('\n\n').trim() || textoDireto,
    paginas: resultado.numpages,
    avisos: avisos.length ? avisos : undefined,
  };
}

module.exports = { extrairTextoPdf, extrairTextoDocx, extrairTextoImagem, comLimiteDeTempo };
