/* revisaoDirecao.js
 * Drawer "Revisão da Direção": o coordenador aprova, reprova ou deixa a
 * prova em análise, deixa um comentário para o professor e sinaliza quais
 * questões pesaram na decisão. Só é usado quando EstadoUsuario.atual.perfil
 * é "direcao" — painel.js decide quando abrir isso em vez do fluxo normal
 * de "Ver" prova do professor.
 */

(function () {
  const {
    escapeHtml, formatarPontos, textoLimpo, resumir, rotuloPeriodo,
    questaoPorId, pedirJson,
  } = window.App;

  const STATUS_ROTULO = {
    rascunho: 'Rascunho', em_revisao: 'Em análise', aprovada: 'Aprovada', reprovada: 'Reprovada',
  };
  const STATUS_CLASSE = { reprovada: 'reprovada', aprovada: 'aprovada', em_revisao: 'revisao' };

  const overlayEl = document.getElementById('drawerRevisaoOverlay');
  const drawerEl = document.getElementById('drawerRevisao');
  const tituloProvaEl = document.getElementById('revisaoTituloProva');
  const avisoAnteriorEl = document.getElementById('revisaoAvisoAnterior');
  const listaEl = document.getElementById('listaRevisaoQuestoes');
  const contadorEl = document.getElementById('contadorRevisaoQuestoes');
  const comentarioEl = document.getElementById('revisaoComentario');
  const statusEl = document.getElementById('statusRevisao');
  const btnAprovar = document.getElementById('btnAprovarProva');
  const btnReprovar = document.getElementById('btnReprovarProva');
  const btnAnalise = document.getElementById('btnDeixarEmAnalise');

  let provaAtual = null;
  let questoesFlagsSet = new Set();

  function fecharDrawer() {
    drawerEl.classList.add('oculto');
    overlayEl.classList.add('oculto');
    provaAtual = null;
  }

  function questoesDaProva(prova) {
    return (prova.questaoIds || []).map((id) => questaoPorId(id)).filter(Boolean);
  }

  function renderizarAvisoAnterior(prova) {
    if (!prova.revisadoEm) {
      avisoAnteriorEl.className = 'aviso-revisao oculto';
      avisoAnteriorEl.innerHTML = '';
      return;
    }
    avisoAnteriorEl.className = `aviso-revisao ${STATUS_CLASSE[prova.status] || ''}`;
    avisoAnteriorEl.innerHTML = `<strong>Já revisada: ${escapeHtml(STATUS_ROTULO[prova.status] || prova.status)}</strong>`
      + (prova.comentarioCoordenador ? `Último comentário: "${escapeHtml(prova.comentarioCoordenador)}"` : 'Nenhum comentário foi deixado.');
  }

  function renderizarLista(prova) {
    const questoes = questoesDaProva(prova);
    contadorEl.textContent = questoes.length ? `(${questoes.length})` : '';

    if (!questoes.length) {
      listaEl.innerHTML = '<div class="lista-vazia">As questões desta prova não estão mais no banco.</div>';
      return;
    }

    listaEl.innerHTML = questoes.map((questao, indice) => `
      <article class="item-revisao" data-id="${escapeHtml(questao.id)}">
        <div class="ordem">${indice + 1}</div>
        <div class="item-corpo">
          <div class="item-cabecalho">
            <span class="codigo">${escapeHtml(questao.codigo || '')}</span>
            <span class="pontos">${formatarPontos(questao.valor)} pts</span>
            <span class="item-origem">${escapeHtml(questao.assunto || '')} · ${escapeHtml(rotuloPeriodo(questao))}</span>
          </div>
          <p class="item-texto">${escapeHtml(resumir(textoLimpo(questao), 180) || '(vazio)')}</p>
          <label class="item-revisao-check">
            <input type="checkbox" data-flag ${questoesFlagsSet.has(questao.id) ? 'checked' : ''}>
            Sinalizar esta questão como motivo da reprovação
          </label>
        </div>
      </article>
    `).join('');

    listaEl.querySelectorAll('[data-flag]').forEach((caixa) => {
      const artigo = caixa.closest('[data-id]');
      caixa.addEventListener('change', () => {
        if (caixa.checked) questoesFlagsSet.add(artigo.dataset.id);
        else questoesFlagsSet.delete(artigo.dataset.id);
      });
    });
  }

  function abrir(prova) {
    if (!prova) return;
    provaAtual = prova;
    questoesFlagsSet = new Set(prova.questoesReprovadas || []);

    tituloProvaEl.textContent = `${prova.titulo} · ${prova.curso || '—'}`;
    comentarioEl.value = prova.comentarioCoordenador || '';
    statusEl.textContent = '';
    statusEl.className = 'status';

    renderizarAvisoAnterior(prova);
    renderizarLista(prova);

    drawerEl.classList.remove('oculto');
    overlayEl.classList.remove('oculto');
  }

  async function enviarDecisao(status) {
    if (!provaAtual) return;
    if (status === 'reprovada' && !questoesFlagsSet.size && !comentarioEl.value.trim()) {
      statusEl.textContent = 'Sinalize ao menos uma questão ou deixe um comentário explicando a reprovação.';
      statusEl.className = 'status erro';
      return;
    }

    [btnAprovar, btnReprovar, btnAnalise].forEach((botao) => { botao.disabled = true; });
    statusEl.textContent = 'Salvando…';
    statusEl.className = 'status';

    try {
      await pedirJson(`/api/provas/${encodeURIComponent(provaAtual.id)}/revisao`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          status,
          comentario: comentarioEl.value.trim(),
          questoesReprovadas: [...questoesFlagsSet],
        }),
      });
      fecharDrawer();
      await window.Painel?.renderizar();
    } catch (err) {
      statusEl.textContent = err.message;
      statusEl.className = 'status erro';
    } finally {
      [btnAprovar, btnReprovar, btnAnalise].forEach((botao) => { botao.disabled = false; });
    }
  }

  document.getElementById('btnFecharDrawerRevisao').addEventListener('click', fecharDrawer);
  overlayEl.addEventListener('click', fecharDrawer);
  btnAprovar.addEventListener('click', () => enviarDecisao('aprovada'));
  btnReprovar.addEventListener('click', () => enviarDecisao('reprovada'));
  btnAnalise.addEventListener('click', () => enviarDecisao('em_revisao'));

  window.RevisaoDirecao = { abrir };
})();
