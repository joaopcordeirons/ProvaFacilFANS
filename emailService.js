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
      const uids = await client.search({ from: emailRemetente });
      // Mais recentes primeiro, limitado pra não reprocessar a caixa toda
      // a cada clique.
      const uidsRecentes = uids.slice(-limite).reverse();

      for (const uid of uidsRecentes) {
        const mensagem = await client.fetchOne(uid, { source: true });
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

module.exports = { buscarEmailsPorRemetente, credenciaisConfiguradas, enviarEmailRecuperacao, enviarEmailVerificacao };
