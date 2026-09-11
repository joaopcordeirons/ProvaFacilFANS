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

async function extrairTextoPdf(buffer) {
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

module.exports = { extrairTextoPdf, extrairTextoDocx, extrairTextoImagem };
