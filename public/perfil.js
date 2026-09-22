/* perfil.js
 * Tela 04 · Perfil: dados pessoais, segurança (troca de senha) e
 * preferências. Usa o usuário carregado por app.js em window.App.EstadoUsuario.
 */

(function () {
  const { EstadoUsuario, pedirJson, Constantes } = window.App;

  function iniciais(nome) {
    const partes = String(nome || '').trim().split(/\s+/).filter(Boolean);
    if (!partes.length) return '··';
    const primeira = partes[0][0] || '';
    const ultima = partes.length > 1 ? partes[partes.length - 1][0] : '';
    return (primeira + ultima).toUpperCase();
  }

  function rotuloPerfil(perfil) {
    return perfil === 'direcao' ? 'Direção' : 'Professor';
  }

  function definirStatus(elId, mensagem, tipo) {
    const el = document.getElementById(elId);
    if (!el) return;
    el.textContent = mensagem || '';
    el.className = `status${tipo ? ' ' + tipo : ''}`;
  }

  let carregadoUmaVez = false;

  function renderizar() {
    const usuario = EstadoUsuario.atual;
    if (!usuario) return;

    document.getElementById('perfilAvatar').textContent = iniciais(usuario.nome);
    document.getElementById('perfilNomeCabecalho').textContent = usuario.nome;
    document.getElementById('perfilLegendaCabecalho').textContent =
      [rotuloPerfil(usuario.perfil), usuario.instituicao || null].filter(Boolean).join(' · ');

    // Só preenche os campos do formulário na primeira renderização (ou
    // depois de salvar), para não sobrescrever o que o usuário está
    // digitando se ele voltar a essa tela no meio de uma edição.
    if (!carregadoUmaVez) {
      document.getElementById('perfilNome').value = usuario.nome || '';
      document.getElementById('perfilEmail').value = usuario.email || '';
      document.getElementById('perfilInstituicao').value = usuario.instituicao || '';
      document.getElementById('perfilCargo').value = usuario.cargo || '';
      document.getElementById('perfilNotificacoes').checked = usuario.notificacoesEmail !== false;
      document.getElementById('perfilIdioma').value = usuario.idioma || 'pt-BR';
      renderizarChecklistCursos(usuario);
      carregadoUmaVez = true;
    }
  }

  // Só professores escolhem curso — a Direção enxerga todos, então nem
  // mostra o bloco.
  function renderizarChecklistCursos(usuario) {
    const bloco = document.getElementById('blocoPerfilCursos');
    const container = document.getElementById('perfilCursosChecklist');
    if (usuario.perfil !== 'professor') {
      bloco.classList.add('oculto');
      return;
    }
    bloco.classList.remove('oculto');
    const selecionados = new Set(usuario.cursos || []);
    container.innerHTML = Constantes.cursos.map((curso) => `
      <label>
        <input type="checkbox" value="${curso.replace(/"/g, '&quot;')}" ${selecionados.has(curso) ? 'checked' : ''}>
        ${curso}
      </label>
    `).join('');
  }

  function cursosMarcados() {
    return [...document.querySelectorAll('#perfilCursosChecklist input:checked')].map((el) => el.value);
  }

  /* --------------------------------------------------- informações pessoais */

  document.getElementById('formPerfil').addEventListener('submit', async (evento) => {
    evento.preventDefault();
    const btn = document.getElementById('btnSalvarPerfil');
    definirStatus('statusPerfil', '', '');
    btn.disabled = true;
    try {
      const { usuario } = await pedirJson('/api/auth/perfil', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          nome: document.getElementById('perfilNome').value.trim(),
          instituicao: document.getElementById('perfilInstituicao').value.trim(),
          cargo: document.getElementById('perfilCargo').value.trim(),
          ...(EstadoUsuario.atual.perfil === 'professor' ? { cursos: cursosMarcados() } : {}),
        }),
      });
      EstadoUsuario.atual = usuario;
      carregadoUmaVez = false;
      renderizar();
      definirStatus('statusPerfil', 'Alterações salvas.', 'ok');
    } catch (err) {
      definirStatus('statusPerfil', err.message, 'erro');
    } finally {
      btn.disabled = false;
    }
  });

  // Toggles de preferências salvam na hora, sem precisar de um botão à parte.
  document.getElementById('perfilNotificacoes').addEventListener('change', async (evento) => {
    try {
      const { usuario } = await pedirJson('/api/auth/perfil', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notificacoesEmail: evento.target.checked }),
      });
      EstadoUsuario.atual = usuario;
    } catch (err) {
      evento.target.checked = !evento.target.checked; // reverte em caso de falha
      await avisar({ titulo: 'Não foi possível salvar', mensagem: err.message });
    }
  });

  /* -------------------------------------------------------------- segurança */

  const modalSenha = document.getElementById('modalAlterarSenha');
  const formSenha = document.getElementById('formAlterarSenha');

  document.getElementById('btnAbrirAlterarSenha').addEventListener('click', () => {
    formSenha.reset();
    definirStatus('statusAlterarSenha', '', '');
    modalSenha.classList.remove('oculto');
  });
  document.getElementById('btnCancelarAlterarSenha').addEventListener('click', () => {
    modalSenha.classList.add('oculto');
  });

  formSenha.addEventListener('submit', async (evento) => {
    evento.preventDefault();
    const nova = document.getElementById('senhaNovaCampo').value;
    const confirmar = document.getElementById('senhaNovaConfirmarCampo').value;
    if (nova !== confirmar) {
      definirStatus('statusAlterarSenha', 'As senhas não coincidem.', 'erro');
      return;
    }
    const btn = document.getElementById('btnConfirmarAlterarSenha');
    btn.disabled = true;
    try {
      await pedirJson('/api/auth/alterar-senha', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          senhaAtual: document.getElementById('senhaAtualCampo').value,
          novaSenha: nova,
        }),
      });
      definirStatus('statusAlterarSenha', 'Senha alterada com sucesso.', 'ok');
      setTimeout(() => modalSenha.classList.add('oculto'), 900);
    } catch (err) {
      definirStatus('statusAlterarSenha', err.message, 'erro');
    } finally {
      btn.disabled = false;
    }
  });

  /* ------------------------------------------------------------ zona de risco */

  const modalExcluir = document.getElementById('modalExcluirConta');

  document.getElementById('btnAbrirExclusao').addEventListener('click', () => {
    definirStatus('statusExcluirConta', '', '');
    modalExcluir.classList.remove('oculto');
  });
  document.getElementById('btnCancelarExclusao').addEventListener('click', () => {
    modalExcluir.classList.add('oculto');
  });
  document.getElementById('btnConfirmarExclusao').addEventListener('click', async (evento) => {
    evento.target.disabled = true;
    try {
      await pedirJson('/api/auth/conta', { method: 'DELETE' });
      window.location.href = '/login.html';
    } catch (err) {
      definirStatus('statusExcluirConta', err.message, 'erro');
      evento.target.disabled = false;
    }
  });

  window.Perfil = { renderizar };
})();
