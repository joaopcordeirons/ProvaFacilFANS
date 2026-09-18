// firebase.js
// Integração server-side com o Firebase Admin SDK / Cloud Firestore.
// As credenciais nunca ficam no código: configure FIREBASE_SERVICE_ACCOUNT_JSON
// ou as três variáveis FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL e
// FIREBASE_PRIVATE_KEY no ambiente de execução.

const admin = require('firebase-admin');
const { CURSOS_VALIDOS, PERIODOS_VALIDOS } = require('./constantes');

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
  // Chama via module.exports (não a função local direto) para que testes
  // consigam substituir obterFirestore por um Firestore falso sem precisar
  // de credenciais reais — não muda nada em produção.
  const banco = module.exports.obterFirestore();
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
function validarCurso(valor) {
  if (!CURSOS_VALIDOS.includes(valor)) {
    throw Object.assign(new Error('Curso inválido ou não informado.'), { statusCode: 400 });
  }
  return valor;
}

function validarPeriodo(valor) {
  const numero = Number.parseInt(valor, 10);
  if (!PERIODOS_VALIDOS.includes(numero)) {
    throw Object.assign(new Error('Período inválido — escolha de 1º a 10º.'), { statusCode: 400 });
  }
  return numero;
}

function normalizarMetadados(dados = {}) {
  const valor = Number(dados.valor);
  const ano = Number.parseInt(dados.ano, 10);
  const assunto = typeof dados.assunto === 'string' ? dados.assunto.trim().slice(0, 60) : '';
  return {
    assunto: assunto || 'Outros',
    ano: Number.isFinite(ano) && ano >= 1990 && ano <= 2100 ? ano : null,
    valor: Number.isFinite(valor) && valor > 0 && valor <= 100
      ? Math.round(valor * 100) / 100
      : 1,
  };
}

async function criarQuestao(dados) {
  const banco = exigirFirestore();
  const curso = validarCurso(dados.curso);
  const periodo = validarPeriodo(dados.periodo);
  const agora = admin.firestore.FieldValue.serverTimestamp();
  const referencia = await banco.collection('questoes').add({
    texto: dados.texto,
    conteudoHtml: sanitizarHtml(dados.conteudoHtml || ''),
    curso,
    periodo,
    ...normalizarMetadados(dados),
    usadaEm: 0,
    criadoPorId: dados.criadoPorId || null,
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

// cursosFiltro:
//  - null/undefined -> sem filtro (usado pela Direção, que vê tudo)
//  - array de cursos -> só questões desses cursos (usado pelo professor,
//    com os cursos em que ele está cadastrado como docente)
async function listarQuestoes(limite = 50, cursosFiltro = null) {
  const banco = exigirFirestore();

  if (!cursosFiltro) {
    const snapshot = await banco.collection('questoes')
      .orderBy('criadoEm', 'desc')
      .limit(limite)
      .get();
    return snapshot.docs.map(formatarQuestao);
  }

  if (!cursosFiltro.length) return [];

  // O Firestore não deixa combinar where('curso','in',...) com
  // orderBy('criadoEm') sem um índice composto — em vez de depender
  // disso, busca tudo do(s) curso(s) e ordena em memória. Os bancos de
  // questões de uma disciplina não chegam a ficar grandes o bastante
  // pra isso pesar.
  const snapshot = await banco.collection('questoes')
    .where('curso', 'in', cursosFiltro.slice(0, 10))
    .get();
  return snapshot.docs
    .map(formatarQuestao)
    .sort((a, b) => new Date(b.criadoEm || 0) - new Date(a.criadoEm || 0))
    .slice(0, limite);
}

// Converte o documento do Firestore no formato consumido pela interface,
// preenchendo os metadados novos (assunto/valor) quando o documento é
// antigo e não os tem.
function formatarQuestao(doc) {
  const dados = doc.data();
  return {
    id: doc.id,
    ...dados,
    ...normalizarMetadados(dados),
    curso: CURSOS_VALIDOS.includes(dados.curso) ? dados.curso : null,
    periodo: PERIODOS_VALIDOS.includes(dados.periodo) ? dados.periodo : null,
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

// Usado pelo server.js para checar permissão (o curso da questão precisa
// estar entre os cursos do professor logado) antes de editar/excluir.
async function buscarQuestaoPorId(id) {
  validarId(id);
  const banco = exigirFirestore();
  const doc = await banco.collection('questoes').doc(id).get();
  return doc.exists ? formatarQuestao(doc) : null;
}

// Edição feita no painel de detalhe do Banco de Questões: o professor
// ajusta enunciado, assunto, período, curso e valor sem precisar recadastrar.
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
  if (dados.curso !== undefined) atualizacao.curso = validarCurso(dados.curso);
  if (dados.periodo !== undefined) atualizacao.periodo = validarPeriodo(dados.periodo);
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

/* ------------------------------------------------------------ provas */

// Cada prova gerada (PDF ou DOCX) vira um documento em "provas". É o que
// alimenta o Painel do professor: provas do semestre, quantas já foram
// aprovadas pela direção e a lista das mais recentes.
const STATUS_PROVA = ['rascunho', 'em_revisao', 'aprovada', 'reprovada'];

// O professor só controla o começo do fluxo (rascunho → em análise). A
// decisão final (aprovar/reprovar) é exclusiva da Direção, via revisarProva.
const STATUS_PROFESSOR = ['rascunho', 'em_revisao'];
const STATUS_REVISAO_COORDENADOR = ['aprovada', 'reprovada', 'em_revisao'];

async function registrarProva(dados) {
  const banco = exigirFirestore();
  const agora = admin.firestore.FieldValue.serverTimestamp();
  const questaoIds = [...new Set(dados.questaoIds || [])];
  const curso = validarCurso(dados.curso);

  const prova = {
    titulo: String(dados.titulo || 'Avaliação').slice(0, 160),
    curso,
    periodo: String(dados.periodo || '').slice(0, 40),
    etapa: String(dados.etapa || '').slice(0, 20),
    data: String(dados.data || '').slice(0, 20),
    questaoIds,
    quantidadeQuestoes: questaoIds.length,
    pontuacaoTotal: Number.isFinite(Number(dados.pontuacaoTotal)) ? Number(dados.pontuacaoTotal) : 0,
    status: 'rascunho',
    // Preenchidos só quando a Direção revisa (ver revisarProva).
    comentarioCoordenador: '',
    questoesReprovadas: [],
    revisadoPorId: null,
    revisadoEm: null,
    formatos: dados.formato ? [dados.formato] : [],
    criadoPorId: dados.criadoPorId || null,
    criadoEm: agora,
    atualizadoEm: agora,
  };

  // Gerar de novo a mesma prova (ex.: PDF depois do DOCX) atualiza o
  // registro em vez de duplicar a linha no painel.
  const semelhante = await banco.collection('provas')
    .where('titulo', '==', prova.titulo)
    .orderBy('criadoEm', 'desc')
    .limit(1)
    .get()
    .catch(() => null);

  const anterior = semelhante && !semelhante.empty ? semelhante.docs[0] : null;
  const mesmasQuestoes = anterior
    && JSON.stringify(anterior.data().questaoIds || []) === JSON.stringify(questaoIds);

  if (mesmasQuestoes) {
    const formatos = [...new Set([...(anterior.data().formatos || []), ...prova.formatos])];
    await anterior.ref.update({
      ...prova,
      formatos,
      status: anterior.data().status || 'rascunho',
      // Regerar o arquivo (ex.: PDF depois do DOCX) não apaga a revisão
      // que a Direção já tiver feito nesta prova.
      comentarioCoordenador: anterior.data().comentarioCoordenador || '',
      questoesReprovadas: anterior.data().questoesReprovadas || [],
      revisadoPorId: anterior.data().revisadoPorId || null,
      revisadoEm: anterior.data().revisadoEm || null,
      criadoEm: anterior.data().criadoEm,
    });
    return { id: anterior.id };
  }

  const referencia = await banco.collection('provas').add(prova);
  return { id: referencia.id };
}

async function listarProvas(limite = 20, cursosFiltro = null) {
  const banco = exigirFirestore();

  if (!cursosFiltro) {
    const snapshot = await banco.collection('provas')
      .orderBy('atualizadoEm', 'desc')
      .limit(limite)
      .get();
    return snapshot.docs.map(formatarProva);
  }

  if (!cursosFiltro.length) return [];

  const snapshot = await banco.collection('provas')
    .where('curso', 'in', cursosFiltro.slice(0, 10))
    .get();
  return snapshot.docs
    .map(formatarProva)
    .sort((a, b) => new Date(b.atualizadoEm || 0) - new Date(a.atualizadoEm || 0))
    .slice(0, limite);
}

function formatarProva(doc) {
  const dados = doc.data();
  return {
    id: doc.id,
    ...dados,
    status: STATUS_PROVA.includes(dados.status) ? dados.status : 'rascunho',
    comentarioCoordenador: dados.comentarioCoordenador || '',
    questoesReprovadas: Array.isArray(dados.questoesReprovadas) ? dados.questoesReprovadas : [],
    revisadoPorId: dados.revisadoPorId || null,
    criadoEm: dados.criadoEm?.toDate?.()?.toISOString?.() || null,
    atualizadoEm: dados.atualizadoEm?.toDate?.()?.toISOString?.() || null,
    revisadoEm: dados.revisadoEm?.toDate?.()?.toISOString?.() || null,
  };
}

// Usado pelo server.js para checar permissão (o curso da prova precisa
// estar entre os cursos do professor logado) antes de mudar o status.
async function buscarProvaPorId(id) {
  validarId(id);
  const banco = exigirFirestore();
  const doc = await banco.collection('provas').doc(id).get();
  return doc.exists ? formatarProva(doc) : null;
}

// O professor só marca em que pé está a preparação da prova (rascunho ou
// enviada para análise) — quem decide aprovar/reprovar é a Direção, em
// revisarProva.
async function atualizarStatusProva(id, status) {
  validarId(id);
  if (!STATUS_PROFESSOR.includes(status)) {
    throw Object.assign(new Error('Status de prova inválido.'), { statusCode: 400 });
  }
  const banco = exigirFirestore();
  const referencia = banco.collection('provas').doc(id);
  const documento = await referencia.get();
  if (!documento.exists) {
    throw Object.assign(new Error('Prova não encontrada.'), { statusCode: 404 });
  }
  await referencia.update({ status, atualizadoEm: admin.firestore.FieldValue.serverTimestamp() });
  return { id, status };
}

// A Direção aprova, reprova ou deixa a prova em análise. Registra um
// comentário geral e, se for o caso, quais questões pesaram na
// reprovação — o professor vê tudo isso assim que reabrir a prova.
async function revisarProva(id, { status, comentario, questoesReprovadas, revisorId } = {}) {
  validarId(id);
  if (!STATUS_REVISAO_COORDENADOR.includes(status)) {
    throw Object.assign(new Error('Status de revisão inválido.'), { statusCode: 400 });
  }
  const banco = exigirFirestore();
  const referencia = banco.collection('provas').doc(id);
  const documento = await referencia.get();
  if (!documento.exists) {
    throw Object.assign(new Error('Prova não encontrada.'), { statusCode: 404 });
  }

  // Só aceita sinalizar questões que realmente pertencem a esta prova.
  const questaoIdsDaProva = new Set(documento.data().questaoIds || []);
  const flags = Array.isArray(questoesReprovadas)
    ? [...new Set(questoesReprovadas.filter((qid) => questaoIdsDaProva.has(qid)))]
    : [];

  await referencia.update({
    status,
    comentarioCoordenador: String(comentario || '').trim().slice(0, 2000),
    questoesReprovadas: flags,
    revisadoPorId: revisorId || null,
    revisadoEm: admin.firestore.FieldValue.serverTimestamp(),
    atualizadoEm: admin.firestore.FieldValue.serverTimestamp(),
  });
  return formatarProva(await referencia.get());
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
  buscarQuestaoPorId,
  buscarQuestoesPorIds,
  registrarUsoQuestoes,
  registrarProva,
  listarProvas,
  buscarProvaPorId,
  atualizarStatusProva,
  revisarProva,
  sanitizarHtml,
};
