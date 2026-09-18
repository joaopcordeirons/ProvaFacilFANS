// auth.js
// Cadastro, login e recuperação de senha dos usuários (professores e
// direção) do ProvaFácil. Senhas nunca são guardadas em texto puro: só o
// hash bcrypt fica no Firestore. O token de recuperação de senha também
// não é guardado em texto puro — só o hash SHA-256 dele, com validade de
// 1 hora, então um vazamento do banco não dá acesso a contas.

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const admin = require('firebase-admin');
const { obterFirestore } = require('./firebase');
const { CURSOS_VALIDOS } = require('./constantes');

const CUSTO_HASH = 12; // fator de custo do bcrypt — 12 é o recomendado atual
const VALIDADE_TOKEN_RECUPERACAO_MS = 60 * 60 * 1000; // 1 hora
const VALIDADE_TOKEN_VERIFICACAO_MS = 24 * 60 * 60 * 1000; // 24 horas
const PERFIS_VALIDOS = ['professor', 'direcao'];

function exigirFirestore() {
  const banco = obterFirestore();
  if (!banco) {
    const erro = new Error(
      'Firebase não configurado. Defina FIREBASE_SERVICE_ACCOUNT_JSON ou FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL e FIREBASE_PRIVATE_KEY.'
    );
    erro.statusCode = 503;
    throw erro;
  }
  return banco;
}

function erro(mensagem, statusCode) {
  return Object.assign(new Error(mensagem), { statusCode });
}

function normalizarEmail(email) {
  return String(email || '').trim().toLowerCase();
}

const REGEX_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validarEmail(email) {
  if (!REGEX_EMAIL.test(email)) {
    throw erro('Informe um e-mail válido.', 400);
  }
}

function validarSenha(senha) {
  if (typeof senha !== 'string' || senha.length < 8) {
    throw erro('A senha precisa ter pelo menos 8 caracteres.', 400);
  }
}

function validarPerfil(perfil) {
  if (!PERFIS_VALIDOS.includes(perfil)) {
    throw erro('Perfil inválido. Use "professor" ou "direcao".', 400);
  }
}

// Cadastro de Direção não pode ficar aberto a qualquer um: exige um
// código de convite (CODIGO_CONVITE_DIRECAO no ambiente), compartilhado
// só com quem a instituição autorizar. Se a variável não estiver
// configurada, o cadastro de Direção fica bloqueado por padrão — falha
// segura, em vez de deixar a conta mais sensível do sistema aberta.
function validarCodigoConvite(codigo) {
  const codigoEsperado = process.env.CODIGO_CONVITE_DIRECAO;
  if (!codigoEsperado) {
    throw erro('Cadastro de Direção está temporariamente indisponível. Contate o suporte da instituição.', 503);
  }
  if (String(codigo || '').trim() !== codigoEsperado) {
    throw erro('Código de convite da Direção inválido.', 403);
  }
}

// Professor(a) precisa lecionar em pelo menos um curso (pode ser vários —
// é isso que decide em quais bancos de questões a conta consegue
// adicionar/ver questões). Direção não seleciona curso: enxerga todos.
function normalizarCursos(cursos, perfil) {
  if (perfil === 'direcao') return [];

  const lista = Array.isArray(cursos) ? cursos : [];
  const unicos = [...new Set(lista.map((c) => String(c || '').trim()))].filter(Boolean);
  const invalidos = unicos.filter((c) => !CURSOS_VALIDOS.includes(c));
  if (invalidos.length) {
    throw erro(`Curso inválido: ${invalidos.join(', ')}.`, 400);
  }
  if (!unicos.length) {
    throw erro('Selecione pelo menos um curso que você leciona.', 400);
  }
  return unicos;
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// Remove os campos sensíveis antes de qualquer dado do usuário sair da
// camada de dados em direção ao front-end.
function formatarUsuarioPublico(doc) {
  const dados = doc.data ? doc.data() : doc;
  return {
    id: doc.id,
    nome: dados.nome,
    email: dados.email,
    perfil: dados.perfil,
    instituicao: dados.instituicao || '',
    cargo: dados.cargo || '',
    notificacoesEmail: dados.notificacoesEmail !== false,
    idioma: dados.idioma || 'pt-BR',
    emailVerificado: Boolean(dados.emailVerificado),
    cursos: Array.isArray(dados.cursos) ? dados.cursos : [],
    criadoEm: dados.criadoEm?.toDate?.()?.toISOString?.() || null,
  };
}

async function buscarUsuarioPorEmailBruto(email) {
  const banco = exigirFirestore();
  const snapshot = await banco.collection('usuarios')
    .where('email', '==', normalizarEmail(email))
    .limit(1)
    .get();
  return snapshot.empty ? null : snapshot.docs[0];
}

async function buscarUsuarioPorIdBruto(id) {
  const banco = exigirFirestore();
  const doc = await banco.collection('usuarios').doc(id).get();
  return doc.exists ? doc : null;
}

async function criarUsuario({ nome, email, senha, perfil, instituicao, cargo, cursos, codigoConvite }) {
  const nomeLimpo = String(nome || '').trim();
  if (!nomeLimpo) throw erro('Informe o nome completo.', 400);

  const emailLimpo = normalizarEmail(email);
  validarEmail(emailLimpo);
  validarSenha(senha);
  validarPerfil(perfil);
  if (perfil === 'direcao') {
    validarCodigoConvite(codigoConvite);
  }
  const cursosValidados = normalizarCursos(cursos, perfil);

  const existente = await buscarUsuarioPorEmailBruto(emailLimpo);
  if (existente) {
    throw erro('Já existe uma conta cadastrada com esse e-mail.', 409);
  }

  const senhaHash = await bcrypt.hash(senha, CUSTO_HASH);
  const banco = exigirFirestore();
  const agora = admin.firestore.FieldValue.serverTimestamp();
  const tokenVerificacao = crypto.randomBytes(32).toString('hex');

  const referencia = await banco.collection('usuarios').add({
    nome: nomeLimpo.slice(0, 120),
    email: emailLimpo,
    senhaHash,
    perfil,
    instituicao: String(instituicao || '').trim().slice(0, 120),
    cargo: String(cargo || '').trim().slice(0, 80),
    cursos: cursosValidados,
    notificacoesEmail: true,
    idioma: 'pt-BR',
    emailVerificado: false,
    tokenVerificacaoHash: hashToken(tokenVerificacao),
    tokenVerificacaoExpira: Date.now() + VALIDADE_TOKEN_VERIFICACAO_MS,
    tokenRecuperacaoHash: null,
    tokenRecuperacaoExpira: null,
    criadoEm: agora,
    atualizadoEm: agora,
  });

  const doc = await referencia.get();
  return { usuario: formatarUsuarioPublico(doc), tokenVerificacao };
}

// Retorna o usuário (com o hash da senha) para o /login conferir a senha,
// ou null se o e-mail não existir — quem chama decide a mensagem de erro.
async function autenticar(email, senha) {
  if (typeof senha !== 'string' || !senha) {
    throw erro('Informe a senha.', 400);
  }
  const doc = await buscarUsuarioPorEmailBruto(email);
  if (!doc) return null;

  const dados = doc.data();
  const confere = await bcrypt.compare(senha, dados.senhaHash || '');
  if (!confere) return null;

  return doc;
}

async function buscarUsuarioPorId(id) {
  const doc = await buscarUsuarioPorIdBruto(id);
  return doc ? formatarUsuarioPublico(doc) : null;
}

// Gera um token de recuperação (string aleatória) para o e-mail informado
// e guarda só o hash dele no Firestore, com validade de 1h. Sempre
// retorna algo — se o e-mail não existir, o token simplesmente não bate
// com nenhum usuário depois; isso evita que o endpoint revele quais
// e-mails têm conta.
async function gerarTokenRecuperacao(email) {
  const doc = await buscarUsuarioPorEmailBruto(email);
  if (!doc) return null;

  const token = crypto.randomBytes(32).toString('hex');
  const banco = exigirFirestore();
  await doc.ref.update({
    tokenRecuperacaoHash: hashToken(token),
    tokenRecuperacaoExpira: Date.now() + VALIDADE_TOKEN_RECUPERACAO_MS,
    atualizadoEm: admin.firestore.FieldValue.serverTimestamp(),
  });

  return { token, usuario: formatarUsuarioPublico(doc) };
}

async function buscarUsuarioPorTokenRecuperacao(token) {
  if (typeof token !== 'string' || !token) return null;
  const banco = exigirFirestore();
  const snapshot = await banco.collection('usuarios')
    .where('tokenRecuperacaoHash', '==', hashToken(token))
    .limit(1)
    .get();
  if (snapshot.empty) return null;

  const doc = snapshot.docs[0];
  const expira = doc.data().tokenRecuperacaoExpira;
  if (!expira || expira < Date.now()) return null;
  return doc;
}

async function redefinirSenhaComToken(token, novaSenha) {
  validarSenha(novaSenha);
  const doc = await buscarUsuarioPorTokenRecuperacao(token);
  if (!doc) {
    throw erro('Link de recuperação inválido ou expirado. Solicite um novo.', 400);
  }

  const senhaHash = await bcrypt.hash(novaSenha, CUSTO_HASH);
  await doc.ref.update({
    senhaHash,
    tokenRecuperacaoHash: null,
    tokenRecuperacaoExpira: null,
    atualizadoEm: admin.firestore.FieldValue.serverTimestamp(),
  });
  return formatarUsuarioPublico(await doc.ref.get());
}

/* ------------------------------------------------- verificação de e-mail */

async function buscarUsuarioPorTokenVerificacao(token) {
  if (typeof token !== 'string' || !token) return null;
  const banco = exigirFirestore();
  const snapshot = await banco.collection('usuarios')
    .where('tokenVerificacaoHash', '==', hashToken(token))
    .limit(1)
    .get();
  if (snapshot.empty) return null;

  const doc = snapshot.docs[0];
  const expira = doc.data().tokenVerificacaoExpira;
  if (!expira || expira < Date.now()) return null;
  return doc;
}

async function verificarEmailComToken(token) {
  const doc = await buscarUsuarioPorTokenVerificacao(token);
  if (!doc) {
    throw erro('Link de verificação inválido ou expirado. Solicite um novo.', 400);
  }
  if (doc.data().emailVerificado) {
    return formatarUsuarioPublico(doc); // já verificado — não é erro, só não faz nada de novo
  }

  // Não limpa o token aqui de propósito: diferente da recuperação de
  // senha (onde reuso seria grave), aqui o pior caso de clicar no link
  // de novo é só reconfirmar — então o link fica válido até expirar
  // (24h), permitindo abrir em mais de uma aba sem dar erro.
  await doc.ref.update({
    emailVerificado: true,
    atualizadoEm: admin.firestore.FieldValue.serverTimestamp(),
  });
  return formatarUsuarioPublico(await doc.ref.get());
}

// Gera um novo token de verificação para reenviar o e-mail. Assim como a
// recuperação de senha, sempre retorna algo neutro pra quem chama poder
// responder de forma genérica e não revelar quais e-mails têm conta.
async function gerarTokenVerificacao(email) {
  const doc = await buscarUsuarioPorEmailBruto(email);
  if (!doc || doc.data().emailVerificado) return null;

  const token = crypto.randomBytes(32).toString('hex');
  await doc.ref.update({
    tokenVerificacaoHash: hashToken(token),
    tokenVerificacaoExpira: Date.now() + VALIDADE_TOKEN_VERIFICACAO_MS,
    atualizadoEm: admin.firestore.FieldValue.serverTimestamp(),
  });

  return { token, usuario: formatarUsuarioPublico(doc) };
}

async function alterarSenha(id, senhaAtual, novaSenha) {
  validarSenha(novaSenha);
  const doc = await buscarUsuarioPorIdBruto(id);
  if (!doc) throw erro('Usuário não encontrado.', 404);

  const confere = await bcrypt.compare(String(senhaAtual || ''), doc.data().senhaHash || '');
  if (!confere) throw erro('Senha atual incorreta.', 401);

  const senhaHash = await bcrypt.hash(novaSenha, CUSTO_HASH);
  await doc.ref.update({
    senhaHash,
    atualizadoEm: admin.firestore.FieldValue.serverTimestamp(),
  });
  return { ok: true };
}

async function atualizarPerfil(id, dados) {
  const doc = await buscarUsuarioPorIdBruto(id);
  if (!doc) throw erro('Usuário não encontrado.', 404);

  const atualizacao = { atualizadoEm: admin.firestore.FieldValue.serverTimestamp() };

  if (dados.nome !== undefined) {
    const nomeLimpo = String(dados.nome || '').trim();
    if (!nomeLimpo) throw erro('O nome não pode ficar vazio.', 400);
    atualizacao.nome = nomeLimpo.slice(0, 120);
  }
  if (dados.instituicao !== undefined) {
    atualizacao.instituicao = String(dados.instituicao || '').trim().slice(0, 120);
  }
  if (dados.cargo !== undefined) {
    atualizacao.cargo = String(dados.cargo || '').trim().slice(0, 80);
  }
  if (dados.notificacoesEmail !== undefined) {
    atualizacao.notificacoesEmail = Boolean(dados.notificacoesEmail);
  }
  if (dados.idioma !== undefined) {
    atualizacao.idioma = String(dados.idioma || 'pt-BR').slice(0, 10);
  }
  if (dados.cursos !== undefined) {
    atualizacao.cursos = normalizarCursos(dados.cursos, doc.data().perfil);
  }

  await doc.ref.update(atualizacao);
  return formatarUsuarioPublico(await doc.ref.get());
}

async function excluirUsuario(id) {
  const doc = await buscarUsuarioPorIdBruto(id);
  if (!doc) throw erro('Usuário não encontrado.', 404);
  await doc.ref.delete();
  return { ok: true };
}

module.exports = {
  criarUsuario,
  autenticar,
  buscarUsuarioPorId,
  gerarTokenRecuperacao,
  redefinirSenhaComToken,
  verificarEmailComToken,
  gerarTokenVerificacao,
  alterarSenha,
  atualizarPerfil,
  excluirUsuario,
  formatarUsuarioPublico,
  PERFIS_VALIDOS,
};
