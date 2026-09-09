// emailService.js
// Conecta numa caixa do Gmail via IMAP, busca e-mails não lidos, e extrai
// o conteúdo de cada um: texto do corpo da mensagem + texto de qualquer
// anexo em PDF ou DOCX. Cada e-mail processado é marcado como lido, para
// não ser reprocessado na próxima verificação.

const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const { extrairTextoPdf, extrairTextoDocx } = require('./extratores');

const MIME_DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

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
    return { nomeArquivo: anexo.filename, tipo: anexo.contentType, ignorado: true };
  } catch (err) {
    return { nomeArquivo: anexo.filename, erro: err.message };
  }
}

// Verifica a caixa de entrada, processa todo e-mail não lido e retorna
// um array com o que foi extraído de cada um.
async function verificarNovosEmails() {
  if (!credenciaisConfiguradas()) {
    throw new Error(
      'Credenciais do Gmail não configuradas. Defina GMAIL_USER e GMAIL_APP_PASSWORD no .env.'
    );
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
      // Busca apenas mensagens ainda não lidas
      const uids = await client.search({ seen: false });

      for (const uid of uids) {
        const mensagem = await client.fetchOne(uid, { source: true });
        const parseado = await simpleParser(mensagem.source);

        const anexosRelevantes = (parseado.attachments || []).filter(
          (a) => a.contentType === 'application/pdf' || a.contentType === MIME_DOCX
        );

        const anexosExtraidos = [];
        for (const anexo of anexosRelevantes) {
          anexosExtraidos.push(await extrairAnexo(anexo));
        }

        emailsProcessados.push({
          de: parseado.from?.text || null,
          assunto: parseado.subject || null,
          data: parseado.date || null,
          textoCorpo: (parseado.text || '').trim(),
          anexos: anexosExtraidos,
        });

        // Marca como lido para não processar de novo na próxima verificação
        await client.messageFlagsAdd(uid, ['\\Seen']);
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout();
  }

  return emailsProcessados;
}

module.exports = { verificarNovosEmails, credenciaisConfiguradas };
