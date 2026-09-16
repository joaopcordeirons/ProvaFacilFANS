/* montarProva.js
 * Passo 2 (escolher as questões) e passo 3 (revisar a ordem, preencher o
 * cabeçalho e gerar o PDF) do fluxo "Montar a prova".
 *
 * Lê e escreve o mesmo estado do Banco de Questões, exposto em window.App.
 */

(function () {
  const {
    Estado, API_BASE, escapeHtml, formatarPontos, textoLimpo, resumir,
    rotuloPeriodo, estaSelecionada, alternarSelecao, salvarSelecao,
    questaoPorId, questoesSelecionadas, pontuacaoSelecionada, mostrarView,
  } = window.App;

  const PONTUACAO_ALVO = 10;

  const listaMontagemEl = document.getElementById('listaMontagem');
  const contadorDisponiveisEl = document.getElementById('contadorDisponiveis');
  const listaRevisaoEl = document.getElementById('listaRevisao');
  const contadorRevisaoEl = document.getElementById('contadorRevisao');
  const statusPdfEl = document.getElementById('statusPdf');
  const linkPdfEl = document.getElementById('linkPdf');
  const previaPdfEl = document.getElementById('previaPdf');
  const painelPreviaPdfEl = document.getElementById('painelPreviaPdf');

  let urlPdfAtual = null;

  /* --------------------------------------------- passo 2: seleção */

  // As já escolhidas sobem para o topo, na ordem em que entraram na prova
  // — é essa ordem que o PDF vai seguir.
  function questoesOrdenadasParaMontagem() {
    const selecionadas = questoesSelecionadas();
    const restantes = Estado.questoes.filter((questao) => !estaSelecionada(questao.id));
    return [...selecionadas, ...restantes];
  }

  function renderizarResumo() {
    const selecionadas = questoesSelecionadas();
    const atuais = selecionadas.filter((questao) => questao.periodo !== 'historico').length;
    const pontos = pontuacaoSelecionada();

    document.getElementById('resumoSelecionadas').textContent = `${selecionadas.length} de ${Estado.questoes.length}`;
    const plural = (quantidade) => `${quantidade} ${quantidade === 1 ? 'questão' : 'questões'}`;
    document.getElementById('resumoAtuais').textContent = plural(atuais);
    document.getElementById('resumoHistoricas').textContent = plural(selecionadas.length - atuais);
    document.getElementById('resumoPontos').textContent = `${formatarPontos(pontos)} pts`;
    document.getElementById('resumoNota').textContent = `${formatarPontos(pontos)} / ${formatarPontos(PONTUACAO_ALVO)}`;

    const avisoEl = document.getElementById('resumoAviso');
    const diferenca = Math.round((pontos - PONTUACAO_ALVO) * 100) / 100;
    if (!selecionadas.length) {
      avisoEl.className = 'resumo-aviso';
      avisoEl.textContent = 'Marque as questões que vão compor a prova.';
    } else if (diferenca === 0) {
      avisoEl.className = 'resumo-aviso ok';
      avisoEl.textContent = 'A soma dos valores fecha em 10,0 pontos.';
    } else if (diferenca < 0) {
      avisoEl.className = 'resumo-aviso alerta';
      avisoEl.textContent = `Faltam ${formatarPontos(-diferenca)} pontos para fechar 10,0.`;
    } else {
      avisoEl.className = 'resumo-aviso alerta';
      avisoEl.textContent = `A prova está ${formatarPontos(diferenca)} pontos acima de 10,0.`;
    }

    document.getElementById('btnContinuarRevisao').disabled = selecionadas.length === 0;
  }

  function renderizarMontagem() {
    if (!listaMontagemEl) return;

    const questoes = questoesOrdenadasParaMontagem();
    contadorDisponiveisEl.textContent = `(${questoes.length})`;

    listaMontagemEl.innerHTML = questoes.length
      ? questoes.map((questao) => `
          <article class="item-montagem ${estaSelecionada(questao.id) ? 'escolhida' : ''}" data-id="${escapeHtml(questao.id)}">
            <button type="button" class="caixa-selecao ${estaSelecionada(questao.id) ? 'marcada' : ''}"
              aria-label="${estaSelecionada(questao.id) ? 'Remover da prova' : 'Adicionar à prova'}"></button>
            <div class="item-corpo">
              <div class="item-cabecalho">
                <span class="codigo">${escapeHtml(questao.codigo)}</span>
                <span class="pontos">${formatarPontos(questao.valor)} PTS</span>
                <span class="item-origem">${escapeHtml(rotuloPeriodo(questao))}</span>
              </div>
              <p class="item-texto">${escapeHtml(resumir(textoLimpo(questao), 150) || '(vazio)')}</p>
            </div>
          </article>
        `).join('')
      : '<div class="lista-vazia">Nenhuma questão no banco ainda. Cadastre questões no Banco de Questões.</div>';

    listaMontagemEl.querySelectorAll('.item-montagem').forEach((elemento) => {
      elemento.addEventListener('click', () => {
        alternarSelecao(elemento.dataset.id);
        renderizarMontagem();
      });
    });

    renderizarResumo();
  }

  /* --------------------------------------------- passo 3: revisão */

  function moverQuestao(id, direcao) {
    const posicao = Estado.selecionadas.indexOf(id);
    const destino = posicao + direcao;
    if (posicao < 0 || destino < 0 || destino >= Estado.selecionadas.length) return;
    const [movida] = Estado.selecionadas.splice(posicao, 1);
    Estado.selecionadas.splice(destino, 0, movida);
    salvarSelecao();
    renderizarRevisao();
  }

  function renderizarRevisao() {
    if (!listaRevisaoEl) return;

    const selecionadas = questoesSelecionadas();
    contadorRevisaoEl.textContent = `(${selecionadas.length} · ${formatarPontos(pontuacaoSelecionada())} pts)`;

    if (!selecionadas.length) {
      listaRevisaoEl.innerHTML = '<div class="lista-vazia">Nenhuma questão selecionada. Volte para o passo 2.</div>';
      document.getElementById('btnGerarPdf').disabled = true;
      return;
    }

    document.getElementById('btnGerarPdf').disabled = false;
    listaRevisaoEl.innerHTML = selecionadas.map((questao, indice) => `
      <article class="item-revisao" data-id="${escapeHtml(questao.id)}">
        <div class="ordem">${indice + 1}</div>
        <div class="item-corpo">
          <div class="item-cabecalho">
            <span class="codigo">${escapeHtml(questao.codigo)}</span>
            <span class="pontos">${formatarPontos(questao.valor)} pts</span>
            <span class="item-origem">${escapeHtml(questao.assunto)} · ${escapeHtml(rotuloPeriodo(questao))}</span>
          </div>
          <p class="item-texto">${escapeHtml(resumir(textoLimpo(questao), 180) || '(vazio)')}</p>
        </div>
        <div class="item-controles">
          <button type="button" data-mover="-1" aria-label="Subir" ${indice === 0 ? 'disabled' : ''}>↑</button>
          <button type="button" data-mover="1" aria-label="Descer" ${indice === selecionadas.length - 1 ? 'disabled' : ''}>↓</button>
          <button type="button" data-remover aria-label="Tirar da prova">✕</button>
        </div>
      </article>
    `).join('');

    listaRevisaoEl.querySelectorAll('.item-revisao').forEach((elemento) => {
      const id = elemento.dataset.id;
      elemento.querySelectorAll('[data-mover]').forEach((botao) => {
        botao.addEventListener('click', () => moverQuestao(id, Number(botao.dataset.mover)));
      });
      elemento.querySelector('[data-remover]').addEventListener('click', () => {
        alternarSelecao(id);
        renderizarRevisao();
        window.App.renderizarBanco();
      });
    });
  }

  /* --------------------------------------------- geração do PDF */

  function dadosDoCabecalho() {
    const dataEscolhida = document.getElementById('campoData').value;
    return {
      titulo: document.getElementById('campoTitulo').value.trim() || 'Avaliação',
      instituicao: document.getElementById('campoInstituicao').value.trim(),
      disciplina: document.getElementById('campoDisciplina').value.trim(),
      professor: document.getElementById('campoProfessor').value.trim(),
      turma: document.getElementById('campoTurma').value.trim(),
      // O input type="date" devolve AAAA-MM-DD; a prova impressa usa o
      // formato brasileiro.
      data: dataEscolhida ? dataEscolhida.split('-').reverse().join('/') : '',
      instrucoes: document.getElementById('campoInstrucoes').value.trim(),
      linhasResposta: Number(document.getElementById('campoLinhas').value),
    };
  }

  async function gerarPdf() {
    const botao = document.getElementById('btnGerarPdf');
    const ids = Estado.selecionadas.slice();
    if (!ids.length) return;

    botao.disabled = true;
    statusPdfEl.textContent = 'Montando o PDF...';
    statusPdfEl.className = 'status';

    try {
      const resposta = await fetch(`${API_BASE}/api/provas/gerar-pdf`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...dadosDoCabecalho(), questaoIds: ids }),
      });

      // Em caso de erro o servidor responde JSON, não PDF.
      if (!resposta.ok) {
        const erro = await resposta.json().catch(() => ({}));
        throw new Error(erro.erro || `Falha ao gerar o PDF (HTTP ${resposta.status}).`);
      }

      const blob = await resposta.blob();
      if (urlPdfAtual) URL.revokeObjectURL(urlPdfAtual);
      urlPdfAtual = URL.createObjectURL(blob);

      const nomeArquivo = `${dadosDoCabecalho().titulo.replace(/[^\p{L}\p{N}]+/gu, '-').toLowerCase() || 'prova'}.pdf`;

      // Dispara o download e deixa a prévia na tela para conferência.
      const ancoraTemporaria = document.createElement('a');
      ancoraTemporaria.href = urlPdfAtual;
      ancoraTemporaria.download = nomeArquivo;
      document.body.appendChild(ancoraTemporaria);
      ancoraTemporaria.click();
      ancoraTemporaria.remove();

      linkPdfEl.href = urlPdfAtual;
      linkPdfEl.download = nomeArquivo;
      linkPdfEl.classList.remove('oculto');

      previaPdfEl.src = urlPdfAtual;
      painelPreviaPdfEl.classList.remove('oculto');

      statusPdfEl.textContent = `PDF gerado com ${ids.length} ${ids.length === 1 ? 'questão' : 'questões'}. O download começou automaticamente.`;
      statusPdfEl.className = 'status ok';

      // O contador "usada em N provas" mudou no servidor.
      window.App.carregarQuestoes();
    } catch (err) {
      statusPdfEl.textContent = err.message;
      statusPdfEl.className = 'status erro';
    } finally {
      botao.disabled = false;
    }
  }

  /* --------------------------------------------- ligações de tela */

  document.getElementById('btnContinuarRevisao').addEventListener('click', () => mostrarView('revisao'));
  document.getElementById('btnAdicionarMais').addEventListener('click', () => mostrarView('banco'));
  document.getElementById('btnVoltarMontagem').addEventListener('click', () => mostrarView('montar'));
  document.getElementById('btnGerarPdf').addEventListener('click', gerarPdf);

  // Data de hoje já preenchida no cabeçalho da prova.
  const campoData = document.getElementById('campoData');
  if (!campoData.value) campoData.value = new Date().toISOString().slice(0, 10);

  window.MontagemProva = { renderizarMontagem, renderizarRevisao };
  renderizarMontagem();
})();
