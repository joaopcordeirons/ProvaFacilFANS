// server.js
// API para extrair texto de PDF/DOCX/imagens (upload) e de e-mails recebidos (Gmail).
// Endpoints principais: POST /api/questoes/extrair-pdf, extrair-docx,
// e POST /api/questoes/verificar-email

require('dotenv').config();

const express = require('express');
const multer = require('multer');
const path = require('path');
const { extrairTextoPdf, extrairTextoDocx, extrairTextoImagem } = require('./extratores');
const { verificarNovosEmails, credenciaisConfiguradas } = require('./emailService');
const { criarQuestao, listarQuestoes, excluirQuestao } = require('./firebase');

const app = express();
const PORT = process.env.PORT || 80;

// Serve a interface web de teste (public/index.html) em http://localhost:3001
app.use(express.static(path.join(__dirname, 'public')));

const MIME_DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const MIMES_IMAGEM = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/bmp', 'image/tiff'];

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

const uploadImagem = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!MIMES_IMAGEM.includes(file.mimetype)) {
      return cb(new Error('Apenas imagens JPG, PNG, WEBP, GIF, BMP ou TIFF são aceitas.'));
    }
    cb(null, true);
  },
});

app.get('/api/status', (req, res) => {
  res.json({ status: 'ok', mensagem: 'API de extração de PDF no ar.' });
});

// Salva o texto revisado pelo professor no Cloud Firestore.
app.post('/api/questoes', express.json(), async (req, res) => {
  try {
    const { texto, conteudoHtml, tipoOrigem, nomeArquivo, paginas, confianca, avisos } = req.body || {};
    if (typeof texto !== 'string' || !texto.trim()) {
      return res.status(400).json({ erro: 'O campo "texto" é obrigatório.' });
    }

    const questao = await criarQuestao({
      texto: texto.trim(), conteudoHtml, tipoOrigem, nomeArquivo, paginas, confianca, avisos,
    });
    return res.status(201).json(questao);
  } catch (err) {
    console.error('Erro ao salvar questão:', err.message);
    return res.status(err.statusCode || 500).json({ erro: err.message });
  }
});

// Lista as questões mais recentes salvas no Cloud Firestore.
app.get('/api/questoes', async (req, res) => {
  try {
    const limiteInformado = Number.parseInt(req.query.limite, 10);
    const limite = Number.isFinite(limiteInformado)
      ? Math.min(Math.max(limiteInformado, 1), 100)
      : 50;
    return res.json({ questoes: await listarQuestoes(limite) });
  } catch (err) {
    console.error('Erro ao listar questões:', err.message);
    return res.status(err.statusCode || 500).json({ erro: err.message });
  }
});

app.delete('/api/questoes/:id', async (req, res) => {
  try {
    return res.json(await excluirQuestao(req.params.id));
  } catch (err) {
    console.error('Erro ao excluir questão:', err.message);
    return res.status(err.statusCode || 500).json({ erro: err.message });
  }
});

// Recebe um PDF (campo "arquivo") e retorna o texto extraído.
// O texto retornado deve poder ser editado pelo professor antes de salvar
// a questão no banco, conforme previsto no formulário do projeto.
app.post('/api/questoes/extrair-pdf', upload.single('arquivo'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ erro: 'Nenhum arquivo enviado. Use o campo "arquivo".' });
    }

    const { texto, paginas } = await extrairTextoPdf(req.file.buffer);

    return res.json({
      nomeArquivo: req.file.originalname,
      paginas,
      texto,
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

    const { texto, avisos } = await extrairTextoDocx(req.file.buffer);

    return res.json({
      nomeArquivo: req.file.originalname,
      texto,
      avisos,
    });
  } catch (err) {
    console.error('Erro ao extrair DOCX:', err.message);
    return res.status(500).json({ erro: 'Falha ao processar o DOCX.', detalhe: err.message });
  }
});

// Recebe uma imagem e usa OCR para retornar o texto detectado.
app.post('/api/questoes/extrair-imagem', uploadImagem.single('arquivo'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ erro: 'Nenhuma imagem enviada. Use o campo "arquivo".' });
    }
    const { texto, confianca } = await extrairTextoImagem(req.file.buffer);
    return res.json({ nomeArquivo: req.file.originalname, texto, confianca });
  } catch (err) {
    console.error('Erro ao reconhecer texto da imagem:', err.message);
    return res.status(500).json({ erro: 'Falha ao ler o texto da imagem.', detalhe: err.message });
  }
});

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

// Tratamento de erro do multer (ex.: arquivo não é PDF, tamanho excedido)
app.use((err, req, res, next) => {
  if (err) {
    return res.status(400).json({ erro: err.message });
  }
  next();
});

// Na Vercel (serverless) não existe processo contínuo escutando porta —
// a própria plataforma invoca `app` como handler a cada requisição.
// Fora dela (VPS, sua máquina), sobe o servidor normalmente.
if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`API de extração de PDF rodando em http://localhost:${PORT}`);
  });
}

module.exports = app;
