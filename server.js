// server.js
<<<<<<< HEAD
// API para extrair texto de PDF/DOCX (upload) e de e-mails recebidos (Gmail).
// Endpoints principais: POST /api/questoes/extrair-pdf, extrair-docx,
// e POST /api/questoes/verificar-email

require('dotenv').config();
=======
// API mínima para extrair texto de arquivos PDF enviados via upload.
// Endpoint principal: POST /api/questoes/extrair-pdf
>>>>>>> 287d4f26d3144aecf0439488ff302f8010b307fd

const express = require('express');
const multer = require('multer');
const path = require('path');
<<<<<<< HEAD
const { extrairTextoPdf, extrairTextoDocx } = require('./extratores');
const { verificarNovosEmails, credenciaisConfiguradas } = require('./emailService');
=======
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
>>>>>>> 287d4f26d3144aecf0439488ff302f8010b307fd

const app = express();
const PORT = process.env.PORT || 80;

// Serve a interface web de teste (public/index.html) em http://localhost:3001
app.use(express.static(path.join(__dirname, 'public')));

const MIME_DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

// Armazena o upload em memória (não grava em disco) — bom para arquivos
// pequenos como uma questão de prova em PDF/DOCX.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    if (file.mimetype !== 'application/pdf') {
      return cb(new Error('Apenas arquivos PDF são aceitos.'));
    }
    cb(null, true);
  },
});

// Upload específico para DOCX (mesmo limite, mimetype diferente)
const uploadDocx = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    if (file.mimetype !== MIME_DOCX) {
      return cb(new Error('Apenas arquivos .docx são aceitos.'));
    }
    cb(null, true);
  },
});

app.get('/api/status', (req, res) => {
  res.json({ status: 'ok', mensagem: 'API de extração de PDF no ar.' });
});

// Recebe um PDF (campo "arquivo") e retorna o texto extraído.
// O texto retornado deve poder ser editado pelo professor antes de salvar
// a questão no banco, conforme previsto no formulário do projeto.
app.post('/api/questoes/extrair-pdf', upload.single('arquivo'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ erro: 'Nenhum arquivo enviado. Use o campo "arquivo".' });
    }

<<<<<<< HEAD
    const { texto, paginas } = await extrairTextoPdf(req.file.buffer);

    return res.json({
      nomeArquivo: req.file.originalname,
      paginas,
      texto,
=======
    const resultado = await pdfParse(req.file.buffer);

    return res.json({
      nomeArquivo: req.file.originalname,
      paginas: resultado.numpages,
      texto: resultado.text.trim(),
>>>>>>> 287d4f26d3144aecf0439488ff302f8010b307fd
    });
  } catch (err) {
    console.error('Erro ao extrair PDF:', err.message);
    return res.status(500).json({ erro: 'Falha ao processar o PDF.', detalhe: err.message });
  }
});

// Recebe um DOCX (campo "arquivo") e retorna o texto extraído.
// Mesma lógica do endpoint de PDF: o texto volta editável para o professor
// revisar antes de a questão ser salva no banco.
app.post('/api/questoes/extrair-docx', uploadDocx.single('arquivo'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ erro: 'Nenhum arquivo enviado. Use o campo "arquivo".' });
    }

<<<<<<< HEAD
    const { texto, avisos } = await extrairTextoDocx(req.file.buffer);

    return res.json({
      nomeArquivo: req.file.originalname,
      texto,
      avisos,
=======
    const resultado = await mammoth.extractRawText({ buffer: req.file.buffer });

    return res.json({
      nomeArquivo: req.file.originalname,
      texto: resultado.value.trim(),
      avisos: resultado.messages.map((m) => m.message),
>>>>>>> 287d4f26d3144aecf0439488ff302f8010b307fd
    });
  } catch (err) {
    console.error('Erro ao extrair DOCX:', err.message);
    return res.status(500).json({ erro: 'Falha ao processar o DOCX.', detalhe: err.message });
  }
});

<<<<<<< HEAD
// Conecta na caixa do Gmail, processa e-mails não lidos e retorna o que
// foi extraído de cada um (corpo do texto + anexos PDF/DOCX). Cada e-mail
// processado é marcado como lido, então chamar de novo só traz o que
// chegou depois da última verificação.
app.post('/api/questoes/verificar-email', async (req, res) => {
  if (!credenciaisConfiguradas()) {
    return res.status(500).json({
      erro: 'GMAIL_USER e GMAIL_APP_PASSWORD não configurados no .env do servidor.',
    });
  }

  try {
    const emails = await verificarNovosEmails();
    return res.json({ quantidade: emails.length, emails });
  } catch (err) {
    console.error('Erro ao verificar e-mails:', err.message);
    return res.status(500).json({ erro: 'Falha ao verificar e-mails.', detalhe: err.message });
  }
});

=======
>>>>>>> 287d4f26d3144aecf0439488ff302f8010b307fd
// Tratamento de erro do multer (ex.: arquivo não é PDF, tamanho excedido)
app.use((err, req, res, next) => {
  if (err) {
    return res.status(400).json({ erro: err.message });
  }
  next();
});

app.listen(PORT, () => {
  console.log(`API de extração de PDF rodando em http://localhost:${PORT}`);
});
