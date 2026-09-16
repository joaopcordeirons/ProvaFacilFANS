// ocrIA.js
// Varredura OPCIONAL de PDF via IA multimodal (Gemini Vision) — uma
// segunda tentativa de leitura para as mesmas páginas com imagem que o
// OCR local (Tesseract, ver extratores.js) já processou automaticamente
// no upload. Existe porque o Tesseract erra muito em prints de
// código-fonte (símbolos, indentação, nomes técnicos como "void"/"scanf"
// viram palavras aleatórias) — a IA costuma ler esse tipo de conteúdo
// melhor, mas custa cota da API do Gemini, então NUNCA roda sozinha: só
// quando o professor confirma explicitamente, no botão que aparece após
// o upload detectar página(s) com imagem. O OCR local continua rodando
// normalmente e automático em todo PDF, sem nenhuma mudança — isso aqui
// é só um "tentar de novo com IA" por cima do resultado dele.
//
// Assim como corrigirComIA (corretorIA.js), nunca lança erro pra quem
// chamou: qualquer falha total devolve { disponivel: false, motivo }.

const path = require('path');
const {
  carregarPdfjsLib,
  carregarCanvasLib,
  paginaContemImagem,
  renderizarPaginaComoPng,
  extrairTextoNativoDaPagina,
  mesclarTextoNativoComOcrDaPagina,
  comLimiteDeTempo,
} = require('./extratores');
const { chamarGeminiJson, mensagemDeErro } = require('./geminiClient');

// Tempo máximo por página (chamada ao Gemini + espera). Como as páginas
// são processadas EM PARALELO (Promise.allSettled logo abaixo, não uma
// fila sequencial), o tempo total da requisição fica perto do tempo da
// página mais lenta, não da soma de todas — importante para caber no
// maxDuration=60s da função na Vercel (ver vercel.json).
const TEMPO_MAXIMO_POR_PAGINA_MS = 25_000;

// Teto de páginas processadas por PDF. Cobre folgadamente o caso de uso
// real (uma ou duas imagens coladas numa lista de exercícios); um teto
// maior arriscaria estourar o maxDuration mesmo em paralelo, ou pressionar
// demais a cota gratuita do Gemini numa única ação do professor.
const MAX_PAGINAS_IA_POR_PDF = 6;

function montarPrompt() {
  return `Você está lendo, a partir de uma imagem, uma página de uma lista de exercícios de programação escolar (pode ter sido escaneada, fotografada com celular ou colada como print/captura de tela). Transcreva TODO o texto visível na imagem, incluindo código-fonte, com a maior fidelidade possível.

Preserve:
- Ortografia exata de palavras-chave, comandos e nomes (ex.: "void", "scanf", "println"), mesmo que pareçam estranhas — não "corrija" para uma palavra parecida em português.
- Indentação e quebras de linha do código, na medida do possível.
- Números, símbolos (chaves, parênteses, ponto e vírgula, operadores) exatamente como aparecem.

NÃO faça:
- Não resuma, não interprete e não explique o conteúdo.
- Não invente texto que não conseguir ler com clareza — nesse caso, marque o trecho como [ilegível] em vez de adivinhar.
- Não adicione comentários seus, markdown ou qualquer texto que não esteja na imagem.

Responda ESTRITAMENTE em JSON, sem markdown, sem texto antes ou depois, no formato:
{"texto": "todo o texto transcrito da imagem, com quebras de linha reais (\\n)"}`;
}

// Carrega o documento (pdfjs) e devolve, por página: o texto nativo e se
// ela contém imagem embutida — mesma varredura inicial que extratores.js
// faz antes de decidir onde rodar OCR.
async function inventariarPaginas(buffer) {
  const pdfjsLib = await carregarPdfjsLib();
  const canvasLib = carregarCanvasLib();
  if (!pdfjsLib || !canvasLib) return null;

  const { getDocument, OPS, GlobalWorkerOptions } = pdfjsLib;
  const { createCanvas } = canvasLib;

  GlobalWorkerOptions.workerSrc = path.join(
    __dirname, 'node_modules', 'pdfjs-dist', 'legacy', 'build', 'pdf.worker.mjs'
  );

  const documento = await getDocument({
    data: new Uint8Array(buffer),
    disableFontFace: true,
    isEvalSupported: false,
    standardFontDataUrl: path.join(__dirname, 'node_modules', 'pdfjs-dist', 'standard_fonts') + path.sep,
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

  return { documento, createCanvas, totalPaginas, textoPorPagina, paginasComImagem };
}

async function lerPaginaComIA(documento, createCanvas, numeroPagina, apiKey) {
  const page = await documento.getPage(numeroPagina);
  const png = await renderizarPaginaComoPng(page, createCanvas);

  const resultado = await comLimiteDeTempo(
    chamarGeminiJson({
      apiKey,
      prompt: montarPrompt(),
      maxOutputTokens: 2000,
      nomeChamador: 'ocrIA',
      imagens: [{ mimeType: 'image/png', dadosBase64: png.toString('base64') }],
    }),
    TEMPO_MAXIMO_POR_PAGINA_MS,
    `A leitura com IA da página ${numeroPagina} excedeu o tempo limite.`
  );

  if (typeof resultado.texto !== 'string') {
    throw new Error('Resposta da IA não trouxe um campo "texto" válido.');
  }
  return resultado.texto.trim();
}

async function extrairTextoPdfComIA(buffer) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return { disponivel: false, motivo: 'GEMINI_API_KEY não configurada no servidor.' };
  }

  const inventario = await inventariarPaginas(buffer);
  if (!inventario) {
    return {
      disponivel: false,
      motivo: 'Varredura com IA indisponível neste ambiente (dependências de leitura de PDF não carregaram).',
    };
  }

  const { documento, createCanvas, totalPaginas, textoPorPagina, paginasComImagem } = inventario;

  if (!paginasComImagem.length) {
    // Sem imagem embutida, não há nada que a IA leia de diferente do texto
    // nativo — devolve o texto nativo tal como está, sem gastar cota.
    return {
      disponivel: true,
      texto: textoPorPagina.join('\n\n').trim(),
      paginas: totalPaginas,
      paginasProcessadas: [],
      paginasComFalha: [],
    };
  }

  const paginasParaProcessar = paginasComImagem.slice(0, MAX_PAGINAS_IA_POR_PDF);
  const paginasComFalha = [];
  let ultimoErro;

  const resultados = await Promise.allSettled(
    paginasParaProcessar.map((numeroPagina) => lerPaginaComIA(documento, createCanvas, numeroPagina, apiKey))
  );

  resultados.forEach((resultado, indice) => {
    const numeroPagina = paginasParaProcessar[indice];
    if (resultado.status === 'fulfilled') {
      textoPorPagina[numeroPagina - 1] = mesclarTextoNativoComOcrDaPagina(
        textoPorPagina[numeroPagina - 1],
        resultado.value
      );
    } else {
      console.error(`[ocr-ia] falha na página ${numeroPagina}:`, resultado.reason?.message);
      paginasComFalha.push(numeroPagina);
      ultimoErro = resultado.reason;
    }
  });

  // Se TODAS as páginas falharam, é mais honesto reportar isso como uma
  // falha geral (com a mensagem de erro real — ex.: chave inválida, limite
  // de cota) do que devolver "sucesso" com o texto praticamente igual ao
  // que o OCR local já tinha dado.
  if (paginasComFalha.length === paginasParaProcessar.length && ultimoErro) {
    return { disponivel: false, motivo: mensagemDeErro(ultimoErro) };
  }

  return {
    disponivel: true,
    texto: textoPorPagina.join('\n\n').trim(),
    paginas: totalPaginas,
    paginasProcessadas: paginasParaProcessar,
    paginasComFalha,
  };
}

module.exports = { extrairTextoPdfComIA };
