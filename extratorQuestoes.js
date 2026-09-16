// extratorQuestoes.js
// Motor de regras (sem chamada a nenhuma API externa/paga) que recebe o
// texto bruto extraído de um PDF/DOCX/imagem (possivelmente com várias
// questões, cabeçalho da escola, instruções, gabarito etc.) e devolve
// somente as questões, já separadas uma da outra.
//
// Por que regras e não uma IA de terceiros:
// Este sistema é usado em escala por vários professores ao mesmo tempo.
// Uma API de IA paga (OpenAI, Anthropic etc.) cobraria por texto
// processado e teria limite de uso/latência de rede. Este motor roda
// 100% localmente, é gratuito e não depende de nenhum serviço externo
// estar no ar.

const { formatarQuestao } = require('./formatadorQuestoes');
const { corrigirTexto } = require('./corretorGramatical');

// ---------------------------------------------------------------------
// 1) Linhas que são só "ruído" (não fazem parte do enunciado de nenhuma
//    questão) e devem ser descartadas de qualquer trecho.
// ---------------------------------------------------------------------
const PADROES_RUIDO = [
  /^\s*(nome|escola|col[ée]gio|turma|s[ée]rie|ano|data|disciplina|mat[ée]ria|professor(a)?|turno|per[íi]odo|bimestre|trimestre|semestre|valor|nota|peso|matr[íi]cula|c[óo]digo|curso|unidade\s*escolar)\s*[:\-]/i,
  /^\s*prova\s+(de|do|da)\b/i,
  /^\s*avalia[cç][ãa]o\s+(de|do|da)\b/i,
  /^\s*p[áa]gina\s*\d+/i,
  /^\s*\d+\s*\/\s*\d+\s*$/,               // "3/10" (numeração de página solta)
  /^\s*gabarito\b/i,
  /^\s*instru[cç][õo]es?\b/i,
  /^\s*boa\s+prova\b/i,
  /^\s*(leia|observe)\s+atentamente\s+antes\s+de\s+come[cç]ar/i,
  // Cabeçalho de instituição de ensino (papel timbrado), como em
  // "Faculdade de Nova Serrana" / "Universidade Federal de X" / "Instituto
  // Federal de Y" — diferente do padrão acima (que exige "Escola: ___"),
  // esse é um título solto, sem dois-pontos.
  /^\s*(faculdade|universidade|institui[cç][ãa]o|centro\s+universit[áa]rio|instituto\s+federal)\b/i,
  // "Graduação em Engenharia de Software" / "Curso de Direito" (título de
  // curso solto no cabeçalho, sem dois-pontos).
  /^\s*(gradua[cç][ãa]o|p[óo]s-gradua[cç][ãa]o|curso)\s+(em|de|do|da)\b/i,
  // "6º Período" / "3º Semestre" / "2º Ano" soltos (sem "Período: ___").
  /^\s*\d+\s*[ºo°]\s*(per[íi]odo|semestre|ano|bimestre|trimestre)\b/i,
  // "Prof. Fulano de Tal" / "Profa. Fulana" — assinatura do professor no
  // cabeçalho, sem dois-pontos (diferente de "Professor: Fulano").
  /^\s*prof(essor)?a?\.?\s+[a-zà-ú]/i,
];

// Marca o início de uma nova questão: "1.", "01)", "Questão 3 -",
// "QUESTÃO 03:", "Q1)", etc.
const REGEX_INICIO_QUESTAO = /^\s*(quest[ãa]o\s+)?(n[ºo°.]?\s*)?0*(\d{1,3})\s*[-.\):]\s*/i;

// Alternativas de múltipla escolha: "A)", "a.", "(B)", "a)54" (sem
// espaço, comum em texto digitado rápido ou em OCR), etc.
const REGEX_ALTERNATIVA = /^\s*\(?([a-eA-E])\)?[.\)]\s*(.*)$/;

// Palavras/expressões que costumam aparecer em enunciados de verdade.
const PALAVRAS_DE_ENUNCIADO = [
  'assinale', 'marque', 'calcule', 'explique', 'cite', 'justifique',
  'complete', 'escreva', 'resolva', 'determine', 'qual', 'quais',
  'quantos', 'quantas', 'verdadeiro ou falso', 'correta', 'incorreta',
  'analise', 'observe', 'leia o texto', 'com base', 'de acordo com',
  'considerando', 'classifique', 'identifique', 'compare', 'descreva',
];

function linhaEhRuido(linha) {
  return PADROES_RUIDO.some((regex) => regex.test(linha));
}

// Remove acentos para comparação tolerante a erro de digitação/OCR
// ("explique" == "esplique" não, mas "explicação" == "explicacao" sim,
// que é o erro mais comum de texto digitado sem acento ou OCR mal lido).
function semAcento(texto) {
  return texto.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

// Distância de Levenshtein simples, usada só para tolerar 1-2 letras
// erradas nas palavras-chave de enunciado (ex.: "calcuie" -> "calcule").
function distanciaEdicao(a, b) {
  const m = a.length, n = b.length;
  if (Math.abs(m - n) > 2) return 99; // corta cedo, não vale a pena calcular
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[m][n];
}

// Verifica se alguma palavra-chave de enunciado aparece no texto, mesmo
// com pequenos erros de digitação/OCR (até 2 letras de diferença em
// palavras longas, 1 em palavras curtas) e ignorando acentuação.
function contemPalavraDeEnunciado(textoLimpo) {
  const palavras = semAcento(textoLimpo.toLowerCase()).split(/[^a-z]+/).filter(Boolean);
  return PALAVRAS_DE_ENUNCIADO.some((chave) => {
    const chaveLimpa = semAcento(chave);
    if (chaveLimpa.includes(' ')) return semAcento(textoLimpo.toLowerCase()).includes(chaveLimpa);
    const tolerancia = chaveLimpa.length >= 7 ? 2 : 1;
    return palavras.some((palavra) => distanciaEdicao(palavra, chaveLimpa) <= tolerancia);
  });
}

// Remove linhas de ruído de dentro de um bloco de texto, preservando a
// ordem das linhas restantes.
function limparRuido(texto) {
  return texto
    .split('\n')
    .filter((linha) => !linhaEhRuido(linha))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Dá uma pontuação de "isso parece uma questão de prova" para um trecho
// de texto já limpo. Quanto maior, mais confiança de que é questão de
// verdade (e não, por exemplo, um pedaço de cabeçalho que sobrou).
function pontuarQuestao(texto, temAlternativas) {
  if (!texto) return -99;
  let pontos = 0;
  if (texto.includes('?')) pontos += 2;
  if (temAlternativas) pontos += 3;
  const temPalavraChave = contemPalavraDeEnunciado(texto);
  if (temPalavraChave) pontos += 1;
  if (texto.length >= 40) pontos += 1;
  if (texto.length < 15) pontos -= 3;
  // Trecho com muitas linhas curtas e nenhuma pontuação de frase real
  // costuma ser sobra de cabeçalho/rodapé, não questão — a não ser que
  // já tenha uma palavra de comando típica de enunciado ("calcule",
  // "explique"...), que por si só já é um sinal forte de questão.
  if (!temPalavraChave && !/[.?!]/.test(texto) && texto.length < 60) pontos -= 2;
  return pontos;
}

// Separa o enunciado das alternativas (se houver) dentro de um bloco.
function separarEnunciadoEAlternativas(blocoTexto) {
  const linhas = blocoTexto.split('\n');
  const enunciadoLinhas = [];
  const alternativas = [];

  for (const linhaOriginal of linhas) {
    const linha = linhaOriginal.trim();
    if (!linha) continue;
    const match = linha.match(REGEX_ALTERNATIVA);
    if (match && match[2].trim()) {
      alternativas.push(`${match[1].toUpperCase()}) ${match[2].trim()}`);
    } else if (alternativas.length === 0) {
      // Só entra no enunciado enquanto ainda não começaram as
      // alternativas — depois disso, qualquer linha "solta" que não
      // bate no padrão de alternativa é tratada como continuação da
      // última alternativa (comum quando o OCR quebra uma linha longa).
      enunciadoLinhas.push(linha);
    } else {
      alternativas[alternativas.length - 1] += ` ${linha}`;
    }
  }

  return {
    enunciado: enunciadoLinhas.join('\n').trim(),
    alternativas,
  };
}

// Função principal: recebe o texto bruto (extraído de PDF/DOCX/OCR/e-mail)
// e devolve a lista de questões já identificadas, corrigidas e limpas.
// É assíncrona porque a correção ortográfica/gramatical (LanguageTool)
// depende de uma chamada de rede — feita uma única vez, pro texto
// inteiro, antes de separar as questões.
async function identificarQuestoes(textoBruto) {
  const { textoCorrigido, aplicado: correcaoAplicada } = await corrigirTexto(String(textoBruto || ''));
  const textoLimpo = limparRuido(textoCorrigido);
  if (!textoLimpo) return { fonte: 'regras', correcaoAplicada, questoes: [] };

  const linhas = textoLimpo.split('\n');

  // Agrupa as linhas em blocos, começando um novo bloco toda vez que uma
  // linha bate no padrão de início de questão ("1.", "Questão 2)", ...).
  const blocosNumerados = [];
  let blocoAtual = null;
  for (const linha of linhas) {
    if (REGEX_INICIO_QUESTAO.test(linha)) {
      if (blocoAtual) blocosNumerados.push(blocoAtual);
      blocoAtual = linha.replace(REGEX_INICIO_QUESTAO, '');
    } else if (blocoAtual !== null) {
      blocoAtual += `\n${linha}`;
    }
  }
  if (blocoAtual) blocosNumerados.push(blocoAtual);

  let blocosBrutos;
  if (blocosNumerados.length >= 1) {
    // Achou numeração de verdade — é o sinal mais confiável que existe,
    // usa direto (mesmo que seja só uma questão numerada sozinha).
    blocosBrutos = blocosNumerados;
  } else {
    // Sem numeração (ou só uma "numeração" isolada, que pode ser coincidência
    // — ex.: um "1)" que era na verdade parte do enunciado). Nesse caso, o
    // texto pode ainda ter várias questões separadas só por linha em
    // branco, que é a segunda pista mais comum em provas digitadas à mão.
    const paragrafos = textoLimpo.split(/\n\s*\n+/).map((p) => p.trim()).filter(Boolean);
    blocosBrutos = paragrafos.length >= 2 ? paragrafos : [textoLimpo];
  }

  const questoes = [];
  blocosBrutos.forEach((bloco) => {
    const { enunciado, alternativas } = separarEnunciadoEAlternativas(bloco);
    const textoParaPontuar = [enunciado, ...alternativas].join('\n').trim();
    const pontuacao = pontuarQuestao(textoParaPontuar, alternativas.length >= 2);

    // Limiar de corte: abaixo disso, tratamos como ruído (cabeçalho,
    // instrução solta etc.) e descartamos automaticamente, conforme
    // pedido — só sobra questão de verdade na lista final.
    const LIMIAR_MINIMO = 0;
    if (pontuacao < LIMIAR_MINIMO || !enunciado) return;

    questoes.push({
      ...formatarQuestao({ enunciado, alternativas }),
      confiancaHeuristica: pontuacao,
    });
  });

  questoes.forEach((questao, indice) => { questao.numero = indice + 1; });

  return { fonte: 'regras', correcaoAplicada, questoes };
}

module.exports = { identificarQuestoes };
