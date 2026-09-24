// modeloProva.js
// Regras de formatação do "Caderno de Provas" da FANS — o mesmo modelo
// usado pelo template oficial em ABNT (assets/Template-Avaliacao-FANS.docx).
//
// Fica separado porque o PDF (provaPdf.js) e o DOCX (provaDocx.js) têm
// que sair idênticos: quem muda uma regra aqui muda nos dois de uma vez.

// Alternativas: "A) texto", "b. texto", "C - texto".
const REGEX_ALTERNATIVA = /^\s*([A-Ea-e])\s*[\)\.\-]\s+(.*)$/;

// Negrito marcado pelo professor: **assim**. É o mesmo texto que o botão
// "Negrito" da tela de edição insere ao redor do trecho selecionado — ver
// public/app.js (configurarNegrito). PDF e DOCX leem essa marcação com
// dividirNegrito() pra desenhar o trecho em negrito de verdade.
const REGEX_NEGRITO = /\*\*(.+?)\*\*/g;

// Cabeçalho de referência da questão, quando o professor cadastrou:
// "Ano: 2023 Banca: FGV Órgão: TJ-MG Prova: Analista".
const CAMPOS_REFERENCIA = [
  ['Ano', 'ano'],
  ['Banca', 'banca'],
  ['Órgão', 'orgao'],
  ['Prova', 'prova'],
];

const ORIENTACOES_PADRAO = [
  'A avaliação deve ser realizada individualmente;',
  'Nesta prova não é admitida nenhuma forma de consulta a qualquer tipo material;',
  'Celulares e outros dispositivos de comunicação devem permanecer desligados e acondicionados debaixo das carteiras durante toda a duração da avaliação;',
  'Não será tolerado nenhum tipo de comunicação entre os alunos, sob pena de anulação da nota obtida;',
  'Esta avaliação tem duração total de uma hora e quarenta minutos;',
];

const COR_INSTITUCIONAL = '1f497d';

/**
 * Pontuação como no template: inteiros com dois dígitos ("04 pontos"),
 * quebrados com vírgula ("2,5 pontos").
 */
function formatarPontos(valor) {
  const numero = Number(valor);
  if (!Number.isFinite(numero) || numero <= 0) return null;
  return Number.isInteger(numero)
    ? String(numero).padStart(2, '0')
    : numero.toFixed(1).replace('.', ',');
}

// Pontuação para textos corridos ("10,0 pontos no total").
function formatarPontosDecimal(valor) {
  const numero = Number(valor);
  if (!Number.isFinite(numero)) return null;
  return numero.toFixed(1).replace('.', ',');
}

/**
 * Quebra um texto em pedaços { texto, negrito }, interpretando os trechos
 * marcados com **assim** como negrito. Um texto sem nenhuma marcação volta
 * como um único pedaço { texto, negrito: false }, então quem consome isso
 * (provaDocx.js e provaPdf.js) não precisa tratar caso especial.
 */
function dividirNegrito(texto) {
  const bruto = String(texto || '');
  const partes = [];
  let ultimoIndice = 0;

  bruto.replace(REGEX_NEGRITO, (correspondencia, conteudo, indice) => {
    if (indice > ultimoIndice) {
      partes.push({ texto: bruto.slice(ultimoIndice, indice), negrito: false });
    }
    if (conteudo) partes.push({ texto: conteudo, negrito: true });
    ultimoIndice = indice + correspondencia.length;
    return correspondencia;
  });

  if (ultimoIndice < bruto.length) {
    partes.push({ texto: bruto.slice(ultimoIndice), negrito: false });
  }

  return partes.length ? partes : [{ texto: bruto, negrito: false }];
}

/**
 * Separa o texto salvo da questão em enunciado e alternativas.
 *
 * Questões dissertativas podem legitimamente ter linhas "A) ..."/"B) ..."
 * como parte do enunciado (ex.: itens que o aluno deve endereçar na
 * resposta) sem serem alternativas de múltipla escolha — ver o mesmo
 * cuidado em public/app.js. Por isso o tipo escolhido pelo professor
 * manda: só extraímos alternativas quando a questão é, de fato,
 * 'multipla_escolha'. Sem tipo informado (questões antigas), cai no
 * comportamento anterior de deduzir pelo texto.
 */
function separarQuestao(texto, tipo) {
  const linhas = String(texto || '').split('\n');
  const enunciado = [];
  const alternativas = [];

  linhas.forEach((linha) => {
    const casamento = tipo !== 'dissertativa' ? linha.match(REGEX_ALTERNATIVA) : null;
    if (casamento) {
      alternativas.push({ letra: casamento[1].toLowerCase(), texto: casamento[2].trim() });
    } else if (linha.trim()) {
      enunciado.push(linha.trim());
    }
  });

  return { enunciado: enunciado.join('\n'), alternativas };
}

/** Monta a linha "Ano: ... Banca: ..." só com os campos preenchidos. */
function referenciaDaQuestao(questao) {
  return CAMPOS_REFERENCIA
    .map(([rotulo, campo]) => {
      const valor = questao[campo];
      if (valor === null || valor === undefined || String(valor).trim() === '') return null;
      return { rotulo: `${rotulo}:`, valor: String(valor).trim() };
    })
    .filter(Boolean);
}

/**
 * Normaliza os dados que vêm da tela antes de desenhar o documento:
 * valida a lista de questões, separa enunciado/alternativas e calcula a
 * pontuação total. PDF e DOCX consomem exatamente esta estrutura.
 */
function prepararProva(prova) {
  if (!prova || !Array.isArray(prova.questoes) || prova.questoes.length === 0) {
    const erro = new Error('Selecione pelo menos uma questão para montar a prova.');
    erro.statusCode = 400;
    throw erro;
  }

  const questoes = prova.questoes.map((questao) => ({
    ...separarQuestao(questao.texto, questao.tipo),
    valor: questao.valor,
    referencia: referenciaDaQuestao(questao),
  }));

  const pontuacaoTotal = prova.questoes.reduce(
    (soma, questao) => soma + (Number.isFinite(Number(questao.valor)) ? Number(questao.valor) : 0),
    0,
  );

  const orientacoesInformadas = String(prova.instrucoes || '')
    .split('\n')
    .map((linha) => linha.replace(/^\s*\d+[.)]\s*/, '').trim())
    .filter(Boolean);

  return {
    titulo: (prova.titulo || '').trim(),
    curso: (prova.curso || prova.disciplina || '').trim(),
    periodo: (prova.periodo || prova.turma || '').trim(),
    data: (prova.data || '').trim(),
    etapa: (prova.etapa || '').trim(),
    professor: (prova.professor || '').trim(),
    aluno: (prova.aluno || '').trim(),
    valorProva: (prova.valorProva || '').trim(),
    aprovacaoCoordenador: (prova.aprovacaoCoordenador || '').trim(),
    orientacoes: orientacoesInformadas.length ? orientacoesInformadas : ORIENTACOES_PADRAO,
    linhasResposta: Number.isFinite(Number(prova.linhasResposta))
      ? Math.max(0, Math.min(Number(prova.linhasResposta), 20))
      : 5,
    questoes,
    pontuacaoTotal,
  };
}

/** Nome de arquivo seguro a partir do título ("Avaliação de POO" -> "avaliacao-de-poo"). */
function nomeArquivo(titulo, extensao) {
  const base = String(titulo || 'prova')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase() || 'prova';
  return `${base}.${extensao}`;
}

module.exports = {
  REGEX_ALTERNATIVA,
  REGEX_NEGRITO,
  ORIENTACOES_PADRAO,
  COR_INSTITUCIONAL,
  formatarPontos,
  formatarPontosDecimal,
  dividirNegrito,
  separarQuestao,
  referenciaDaQuestao,
  prepararProva,
  nomeArquivo,
};
