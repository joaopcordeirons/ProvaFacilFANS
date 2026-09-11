// extratores.js
// Funções puras de extração de texto, usadas tanto pelos endpoints de
// upload (PDF/DOCX) quanto pelo módulo de e-mail (anexos).

const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const path = require('path');
const sharp = require('sharp');
const { createWorker } = require('tesseract.js');

// Criar um worker Tesseract é caro: ele carrega o WASM e os modelos de idioma.
// Mantemos uma instância por processo para que somente a primeira imagem pague
// esse custo. A fila evita duas chamadas simultâneas no mesmo worker.
let workerPromise;
let filaOcr = Promise.resolve();
const TEMPO_MAXIMO_OCR_MS = 45_000;

// Larguras-alvo (em px) para o pré-processamento de imagem antes do OCR.
// Fotos de celular tiradas de longe ficam com o texto pequeno demais para o
// Tesseract; abaixo do mínimo nós ampliamos. Acima do máximo só deixa o OCR
// mais lento sem ganho de precisão, então reduzimos.
const LARGURA_MINIMA_OCR = 1600;
const LARGURA_MAXIMA_OCR = 3500;

function obterWorkerOcr() {
  if (!workerPromise) {
    workerPromise = createWorker(['por', 'eng'], 1, {
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
    }).catch((err) => {
      workerPromise = undefined;
      throw err;
    });
  }
  return workerPromise;
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
  // A validação/preparação com sharp roda fora da fila: se a imagem estiver
  // corrompida, falha rápido sem ocupar a vez de outra requisição no worker
  // único do Tesseract.
  const bufferPreparado = await prepararImagemParaOcr(buffer);

  const trabalho = filaOcr.then(async () => {
    let temporizador;
    const limite = new Promise((_, rejeitar) => {
      temporizador = setTimeout(
        () => rejeitar(new Error('O OCR excedeu o limite de 45 segundos. Tente uma imagem menor ou mais nítida.')),
        TEMPO_MAXIMO_OCR_MS
      );
    });
    try {
      const worker = await Promise.race([obterWorkerOcr(), limite]);
      const resultado = await Promise.race([worker.recognize(bufferPreparado), limite]);
      clearTimeout(temporizador);
      return {
        texto: resultado.data.text.trim(),
        confianca: Math.round(resultado.data.confidence),
      };
    } catch (err) {
      clearTimeout(temporizador);
      // O tesseract.js às vezes rejeita com uma string crua (ex.: "Error:
      // Error attempting to read image.") em vez de um objeto Error. Isso
      // fazia err.message ficar `undefined` lá no endpoint. Normalizamos
      // aqui para sempre virar um Error de verdade com uma mensagem legível.
      const mensagem = err instanceof Error ? err.message : String(err);
      throw new Error(
        mensagem.includes('read image') || mensagem.includes('pix')
          ? 'O Tesseract não conseguiu processar essa imagem. Tente uma foto mais nítida, com melhor iluminação, ou outro arquivo.'
          : mensagem
      );
    }
  });
  filaOcr = trabalho.catch(() => undefined);
  return trabalho;
}

module.exports = { extrairTextoPdf, extrairTextoDocx, extrairTextoImagem };
