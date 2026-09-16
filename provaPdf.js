// provaPdf.js
// Monta o PDF final da prova a partir das questões selecionadas pelo
// professor na tela "Montar a prova".
//
// O módulo é puro: recebe os dados já resolvidos (nenhuma consulta a
// banco acontece aqui) e devolve um Buffer com o PDF pronto. Quem busca
// as questões no Firestore é o server.js — assim dá para testar a
// montagem do documento sem credenciais de Firebase.

const PDFDocument = require('pdfkit');

const MARGEM = 56;            // ~2 cm
const COR_TINTA = '#1b1d22';
const COR_SUAVE = '#63666e';
const COR_LINHA = '#c9ccd1';

// Linhas como "A) alguma coisa", "b. outra", "C - terceira" são tratadas
// como alternativas de múltipla escolha e recebem recuo no PDF.
const REGEX_ALTERNATIVA = /^\s*([A-Ea-e])\s*[\)\.\-]\s+(.*)$/;

function formatarPontos(valor) {
  const numero = Number(valor);
  if (!Number.isFinite(numero)) return null;
  return numero.toFixed(1).replace('.', ',');
}

// Separa o texto salvo da questão em enunciado (pode ter várias linhas)
// e alternativas, no mesmo critério usado na interface.
function separarQuestao(texto) {
  const linhas = String(texto || '').split('\n');
  const enunciado = [];
  const alternativas = [];

  linhas.forEach((linha) => {
    const casamento = linha.match(REGEX_ALTERNATIVA);
    if (casamento) {
      alternativas.push({ letra: casamento[1].toUpperCase(), texto: casamento[2].trim() });
    } else if (linha.trim()) {
      enunciado.push(linha.trim());
    }
  });

  return { enunciado: enunciado.join('\n'), alternativas };
}

function larguraUtil(doc) {
  return doc.page.width - doc.page.margins.left - doc.page.margins.right;
}

// Desenha um rótulo pequeno em versalete + o valor ao lado, no estilo
// dos campos de cabeçalho de prova impressa.
function campoCabecalho(doc, rotulo, valor, x, y, largura) {
  doc.font('Helvetica').fontSize(7.5).fillColor(COR_SUAVE)
    .text(rotulo.toUpperCase(), x, y, { width: largura, characterSpacing: 0.6 });
  doc.font('Helvetica-Bold').fontSize(10).fillColor(COR_TINTA)
    .text(valor || '—', x, y + 11, { width: largura });
  // Devolve a altura ocupada para o chamador saber onde continuar — o
  // valor pode quebrar em duas linhas ("Engenharia de Software").
  return doc.y - y;
}

function desenharCabecalho(doc, prova) {
  const largura = larguraUtil(doc);
  const esquerda = doc.page.margins.left;

  doc.font('Helvetica-Bold').fontSize(9).fillColor(COR_SUAVE)
    .text(String(prova.instituicao || 'FANS').toUpperCase(), esquerda, doc.y, {
      width: largura, characterSpacing: 1.2,
    });

  doc.moveDown(0.35);
  doc.font('Helvetica-Bold').fontSize(17).fillColor(COR_TINTA)
    .text(prova.titulo || 'Avaliação', { width: largura });

  doc.moveDown(0.7);
  const yCampos = doc.y;
  const colunas = [
    ['Disciplina', prova.disciplina],
    ['Professor(a)', prova.professor],
    ['Turma', prova.turma],
    ['Data', prova.data],
  ];
  const larguraColuna = largura / colunas.length;
  let alturaCampos = 26;
  colunas.forEach(([rotulo, valor], indice) => {
    const altura = campoCabecalho(doc, rotulo, valor, esquerda + indice * larguraColuna, yCampos, larguraColuna - 8);
    alturaCampos = Math.max(alturaCampos, altura);
  });

  doc.y = yCampos + alturaCampos + 6;
  doc.moveTo(esquerda, doc.y).lineTo(esquerda + largura, doc.y)
    .lineWidth(0.8).strokeColor(COR_LINHA).stroke();

  // Linha do aluno: nome em uma linha contínua + espaço para a nota.
  doc.y += 16;
  const yAluno = doc.y;
  doc.font('Helvetica').fontSize(9.5).fillColor(COR_SUAVE).text('Aluno(a):', esquerda, yAluno);
  const inicioLinhaAluno = esquerda + 52;
  const fimLinhaAluno = esquerda + largura - 120;
  doc.moveTo(inicioLinhaAluno, yAluno + 10).lineTo(fimLinhaAluno, yAluno + 10)
    .lineWidth(0.6).strokeColor(COR_LINHA).stroke();

  doc.font('Helvetica').fontSize(9.5).fillColor(COR_SUAVE).text('Nota:', fimLinhaAluno + 16, yAluno);
  doc.moveTo(fimLinhaAluno + 48, yAluno + 10).lineTo(esquerda + largura, yAluno + 10)
    .lineWidth(0.6).strokeColor(COR_LINHA).stroke();

  doc.y = yAluno + 24;

  const pontuacao = formatarPontos(prova.pontuacaoTotal);
  const resumo = [
    `${prova.questoes.length} questão(ões)`,
    pontuacao ? `${pontuacao} pontos no total` : null,
  ].filter(Boolean).join(' · ');

  doc.font('Helvetica').fontSize(8.5).fillColor(COR_SUAVE).text(resumo, esquerda, doc.y, { width: largura });
  doc.y += 6;

  if (prova.instrucoes && String(prova.instrucoes).trim()) {
    doc.moveDown(0.6);
    const yCaixa = doc.y;
    const alturaTexto = doc.font('Helvetica').fontSize(9)
      .heightOfString(prova.instrucoes.trim(), { width: largura - 24, lineGap: 1.5 });
    doc.roundedRect(esquerda, yCaixa, largura, alturaTexto + 20, 4)
      .lineWidth(0.8).strokeColor(COR_LINHA).stroke();
    doc.fillColor(COR_TINTA)
      .text(prova.instrucoes.trim(), esquerda + 12, yCaixa + 10, { width: largura - 24, lineGap: 1.5 });
    doc.y = yCaixa + alturaTexto + 20;
  }

  doc.moveDown(1.1);
}

// Altura aproximada que a questão vai ocupar, usada para decidir se ela
// cabe no resto da página ou se precisa começar na próxima (evita quebrar
// o enunciado logo depois do título "Questão N").
function alturaEstimada(doc, questao, opcoes) {
  const largura = larguraUtil(doc);
  let altura = 20; // título "Questão N (x pts)"

  altura += doc.font('Helvetica').fontSize(10.5)
    .heightOfString(questao.enunciado || '(questão sem enunciado)', { width: largura, lineGap: 2 });

  questao.alternativas.forEach((alternativa) => {
    altura += doc.font('Helvetica').fontSize(10.5)
      .heightOfString(`${alternativa.letra}) ${alternativa.texto}`, { width: largura - 18, lineGap: 2 }) + 3;
  });

  if (!questao.alternativas.length && opcoes.linhasResposta > 0) {
    altura += 10 + opcoes.linhasResposta * 22;
  }

  return altura + 18;
}

function desenharQuestao(doc, questao, numero, opcoes) {
  const largura = larguraUtil(doc);
  const esquerda = doc.page.margins.left;

  const espacoRestante = doc.page.height - doc.page.margins.bottom - doc.y;
  if (espacoRestante < Math.min(alturaEstimada(doc, questao, opcoes), 150)) {
    doc.addPage();
  }

  const pontos = formatarPontos(questao.valor);
  doc.font('Helvetica-Bold').fontSize(10.5).fillColor(COR_TINTA)
    .text(`Questão ${numero}`, esquerda, doc.y, { continued: Boolean(pontos) });
  if (pontos) {
    doc.font('Helvetica').fontSize(9).fillColor(COR_SUAVE).text(`   (${pontos} pontos)`);
  }

  doc.moveDown(0.35);
  doc.font('Helvetica').fontSize(10.5).fillColor(COR_TINTA)
    .text(questao.enunciado || '(questão sem enunciado)', esquerda, doc.y, { width: largura, lineGap: 2 });

  if (questao.alternativas.length) {
    doc.moveDown(0.4);
    questao.alternativas.forEach((alternativa) => {
      doc.font('Helvetica').fontSize(10.5).fillColor(COR_TINTA)
        .text(`${alternativa.letra}) ${alternativa.texto}`, esquerda + 18, doc.y, {
          width: largura - 18, lineGap: 2,
        });
      doc.y += 3;
    });
  } else if (opcoes.linhasResposta > 0) {
    // Questão dissertativa: espaço pautado para o aluno responder.
    doc.y += 10;
    for (let i = 0; i < opcoes.linhasResposta; i += 1) {
      if (doc.y + 22 > doc.page.height - doc.page.margins.bottom) {
        doc.addPage();
      }
      doc.moveTo(esquerda, doc.y + 12).lineTo(esquerda + largura, doc.y + 12)
        .lineWidth(0.5).strokeColor(COR_LINHA).stroke();
      doc.y += 22;
    }
  }

  doc.moveDown(1);
}

function desenharRodapes(doc, prova) {
  const intervalo = doc.bufferedPageRange();
  for (let i = 0; i < intervalo.count; i += 1) {
    doc.switchToPage(intervalo.start + i);
    const y = doc.page.height - doc.page.margins.bottom + 16;
    // Escrever abaixo da margem inferior faria o pdfkit criar uma página
    // nova a cada rodapé; zerar a margem durante o desenho evita isso.
    const margemInferior = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    const largura = larguraUtil(doc);
    doc.font('Helvetica').fontSize(8).fillColor(COR_SUAVE)
      .text(prova.titulo || 'Avaliação', doc.page.margins.left, y, {
        width: largura / 2, lineBreak: false,
      })
      .text(`Página ${i + 1} de ${intervalo.count}`, doc.page.margins.left + largura / 2, y, {
        width: largura / 2, align: 'right', lineBreak: false,
      });
    doc.page.margins.bottom = margemInferior;
  }
}

/**
 * Monta o PDF da prova.
 *
 * @param {object} prova
 * @param {string} prova.titulo
 * @param {string} [prova.instituicao]
 * @param {string} [prova.disciplina]
 * @param {string} [prova.professor]
 * @param {string} [prova.turma]
 * @param {string} [prova.data]
 * @param {string} [prova.instrucoes]
 * @param {number} [prova.linhasResposta]  linhas pautadas nas dissertativas
 * @param {Array<{texto: string, valor?: number}>} prova.questoes
 * @returns {Promise<Buffer>}
 */
function montarPdfProva(prova) {
  if (!prova || !Array.isArray(prova.questoes) || prova.questoes.length === 0) {
    const erro = new Error('Selecione pelo menos uma questão para montar a prova.');
    erro.statusCode = 400;
    throw erro;
  }

  const questoes = prova.questoes.map((questao) => ({
    ...separarQuestao(questao.texto),
    valor: questao.valor,
  }));

  const pontuacaoTotal = prova.questoes.reduce(
    (soma, questao) => soma + (Number.isFinite(Number(questao.valor)) ? Number(questao.valor) : 0),
    0,
  );

  const opcoes = {
    linhasResposta: Number.isFinite(Number(prova.linhasResposta))
      ? Math.max(0, Math.min(Number(prova.linhasResposta), 20))
      : 5,
  };

  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: 'A4',
        margins: { top: MARGEM, bottom: MARGEM, left: MARGEM, right: MARGEM },
        bufferPages: true, // necessário para numerar as páginas no fim
        info: {
          Title: prova.titulo || 'Avaliação',
          Author: prova.professor || 'ProvaFácil FANS',
          Subject: prova.disciplina || '',
          Creator: 'ProvaFácil FANS',
        },
      });

      const pedacos = [];
      doc.on('data', (pedaco) => pedacos.push(pedaco));
      doc.on('end', () => resolve(Buffer.concat(pedacos)));
      doc.on('error', reject);

      desenharCabecalho(doc, { ...prova, questoes, pontuacaoTotal });
      questoes.forEach((questao, indice) => desenharQuestao(doc, questao, indice + 1, opcoes));
      desenharRodapes(doc, prova);

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = { montarPdfProva, separarQuestao };
