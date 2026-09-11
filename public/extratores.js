// extratores.js
// Funções puras de extração de texto, usadas tanto pelos endpoints de
// upload (PDF/DOCX) quanto pelo módulo de e-mail (anexos).

const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const path = require('path');
const { createWorker } = require('tesseract.js');

// Criar um worker Tesseract é caro: ele carrega o WASM e os modelos de idioma.
// Mantemos uma instância por processo para que somente a primeira imagem pague
// esse custo. A fila evita duas chamadas simultâneas no mesmo worker.
let workerPromise;
let filaOcr = Promise.resolve();
const TEMPO_MAXIMO_OCR_MS = 45_000;

function obterWorkerOcr() {
  if (!workerPromise) {
    workerPromise = createWorker(['por', 'eng'], 1, {
      // Os arquivos .traineddata ficam junto do projeto e são incluídos no
      // bundle da Vercel; assim o cold start não depende de download externo.
      langPath: __dirname,
      cachePath: path.join('/tmp', 'provafacil-tesseract-cache'),
      gzip: false,
    }).catch((err) => {
      workerPromise = undefined;
      throw err;
    });
  }
  return workerPromise;
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
  const trabalho = filaOcr.then(async () => {
    let temporizador;
    const limite = new Promise((_, rejeitar) => {
      temporizador = setTimeout(
        () => rejeitar(new Error('O OCR excedeu o limite de 45 segundos. Tente uma imagem menor ou mais nítida.')),
        TEMPO_MAXIMO_OCR_MS
      );
    });
    const worker = await Promise.race([obterWorkerOcr(), limite]);
    const resultado = await Promise.race([worker.recognize(buffer), limite]);
    clearTimeout(temporizador);
    return {
      texto: resultado.data.text.trim(),
      confianca: Math.round(resultado.data.confidence),
    };
  });
  filaOcr = trabalho.catch(() => undefined);
  return trabalho;
}

module.exports = { extrairTextoPdf, extrairTextoDocx, extrairTextoImagem };
