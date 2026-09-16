// firebase.js
// Integração server-side com o Firebase Admin SDK / Cloud Firestore.
// As credenciais nunca ficam no código: configure FIREBASE_SERVICE_ACCOUNT_JSON
// ou as três variáveis FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL e
// FIREBASE_PRIVATE_KEY no ambiente de execução.

const admin = require('firebase-admin');

let firestore = null;
let inicializacaoTentada = false;

function sanitizarHtml(html) {
  if (typeof html !== 'string') return '';
  return html
    .replace(/<(script|style|iframe|object|embed|form)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/\s(on\w+|style|srcdoc)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/\s(href|src)\s*=\s*("\s*javascript:[^"]*"|'\s*javascript:[^']*'|\s*javascript:[^\s>]+)/gi, '')
    .trim();
}

function obterFirestore() {
  if (firestore) return firestore;
  if (inicializacaoTentada) return null;
  inicializacaoTentada = true;

  try {
    let credencial;
    if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
      credencial = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    } else if (
      process.env.FIREBASE_PROJECT_ID &&
      process.env.FIREBASE_CLIENT_EMAIL &&
      process.env.FIREBASE_PRIVATE_KEY
    ) {
      credencial = {
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      };
    } else {
      console.warn('[firebase] Credenciais não configuradas. Persistência desabilitada.');
      return null;
    }

    admin.initializeApp({ credential: admin.credential.cert(credencial) });
    firestore = admin.firestore();
    console.log('[firebase] Firestore inicializado.');
    return firestore;
  } catch (err) {
    console.error('[firebase] Falha ao inicializar:', err.message);
    return null;
  }
}

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

// Metadados usados pelas telas de Banco de Questões (filtros por período
// e assunto) e de Montagem da prova (valor em pontos de cada questão).
// Ficam com padrão sempre preenchido para que questões salvas antes
// dessas telas existirem continuem aparecendo nos filtros.
const PERIODOS_VALIDOS = ['atual', 'historico'];

function normalizarMetadados(dados = {}) {
  const valor = Number(dados.valor);
  const ano = Number.parseInt(dados.ano, 10);
  const assunto = typeof dados.assunto === 'string' ? dados.assunto.trim().slice(0, 60) : '';
  return {
    assunto: assunto || 'Outros',
    periodo: PERIODOS_VALIDOS.includes(dados.periodo) ? dados.periodo : 'atual',
    ano: Number.isFinite(ano) && ano >= 1990 && ano <= 2100 ? ano : null,
    valor: Number.isFinite(valor) && valor > 0 && valor <= 100
      ? Math.round(valor * 100) / 100
      : 1,
  };
}

async function criarQuestao(dados) {
  const banco = exigirFirestore();
  const agora = admin.firestore.FieldValue.serverTimestamp();
  const referencia = await banco.collection('questoes').add({
    texto: dados.texto,
    conteudoHtml: sanitizarHtml(dados.conteudoHtml || ''),
    ...normalizarMetadados(dados),
    usadaEm: 0,
    tipoOrigem: dados.tipoOrigem || 'manual',
    nomeArquivo: dados.nomeArquivo || null,
    paginas: Number.isFinite(dados.paginas) ? dados.paginas : null,
    confianca: Number.isFinite(dados.confianca) ? dados.confianca : null,
    avisos: Array.isArray(dados.avisos) ? dados.avisos : [],
    criadoEm: agora,
    atualizadoEm: agora,
  });
  return { id: referencia.id };
}

async function listarQuestoes(limite = 50) {
  const banco = exigirFirestore();
  const snapshot = await banco.collection('questoes')
    .orderBy('criadoEm', 'desc')
    .limit(limite)
    .get();

  return snapshot.docs.map(formatarQuestao);
}

// Converte o documento do Firestore no formato consumido pela interface,
// preenchendo os metadados novos (assunto/período/valor) quando o
// documento é antigo e não os tem.
function formatarQuestao(doc) {
  const dados = doc.data();
  return {
    id: doc.id,
    ...dados,
    ...normalizarMetadados(dados),
    usadaEm: Number.isFinite(dados.usadaEm) ? dados.usadaEm : 0,
    criadoEm: dados.criadoEm?.toDate?.()?.toISOString?.() || null,
    atualizadoEm: dados.atualizadoEm?.toDate?.()?.toISOString?.() || null,
  };
}

function validarId(id) {
  if (!id || typeof id !== 'string' || id.length > 200) {
    throw Object.assign(new Error('ID de questão inválido.'), { statusCode: 400 });
  }
  return id;
}

// Edição feita no painel de detalhe do Banco de Questões: o professor
// ajusta enunciado, assunto, período e valor sem precisar recadastrar.
async function atualizarQuestao(id, dados) {
  validarId(id);
  const banco = exigirFirestore();
  const referencia = banco.collection('questoes').doc(id);
  const documento = await referencia.get();
  if (!documento.exists) {
    throw Object.assign(new Error('Questão não encontrada.'), { statusCode: 404 });
  }

  const atualizacao = {
    ...normalizarMetadados({ ...documento.data(), ...dados }),
    atualizadoEm: admin.firestore.FieldValue.serverTimestamp(),
  };
  if (typeof dados.texto === 'string' && dados.texto.trim()) {
    atualizacao.texto = dados.texto.trim();
  }
  if (typeof dados.conteudoHtml === 'string') {
    atualizacao.conteudoHtml = sanitizarHtml(dados.conteudoHtml);
  }

  await referencia.update(atualizacao);
  return formatarQuestao(await referencia.get());
}

// Busca as questões escolhidas para a prova. O PDF é montado a partir do
// que está no banco (e não do que o navegador mandou), então uma edição
// feita em outra aba não passa despercebida.
async function buscarQuestoesPorIds(ids) {
  const banco = exigirFirestore();
  const unicos = [...new Set((ids || []).map(validarId))];
  if (!unicos.length) {
    throw Object.assign(new Error('Nenhuma questão informada.'), { statusCode: 400 });
  }

  const documentos = await banco.getAll(...unicos.map((id) => banco.collection('questoes').doc(id)));
  const encontrados = new Map(
    documentos.filter((doc) => doc.exists).map((doc) => [doc.id, formatarQuestao(doc)]),
  );

  const faltando = unicos.filter((id) => !encontrados.has(id));
  if (faltando.length) {
    throw Object.assign(
      new Error(`Questão(ões) não encontrada(s): ${faltando.join(', ')}.`),
      { statusCode: 404 },
    );
  }

  // Preserva a ordem em que o professor montou a prova.
  return unicos.map((id) => encontrados.get(id));
}

// Contador de "usada em N provas" mostrado no painel de detalhe.
// Falhar aqui não pode invalidar um PDF já gerado, por isso o erro é só
// registrado no log.
async function registrarUsoQuestoes(ids) {
  try {
    const banco = exigirFirestore();
    const lote = banco.batch();
    [...new Set(ids || [])].forEach((id) => {
      lote.update(banco.collection('questoes').doc(id), {
        usadaEm: admin.firestore.FieldValue.increment(1),
        usadaPelaUltimaVezEm: admin.firestore.FieldValue.serverTimestamp(),
      });
    });
    await lote.commit();
  } catch (err) {
    console.warn('[firebase] Não foi possível registrar o uso das questões:', err.message);
  }
}

async function excluirQuestao(id) {
  validarId(id);
  const banco = exigirFirestore();
  await banco.collection('questoes').doc(id).delete();
  return { id };
}

module.exports = {
  obterFirestore,
  criarQuestao,
  listarQuestoes,
  atualizarQuestao,
  excluirQuestao,
  buscarQuestoesPorIds,
  registrarUsoQuestoes,
  sanitizarHtml,
};
