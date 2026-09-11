// extratores.js
// Funções puras de extração de texto, usadas tanto pelos endpoints de
// upload (PDF/DOCX) quanto pelo módulo de e-mail (anexos).

const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const { createWorker } = require('tesseract.js');

async function extrairTextoPdf(buffer) {
  const resultado = await pdfParse(buffer);
  return { texto: resultado.text.trim(), paginas: resultado.numpages };
}

async function extrairTextoDocx(buffer) {
  const resultado = await mammoth.extractRawText({ buffer });
  return { texto: resultado.value.trim(), avisos: resultado.messages.map((m) => m.message) };
}

async function extrairTextoImagem(buffer) {
  const worker = await createWorker('por+eng');
  try {
    const resultado = await worker.recognize(buffer);
    return {
      texto: resultado.data.text.trim(),
      confianca: Math.round(resultado.data.confidence),
    };
  } finally {
    await worker.terminate();
  }
}

module.exports = { extrairTextoPdf, extrairTextoDocx, extrairTextoImagem };
