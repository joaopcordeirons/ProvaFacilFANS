/* login.js
 * Tela de login/cadastro/verificação de e-mail/recuperação de senha.
 * Página independente da SPA principal (public/index.html) — não exige
 * sessão para carregar.
 */

const API_BASE = window.location.origin;

async function pedirJson(caminho, opcoes) {
  const resposta = await fetch(API_BASE + caminho, {
    ...opcoes,
    headers: { 'Content-Type': 'application/json', ...(opcoes?.headers || {}) },
  });
  const dados = await resposta.json().catch(() => ({}));
  if (!resposta.ok) {
    throw Object.assign(new Error(dados.erro || 'Falha na comunicação com o servidor.'), { dados });
  }
  return dados;
}

/* ---------------------------------------------------- cursos (cadastro) */

let cursosDisponiveis = [];

async function carregarCursos() {
  try {
    const dados = await pedirJson('/api/constantes');
    cursosDisponiveis = Array.isArray(dados.cursos) ? dados.cursos : [];
  } catch (_) {
    cursosDisponiveis = [];
  }
  const container = document.getElementById('cadastroCursosChecklist');
  container.innerHTML = cursosDisponiveis.map((curso) => `
    <label><input type="checkbox" value="${curso.replace(/"/g, '&quot;')}"> ${curso}</label>
  `).join('');
}

function cursosMarcadosNoCadastro() {
  return [...document.querySelectorAll('#cadastroCursosChecklist input:checked')].map((el) => el.value);
}

// O bloco de cursos só faz sentido pra Professor — Direção enxerga tudo.
function atualizarBlocoCursosCadastro() {
  const bloco = document.getElementById('blocoCadastroCursos');
  const ehProfessor = perfilSelecionado('perfilSeletorCadastro') === 'professor';
  bloco.classList.toggle('oculto', !ehProfessor);
  if (!ehProfessor) document.getElementById('erroCadastroCursos').classList.add('oculto');
}

/* ------------------------------------------------------- navegação entre vistas */

const VISTAS = ['vistaLogin', 'vistaCadastro', 'vistaEsqueci', 'vistaConfirmeEmail', 'vistaRedefinir', 'vistaVerificandoEmail'];

function mostrarVista(id) {
  VISTAS.forEach((vista) => {
    document.getElementById(vista).classList.toggle('oculto', vista !== id);
  });
}

document.getElementById('btnIrCadastro').addEventListener('click', () => mostrarVista('vistaCadastro'));
document.getElementById('btnVoltarLoginDeCadastro').addEventListener('click', () => mostrarVista('vistaLogin'));
document.getElementById('btnIrEsqueci').addEventListener('click', () => mostrarVista('vistaEsqueci'));
document.getElementById('btnVoltarLoginDeEsqueci').addEventListener('click', () => mostrarVista('vistaLogin'));
document.getElementById('btnVoltarLoginDeConfirme').addEventListener('click', () => mostrarVista('vistaLogin'));
document.getElementById('btnVoltarLoginDeVerificado')?.addEventListener('click', () => mostrarVista('vistaLogin'));

/* ------------------------------------------------------- seletor de perfil */

function ligarSeletorPerfil(idContainer) {
  const container = document.getElementById(idContainer);
  container.querySelectorAll('.perfil-opcao').forEach((botao) => {
    botao.addEventListener('click', () => {
      container.querySelectorAll('.perfil-opcao').forEach((b) => b.classList.remove('ativo'));
      botao.classList.add('ativo');
    });
  });
}

function perfilSelecionado(idContainer) {
  return document.querySelector(`#${idContainer} .perfil-opcao.ativo`)?.dataset.perfil || 'professor';
}

ligarSeletorPerfil('perfilSeletorLogin');
ligarSeletorPerfil('perfilSeletorCadastro');

// Mostra/esconde o checklist de cursos conforme o perfil escolhido no cadastro.
document.querySelectorAll('#perfilSeletorCadastro .perfil-opcao').forEach((botao) => {
  botao.addEventListener('click', atualizarBlocoCursosCadastro);
});
atualizarBlocoCursosCadastro();
carregarCursos();

/* ------------------------------------------------------------------- utilidades */

function definirStatus(elId, mensagem, tipo) {
  const el = document.getElementById(elId);
  el.textContent = mensagem || '';
  el.className = `status${tipo ? ' ' + tipo : ''}`;
}

// Mostra a vista "confirme seu e-mail" preenchida com o endereço certo —
// usada tanto logo após o cadastro quanto quando o login barra por conta
// de e-mail não confirmado.
function abrirVistaConfirmeEmail(email) {
  document.getElementById('confirmeEmailEndereco').textContent = email;
  document.getElementById('btnReenviarConfirmacao').dataset.email = email;
  definirStatus('statusConfirmeEmail', '', '');
  mostrarVista('vistaConfirmeEmail');
}

async function reenviarVerificacao(email, elStatusId, botao) {
  if (!email) return;
  botao.disabled = true;
  try {
    const resultado = await pedirJson('/api/auth/reenviar-verificacao', {
      method: 'POST',
      body: JSON.stringify({ email }),
    });
    definirStatus(elStatusId, resultado.mensagem, 'ok');
  } catch (err) {
    definirStatus(elStatusId, err.message, 'erro');
  } finally {
    botao.disabled = false;
  }
}

/* ------------------------------------------------------------------- login */

let ultimoEmailLogin = '';

document.getElementById('formLogin').addEventListener('submit', async (evento) => {
  evento.preventDefault();
  const btn = document.getElementById('btnEntrar');
  const btnReenviar = document.getElementById('btnReenviarDoLogin');
  definirStatus('statusLogin', '', '');
  btnReenviar.classList.add('oculto');
  btn.disabled = true;
  ultimoEmailLogin = document.getElementById('loginEmail').value.trim();
  try {
    await pedirJson('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({
        email: ultimoEmailLogin,
        senha: document.getElementById('loginSenha').value,
        perfil: perfilSelecionado('perfilSeletorLogin'),
        lembrarConectado: document.getElementById('loginLembrar').checked,
      }),
    });
    window.location.href = '/';
  } catch (err) {
    definirStatus('statusLogin', err.message, 'erro');
    if (err.dados?.emailNaoVerificado) btnReenviar.classList.remove('oculto');
  } finally {
    btn.disabled = false;
  }
});

document.getElementById('btnReenviarDoLogin').addEventListener('click', (evento) => {
  reenviarVerificacao(ultimoEmailLogin, 'statusLogin', evento.target);
});

/* ----------------------------------------------------------------- cadastro */

document.getElementById('formCadastro').addEventListener('submit', async (evento) => {
  evento.preventDefault();
  const btn = document.getElementById('btnCadastrar');
  definirStatus('statusCadastro', '', '');

  const senha = document.getElementById('cadastroSenha').value;
  const confirmar = document.getElementById('cadastroConfirmarSenha').value;
  if (senha !== confirmar) {
    definirStatus('statusCadastro', 'As senhas não coincidem.', 'erro');
    return;
  }

  const perfil = perfilSelecionado('perfilSeletorCadastro');
  const cursos = cursosMarcadosNoCadastro();
  const erroCursosEl = document.getElementById('erroCadastroCursos');
  if (perfil === 'professor' && !cursos.length) {
    erroCursosEl.classList.remove('oculto');
    return;
  }
  erroCursosEl.classList.add('oculto');

  btn.disabled = true;
  try {
    const email = document.getElementById('cadastroEmail').value.trim();
    await pedirJson('/api/auth/registrar', {
      method: 'POST',
      body: JSON.stringify({
        nome: document.getElementById('cadastroNome').value.trim(),
        email,
        senha,
        perfil,
        instituicao: document.getElementById('cadastroInstituicao').value.trim(),
        cargo: document.getElementById('cadastroCargo').value.trim(),
        cursos,
      }),
    });
    abrirVistaConfirmeEmail(email);
  } catch (err) {
    definirStatus('statusCadastro', err.message, 'erro');
  } finally {
    btn.disabled = false;
  }
});

document.getElementById('btnReenviarConfirmacao').addEventListener('click', (evento) => {
  reenviarVerificacao(evento.target.dataset.email, 'statusConfirmeEmail', evento.target);
});

/* --------------------------------------------------------- esqueci minha senha */

document.getElementById('formEsqueci').addEventListener('submit', async (evento) => {
  evento.preventDefault();
  const btn = document.getElementById('btnEnviarRecuperacao');
  definirStatus('statusEsqueci', '', '');
  btn.disabled = true;
  try {
    const resultado = await pedirJson('/api/auth/esqueci-senha', {
      method: 'POST',
      body: JSON.stringify({ email: document.getElementById('esqueciEmail').value.trim() }),
    });
    definirStatus('statusEsqueci', resultado.mensagem, 'ok');
  } catch (err) {
    definirStatus('statusEsqueci', err.message, 'erro');
  } finally {
    btn.disabled = false;
  }
});

/* ------------------------------------------------- redefinir senha (via link) */

document.getElementById('formRedefinir').addEventListener('submit', async (evento) => {
  evento.preventDefault();
  const btn = document.getElementById('btnRedefinir');
  definirStatus('statusRedefinir', '', '');

  const senha = document.getElementById('redefinirSenha').value;
  const confirmar = document.getElementById('redefinirConfirmarSenha').value;
  if (senha !== confirmar) {
    definirStatus('statusRedefinir', 'As senhas não coincidem.', 'erro');
    return;
  }

  const token = new URLSearchParams(window.location.search).get('token');
  btn.disabled = true;
  try {
    await pedirJson('/api/auth/redefinir-senha', {
      method: 'POST',
      body: JSON.stringify({ token, novaSenha: senha }),
    });
    definirStatus('statusRedefinir', 'Senha redefinida! Faça login com a nova senha.', 'ok');
    setTimeout(() => {
      window.history.replaceState({}, '', '/login.html');
      mostrarVista('vistaLogin');
    }, 1500);
  } catch (err) {
    definirStatus('statusRedefinir', err.message, 'erro');
  } finally {
    btn.disabled = false;
  }
});

/* -------------------------------------------- verificação de e-mail (via link) */

async function processarLinkDeVerificacao(token) {
  mostrarVista('vistaVerificandoEmail');
  try {
    await pedirJson('/api/auth/verificar-email', {
      method: 'POST',
      body: JSON.stringify({ token }),
    });
    document.getElementById('verificandoEmailTexto').textContent = 'Tudo certo!';
    definirStatus('statusVerificandoEmail', 'E-mail confirmado. Você já pode entrar.', 'ok');
  } catch (err) {
    document.getElementById('verificandoEmailTexto').textContent = 'Não foi possível confirmar.';
    definirStatus('statusVerificandoEmail', err.message, 'erro');
  } finally {
    document.getElementById('btnVoltarLoginDeVerificado').classList.remove('oculto');
    window.history.replaceState({}, '', '/login.html');
  }
}

/* --------------------------------------------------------------- inicialização */

const parametros = new URLSearchParams(window.location.search);
const tokenRedefinir = parametros.get('token');
const tokenVerificar = parametros.get('verificar');

if (tokenVerificar) {
  processarLinkDeVerificacao(tokenVerificar);
} else if (tokenRedefinir) {
  mostrarVista('vistaRedefinir');
}
