// provaDocx.js
// Gera o .docx da prova no modelo oficial "Caderno de Provas" da FANS.
//
// Em vez de montar um documento do zero, o módulo abre o template
// aprovado (assets/Template-Avaliacao-FANS.docx) e troca apenas o
// word/document.xml. Estilos, numeração, fontes, tamanho/margens de
// página, rodapé azul ("FACULDADE DE NOVA SERRANA / WWW.FANS.EDU.BR") e
// a logo continuam sendo exatamente os do arquivo que o coordenador
// aprovou — nada é recriado "parecido".
//
// O DOCX sai editável: o professor pode ajustar uma palavra no Word
// antes de imprimir, o que o PDF não permite.

const fs = require('fs');
const path = require('path');
const { lerZip, escreverZip } = require('./zipDocx');
const {
  prepararProva, formatarPontos, COR_INSTITUCIONAL, dividirNegrito,
} = require('./modeloProva');

const CAMINHO_TEMPLATE = path.join(__dirname, 'assets', 'Template-Avaliacao-FANS.docx');

/* ------------------------------------------------------ peças de XML */

// Corpo do texto das questões: Arial 10 (sz 20 = meio-pontos), justificado,
// sem espaço entre parágrafos — igual ao template.
const FONTE_ARIAL = '<w:rFonts w:ascii="Arial" w:cs="Arial" w:eastAsia="Arial" w:hAnsi="Arial"/>';
const RPR_TEXTO = `${FONTE_ARIAL}<w:sz w:val="20"/><w:szCs w:val="20"/>`;
const RPR_TEXTO_NEGRITO = `${FONTE_ARIAL}<w:b w:val="1"/><w:bCs w:val="1"/><w:sz w:val="20"/><w:szCs w:val="20"/>`;
const PPR_TEXTO = '<w:spacing w:after="0" w:line="240" w:lineRule="auto"/><w:jc w:val="both"/>';

// Rótulos do quadro de identificação: Arial, negrito, versalete, azul FANS.
const RPR_ROTULO = `${FONTE_ARIAL}<w:b w:val="1"/><w:bCs w:val="1"/><w:smallCaps w:val="1"/><w:color w:val="${COR_INSTITUCIONAL}"/>`;
// Valores preenchidos (curso, data, período...): Arial 10 em vez do
// Calibri 11 do template — a coluna da DATA é estreita e "16/09/2026"
// quebrava em duas linhas.
const RPR_VALOR_CAMPO = `${FONTE_ARIAL}<w:b w:val="1"/><w:bCs w:val="1"/><w:sz w:val="20"/><w:szCs w:val="20"/>`;

// Faixa azul de largura total usada nos títulos de questão, no quadro de
// orientações e no "TÉRMINO DA PROVA". Os recuos negativos são o que faz
// a faixa passar das margens, como no template.
// keepNext evita o título da questão sozinho no pé da página.
const PPR_FAIXA = `<w:keepNext w:val="1"/><w:shd w:fill="${COR_INSTITUCIONAL}" w:val="clear"/><w:ind w:left="-1276" w:right="-852" w:firstLine="0"/><w:jc w:val="center"/>`;
const RPR_FAIXA = '<w:b w:val="1"/><w:bCs w:val="1"/><w:color w:val="ffffff"/><w:sz w:val="28"/><w:szCs w:val="28"/>';

const BORDAS_TABELA = [
  'top', 'left', 'bottom', 'right', 'insideH', 'insideV',
].map((lado) => `<w:${lado} w:color="000000" w:space="0" w:sz="4" w:val="single"/>`).join('');

// A logo já vem no template (word/media/image1.png, relação rId7); aqui
// só reposicionamos o mesmo desenho ancorado dentro da primeira célula.
const DESENHO_LOGO = `<w:r><w:rPr><w:rtl w:val="0"/></w:rPr><w:drawing><wp:anchor allowOverlap="1" behindDoc="0" distB="0" distT="0" distL="114300" distR="114300" hidden="0" layoutInCell="1" locked="0" relativeHeight="0" simplePos="0"><wp:simplePos x="0" y="0"/><wp:positionH relativeFrom="column"><wp:posOffset>457200</wp:posOffset></wp:positionH><wp:positionV relativeFrom="paragraph"><wp:posOffset>132432</wp:posOffset></wp:positionV><wp:extent cx="1537335" cy="1059180"/><wp:effectExtent b="0" l="0" r="0" t="0"/><wp:wrapSquare wrapText="bothSides" distB="0" distT="0" distL="114300" distR="114300"/><wp:docPr id="2" name="image1.png"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="0" name="image1.png"/><pic:cNvPicPr preferRelativeResize="0"/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rId7"/><a:srcRect b="0" l="0" r="0" t="0"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1537335" cy="1059180"/></a:xfrm><a:prstGeom prst="rect"/><a:ln/></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:anchor></w:drawing></w:r>`;

/* --------------------------------------------------- helpers de XML */

function escapar(texto) {
  return String(texto === null || texto === undefined ? '' : texto)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function run(texto, rPr = '') {
  return `<w:r><w:rPr>${rPr}<w:rtl w:val="0"/></w:rPr><w:t xml:space="preserve">${escapar(texto)}</w:t></w:r>`;
}

// Enunciado/alternativas podem ter trechos em **negrito** (marcados pelo
// professor no botão "Negrito" da tela de edição). Aqui cada trecho vira
// um <w:r> com a formatação certa, mantendo o resto do texto normal.
function runsComNegrito(texto, rPrNormal = RPR_TEXTO, rPrNegrito = RPR_TEXTO_NEGRITO) {
  return dividirNegrito(texto)
    .map((parte) => run(parte.texto, parte.negrito ? rPrNegrito : rPrNormal))
    .join('');
}

function paragrafo(runs, pPr = '', rPrParagrafo = '') {
  return `<w:p><w:pPr>${pPr}<w:rPr>${rPrParagrafo}</w:rPr></w:pPr>${runs}</w:p>`;
}

/** Parágrafo vazio no mesmo corpo de texto das questões. */
function paragrafoVazio(pPr = PPR_TEXTO, rPr = RPR_TEXTO) {
  return paragrafo('', pPr, rPr);
}

function faixa(texto) {
  return paragrafo(run(texto, RPR_FAIXA), PPR_FAIXA, RPR_FAIXA);
}

function celula(conteudo, { larguraColunas = 1, alinhamento = 'center', fundo = null } = {}) {
  const propriedades = [
    larguraColunas > 1 ? `<w:gridSpan w:val="${larguraColunas}"/>` : '',
    fundo ? `<w:shd w:fill="${fundo}" w:val="clear"/>` : '',
    '<w:vAlign w:val="center"/>',
  ].join('');
  const corpo = Array.isArray(conteudo) ? conteudo.join('') : conteudo;
  return `<w:tc><w:tcPr>${propriedades}</w:tcPr>${corpo || paragrafo('', `<w:jc w:val="${alinhamento}"/>`)}</w:tc>`;
}

function linha(celulas, altura) {
  return `<w:tr><w:trPr><w:cantSplit w:val="0"/><w:trHeight w:val="${altura}" w:hRule="atLeast"/><w:tblHeader w:val="0"/></w:trPr>${celulas.join('')}</w:tr>`;
}

function tabela(colunas, linhas) {
  const grade = colunas.map((largura) => `<w:gridCol w:w="${largura}"/>`).join('');
  const total = colunas.reduce((soma, largura) => soma + largura, 0);
  return `<w:tbl><w:tblPr><w:tblStyle w:val="Table1"/><w:tblW w:w="${total}.0" w:type="dxa"/><w:jc w:val="left"/><w:tblInd w:w="-1168.0" w:type="dxa"/><w:tblBorders>${BORDAS_TABELA}</w:tblBorders><w:tblLayout w:type="fixed"/><w:tblLook w:val="0400"/></w:tblPr><w:tblGrid>${grade}</w:tblGrid>${linhas.join('')}</w:tbl>`;
}

// Célula de rótulo ("CURSO:") e célula do valor preenchido pelo professor.
function rotulo(texto, larguraColunas = 1) {
  return celula(paragrafo(run(texto, RPR_ROTULO), '<w:jc w:val="center"/>', RPR_ROTULO), { larguraColunas });
}

function valor(texto, larguraColunas = 1, alinhamento = 'left') {
  const conteudo = texto
    ? paragrafo(run(texto, RPR_VALOR_CAMPO), `<w:jc w:val="${alinhamento}"/>`, RPR_VALOR_CAMPO)
    : '';
  return celula(conteudo, { larguraColunas, alinhamento });
}

/* ----------------------------------------------------- blocos da prova */

// Quadro de identificação: logo + "CADERNO DE PROVAS" + campos do topo.
function blocoCabecalho(prova) {
  const colunas = [1530, 4034, 2088, 1252, 454, 658, 979];

  const titulo = [
    paragrafo(DESENHO_LOGO, '<w:ind w:left="-250" w:right="-108" w:firstLine="0"/><w:jc w:val="center"/>'),
    paragrafo('', '<w:ind w:left="-108" w:right="-108" w:firstLine="0"/><w:jc w:val="center"/>'),
    paragrafo(
      run('CADERNO DE PROVAS', `${FONTE_ARIAL}<w:b w:val="1"/><w:bCs w:val="1"/><w:smallCaps w:val="1"/><w:color w:val="${COR_INSTITUCIONAL}"/><w:sz w:val="44"/><w:szCs w:val="44"/><w:u w:val="single"/>`),
      '<w:ind w:left="-108" w:right="-108" w:firstLine="0"/><w:jc w:val="left"/>',
    ),
    paragrafo(
      run(`   ${prova.titulo || 'Avaliação'}`, `<w:color w:val="${COR_INSTITUCIONAL}"/><w:sz w:val="36"/><w:szCs w:val="36"/>`),
      '<w:spacing w:after="240" w:before="240" w:line="360" w:lineRule="auto"/><w:ind w:left="-108" w:right="-108" w:firstLine="0"/><w:jc w:val="left"/>',
    ),
  ];

  return tabela(colunas, [
    linha([celula(titulo, { larguraColunas: 7 })], 2171),
    linha([
      rotulo('CURSO:'), valor(prova.curso),
      rotulo('DATA:'), valor(prova.data),
      rotulo('ETAPA:', 2), valor(prova.etapa),
    ], 271),
    linha([
      rotulo('PERÍODO:'), valor(prova.periodo),
      rotulo('APROVAÇÃO DO COORDENADOR:'), valor(prova.aprovacaoCoordenador, 4),
    ], 502),
    linha([
      rotulo('ALUNO:'), valor(prova.aluno, 2),
      rotulo('VALOR:', 2), valor(prova.valorProva, 2),
    ], 528),
  ]);
}

// Quadro "ORIENTAÇÕES GERAIS": faixa azul + lista numerada em itálico.
function blocoOrientacoes(prova) {
  const cabecalho = celula(
    paragrafo(run('ORIENTAÇÕES GERAIS PARA ESTA AVALIAÇÃO:', RPR_FAIXA), '<w:jc w:val="center"/>', '<w:sz w:val="28"/><w:szCs w:val="28"/>'),
    { fundo: COR_INSTITUCIONAL },
  );

  const rPrItem = '<w:rFonts w:ascii="Calibri" w:cs="Calibri" w:eastAsia="Calibri" w:hAnsi="Calibri"/>'
    + `<w:b w:val="0"/><w:bCs w:val="0"/><w:i w:val="1"/><w:iCs w:val="1"/><w:color w:val="${COR_INSTITUCIONAL}"/><w:sz w:val="22"/><w:szCs w:val="22"/>`;
  // numId 1 é a lista decimal que já existe no numbering.xml do template.
  const pPrItem = '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>'
    + '<w:tabs><w:tab w:val="left" w:leader="none" w:pos="317"/></w:tabs>'
    + '<w:spacing w:after="0" w:before="0" w:line="276" w:lineRule="auto"/>'
    + '<w:ind w:left="34" w:right="0" w:firstLine="0"/><w:jc w:val="both"/>';

  const itens = prova.orientacoes.map((item) => paragrafo(run(item, rPrItem), pPrItem, rPrItem));

  return tabela([11009], [
    linha([cabecalho], 470),
    linha([celula(itens)], 1832),
  ]);
}

// Uma questão: faixa "QUESTÃO N – (xx pontos)", linha de referência,
// enunciado, alternativas (ou linhas pautadas, se for dissertativa).
function blocoQuestao(questao, numero, prova) {
  const pontos = formatarPontos(questao.valor);
  const partes = [
    paragrafo('', '<w:jc w:val="left"/>'),
    faixa(`QUESTÃO ${numero}${pontos ? ` – (${pontos} pontos)` : ''}`),
  ];

  if (questao.referencia.length) {
    const runs = questao.referencia
      .map(({ rotulo: chave, valor: conteudo }) => run(chave, RPR_TEXTO_NEGRITO) + run(` ${conteudo}`, RPR_TEXTO))
      .join(run(' ', RPR_TEXTO));
    partes.push(paragrafo(runs, PPR_TEXTO, RPR_TEXTO));
    partes.push(paragrafoVazio(PPR_TEXTO, RPR_TEXTO_NEGRITO));
  }

  String(questao.enunciado || '(questão sem enunciado)')
    .split('\n')
    .forEach((linhaTexto) => partes.push(paragrafo(runsComNegrito(linhaTexto), PPR_TEXTO, RPR_TEXTO)));

  if (questao.alternativas.length) {
    partes.push(paragrafoVazio());
    questao.alternativas.forEach((alternativa) => {
      partes.push(paragrafo(
        run(`${alternativa.letra}) `, RPR_TEXTO_NEGRITO) + runsComNegrito(alternativa.texto),
        PPR_TEXTO,
        RPR_TEXTO,
      ));
    });
  } else if (prova.linhasResposta > 0) {
    // Dissertativa: linhas pautadas para o aluno escrever.
    partes.push(paragrafoVazio());
    const pPrLinha = '<w:pBdr><w:bottom w:color="000000" w:space="1" w:sz="4" w:val="single"/></w:pBdr>'
      + '<w:spacing w:after="0" w:line="360" w:lineRule="auto"/><w:jc w:val="left"/>';
    for (let i = 0; i < prova.linhasResposta; i += 1) {
      partes.push(paragrafo('', pPrLinha, RPR_TEXTO));
    }
  }

  return partes.join('');
}

/* ------------------------------------------------------------ geração */

let templateEmCache = null;

function carregarTemplate() {
  if (!templateEmCache) {
    if (!fs.existsSync(CAMINHO_TEMPLATE)) {
      const erro = new Error('Template oficial da FANS não encontrado em assets/Template-Avaliacao-FANS.docx.');
      erro.statusCode = 500;
      throw erro;
    }
    templateEmCache = lerZip(fs.readFileSync(CAMINHO_TEMPLATE));
  }
  // Cópia: quem chama altera o document.xml sem sujar o cache.
  return new Map(templateEmCache);
}

/**
 * Monta o DOCX da prova no modelo da FANS.
 *
 * Aceita os mesmos campos do PDF, mais os do quadro de identificação do
 * template (curso, período, etapa, aluno, valor da prova).
 *
 * @param {object} prova
 * @returns {Buffer} arquivo .docx pronto para download
 */
function montarDocxProva(prova) {
  const dados = prepararProva(prova);
  const arquivos = carregarTemplate();

  const documentoOriginal = arquivos.get('word/document.xml').toString('utf8');
  const inicioCorpo = documentoOriginal.indexOf('<w:body>');
  const fimCorpo = documentoOriginal.indexOf('</w:body>');
  if (inicioCorpo < 0 || fimCorpo < 0) {
    throw new Error('Template da FANS inválido: corpo do documento não encontrado.');
  }

  // A configuração de página (A4, margens, rodapé, numeração) vem do
  // próprio template — nunca é reescrita aqui.
  const corpoOriginal = documentoOriginal.slice(inicioCorpo + '<w:body>'.length, fimCorpo);
  const sectPr = (corpoOriginal.match(/<w:sectPr[\s\S]*?<\/w:sectPr>/) || [''])[0];

  const corpo = [
    paragrafo('', '<w:spacing w:after="0" w:before="0" w:line="276" w:lineRule="auto"/><w:jc w:val="left"/>'),
    blocoCabecalho(dados),
    paragrafo('', '<w:jc w:val="left"/>'),
    blocoOrientacoes(dados),
    ...dados.questoes.map((questao, indice) => blocoQuestao(questao, indice + 1, dados)),
    paragrafo('', '<w:jc w:val="left"/>'),
    faixa('TÉRMINO DA PROVA.'),
    sectPr,
  ].join('');

  arquivos.set(
    'word/document.xml',
    Buffer.from(documentoOriginal.slice(0, inicioCorpo + '<w:body>'.length) + corpo + documentoOriginal.slice(fimCorpo), 'utf8'),
  );

  return escreverZip(arquivos);
}

module.exports = { montarDocxProva };
