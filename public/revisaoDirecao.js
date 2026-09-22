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
    questaoPorId, pedirJson, pedirPdf, ligarBotaoEnviarEmail,
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

  const painelPdfEl = document.getElementById('painelDirecaoPdf');
  const painelDecisaoEl = document.getElementById('painelDirecaoDecisao');
  const previaEl = document.getElementById('previaPdfDirecao');
  const statusPreviaEl = document.getElementById('statusPreviaDirecao');
  const linkNovaAbaEl = document.getElementById('linkPreviaDirecaoNovaAba');

  let provaAtual = null;
  let questoesFlagsSet = new Set();
  let urlPrevia = null;
  let controladorPrevia = null;

  function limparPrevia(mensagem = '', erro = false) {
    controladorPrevia?.abort();
    if (urlPrevia) URL.revokeObjectURL(urlPrevia);
    urlPrevia = null;
    previaEl.removeAttribute('src');
    linkNovaAbaEl.classList.add('oculto');
    statusPreviaEl.textContent = mensagem;
    statusPreviaEl.className = `previa-status${erro ? ' erro' : ''}`;
  }

  // A Direção decide olhando a prova como o professor a imprimiria — o
  // PDF é montado no servidor a partir do que foi salvo com a prova.
  async function carregarPrevia(prova) {
    limparPrevia('Montando o PDF da prova…');
    const controlador = new AbortController();
    controladorPrevia = controlador;
    try {
      const blob = await pedirPdf(`/api/provas/${encodeURIComponent(prova.id)}/previa-pdf`, { signal: controlador.signal });
      if (controlador.signal.aborted) return;
      urlPrevia = URL.createObjectURL(blob);
      previaEl.src = `${urlPrevia}#view=FitH`;
      linkNovaAbaEl.href = urlPrevia;
      linkNovaAbaEl.classList.remove('oculto');
      statusPreviaEl.textContent = 'Prova como foi enviada pelo professor.';
    } catch (err) {
      if (err.name === 'AbortError') return;
      limparPrevia(err.message, true);
    }
  }

  function selecionarAba(aba) {
    document.querySelectorAll('[data-aba-direcao]').forEach((botao) => {
      botao.classList.toggle('ativa', botao.dataset.abaDirecao === aba);
    });
    painelPdfEl.classList.toggle('oculto', aba !== 'prova');
    painelDecisaoEl.classList.toggle('oculto', aba !== 'decisao');
    // O PDF precisa de largura para ficar legível.
    drawerEl.classList.toggle('larga', aba === 'prova');
  }

  function fecharDrawer() {
    drawerEl.classList.add('oculto');
    overlayEl.classList.add('oculto');
    limparPrevia();
    provaAtual = null;
    document.getElementById('areaEnviarEmailDirecao').innerHTML = '';
    document.getElementById('statusEnvioEmailDirecao').textContent = '';
    document.getElementById('btnEnviarEmailDirecao').disabled = false;
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
            ${questao.arquivada ? '<span class="tag-arquivada" title="Foi excluída do banco depois desta prova ter sido montada">Excluída do banco</span>' : ''}
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

    selecionarAba('prova');
    carregarPrevia(prova);

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

  document.querySelectorAll('[data-aba-direcao]').forEach((botao) => {
    botao.addEventListener('click', () => selecionarAba(botao.dataset.abaDirecao));
  });
  document.getElementById('btnFecharDrawerRevisao').addEventListener('click', fecharDrawer);
  overlayEl.addEventListener('click', fecharDrawer);
  btnAprovar.addEventListener('click', () => enviarDecisao('aprovada'));
  btnReprovar.addEventListener('click', () => enviarDecisao('reprovada'));
  btnAnalise.addEventListener('click', () => enviarDecisao('em_revisao'));

  // Fica fora das abas de propósito: a Direção pode querer encaminhar a
  // prova por e-mail em qualquer momento da revisão, independente do
  // resultado (aprovada, reprovada ou ainda em análise).
  ligarBotaoEnviarEmail(
    document.getElementById('btnEnviarEmailDirecao'),
    document.getElementById('areaEnviarEmailDirecao'),
    document.getElementById('statusEnvioEmailDirecao'),
    () => provaAtual,
  );

  window.RevisaoDirecao = { abrir };
})();
