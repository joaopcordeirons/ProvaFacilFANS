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
    EstadoUsuario, cursosDoUsuario, opcoesCurso, opcoesPeriodo,
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

  let urlArquivoAtual = null;

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
    const pontos = pontuacaoSelecionada();

    document.getElementById('resumoSelecionadas').textContent = `${selecionadas.length} de ${Estado.questoes.length}`;
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

  /* --------------------------------------- cabeçalho da prova (curso/período) */

  // Preenche o título e os selects de Curso/Período do cabeçalho da prova
  // com base no(s) curso(s) do usuário logado. Só roda uma vez — depois
  // disso é o professor quem decide os valores.
  let cabecalhoPreparado = false;
  function prepararCabecalhoProva() {
    if (cabecalhoPreparado || !EstadoUsuario.atual) return;
    const cursos = cursosDoUsuario();

    const tituloDisciplinaEl = document.getElementById('tituloDisciplinaMontagem');
    if (tituloDisciplinaEl) {
      tituloDisciplinaEl.textContent = cursos.length === 1
        ? cursos[0]
        : (EstadoUsuario.atual.perfil === 'direcao' ? 'Todos os cursos' : 'Meus cursos');
    }

    const campoCursoEl = document.getElementById('campoCurso');
    if (campoCursoEl) campoCursoEl.innerHTML = opcoesCurso(cursos[0]);

    const campoPeriodoEl = document.getElementById('campoPeriodo');
    if (campoPeriodoEl) campoPeriodoEl.innerHTML = opcoesPeriodo();

    const campoTituloEl = document.getElementById('campoTitulo');
    if (campoTituloEl && (!campoTituloEl.value || campoTituloEl.value === 'Avaliação')) {
      campoTituloEl.value = cursos.length === 1 ? `Avaliação de ${cursos[0]}` : 'Avaliação';
    }

    cabecalhoPreparado = true;
  }

  function renderizarMontagem() {
    if (!listaMontagemEl) return;
    prepararCabecalhoProva();

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
                <span class="item-origem">${escapeHtml(rotuloPeriodo(questao))}${cursosDoUsuario().length > 1 ? ` · ${escapeHtml(questao.curso || '—')}` : ''}</span>
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
    prepararCabecalhoProva();

    const selecionadas = questoesSelecionadas();
    contadorRevisaoEl.textContent = `(${selecionadas.length} · ${formatarPontos(pontuacaoSelecionada())} pts)`;

    if (!selecionadas.length) {
      listaRevisaoEl.innerHTML = '<div class="lista-vazia">Nenhuma questão selecionada. Volte para o passo 2.</div>';
      document.getElementById('btnGerarPdf').disabled = true;
      document.getElementById('btnGerarDocx').disabled = true;
      return;
    }

    document.getElementById('btnGerarPdf').disabled = false;
    document.getElementById('btnGerarDocx').disabled = false;
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

  /* ------------------------------------ geração do arquivo da prova */

  // Campos do quadro de identificação do template oficial da FANS
  // (curso, período, etapa, data, valor) — os mesmos no PDF e no DOCX.
  function dadosDoCabecalho() {
    const dataEscolhida = document.getElementById('campoData').value;
    return {
      titulo: document.getElementById('campoTitulo').value.trim() || 'Avaliação',
      curso: document.getElementById('campoCurso').value.trim(),
      periodo: document.getElementById('campoPeriodo').value.trim(),
      etapa: document.getElementById('campoEtapa').value.trim(),
      valorProva: document.getElementById('campoValorProva').value.trim(),
      professor: document.getElementById('campoProfessor').value.trim(),
      // O input type="date" devolve AAAA-MM-DD; a prova impressa usa o
      // formato brasileiro.
      data: dataEscolhida ? dataEscolhida.split('-').reverse().join('/') : '',
      instrucoes: document.getElementById('campoInstrucoes').value.trim(),
      linhasResposta: Number(document.getElementById('campoLinhas').value),
    };
  }

  function nomeDoArquivo(titulo, extensao) {
    const base = titulo
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^\p{L}\p{N}]+/gu, '-')
      .replace(/^-|-$/g, '')
      .toLowerCase() || 'prova';
    return `${base}.${extensao}`;
  }

  // PDF e DOCX saem no mesmo modelo; muda só o endpoint e o que dá para
  // mostrar na tela (o navegador não pré-visualiza .docx).
  async function gerarProva(formato) {
    const botoes = [document.getElementById('btnGerarPdf'), document.getElementById('btnGerarDocx')];
    const ids = Estado.selecionadas.slice();
    if (!ids.length) return;

    botoes.forEach((botao) => { botao.disabled = true; });
    statusPdfEl.textContent = `Montando o ${formato.toUpperCase()}...`;
    statusPdfEl.className = 'status';

    try {
      const dados = dadosDoCabecalho();
      const resposta = await fetch(`${API_BASE}/api/provas/gerar-${formato}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...dados, questaoIds: ids }),
      });

      // Em caso de erro o servidor responde JSON, não o arquivo.
      if (!resposta.ok) {
        const erro = await resposta.json().catch(() => ({}));
        throw new Error(erro.erro || `Falha ao gerar o ${formato.toUpperCase()} (HTTP ${resposta.status}).`);
      }

      const blob = await resposta.blob();
      if (urlArquivoAtual) URL.revokeObjectURL(urlArquivoAtual);
      urlArquivoAtual = URL.createObjectURL(blob);

      const nomeArquivo = nomeDoArquivo(dados.titulo, formato);

      // Dispara o download.
      const ancoraTemporaria = document.createElement('a');
      ancoraTemporaria.href = urlArquivoAtual;
      ancoraTemporaria.download = nomeArquivo;
      document.body.appendChild(ancoraTemporaria);
      ancoraTemporaria.click();
      ancoraTemporaria.remove();

      linkPdfEl.href = urlArquivoAtual;
      linkPdfEl.download = nomeArquivo;
      linkPdfEl.textContent = `Baixar o ${formato.toUpperCase()} novamente`;
      linkPdfEl.classList.remove('oculto');

      // Só o PDF dá para conferir na própria tela.
      if (formato === 'pdf') {
        previaPdfEl.src = urlArquivoAtual;
        painelPreviaPdfEl.classList.remove('oculto');
      } else {
        previaPdfEl.removeAttribute('src');
        painelPreviaPdfEl.classList.add('oculto');
      }

      const plural = ids.length === 1 ? 'questão' : 'questões';
      statusPdfEl.textContent = formato === 'pdf'
        ? `PDF gerado com ${ids.length} ${plural}. O download começou automaticamente.`
        : `DOCX gerado com ${ids.length} ${plural}. Abra no Word para editar antes de imprimir.`;
      statusPdfEl.className = 'status ok';

      // O contador "usada em N provas" e a lista do painel mudaram no
      // servidor (a prova gerada fica registrada em /api/provas).
      window.App.carregarQuestoes();
      window.Painel?.renderizar();
    } catch (err) {
      statusPdfEl.textContent = err.message;
      statusPdfEl.className = 'status erro';
    } finally {
      botoes.forEach((botao) => { botao.disabled = false; });
    }
  }

  /* --------------------------------------------- ligações de tela */

  document.getElementById('btnContinuarRevisao').addEventListener('click', () => mostrarView('revisao'));
  document.getElementById('btnAdicionarMais').addEventListener('click', () => mostrarView('banco'));
  document.getElementById('btnVoltarMontagem').addEventListener('click', () => mostrarView('montar'));
  document.getElementById('btnGerarPdf').addEventListener('click', () => gerarProva('pdf'));
  document.getElementById('btnGerarDocx').addEventListener('click', () => gerarProva('docx'));

  // Data de hoje já preenchida no cabeçalho da prova.
  const campoData = document.getElementById('campoData');
  if (!campoData.value) campoData.value = new Date().toISOString().slice(0, 10);

  window.MontagemProva = { renderizarMontagem, renderizarRevisao };
  renderizarMontagem();
})();
