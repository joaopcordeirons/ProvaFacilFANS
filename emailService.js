// emailService.js
// Conecta numa caixa do Gmail via IMAP e busca, no histórico completo,
// e-mails vindos do endereço cadastrado do professor logado, extraindo
// o conteúdo de cada um: texto do corpo da mensagem + texto de qualquer
// anexo em PDF, DOCX ou imagem. Nada é marcado como lido — a deduplicação
// de "já processado" é feita à parte, por messageId (ver firebase.js).

const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const nodemailer = require('nodemailer');
const { extrairTextoPdf, extrairTextoDocx, extrairTextoImagem } = require('./extratores');

const MIME_DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const MIMES_IMAGEM = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/bmp', 'image/tiff'];

function credenciaisConfiguradas() {
  return Boolean(process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD);
}

async function extrairAnexo(anexo) {
  try {
    if (anexo.contentType === 'application/pdf') {
      const { texto, paginas } = await extrairTextoPdf(anexo.content);
      return { nomeArquivo: anexo.filename, tipo: 'pdf', paginas, texto };
    }
    if (anexo.contentType === MIME_DOCX) {
      const { texto, avisos } = await extrairTextoDocx(anexo.content);
      return { nomeArquivo: anexo.filename, tipo: 'docx', avisos, texto };
    }
    if (MIMES_IMAGEM.includes(anexo.contentType)) {
      const { texto, confianca } = await extrairTextoImagem(anexo.content);
      return { nomeArquivo: anexo.filename, tipo: 'imagem', confianca, texto };
    }
    return { nomeArquivo: anexo.filename, tipo: anexo.contentType, ignorado: true };
  } catch (err) {
    return { nomeArquivo: anexo.filename, erro: err.message };
  }
}

// Busca, no histórico completo da caixa (não só não lidos), todo e-mail
// vindo de um remetente específico — o e-mail cadastrado do professor
// logado. Isso resolve dois problemas do fluxo antigo (que buscava só
// não lidos, de qualquer remetente, marcando como lido na hora):
//   1. atribuição errada — antes, quem salvava a questão era sempre quem
//      estivesse logado no momento de clicar "Verificar agora", não quem
//      de fato mandou o e-mail;
//   2. e-mails "perdidos" — como eram marcados como lidos ao processar,
//      um e-mail que o professor não salvou na hora sumia da lista sem
//      chance de tentar de nova depois.
// Nada aqui é marcado como lido — é só leitura. Quem decide o que já foi
// aproveitado é o dedup por messageId feito no server.js/firebase.js.
async function buscarEmailsPorRemetente(emailRemetente, limite = 30) {
  if (!credenciaisConfiguradas()) {
    throw new Error(
      'Credenciais do Gmail não configuradas. Defina GMAIL_USER e GMAIL_APP_PASSWORD no .env.'
    );
  }
  if (!emailRemetente) {
    throw new Error('E-mail do professor não encontrado no cadastro.');
  }

  const client = new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: {
      user: process.env.GMAIL_USER,
      pass: process.env.GMAIL_APP_PASSWORD,
    },
    logger: false,
  });

  const emailsProcessados = [];

  await client.connect();
  try {
    const lock = await client.getMailboxLock('INBOX');
    try {
      const uids = await client.search({ from: emailRemetente }, { uid: true });
      // Mais recentes primeiro, limitado pra não reprocessar a caixa toda
      // a cada clique.
      const uidsRecentes = uids.slice(-limite).reverse();

      for (const uid of uidsRecentes) {
        const mensagem = await client.fetchOne(uid, { source: true }, { uid: true });
        const parseado = await simpleParser(mensagem.source);

        const anexosRelevantes = (parseado.attachments || []).filter(
          (a) => a.contentType === 'application/pdf' || a.contentType === MIME_DOCX || MIMES_IMAGEM.includes(a.contentType)
        );

        const anexosExtraidos = [];
        for (const anexo of anexosRelevantes) {
          anexosExtraidos.push(await extrairAnexo(anexo));
        }

        emailsProcessados.push({
          messageId: parseado.messageId || `uid-${uid}`,
          uid,
          de: parseado.from?.text || null,
          assunto: parseado.subject || null,
          data: parseado.date || null,
          textoCorpo: (parseado.text || '').trim(),
          anexos: anexosExtraidos,
        });
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout();
  }

  return emailsProcessados;
}

// Remove de verdade um e-mail da caixa (usado pelo botão "Remover da
// tela"): move a mensagem para a Lixeira do Gmail, em vez de só tirá-la
// da INBOX (o que no Gmail apenas arquiva a mensagem em vez de excluí-la).
// Assim ela some da tela e não volta a aparecer numa próxima busca.
// Antes de mover, confirma que o e-mail é mesmo do remetente informado —
// evita que um professor exclua, por engano ou não, um e-mail de outro
// professor na mesma caixa compartilhada.
// Descobre o nome real da pasta de Lixeira via IMAP (flag especial
// \Trash), em vez de supor um nome fixo. O Gmail nomeia essa pasta de
// forma diferente por idioma da conta — "[Gmail]/Trash" (inglês),
// "[Gmail]/Lixeira" (português), "[Google Mail]/Trash" (contas antigas
// @googlemail.com) etc. Usar sempre "[Gmail]/Trash" fazia o messageMove
// falhar silenciosamente em qualquer conta que não estivesse em inglês —
// era por isso que "Remover da tela" não excluía de fato o e-mail.
let cacheNomeLixeira = null;
async function obterNomeLixeira(client) {
  if (cacheNomeLixeira) return cacheNomeLixeira;
  const caixas = await client.list();
  const lixeira = caixas.find((caixa) => (caixa.specialUse === '\\Trash'));
  if (lixeira) {
    cacheNomeLixeira = lixeira.path;
    return cacheNomeLixeira;
  }
  // Fallback só pro caso (raro) de o servidor não anunciar specialUse:
  // tenta os nomes mais comuns até um existir.
  const candidatos = ['[Gmail]/Trash', '[Gmail]/Lixeira', '[Google Mail]/Trash', '[Google Mail]/Bin'];
  const existente = caixas.map((caixa) => caixa.path);
  const encontrado = candidatos.find((nome) => existente.includes(nome));
  if (!encontrado) {
    throw new Error('Não foi possível localizar a pasta de Lixeira desta conta do Gmail.');
  }
  cacheNomeLixeira = encontrado;
  return cacheNomeLixeira;
}

async function excluirEmailPorUid(uid, emailRemetente) {
  if (!credenciaisConfiguradas()) {
    throw new Error(
      'Credenciais do Gmail não configuradas. Defina GMAIL_USER e GMAIL_APP_PASSWORD no .env.'
    );
  }
  if (!uid) {
    throw new Error('UID do e-mail não informado.');
  }
  if (!emailRemetente) {
    throw new Error('E-mail do professor não encontrado no cadastro.');
  }

  const client = new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: {
      user: process.env.GMAIL_USER,
      pass: process.env.GMAIL_APP_PASSWORD,
    },
    logger: false,
  });

  await client.connect();
  try {
    const nomeLixeira = await obterNomeLixeira(client);
    const lock = await client.getMailboxLock('INBOX');
    try {
      const mensagem = await client.fetchOne(uid, { envelope: true }, { uid: true });
      const remetenteDaMensagem = (mensagem?.envelope?.from || [])
        .map((endereco) => (endereco.address || '').toLowerCase());
      if (!mensagem || !remetenteDaMensagem.includes(emailRemetente.toLowerCase())) {
        throw new Error('Esse e-mail não pertence ao seu cadastro.');
      }
      await client.messageMove(uid, nomeLixeira, { uid: true });
    } finally {
      lock.release();
    }
  } finally {
    await client.logout();
  }
}

/* ------------------------------------------------- envio: recuperação de senha */

let transportador = null;

// Mesma conta usada para receber questões por e-mail (GMAIL_USER /
// GMAIL_APP_PASSWORD) serve também para enviar o link de recuperação de
// senha — evita configurar um segundo serviço de e-mail só para isso.
function obterTransportador() {
  if (transportador) return transportador;
  if (!credenciaisConfiguradas()) return null;
  transportador = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
  });
  return transportador;
}

// Envia o link de redefinição de senha. Se o Gmail não estiver
// configurado no ambiente (ex.: desenvolvimento local sem .env
// completo), não derruba o fluxo — só registra o link no console para o
// desenvolvedor testar manualmente, e avisa quem chamou que não foi
// enviado de verdade.
async function enviarEmailRecuperacao(destino, nome, link) {
  const cliente = obterTransportador();
  if (!cliente) {
    console.warn(
      `[emailService] GMAIL_USER/GMAIL_APP_PASSWORD não configurados — link de recuperação para ${destino}: ${link}`
    );
    return { enviado: false };
  }

  await cliente.sendMail({
    from: `"ProvaFácil FANS" <${process.env.GMAIL_USER}>`,
    to: destino,
    subject: 'Redefinição de senha — ProvaFácil FANS',
    text: `Olá, ${nome || ''}.\n\nRecebemos um pedido para redefinir a senha da sua conta no ProvaFácil FANS.\n\nPara escolher uma nova senha, acesse o link abaixo (válido por 1 hora):\n${link}\n\nSe você não pediu essa redefinição, pode ignorar este e-mail — sua senha continua a mesma.`,
    html: `<p>Olá, ${nome || ''}.</p><p>Recebemos um pedido para redefinir a senha da sua conta no <strong>ProvaFácil FANS</strong>.</p><p>Para escolher uma nova senha, acesse o link abaixo (válido por 1 hora):</p><p><a href="${link}">${link}</a></p><p>Se você não pediu essa redefinição, pode ignorar este e-mail — sua senha continua a mesma.</p>`,
  });
  return { enviado: true };
}

// Envia o link de verificação de e-mail, usado logo após o cadastro (a
// conta fica com emailVerificado:false e login bloqueado até o professor
// clicar no link). Mesma lógica de fallback da recuperação de senha: sem
// Gmail configurado, só registra o link no console.
async function enviarEmailVerificacao(destino, nome, link) {
  const cliente = obterTransportador();
  if (!cliente) {
    console.warn(
      `[emailService] GMAIL_USER/GMAIL_APP_PASSWORD não configurados — link de verificação para ${destino}: ${link}`
    );
    return { enviado: false };
  }

  await cliente.sendMail({
    from: `"ProvaFácil FANS" <${process.env.GMAIL_USER}>`,
    to: destino,
    subject: 'Confirme seu e-mail — ProvaFácil FANS',
    text: `Olá, ${nome || ''}.\n\nPara concluir seu cadastro no ProvaFácil FANS e liberar o acesso, confirme seu e-mail no link abaixo (válido por 24 horas):\n${link}\n\nSe você não fez esse cadastro, pode ignorar este e-mail.`,
    html: `<p>Olá, ${nome || ''}.</p><p>Para concluir seu cadastro no <strong>ProvaFácil FANS</strong> e liberar o acesso, confirme seu e-mail no link abaixo (válido por 24 horas):</p><p><a href="${link}">${link}</a></p><p>Se você não fez esse cadastro, pode ignorar este e-mail.</p>`,
  });
  return { enviado: true };
}

/* ------------------------------------------------ notificações de provas */

function escaparHtmlEmail(texto) {
  return String(texto || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

const ROTULOS_STATUS_PROVA = {
  aprovada: 'aprovada',
  reprovada: 'reprovada',
  em_revisao: 'colocada em análise',
};

// Avisa a Direção (uma ou mais pessoas) quando um professor envia uma
// prova para revisão. Quem chama já filtrou os destinatários pelo
// próprio campo notificacoesEmail de cada um — aqui só dispara.
async function notificarProvaEnviada({ destinatarios, professorNome, prova, linkPainel }) {
  const cliente = obterTransportador();
  if (!cliente || !destinatarios || !destinatarios.length) return { enviado: false };

  const tituloSeguro = escaparHtmlEmail(prova.titulo);
  const cursoSeguro = escaparHtmlEmail(prova.curso || '');
  const nomeSeguro = escaparHtmlEmail(professorNome);

  await cliente.sendMail({
    from: `"ProvaFácil FANS" <${process.env.GMAIL_USER}>`,
    to: destinatarios.join(', '),
    subject: `Nova prova para revisar: ${prova.titulo}`,
    text: `${professorNome} enviou a prova "${prova.titulo}" (${prova.curso || ''}) para sua revisão.\n\nAcesse o painel para aprovar, reprovar ou comentar:\n${linkPainel}`,
    html: `<p><strong>${nomeSeguro}</strong> enviou a prova <strong>${tituloSeguro}</strong>${cursoSeguro ? ` (${cursoSeguro})` : ''} para sua revisão.</p><p><a href="${linkPainel}">Acessar o painel</a></p>`,
  });
  return { enviado: true };
}

// Avisa o professor (autor da prova) quando a Direção muda o status:
// aprova, reprova ou devolve para análise.
async function notificarRevisaoProva({ destino, nomeProfessor, prova, linkPainel }) {
  const cliente = obterTransportador();
  if (!cliente || !destino) return { enviado: false };

  const rotulo = ROTULOS_STATUS_PROVA[prova.status] || prova.status;
  const comentario = String(prova.comentarioCoordenador || '').trim();
  const tituloSeguro = escaparHtmlEmail(prova.titulo);
  const comentarioSeguro = escaparHtmlEmail(comentario);

  await cliente.sendMail({
    from: `"ProvaFácil FANS" <${process.env.GMAIL_USER}>`,
    to: destino,
    subject: `Sua prova "${prova.titulo}" foi ${rotulo}`,
    text: `Olá, ${nomeProfessor}.\n\nSua prova "${prova.titulo}" (${prova.curso || ''}) foi ${rotulo} pela Direção.${comentario ? `\n\nComentário da Direção: ${comentario}` : ''}\n\nAcesse o painel para ver os detalhes:\n${linkPainel}`,
    html: `<p>Olá, ${escaparHtmlEmail(nomeProfessor)}.</p><p>Sua prova <strong>${tituloSeguro}</strong> foi <strong>${escaparHtmlEmail(rotulo)}</strong> pela Direção.</p>${comentario ? `<p>Comentário da Direção: ${comentarioSeguro}</p>` : ''}<p><a href="${linkPainel}">Acessar o painel</a></p>`,
  });
  return { enviado: true };
}

// Envia o arquivo de uma prova (PDF ou DOCX) por e-mail para quem quem
// está usando o sistema escolher — de qualquer status (rascunho,
// aprovada etc). Diferente das notificações acima, é uma ação explícita
// de quem clica em "Enviar por e-mail", então não passa pelo filtro de
// notificacoesEmail (esse é só para os avisos automáticos).
async function enviarProvaPorEmail({ destinatarios, remetenteNome, mensagem, prova, arquivo, nomeArquivo, mime }) {
  const cliente = obterTransportador();
  if (!cliente) {
    throw new Error('GMAIL_USER e GMAIL_APP_PASSWORD não configurados no .env do servidor.');
  }

  const mensagemLimpa = String(mensagem || '').trim().slice(0, 2000);
  const tituloSeguro = escaparHtmlEmail(prova.titulo);
  const remetenteSeguro = escaparHtmlEmail(remetenteNome);
  const mensagemSeguraHtml = escaparHtmlEmail(mensagemLimpa).replace(/\n/g, '<br>');

  await cliente.sendMail({
    from: `"ProvaFácil FANS" <${process.env.GMAIL_USER}>`,
    to: destinatarios.join(', '),
    subject: `Prova: ${prova.titulo}`,
    text: `${remetenteNome} compartilhou a prova "${prova.titulo}" com você.${mensagemLimpa ? `\n\n${mensagemLimpa}` : ''}\n\nO arquivo está em anexo.`,
    html: `<p><strong>${remetenteSeguro}</strong> compartilhou a prova <strong>${tituloSeguro}</strong> com você.</p>${mensagemLimpa ? `<p>${mensagemSeguraHtml}</p>` : ''}<p>O arquivo está em anexo.</p>`,
    attachments: [{ filename: nomeArquivo, content: arquivo, contentType: mime }],
  });
  return { enviado: true };
}

module.exports = {
  buscarEmailsPorRemetente,
  excluirEmailPorUid,
  credenciaisConfiguradas,
  enviarEmailRecuperacao,
  enviarEmailVerificacao,
  notificarProvaEnviada,
  notificarRevisaoProva,
  enviarProvaPorEmail,
};
