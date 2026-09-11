// firebase.js
// Integração server-side com o Firebase Admin SDK / Cloud Firestore.
// As credenciais nunca ficam no código: configure FIREBASE_SERVICE_ACCOUNT_JSON
// ou as três variáveis FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL e
// FIREBASE_PRIVATE_KEY no ambiente de execução.

const admin = require('firebase-admin');

let firestore = null;
let inicializacaoTentada = false;

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

async function criarQuestao(dados) {
  const banco = exigirFirestore();
  const agora = admin.firestore.FieldValue.serverTimestamp();
  const referencia = await banco.collection('questoes').add({
    texto: dados.texto,
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

  return snapshot.docs.map((doc) => {
    const dados = doc.data();
    return {
      id: doc.id,
      ...dados,
      criadoEm: dados.criadoEm?.toDate?.()?.toISOString?.() || null,
      atualizadoEm: dados.atualizadoEm?.toDate?.()?.toISOString?.() || null,
    };
  });
}

async function excluirQuestao(id) {
  if (!id || typeof id !== 'string' || id.length > 200) {
    throw Object.assign(new Error('ID de questão inválido.'), { statusCode: 400 });
  }
  const banco = exigirFirestore();
  await banco.collection('questoes').doc(id).delete();
  return { id };
}

module.exports = { obterFirestore, criarQuestao, listarQuestoes, excluirQuestao };
