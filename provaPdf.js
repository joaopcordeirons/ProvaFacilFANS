// provaPdf.js
// Monta o PDF final da prova no modelo oficial "Caderno de Provas" da
// FANS — o mesmo do template em ABNT (assets/Template-Avaliacao-FANS.docx):
// quadro de identificação com a logo, faixas azuis de questão, corpo em
// Arial 10 justificado e rodapé institucional em todas as páginas.
//
// As medidas abaixo são as do template, convertidas de twips para pontos
// (1 pt = 20 twips) — é por isso que os números parecem quebrados.
//
// O módulo é puro: recebe os dados já resolvidos (nenhuma consulta a
// banco acontece aqui) e devolve um Buffer com o PDF pronto. Quem busca
// as questões no Firestore é o server.js.

const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const { lerCoberturaTTF } = require('./coberturaFonte');
const {
  prepararProva, formatarPontos, separarQuestao, COR_INSTITUCIONAL, dividirNegrito,
} = require('./modeloProva');

// As fontes padrão do PDF (Helvetica etc.) só desenham o WinAnsiEncoding
// (~cp1252): letras acentuadas do português entram nessa tabela, mas
// símbolos como "●", "•", travessão "—" ou aspas curvas não — e o pdfkit
// não falha nesse caso, ele escreve bytes de outro glyph da tabela no PDF,
// o que aparece como lixo tipo "%Ï" quando o professor cola uma questão
// com marcadores de lista. A correção é embutir uma fonte TrueType de
// verdade (com tabela Unicode própria) em vez de depender do WinAnsi.
//
// Liberation Sans é metricamente compatível com a Arial do template (SIL
// Open Font License, redistribuível) e cobre bullet, travessões, aspas
// tipográficas e os símbolos matemáticos mais comuns. Mas nenhuma fonte
// cobre tudo — símbolos mais raros (✓ ✗ ★ ▶, moedas menos comuns) ficam
// de fora dela. Para esses casos existe uma segunda fonte reserva, a
// DejaVu Sans, com uma tabela Unicode bem mais ampla (Bitstream Vera
// License, redistribuível): o texto do professor é varrido caractere a
// caractere e só troca de fonte no trecho que a fonte principal não sabe
// desenhar — ver `escreverTexto` mais abaixo.
const PASTA_FONTES = path.join(__dirname, 'assets', 'fontes');

const FONTE = {
  normal: 'Corpo',
  negrito: 'Corpo-Negrito',
  italico: 'Corpo-Italico',
};
const FONTE_RESERVA = {
  normal: 'Reserva',
  negrito: 'Reserva-Negrito',
  italico: 'Reserva-Italico',
};
// Cada fonte principal aponta para a reserva do mesmo peso/estilo, para
// o texto de fallback não destoar (negrito continua negrito, etc.).
const PAR_RESERVA = {
  [FONTE.normal]: FONTE_RESERVA.normal,
  [FONTE.negrito]: FONTE_RESERVA.negrito,
  [FONTE.italico]: FONTE_RESERVA.italico,
};

function registrarFontes(doc) {
  doc.registerFont(FONTE.normal, path.join(PASTA_FONTES, 'LiberationSans-Regular.ttf'));
  doc.registerFont(FONTE.negrito, path.join(PASTA_FONTES, 'LiberationSans-Bold.ttf'));
  doc.registerFont(FONTE.italico, path.join(PASTA_FONTES, 'LiberationSans-Italic.ttf'));
  doc.registerFont(FONTE_RESERVA.normal, path.join(PASTA_FONTES, 'DejaVuSans.ttf'));
  doc.registerFont(FONTE_RESERVA.negrito, path.join(PASTA_FONTES, 'DejaVuSans-Bold.ttf'));
  doc.registerFont(FONTE_RESERVA.italico, path.join(PASTA_FONTES, 'DejaVuSans-Oblique.ttf'));
}

// Cobertura da fonte principal, calculada uma vez só (o arquivo não
// muda em runtime) e reaproveitada em toda geração de PDF.
let coberturaPrincipal = null;
function obterCoberturaPrincipal() {
  if (coberturaPrincipal === null) {
    coberturaPrincipal = lerCoberturaTTF(path.join(PASTA_FONTES, 'LiberationSans-Regular.ttf'));
  }
  return coberturaPrincipal;
}

// Quebra o texto em trechos contínuos "cobertos pela fonte principal" /
// "precisam da reserva". Espaços e quebras de linha nunca sozinhos
// disparam a troca de fonte — não vale a pena mudar de fonte por causa
// de um espaço no meio de uma palavra coberta.
function segmentarPorCobertura(texto, cobertura) {
  if (!cobertura) return [{ texto, reserva: false }];

  const segmentos = [];
  let atual = '';
  let atualReserva = false;

  Array.from(texto).forEach((caractere) => {
    const precisaReserva = caractere.trim() !== '' && !cobertura.has(caractere.codePointAt(0));
    if (atual && precisaReserva !== atualReserva) {
      segmentos.push({ texto: atual, reserva: atualReserva });
      atual = '';
    }
    atual += caractere;
    atualReserva = precisaReserva;
  });
  if (atual) segmentos.push({ texto: atual, reserva: atualReserva });
  return segmentos;
}

/**
 * Substituto de `doc.text(...)` que troca para a fonte reserva só nos
 * trechos que a fonte principal não sabe desenhar. Aceita as duas formas
 * de chamada do pdfkit: com posição (`x`, `y`) para começar um parágrafo
 * novo, ou só com opções (`continued: true` encadeado a um texto anterior
 * na mesma linha).
 *
 * @param {PDFKit.PDFDocument} doc
 * @param {string} texto
 * @param {string} fontePrincipal um dos valores de FONTE
 * @param {number|object} [x] posição x, ou já as opções (chamada continuada)
 * @param {number} [y]
 * @param {object} [opcoes]
 */
function escreverTexto(doc, texto, fontePrincipal, x, y, opcoes) {
  let posX = x;
  let posY = y;
  let opcoesFinais = opcoes;
  if (typeof posX === 'object' && posX !== null) {
    opcoesFinais = posX;
    posX = undefined;
    posY = undefined;
  }
  opcoesFinais = opcoesFinais || {};

  const segmentos = segmentarPorCobertura(texto, obterCoberturaPrincipal());

  if (segmentos.length === 1 && !segmentos[0].reserva) {
    doc.font(fontePrincipal);
    if (posX !== undefined) doc.text(texto, posX, posY, opcoesFinais);
    else doc.text(texto, opcoesFinais);
    return;
  }

  const fonteReserva = PAR_RESERVA[fontePrincipal] || FONTE_RESERVA.normal;
  segmentos.forEach((segmento, indice) => {
    const primeiro = indice === 0;
    const ultimo = indice === segmentos.length - 1;
    doc.font(segmento.reserva ? fonteReserva : fontePrincipal);
    const opcoesSegmento = { ...opcoesFinais, continued: !ultimo || opcoesFinais.continued };
    if (primeiro && posX !== undefined) doc.text(segmento.texto, posX, posY, opcoesSegmento);
    else doc.text(segmento.texto, opcoesSegmento);
  });
}

/**
 * Como escreverTexto, mas interpretando trechos **assim** (marcados pelo
 * professor no botão "Negrito" da tela de edição) e desenhando-os com
 * `fonteNegrito` em vez de `fonteNormal`, encadeados na mesma linha.
 *
 * O texto pode ter várias linhas (\n) — por exemplo, uma dissertativa cujo
 * enunciado tem itens "A)"/"B)" em linhas próprias, com essas letras em
 * negrito. O pdfkit só entende \n como quebra de linha de verdade quando a
 * chamada NÃO está em modo "continued"; encadear os trechos em negrito com
 * continued:true de ponta a ponta (ignorando onde as linhas terminam)
 * engolia essas quebras. Por isso separamos por linha primeiro, e só
 * encadeamos continued:true entre os trechos de negrito de uma mesma
 * linha — nunca de uma linha para a próxima.
 */
function escreverTextoComNegrito(doc, texto, fonteNormal, fonteNegrito, x, y, opcoes) {
  let posX = x;
  let posY = y;
  let opcoesBase = opcoes;
  if (typeof posX === 'object' && posX !== null) {
    opcoesBase = posX;
    posX = undefined;
    posY = undefined;
  }
  opcoesBase = opcoesBase || {};

  const linhas = String(texto).split('\n');
  linhas.forEach((linhaTexto, indiceLinha) => {
    const primeiraLinha = indiceLinha === 0;
    const partes = dividirNegrito(linhaTexto);
    partes.forEach((parte, indice) => {
      const primeiraParte = indice === 0;
      const ultimaParte = indice === partes.length - 1;
      const fonte = parte.negrito ? fonteNegrito : fonteNormal;
      // Só a última parte da última linha herda o "continued" pedido por
      // quem chamou (ex.: pra emendar na letra da alternativa seguinte);
      // entre linhas, nunca — é isso que preserva a quebra.
      const ultimaLinha = indiceLinha === linhas.length - 1;
      const opcoesParte = {
        ...opcoesBase,
        continued: !ultimaParte || (ultimaLinha && opcoesBase.continued),
      };
      if (primeiraParte && primeiraLinha && posX !== undefined) {
        escreverTexto(doc, parte.texto, fonte, posX, posY, opcoesParte);
      } else {
        escreverTexto(doc, parte.texto, fonte, opcoesParte);
      }
    });
  });
}

const pt = (twips) => twips / 20;

const MARGEM_SUPERIOR = pt(568);
const MARGEM_INFERIOR = pt(1134);
const MARGEM_ESQUERDA = pt(1701);
const MARGEM_DIREITA = pt(1134);

// Tabelas e faixas "estouram" as margens no template (recuos negativos).
const LARGURA_PAGINA = 595.28; // A4 em pontos
const TABELA_X = MARGEM_ESQUERDA - pt(1168);
const TABELA_LARGURA = pt(10995);
const FAIXA_X = MARGEM_ESQUERDA - pt(1276);
const FAIXA_LARGURA = LARGURA_PAGINA - FAIXA_X - (MARGEM_DIREITA - pt(852));

const AZUL = `#${COR_INSTITUCIONAL}`;
const PRETO = '#000000';
const BRANCO = '#ffffff';

const ALTURA_FAIXA = 23.5;
const MARGEM_CELULA = 5;
const ESPACO_ENTRE_LINHAS = 1.4;

const CAMINHO_LOGO = path.join(__dirname, 'assets', 'logo-fans.png');

// Larguras das colunas do quadro de identificação, na ordem do template.
const COLUNAS_CABECALHO = [1530, 4034, 2088, 1252, 454, 658, 979].map(pt);

/* -------------------------------------------------------- utilidades */

function limiteInferior(doc) {
  return doc.page.height - MARGEM_INFERIOR;
}

// Garante espaço na página antes de desenhar um bloco de altura conhecida.
function garantirEspaco(doc, altura) {
  if (doc.y + altura > limiteInferior(doc)) {
    doc.addPage();
    doc.y = MARGEM_SUPERIOR;
  }
}

function desenharRetangulo(doc, x, y, largura, altura, preenchimento) {
  if (preenchimento) {
    doc.rect(x, y, largura, altura).fillColor(preenchimento).fill();
  }
  doc.rect(x, y, largura, altura).lineWidth(0.8).strokeColor(PRETO).stroke();
}

/* ------------------------------------------- quadro de identificação */

// Uma linha do quadro: células com rótulo azul e valor preenchido.
function desenharLinhaCabecalho(doc, y, alturaMinima, celulas) {
  // Descobre a altura real: um curso com nome comprido pode precisar de
  // duas linhas dentro da célula.
  let altura = alturaMinima;
  const preparadas = [];
  let indiceColuna = 0;

  celulas.forEach((celula) => {
    const span = celula.span || 1;
    const largura = COLUNAS_CABECALHO
      .slice(indiceColuna, indiceColuna + span)
      .reduce((soma, valor) => soma + valor, 0);
    const x = TABELA_X + COLUNAS_CABECALHO
      .slice(0, indiceColuna)
      .reduce((soma, valor) => soma + valor, 0);

    // Rótulo e valor são os dois em negrito no template; muda só o corpo.
    const fonte = FONTE.negrito;
    const tamanho = celula.tipo === 'rotulo' ? 11 : 10;
    const texto = celula.texto || '';
    const alturaTexto = texto
      ? doc.font(fonte).fontSize(tamanho).heightOfString(texto, { width: largura - MARGEM_CELULA * 2 })
      : 0;
    altura = Math.max(altura, alturaTexto + MARGEM_CELULA * 2);

    preparadas.push({ ...celula, x, largura, fonte, tamanho, texto, alturaTexto });
    indiceColuna += span;
  });

  preparadas.forEach((celula) => {
    desenharRetangulo(doc, celula.x, y, celula.largura, altura, null);
    if (!celula.texto) return;
    doc.fillColor(celula.tipo === 'rotulo' ? AZUL : PRETO).fontSize(celula.tamanho);
    escreverTexto(doc, celula.texto, celula.fonte, celula.x + MARGEM_CELULA, y + (altura - celula.alturaTexto) / 2, {
      width: celula.largura - MARGEM_CELULA * 2,
      align: celula.tipo === 'rotulo' ? 'center' : (celula.align || 'left'),
    });
  });

  return y + altura;
}

function desenharCabecalho(doc, prova) {
  let y = MARGEM_SUPERIOR;

  // Linha do título: logo à esquerda, "CADERNO DE PROVAS" e o nome da
  // avaliação à direita.
  const alturaTitulo = pt(2171);
  desenharRetangulo(doc, TABELA_X, y, TABELA_LARGURA, alturaTitulo, null);

  const xLogo = TABELA_X + pt(457200 / 635); // mesmo deslocamento do template
  const larguraLogo = 1537335 / 12700;       // EMU -> pt
  const alturaLogo = 1059180 / 12700;
  try {
    doc.image(CAMINHO_LOGO, xLogo, y + (alturaTitulo - alturaLogo) / 2, {
      width: larguraLogo, height: alturaLogo,
    });
  } catch (err) {
    // Sem a logo o caderno ainda sai — só com o nome da instituição.
    console.warn('[provaPdf] Logo da FANS não carregada:', err.message);
    doc.font(FONTE.negrito).fontSize(20).fillColor(AZUL)
      .text('FANS', xLogo, y + alturaTitulo / 2 - 12, { width: larguraLogo, align: 'center' });
  }

  const xTexto = xLogo + larguraLogo + 14;
  const larguraTexto = TABELA_X + TABELA_LARGURA - xTexto - MARGEM_CELULA;
  doc.font(FONTE.negrito).fontSize(22).fillColor(AZUL)
    .text('CADERNO DE PROVAS', xTexto, y + alturaTitulo / 2 - 32, {
      width: larguraTexto, underline: true,
    });
  doc.fillColor(AZUL).fontSize(18);
  escreverTexto(doc, prova.titulo || 'Avaliação', FONTE.normal, xTexto, doc.y + 8, { width: larguraTexto });

  y += alturaTitulo;

  y = desenharLinhaCabecalho(doc, y, pt(271), [
    { tipo: 'rotulo', texto: 'CURSO:' },
    { tipo: 'valor', texto: prova.curso, align: 'center' },
    { tipo: 'rotulo', texto: 'DATA:' },
    { tipo: 'valor', texto: prova.data },
    { tipo: 'rotulo', texto: 'ETAPA:', span: 2 },
    { tipo: 'valor', texto: prova.etapa },
  ]);

  y = desenharLinhaCabecalho(doc, y, pt(502), [
    { tipo: 'rotulo', texto: 'PERÍODO:' },
    { tipo: 'valor', texto: prova.periodo, align: 'center' },
    { tipo: 'rotulo', texto: 'APROVAÇÃO DO COORDENADOR:' },
    { tipo: 'valor', texto: prova.aprovacaoCoordenador, span: 4, align: 'center' },
  ]);

  y = desenharLinhaCabecalho(doc, y, pt(528), [
    { tipo: 'rotulo', texto: 'ALUNO:' },
    { tipo: 'valor', texto: prova.aluno, span: 2 },
    { tipo: 'rotulo', texto: 'VALOR:', span: 2 },
    { tipo: 'valor', texto: prova.valorProva, span: 2 },
  ]);

  doc.y = y + 16;
}

/* --------------------------------------------- orientações e faixas */

function desenharFaixa(doc, texto, { manterJunto = 0 } = {}) {
  garantirEspaco(doc, ALTURA_FAIXA + manterJunto);
  const y = doc.y;
  doc.rect(FAIXA_X, y, FAIXA_LARGURA, ALTURA_FAIXA).fillColor(AZUL).fill();
  doc.font(FONTE.negrito).fontSize(14).fillColor(BRANCO)
    .text(texto, FAIXA_X, y + (ALTURA_FAIXA - 14) / 2 + 1, {
      width: FAIXA_LARGURA, align: 'center', lineBreak: false,
    });
  doc.y = y + ALTURA_FAIXA;
}

function desenharOrientacoes(doc, prova) {
  const yInicio = doc.y;

  // Faixa azul do título, com borda como no template.
  doc.rect(TABELA_X, yInicio, TABELA_LARGURA, ALTURA_FAIXA).fillColor(AZUL).fill();
  doc.rect(TABELA_X, yInicio, TABELA_LARGURA, ALTURA_FAIXA).lineWidth(0.8).strokeColor(PRETO).stroke();
  doc.font(FONTE.negrito).fontSize(14).fillColor(BRANCO)
    .text('ORIENTAÇÕES GERAIS PARA ESTA AVALIAÇÃO:', TABELA_X, yInicio + (ALTURA_FAIXA - 14) / 2 + 1, {
      width: TABELA_LARGURA, align: 'center', lineBreak: false,
    });

  // Corpo: lista numerada em itálico azul, justificada.
  const yCorpo = yInicio + ALTURA_FAIXA;
  const larguraTexto = TABELA_LARGURA - MARGEM_CELULA * 2 - 18;
  doc.font(FONTE.italico).fontSize(11);
  const alturaCorpo = Math.max(
    pt(1832),
    prova.orientacoes.reduce(
      (soma, item) => soma + doc.heightOfString(item, { width: larguraTexto, lineGap: ESPACO_ENTRE_LINHAS }),
      MARGEM_CELULA * 2,
    ),
  );

  desenharRetangulo(doc, TABELA_X, yCorpo, TABELA_LARGURA, alturaCorpo, null);

  let y = yCorpo + MARGEM_CELULA;
  prova.orientacoes.forEach((item, indice) => {
    doc.font(FONTE.italico).fontSize(11).fillColor(AZUL)
      .text(`${indice + 1}.`, TABELA_X + MARGEM_CELULA, y, { width: 16 });
    escreverTexto(doc, item, FONTE.italico, TABELA_X + MARGEM_CELULA + 18, y, {
      width: larguraTexto, align: 'justify', lineGap: ESPACO_ENTRE_LINHAS,
    });
    y = doc.y;
  });

  doc.y = yCorpo + alturaCorpo + 16;
}

/* ------------------------------------------------------- as questões */

function larguraCorpo(doc) {
  return doc.page.width - MARGEM_ESQUERDA - MARGEM_DIREITA;
}

function desenharQuestao(doc, questao, numero, prova) {
  const largura = larguraCorpo(doc);
  const pontos = formatarPontos(questao.valor);

  doc.moveDown(0.6);
  // Reserva espaço para a faixa + as duas primeiras linhas, para o
  // título nunca ficar sozinho no pé da página.
  desenharFaixa(doc, `QUESTÃO ${numero}${pontos ? ` – (${pontos} pontos)` : ''}`, { manterJunto: 46 });
  doc.y += 10;

  if (questao.referencia.length) {
    // "Ano: 2023 Banca: FGV ..." — rótulo fixo em negrito, valor (digitado
    // pelo professor) passa pela fonte reserva se precisar; continued
    // encadeia os trechos todos na mesma linha.
    doc.fillColor(PRETO).fontSize(10);
    questao.referencia.forEach(({ rotulo, valor }, indice) => {
      const ultimo = indice === questao.referencia.length - 1;
      doc.font(FONTE.negrito);
      if (indice === 0) {
        doc.text(`${rotulo} `, MARGEM_ESQUERDA, doc.y, { width: largura, continued: true });
      } else {
        doc.text(`${rotulo} `, { continued: true });
      }
      escreverTexto(doc, ultimo ? valor : `${valor}  `, FONTE.normal, { continued: !ultimo });
    });
    doc.y += 8;
  }

  doc.fontSize(10).fillColor(PRETO);
  escreverTextoComNegrito(doc, questao.enunciado || '(questão sem enunciado)', FONTE.normal, FONTE.negrito,
    MARGEM_ESQUERDA, doc.y, { width: largura, align: 'justify', lineGap: ESPACO_ENTRE_LINHAS });

  if (questao.alternativas.length) {
    doc.y += 8;
    questao.alternativas.forEach((alternativa) => {
      garantirEspaco(doc, 14);
      doc.font(FONTE.negrito).fontSize(10).fillColor(PRETO)
        .text(`${alternativa.letra}) `, MARGEM_ESQUERDA, doc.y, { continued: true });
      escreverTextoComNegrito(doc, alternativa.texto, FONTE.normal, FONTE.negrito,
        { width: largura, lineGap: ESPACO_ENTRE_LINHAS });
    });
  } else if (prova.linhasResposta > 0) {
    // Dissertativa: espaço pautado para o aluno responder.
    doc.y += 12;
    for (let i = 0; i < prova.linhasResposta; i += 1) {
      garantirEspaco(doc, 22);
      doc.moveTo(MARGEM_ESQUERDA, doc.y + 12).lineTo(MARGEM_ESQUERDA + largura, doc.y + 12)
        .lineWidth(0.5).strokeColor('#8a8d93').stroke();
      doc.y += 22;
    }
  }

  doc.y += 6;
}

/* ---------------------------------------------------------- rodapé */

// Faixa azul institucional repetida no pé de todas as páginas.
function desenharRodapes(doc) {
  const intervalo = doc.bufferedPageRange();
  for (let i = 0; i < intervalo.count; i += 1) {
    doc.switchToPage(intervalo.start + i);
    // Escrever abaixo da margem inferior faria o pdfkit criar uma página
    // nova a cada rodapé; zerar a margem durante o desenho evita isso.
    const margemOriginal = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;

    const altura = 38;
    const yFaixa = doc.page.height - MARGEM_INFERIOR + 14;
    doc.rect(FAIXA_X, yFaixa, FAIXA_LARGURA, altura).fillColor(AZUL).fill();
    doc.font(FONTE.negrito).fontSize(14).fillColor(BRANCO)
      .text('FACULDADE DE NOVA SERRANA', FAIXA_X, yFaixa + 5, {
        width: FAIXA_LARGURA, align: 'center', lineBreak: false,
      })
      .text('WWW.FANS.EDU.BR', FAIXA_X, yFaixa + 21, {
        width: FAIXA_LARGURA, align: 'center', lineBreak: false,
      });

    doc.page.margins.bottom = margemOriginal;
  }
}

/* ------------------------------------------------------------ geração */

/**
 * Monta o PDF da prova no modelo da FANS.
 *
 * @param {object} prova
 * @param {string} prova.titulo            ex.: "Avaliação de Banco de Dados"
 * @param {string} [prova.curso]
 * @param {string} [prova.periodo]
 * @param {string} [prova.data]
 * @param {string} [prova.etapa]
 * @param {string} [prova.aluno]
 * @param {string} [prova.valorProva]
 * @param {string} [prova.aprovacaoCoordenador]
 * @param {string} [prova.instrucoes]      uma orientação por linha
 * @param {number} [prova.linhasResposta]  linhas pautadas nas dissertativas
 * @param {Array<{texto: string, valor?: number}>} prova.questoes
 * @returns {Promise<Buffer>}
 */
function montarPdfProva(prova) {
  const dados = prepararProva(prova);

  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: 'A4',
        margins: {
          top: MARGEM_SUPERIOR,
          bottom: MARGEM_INFERIOR,
          left: MARGEM_ESQUERDA,
          right: MARGEM_DIREITA,
        },
        bufferPages: true, // necessário para desenhar o rodapé em todas as páginas
        info: {
          Title: dados.titulo || 'Avaliação',
          Author: dados.professor || 'ProvaFácil FANS',
          Subject: dados.curso || '',
          Creator: 'ProvaFácil FANS',
        },
      });

      const pedacos = [];
      doc.on('data', (pedaco) => pedacos.push(pedaco));
      doc.on('end', () => resolve(Buffer.concat(pedacos)));
      doc.on('error', reject);

      registrarFontes(doc);

      desenharCabecalho(doc, dados);
      desenharOrientacoes(doc, dados);
      dados.questoes.forEach((questao, indice) => desenharQuestao(doc, questao, indice + 1, dados));
      doc.moveDown(0.6);
      desenharFaixa(doc, 'TÉRMINO DA PROVA.');
      desenharRodapes(doc);

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = { montarPdfProva, separarQuestao };
