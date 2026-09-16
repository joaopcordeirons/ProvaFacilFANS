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
const {
  prepararProva, formatarPontos, separarQuestao, COR_INSTITUCIONAL,
} = require('./modeloProva');

// O pdfkit carrega as métricas das fontes padrão por subpath dinâmico
// ("#standard-fonts/Helvetica"). Empacotadores que analisam o código
// estaticamente — como o da Vercel — não enxergam esse require e deixam
// os arquivos de fora, o que quebra a geração com
// "Cannot find module .../standard-fonts/Helvetica.cjs" só em produção.
// Os requires abaixo são apenas uma pista para o empacotador incluir os
// arquivos; se falharem, o pdfkit ainda tenta resolver sozinho.
try {
  require('pdfkit/standard-fonts/Helvetica');
  require('pdfkit/standard-fonts/HelveticaBold');
  require('pdfkit/standard-fonts/HelveticaOblique');
} catch (err) {
  console.warn('[provaPdf] Fontes padrão do pdfkit não pré-carregadas:', err.message);
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
    const fonte = 'Helvetica-Bold';
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
    doc.font(celula.fonte).fontSize(celula.tamanho)
      .fillColor(celula.tipo === 'rotulo' ? AZUL : PRETO)
      .text(celula.texto, celula.x + MARGEM_CELULA, y + (altura - celula.alturaTexto) / 2, {
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
    doc.font('Helvetica-Bold').fontSize(20).fillColor(AZUL)
      .text('FANS', xLogo, y + alturaTitulo / 2 - 12, { width: larguraLogo, align: 'center' });
  }

  const xTexto = xLogo + larguraLogo + 14;
  const larguraTexto = TABELA_X + TABELA_LARGURA - xTexto - MARGEM_CELULA;
  doc.font('Helvetica-Bold').fontSize(22).fillColor(AZUL)
    .text('CADERNO DE PROVAS', xTexto, y + alturaTitulo / 2 - 32, {
      width: larguraTexto, underline: true,
    });
  doc.font('Helvetica').fontSize(18).fillColor(AZUL)
    .text(prova.titulo || 'Avaliação', xTexto, doc.y + 8, { width: larguraTexto });

  y += alturaTitulo;

  y = desenharLinhaCabecalho(doc, y, pt(271), [
    { tipo: 'rotulo', texto: 'CURSO:' },
    { tipo: 'valor', texto: prova.curso },
    { tipo: 'rotulo', texto: 'DATA:' },
    { tipo: 'valor', texto: prova.data },
    { tipo: 'rotulo', texto: 'ETAPA:', span: 2 },
    { tipo: 'valor', texto: prova.etapa },
  ]);

  y = desenharLinhaCabecalho(doc, y, pt(502), [
    { tipo: 'rotulo', texto: 'PERÍODO:' },
    { tipo: 'valor', texto: prova.periodo },
    { tipo: 'rotulo', texto: 'APROVAÇÃO DO COORDENADOR:' },
    { tipo: 'valor', texto: prova.aprovacaoCoordenador, span: 4 },
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
  doc.font('Helvetica-Bold').fontSize(14).fillColor(BRANCO)
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
  doc.font('Helvetica-Bold').fontSize(14).fillColor(BRANCO)
    .text('ORIENTAÇÕES GERAIS PARA ESTA AVALIAÇÃO:', TABELA_X, yInicio + (ALTURA_FAIXA - 14) / 2 + 1, {
      width: TABELA_LARGURA, align: 'center', lineBreak: false,
    });

  // Corpo: lista numerada em itálico azul, justificada.
  const yCorpo = yInicio + ALTURA_FAIXA;
  const larguraTexto = TABELA_LARGURA - MARGEM_CELULA * 2 - 18;
  doc.font('Helvetica-Oblique').fontSize(11);
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
    doc.font('Helvetica-Oblique').fontSize(11).fillColor(AZUL)
      .text(`${indice + 1}.`, TABELA_X + MARGEM_CELULA, y, { width: 16 })
      .text(item, TABELA_X + MARGEM_CELULA + 18, y, {
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
    // "Ano: 2023 Banca: FGV ..." — rótulo em negrito, valor normal, tudo
    // na mesma linha (continued encadeia os trechos).
    doc.fillColor(PRETO).font('Helvetica-Bold').fontSize(10)
      .text(`${questao.referencia[0].rotulo} `, MARGEM_ESQUERDA, doc.y, {
        width: largura, continued: true,
      });
    questao.referencia.forEach(({ rotulo, valor }, indice) => {
      if (indice > 0) doc.font('Helvetica-Bold').text(`${rotulo} `, { continued: true });
      const ultimo = indice === questao.referencia.length - 1;
      doc.font('Helvetica').text(ultimo ? valor : `${valor}  `, { continued: !ultimo });
    });
    doc.y += 8;
  }

  doc.font('Helvetica').fontSize(10).fillColor(PRETO)
    .text(questao.enunciado || '(questão sem enunciado)', MARGEM_ESQUERDA, doc.y, {
      width: largura, align: 'justify', lineGap: ESPACO_ENTRE_LINHAS,
    });

  if (questao.alternativas.length) {
    doc.y += 8;
    questao.alternativas.forEach((alternativa) => {
      garantirEspaco(doc, 14);
      doc.font('Helvetica-Bold').fontSize(10).fillColor(PRETO)
        .text(`${alternativa.letra}) `, MARGEM_ESQUERDA, doc.y, { continued: true });
      doc.font('Helvetica').fontSize(10)
        .text(alternativa.texto, { width: largura, lineGap: ESPACO_ENTRE_LINHAS });
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
    doc.font('Helvetica-Bold').fontSize(14).fillColor(BRANCO)
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
