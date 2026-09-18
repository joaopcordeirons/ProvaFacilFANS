// server.js
// API para extrair texto de PDF/DOCX/imagens (upload) e de e-mails recebidos (Gmail).
// Endpoints principais: POST /api/questoes/extrair-pdf, extrair-docx,
// e POST /api/questoes/verificar-email

require('dotenv').config();

const express = require('express');
const multer = require('multer');
const path = require('path');
const cookieParser = require('cookie-parser');
const { extrairTextoPdf, extrairTextoDocx, extrairTextoImagem } = require('./extratores');
const { identificarQuestoes } = require('./extratorQuestoes');
const { verificarConteudo } = require('./verificadorConteudo');
const { corrigirComIA } = require('./corretorIA');
const { verificarNovosEmails, credenciaisConfiguradas, enviarEmailRecuperacao, enviarEmailVerificacao } = require('./emailService');
const {
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
  revisarProva,
} = require('./firebase');
const {
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
} = require('./auth');
const {
  gerarToken,
  definirCookieSessao,
  limparCookieSessao,
  exigirAutenticacao,
  paginaProtegida,
} = require('./authMiddleware');
const { montarPdfProva } = require('./provaPdf');
const { montarDocxProva } = require('./provaDocx');
const { nomeArquivo } = require('./modeloProva');
const { CURSOS_VALIDOS, PERIODOS_VALIDOS } = require('./constantes');

const app = express();
const PORT = process.env.PORT || 80;

app.use(cookieParser());

// A raiz do app (a SPA em public/index.html) exige sessão válida — sem
// login, o navegador é redirecionado para a tela de login. As demais
// páginas estáticas (login.html, style.css, app.js...) continuam
// públicas, senão nem a tela de login carregaria.
app.get(['/', '/index.html'], paginaProtegida);

// Serve a interface web (public/) em http://localhost:3001
app.use(express.static(path.join(__dirname, 'public')));

const MIME_DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const MIMES_IMAGEM = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/bmp', 'image/tiff'];

// Corrige o mojibake clássico do multer/busboy: o nome do arquivo chega
// em UTF-8, mas o multipart/form-data às vezes decodifica o cabeçalho
// como Latin-1 primeiro — "Exercícios" vira "ExercÃ­cios". Reconverter
// os bytes resolve, sem afetar nomes que já vieram certos (nesse caso o
// round-trip não muda nada).
function corrigirNomeArquivo(nome) {
  if (!nome) return nome;
  try {
    return Buffer.from(nome, 'latin1').toString('utf8');
  } catch (_) {
    return nome;
  }
}


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

// Lista fixa de cursos e períodos — usada pelos formulários de
// cadastro/perfil (seleção de curso) e pelo Banco de Questões/Montagem
// de prova (seleção de período). Pública porque a tela de cadastro
// precisa dela antes do login existir.
app.get('/api/constantes', (req, res) => {
  res.json({ cursos: CURSOS_VALIDOS, periodos: PERIODOS_VALIDOS });
});

/* ================================================================== */
/* ============================ AUTENTICAÇÃO ========================= */
/* ================================================================== */

// Link de "voltar ao site" usado no e-mail de recuperação de senha —
// construído a partir da própria requisição, então funciona tanto em
// localhost quanto no domínio da Vercel sem precisar configurar mais
// uma variável de ambiente.
function origemDoPedido(req) {
  const protocolo = req.headers['x-forwarded-proto'] || req.protocol;
  return `${protocolo}://${req.get('host')}`;
}

// Cadastro de um novo professor ou de um membro da direção. A conta
// nasce com emailVerificado:false e SEM sessão aberta — o login só é
// liberado depois que o link enviado por e-mail for confirmado.
app.post('/api/auth/registrar', express.json({ limit: '20kb' }), async (req, res) => {
  try {
    const { nome, email, senha, perfil, instituicao, cargo, cursos, codigoConvite } = req.body || {};
    const { usuario, tokenVerificacao } = await criarUsuario({ nome, email, senha, perfil, instituicao, cargo, cursos, codigoConvite });

    const link = `${origemDoPedido(req)}/login.html?verificar=${tokenVerificacao}`;
    await enviarEmailVerificacao(usuario.email, usuario.nome, link);

    return res.status(201).json({
      usuario,
      mensagem: 'Conta criada! Enviamos um link de confirmação para o seu e-mail — confirme para poder entrar.',
    });
  } catch (err) {
    console.error('Erro ao registrar usuário:', err.message);
    return res.status(err.statusCode || 500).json({ erro: err.message });
  }
});

// Login: confere e-mail/senha, exige e-mail confirmado e, se a conta
// bater com o perfil selecionado na tela (professor/direção), abre a sessão.
app.post('/api/auth/login', express.json({ limit: '10kb' }), async (req, res) => {
  try {
    const { email, senha, perfil, lembrarConectado } = req.body || {};
    const doc = await autenticar(email, senha);
    if (!doc) {
      return res.status(401).json({ erro: 'E-mail ou senha incorretos.' });
    }

    const usuario = formatarUsuarioPublico(doc);
    if (!usuario.emailVerificado) {
      return res.status(403).json({
        erro: 'Confirme seu e-mail para poder entrar. Verifique sua caixa de entrada.',
        emailNaoVerificado: true,
      });
    }
    if (perfil && usuario.perfil !== perfil) {
      const rotulo = usuario.perfil === 'direcao' ? 'Direção' : 'Professor';
      return res.status(403).json({
        erro: `Essa conta está cadastrada como ${rotulo}. Selecione o perfil correto para entrar.`,
      });
    }

    const token = gerarToken(usuario, Boolean(lembrarConectado));
    definirCookieSessao(req, res, token, Boolean(lembrarConectado));
    return res.json({ usuario });
  } catch (err) {
    console.error('Erro ao fazer login:', err.message);
    return res.status(err.statusCode || 500).json({ erro: err.message });
  }
});

// Confirmação do link de verificação enviado por e-mail no cadastro.
app.post('/api/auth/verificar-email', express.json({ limit: '5kb' }), async (req, res) => {
  try {
    const { token } = req.body || {};
    if (typeof token !== 'string' || !token) {
      return res.status(400).json({ erro: 'Link de verificação inválido.' });
    }
    const usuario = await verificarEmailComToken(token);
    return res.json({ ok: true, usuario });
  } catch (err) {
    console.error('Erro ao verificar e-mail:', err.message);
    return res.status(err.statusCode || 500).json({ erro: err.message });
  }
});

// Reenvio do link de verificação (ex.: professor não achou o e-mail ou o
// link de 24h expirou). Resposta sempre genérica, mesma lógica do
// "esqueci minha senha" — não revela se o e-mail existe ou já foi confirmado.
app.post('/api/auth/reenviar-verificacao', express.json({ limit: '5kb' }), async (req, res) => {
  const MENSAGEM_GENERICA = { ok: true, mensagem: 'Se esse e-mail tiver uma conta pendente de confirmação, reenviamos o link.' };
  try {
    const { email } = req.body || {};
    if (typeof email !== 'string' || !email.trim()) {
      return res.status(400).json({ erro: 'Informe o e-mail.' });
    }

    const resultado = await gerarTokenVerificacao(email);
    if (resultado) {
      const link = `${origemDoPedido(req)}/login.html?verificar=${resultado.token}`;
      await enviarEmailVerificacao(resultado.usuario.email, resultado.usuario.nome, link);
    }
    return res.json(MENSAGEM_GENERICA);
  } catch (err) {
    console.error('Erro ao reenviar verificação:', err.message);
    return res.json(MENSAGEM_GENERICA);
  }
});

app.post('/api/auth/logout', (req, res) => {
  limparCookieSessao(req, res);
  return res.json({ ok: true });
});

// Usado pelo front-end para saber, a cada carregamento, se a sessão
// ainda é válida e quem é o usuário logado.
app.get('/api/auth/me', exigirAutenticacao, async (req, res) => {
  try {
    const usuario = await buscarUsuarioPorId(req.usuarioId);
    if (!usuario) {
      limparCookieSessao(req, res);
      return res.status(401).json({ erro: 'Sessão inválida.' });
    }
    return res.json({ usuario });
  } catch (err) {
    console.error('Erro ao carregar usuário logado:', err.message);
    return res.status(err.statusCode || 500).json({ erro: err.message });
  }
});

// Pedido de recuperação de senha. A resposta é sempre a mesma, exista ou
// não o e-mail na base — isso evita que alguém use esse endpoint para
// descobrir quais e-mails têm conta no sistema.
app.post('/api/auth/esqueci-senha', express.json({ limit: '5kb' }), async (req, res) => {
  const MENSAGEM_GENERICA = { ok: true, mensagem: 'Se esse e-mail tiver uma conta, enviamos um link de recuperação para ele.' };
  try {
    const { email } = req.body || {};
    if (typeof email !== 'string' || !email.trim()) {
      return res.status(400).json({ erro: 'Informe o e-mail.' });
    }

    const resultado = await gerarTokenRecuperacao(email);
    if (resultado) {
      const link = `${origemDoPedido(req)}/login.html?token=${resultado.token}`;
      await enviarEmailRecuperacao(resultado.usuario.email, resultado.usuario.nome, link);
    }
    return res.json(MENSAGEM_GENERICA);
  } catch (err) {
    console.error('Erro ao gerar recuperação de senha:', err.message);
    // Mesmo em erro interno, não vaza detalhe nenhum sobre a existência do e-mail.
    return res.json(MENSAGEM_GENERICA);
  }
});

// Conclusão da recuperação: troca a senha usando o token recebido por
// e-mail (válido por 1h, uso único).
app.post('/api/auth/redefinir-senha', express.json({ limit: '5kb' }), async (req, res) => {
  try {
    const { token, novaSenha } = req.body || {};
    if (typeof token !== 'string' || !token) {
      return res.status(400).json({ erro: 'Link de recuperação inválido.' });
    }
    await redefinirSenhaComToken(token, novaSenha);
    return res.json({ ok: true });
  } catch (err) {
    console.error('Erro ao redefinir senha:', err.message);
    return res.status(err.statusCode || 500).json({ erro: err.message });
  }
});

// Tela de Perfil: atualizar dados pessoais e preferências.
app.put('/api/auth/perfil', exigirAutenticacao, express.json({ limit: '10kb' }), async (req, res) => {
  try {
    const { nome, instituicao, cargo, notificacoesEmail, idioma, cursos } = req.body || {};
    const usuario = await atualizarPerfil(req.usuarioId, { nome, instituicao, cargo, notificacoesEmail, idioma, cursos });
    return res.json({ usuario });
  } catch (err) {
    console.error('Erro ao atualizar perfil:', err.message);
    return res.status(err.statusCode || 500).json({ erro: err.message });
  }
});

// Tela de Perfil: trocar a senha estando logado (exige a senha atual).
app.post('/api/auth/alterar-senha', exigirAutenticacao, express.json({ limit: '5kb' }), async (req, res) => {
  try {
    const { senhaAtual, novaSenha } = req.body || {};
    await alterarSenha(req.usuarioId, senhaAtual, novaSenha);
    return res.json({ ok: true });
  } catch (err) {
    console.error('Erro ao alterar senha:', err.message);
    return res.status(err.statusCode || 500).json({ erro: err.message });
  }
});

// Zona de risco do Perfil: exclusão definitiva da conta.
app.delete('/api/auth/conta', exigirAutenticacao, async (req, res) => {
  try {
    await excluirUsuario(req.usuarioId);
    limparCookieSessao(req, res);
    return res.json({ ok: true });
  } catch (err) {
    console.error('Erro ao excluir conta:', err.message);
    return res.status(err.statusCode || 500).json({ erro: err.message });
  }
});

/* ================================================================== */
/* ======================== DADOS DO APLICATIVO ====================== */
/* ================================================================== */
// A partir daqui, toda rota exige sessão válida — ninguém acessa banco de
// questões, montagem de provas ou upload sem estar logado.
app.use('/api/questoes', exigirAutenticacao);
app.use('/api/provas', exigirAutenticacao);

// Carrega o usuário completo (perfil + cursos) a cada request nessas
// rotas — em vez de confiar só no que está no cookie — para que uma
// mudança de curso feita agora mesmo no Perfil já valha na hora, sem
// precisar deslogar. Direção sempre tem acesso irrestrito (cursosPermitidos
// null = sem filtro); professor só aos cursos em que está cadastrado.
async function carregarUsuarioCompleto(req, res, next) {
  try {
    const usuario = await buscarUsuarioPorId(req.usuarioId);
    if (!usuario) return res.status(401).json({ erro: 'Sessão inválida.' });
    req.usuario = usuario;
    req.cursosPermitidos = usuario.perfil === 'direcao' ? null : usuario.cursos;
    return next();
  } catch (err) {
    return res.status(err.statusCode || 500).json({ erro: err.message });
  }
}
app.use('/api/questoes', carregarUsuarioCompleto);
app.use('/api/provas', carregarUsuarioCompleto);

// Confere se o professor tem permissão sobre um curso específico
// (direção sempre tem). Usado antes de criar/editar/excluir.
function podeUsarCurso(req, curso) {
  return req.cursosPermitidos === null || req.cursosPermitidos.includes(curso);
}

// Salva o texto revisado pelo professor no Cloud Firestore.
app.post('/api/questoes', express.json(), async (req, res) => {
  try {
    const {
      texto, conteudoHtml, tipoOrigem, nomeArquivo, paginas, confianca, avisos,
      assunto, periodo, ano, valor, curso,
    } = req.body || {};
    if (typeof texto !== 'string' || !texto.trim()) {
      return res.status(400).json({ erro: 'O campo "texto" é obrigatório.' });
    }
    if (!podeUsarCurso(req, curso)) {
      return res.status(403).json({ erro: 'Você não leciona nesse curso.' });
    }

    const questao = await criarQuestao({
      texto: texto.trim(), conteudoHtml, tipoOrigem, nomeArquivo, paginas, confianca, avisos,
      assunto, periodo, ano, valor, curso, criadoPorId: req.usuarioId,
    });
    return res.status(201).json(questao);
  } catch (err) {
    console.error('Erro ao salvar questão:', err.message);
    return res.status(err.statusCode || 500).json({ erro: err.message });
  }
});

// Lista as questões mais recentes salvas no Cloud Firestore — só do(s)
// curso(s) do professor logado; sem filtro para a Direção.
app.get('/api/questoes', async (req, res) => {
  try {
    const limiteInformado = Number.parseInt(req.query.limite, 10);
    const limite = Number.isFinite(limiteInformado)
      ? Math.min(Math.max(limiteInformado, 1), 100)
      : 50;
    return res.json({ questoes: await listarQuestoes(limite, req.cursosPermitidos) });
  } catch (err) {
    console.error('Erro ao listar questões:', err.message);
    return res.status(err.statusCode || 500).json({ erro: err.message });
  }
});

// Recebe um texto bruto (extraído de PDF/DOCX/OCR/e-mail, possivelmente
// com várias questões e cabeçalho/instruções misturados) e devolve só as
// questões já separadas, prontas para o professor revisar e salvar uma a
// uma. Roda 100% local (motor de regras), sem custo por chamada.
app.post('/api/questoes/identificar', express.json({ limit: '2mb' }), async (req, res) => {
  try {
    const { texto } = req.body || {};
    if (typeof texto !== 'string' || !texto.trim()) {
      return res.status(400).json({ erro: 'O campo "texto" é obrigatório.' });
    }
    return res.json(await identificarQuestoes(texto));
  } catch (err) {
    console.error('Erro ao identificar questões:', err.message);
    return res.status(500).json({ erro: 'Falha ao identificar questões no texto.', detalhe: err.message });
  }
});

// Verificação OPCIONAL de coerência de conteúdo via IA (Gemini, sob
// demanda — só quando o professor clica, nunca automático). Ver
// verificadorConteudo.js para o porquê disso ser opcional.
app.post('/api/questoes/verificar-conteudo', express.json({ limit: '1mb' }), async (req, res) => {
  try {
    const { enunciado, alternativas } = req.body || {};
    if (typeof enunciado !== 'string' || !enunciado.trim()) {
      return res.status(400).json({ erro: 'O campo "enunciado" é obrigatório.' });
    }
    return res.json(await verificarConteudo({ enunciado, alternativas }));
  } catch (err) {
    console.error('Erro ao verificar conteúdo:', err.message);
    return res.status(500).json({ erro: 'Falha ao verificar conteúdo.', detalhe: err.message });
  }
});

// Correção OPCIONAL de formatação via IA (Gemini, sob demanda — só
// quando o professor clica em "Corrigir com IA", nunca automático). Ao
// contrário da verificação acima, esta reescreve o texto — o professor
// sempre revisa antes de salvar. Ver corretorIA.js.
app.post('/api/questoes/corrigir-com-ia', express.json({ limit: '1mb' }), async (req, res) => {
  try {
    const { enunciado, alternativas } = req.body || {};
    if (typeof enunciado !== 'string' || !enunciado.trim()) {
      return res.status(400).json({ erro: 'O campo "enunciado" é obrigatório.' });
    }
    return res.json(await corrigirComIA({ enunciado, alternativas }));
  } catch (err) {
    console.error('Erro ao corrigir com IA:', err.message);
    return res.status(500).json({ erro: 'Falha ao corrigir com IA.', detalhe: err.message });
  }
});

// Edição de uma questão já salva (painel de detalhe do Banco de Questões):
// enunciado, assunto, período/ano e valor em pontos.
app.put('/api/questoes/:id', express.json({ limit: '1mb' }), async (req, res) => {
  try {
    const { texto, conteudoHtml, assunto, periodo, ano, valor, curso } = req.body || {};
    if (texto !== undefined && (typeof texto !== 'string' || !texto.trim())) {
      return res.status(400).json({ erro: 'O campo "texto" não pode ficar vazio.' });
    }

    const existente = await buscarQuestaoPorId(req.params.id);
    if (!existente) return res.status(404).json({ erro: 'Questão não encontrada.' });
    if (!podeUsarCurso(req, existente.curso)) {
      return res.status(403).json({ erro: 'Você não leciona no curso dessa questão.' });
    }
    if (curso !== undefined && !podeUsarCurso(req, curso)) {
      return res.status(403).json({ erro: 'Você não leciona nesse curso.' });
    }

    return res.json(await atualizarQuestao(req.params.id, {
      texto, conteudoHtml, assunto, periodo, ano, valor, curso,
    }));
  } catch (err) {
    console.error('Erro ao atualizar questão:', err.message);
    return res.status(err.statusCode || 500).json({ erro: err.message });
  }
});

// Monta a prova com as questões selecionadas, no modelo oficial da FANS,
// e devolve o arquivo para download — em PDF (pronto para imprimir) ou em
// DOCX (o mesmo layout, editável no Word). As questões vêm do Firestore
// (o navegador manda só os IDs e a ordem), e cada uma tem seu contador
// "usada em N provas" incrementado depois que o arquivo é gerado.
const MIME_SAIDA = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

function dadosDaProva(corpo, questoes) {
  return {
    titulo: corpo.titulo,
    curso: corpo.curso || corpo.disciplina,
    periodo: corpo.periodo || corpo.turma,
    data: corpo.data,
    etapa: corpo.etapa,
    aluno: corpo.aluno,
    valorProva: corpo.valorProva,
    aprovacaoCoordenador: corpo.aprovacaoCoordenador,
    professor: corpo.professor,
    instrucoes: corpo.instrucoes,
    linhasResposta: corpo.linhasResposta,
    questoes: questoes.map((questao) => ({
      texto: questao.texto,
      valor: questao.valor,
      ano: questao.ano,
      banca: questao.banca,
      orgao: questao.orgao,
      prova: questao.prova,
    })),
  };
}

async function gerarProva(req, res, formato) {
  try {
    const corpo = req.body || {};
    const { questaoIds } = corpo;

    if (!Array.isArray(questaoIds) || questaoIds.length === 0) {
      return res.status(400).json({ erro: 'Selecione pelo menos uma questão para montar a prova.' });
    }
    if (questaoIds.length > 60) {
      return res.status(400).json({ erro: 'Uma prova pode ter no máximo 60 questões.' });
    }

    const cursoProva = corpo.curso || corpo.disciplina;
    if (!podeUsarCurso(req, cursoProva)) {
      return res.status(403).json({ erro: 'Você não leciona nesse curso.' });
    }

    const questoes = await buscarQuestoesPorIds(questaoIds);
    const foraDoCurso = questoes.find((questao) => !podeUsarCurso(req, questao.curso));
    if (foraDoCurso) {
      return res.status(403).json({ erro: 'Uma ou mais questões selecionadas não pertencem a um curso que você leciona.' });
    }

    const dados = dadosDaProva(corpo, questoes);
    const arquivo = formato === 'docx'
      ? montarDocxProva(dados)
      : await montarPdfProva(dados);

    await registrarUsoQuestoes(questoes.map((questao) => questao.id));

    // O registro alimenta o Painel do professor. Falhar aqui não invalida
    // um arquivo que já foi gerado — o download continua.
    try {
      await registrarProva({
        titulo: dados.titulo,
        curso: dados.curso,
        periodo: dados.periodo,
        etapa: dados.etapa,
        data: dados.data,
        formato,
        questaoIds: questoes.map((questao) => questao.id),
        pontuacaoTotal: questoes.reduce((soma, questao) => soma + Number(questao.valor || 0), 0),
        criadoPorId: req.usuarioId,
      });
    } catch (err) {
      console.warn('Não foi possível registrar a prova no painel:', err.message);
    }

    res.setHeader('Content-Type', MIME_SAIDA[formato]);
    res.setHeader('Content-Disposition', `attachment; filename="${nomeArquivo(corpo.titulo, formato)}"`);
    res.setHeader('Content-Length', arquivo.length);
    return res.end(arquivo);
  } catch (err) {
    console.error(`Erro ao gerar a prova em ${formato.toUpperCase()}:`, err.message);
    return res.status(err.statusCode || 500).json({
      erro: err.message || `Falha ao gerar a prova em ${formato.toUpperCase()}.`,
    });
  }
}

app.post('/api/provas/gerar-pdf', express.json({ limit: '1mb' }), (req, res) => gerarProva(req, res, 'pdf'));
app.post('/api/provas/gerar-docx', express.json({ limit: '1mb' }), (req, res) => gerarProva(req, res, 'docx'));

// Provas já geradas, para o Painel do professor.
app.get('/api/provas', async (req, res) => {
  try {
    const limiteInformado = Number.parseInt(req.query.limite, 10);
    const limite = Number.isFinite(limiteInformado)
      ? Math.min(Math.max(limiteInformado, 1), 50)
      : 20;
    return res.json({ provas: await listarProvas(limite, req.cursosPermitidos) });
  } catch (err) {
    console.error('Erro ao listar provas:', err.message);
    return res.status(err.statusCode || 500).json({ erro: err.message });
  }
});

// Não existe rota para o professor alterar o status da prova: a geração
// já manda ela "Em análise" automaticamente (ver registrarProva), e só a
// Direção pode mudar isso a partir daí — pela rota de revisão abaixo.

// A Direção aprova, reprova ou deixa a prova em análise — com um
// comentário geral e, se reprovar, quais questões específicas pesaram na
// decisão. Só quem tem perfil de Direção pode usar esta rota; o professor
// só enxerga o resultado quando reabre a prova.
app.patch('/api/provas/:id/revisao', express.json({ limit: '8kb' }), async (req, res) => {
  try {
    if (req.usuario.perfil !== 'direcao') {
      return res.status(403).json({ erro: 'Somente a Direção pode revisar provas.' });
    }
    const existente = await buscarProvaPorId(req.params.id);
    if (!existente) return res.status(404).json({ erro: 'Prova não encontrada.' });

    const { status, comentario, questoesReprovadas } = req.body || {};
    const atualizada = await revisarProva(req.params.id, {
      status,
      comentario,
      questoesReprovadas,
      revisorId: req.usuarioId,
    });
    return res.json(atualizada);
  } catch (err) {
    console.error('Erro ao revisar a prova:', err.message);
    return res.status(err.statusCode || 500).json({ erro: err.message });
  }
});

app.delete('/api/questoes/:id', async (req, res) => {
  try {
    const existente = await buscarQuestaoPorId(req.params.id);
    if (!existente) return res.status(404).json({ erro: 'Questão não encontrada.' });
    if (!podeUsarCurso(req, existente.curso)) {
      return res.status(403).json({ erro: 'Você não leciona no curso dessa questão.' });
    }
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
      nomeArquivo: corrigirNomeArquivo(req.file.originalname),
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
      nomeArquivo: corrigirNomeArquivo(req.file.originalname),
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
    return res.json({ nomeArquivo: corrigirNomeArquivo(req.file.originalname), texto, confianca });
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
