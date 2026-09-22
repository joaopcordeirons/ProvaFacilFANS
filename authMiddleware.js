// authMiddleware.js
// Sessão via JWT guardado num cookie httpOnly (não acessível por
// JavaScript no navegador — mitiga roubo de sessão por XSS). O token só
// carrega o ID e o perfil do usuário, nunca a senha ou o hash dela.

const jwt = require('jsonwebtoken');

const NOME_COOKIE = 'provafacil_sessao';
const DURACAO_CURTA = '12h';   // sessão normal (fecha o navegador, expira)
const DURACAO_LONGA = '30d';   // "manter conectado" marcado

function segredo() {
  const valor = process.env.JWT_SECRET;
  if (!valor || valor.length < 16) {
    throw Object.assign(
      new Error('JWT_SECRET não configurado no ambiente (defina uma string aleatória de pelo menos 16 caracteres).'),
      { statusCode: 503 },
    );
  }
  return valor;
}

function gerarToken(usuario, lembrarConectado) {
  return jwt.sign(
    { sub: usuario.id, perfil: usuario.perfil },
    segredo(),
    { expiresIn: lembrarConectado ? DURACAO_LONGA : DURACAO_CURTA },
  );
}

// Em produção (Vercel/HTTPS) o cookie só trafega em conexão segura; em
// desenvolvimento local (http://localhost) isso bloquearia o cookie, daí
// a checagem por req.secure/VERCEL.
function cookieEhSeguro(req) {
  return Boolean(req.secure || req.headers['x-forwarded-proto'] === 'https' || process.env.VERCEL);
}

function definirCookieSessao(req, res, token, lembrarConectado) {
  res.cookie(NOME_COOKIE, token, {
    httpOnly: true,
    secure: cookieEhSeguro(req),
    sameSite: 'lax',
    maxAge: lembrarConectado ? 30 * 24 * 60 * 60 * 1000 : 12 * 60 * 60 * 1000,
    path: '/',
  });
}

function limparCookieSessao(req, res) {
  res.clearCookie(NOME_COOKIE, {
    httpOnly: true,
    secure: cookieEhSeguro(req),
    sameSite: 'lax',
    path: '/',
  });
}

function lerToken(req) {
  return req.cookies ? req.cookies[NOME_COOKIE] : null;
}

// Middleware para rotas de API: exige sessão válida, senão 401.
function exigirAutenticacao(req, res, next) {
  const token = lerToken(req);
  if (!token) {
    return res.status(401).json({ erro: 'Sessão não encontrada. Faça login novamente.' });
  }
  try {
    const dados = jwt.verify(token, segredo());
    req.usuarioId = dados.sub;
    req.usuarioPerfil = dados.perfil;
    return next();
  } catch (_) {
    limparCookieSessao(req, res);
    return res.status(401).json({ erro: 'Sessão expirada. Faça login novamente.' });
  }
}

// Middleware para páginas HTML (index.html): sem sessão válida, manda
// para a tela de login em vez de responder 401 em JSON.
function paginaProtegida(req, res, next) {
  const token = lerToken(req);
  if (!token) return res.redirect('/login.html');
  try {
    jwt.verify(token, segredo());
    return next();
  } catch (_) {
    limparCookieSessao(req, res);
    return res.redirect('/login.html');
  }
}

// Lê o perfil da sessão sem lançar erro (usado só para decidir para qual
// página redirecionar — quem exige a sessão de fato é paginaProtegida).
function perfilDaSessao(req) {
  const token = lerToken(req);
  if (!token) return null;
  try {
    return jwt.verify(token, segredo()).perfil || null;
  } catch (_) {
    return null;
  }
}

module.exports = {
  NOME_COOKIE,
  gerarToken,
  definirCookieSessao,
  limparCookieSessao,
  exigirAutenticacao,
  paginaProtegida,
  perfilDaSessao,
};
