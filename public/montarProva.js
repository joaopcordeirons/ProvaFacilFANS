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
  const statusEnvioEl = document.getElementById('statusEnvio');
  const linkPdfEl = document.getElementById('linkPdf');
  const previaPdfEl = document.getElementById('previaPdf');
  const painelPreviaPdfEl = document.getElementById('painelPreviaPdf');
  const btnSalvarRascunhoEl = document.getElementById('btnSalvarRascunho');
  const btnEnviarCoordenadorEl = document.getElementById('btnEnviarCoordenador');
  const avisoProvaTravadaEl = document.getElementById('avisoProvaTravada');
  const btnDuplicarProvaEl = document.getElementById('btnDuplicarProva');
  const btnAdicionarMaisEl = document.getElementById('btnAdicionarMais');
  const btnRemoverSelecionadasEl = document.getElementById('btnRemoverSelecionadas');
  const CAMPOS_CABECALHO_IDS = [
    'campoTitulo', 'campoCurso', 'campoPeriodo', 'campoEtapa', 'campoData',
    'campoValorProva', 'campoProfessor', 'campoInstrucoes', 'campoLinhas',
  ];

  // IDs marcados na caixinha de cada questão para remover várias de uma
  // vez em "Remover selecionadas", em vez de clicar no ✕ uma por uma.
  const idsParaRemoverEmLote = new Set();

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

  const STATUS_ROTULO_FEEDBACK = {
    reprovada: 'Reprovada pela Direção',
    aprovada: 'Aprovada pela Direção',
    em_revisao: 'Em análise pela Direção',
    rascunho: 'Observação da Direção',
  };
  const STATUS_CLASSE_FEEDBACK = { reprovada: 'reprovada', aprovada: 'aprovada', em_revisao: 'revisao' };
  const avisoFeedbackEl = document.getElementById('avisoFeedbackDirecao');

  function renderizarAvisoFeedback() {
    if (!avisoFeedbackEl) return;
    const feedback = Estado.provaFeedback;
    if (!feedback) {
      avisoFeedbackEl.className = 'aviso-revisao oculto';
      avisoFeedbackEl.innerHTML = '';
      return;
    }
    const rotulo = STATUS_ROTULO_FEEDBACK[feedback.status] || STATUS_ROTULO_FEEDBACK.rascunho;
    avisoFeedbackEl.className = `aviso-revisao ${STATUS_CLASSE_FEEDBACK[feedback.status] || ''}`;
    avisoFeedbackEl.innerHTML = `<strong>${escapeHtml(rotulo)}</strong>`
      + (feedback.comentario ? escapeHtml(feedback.comentario) : 'Nenhum comentário foi deixado.')
      + (feedback.questoesReprovadas.length
        ? ` ${feedback.questoesReprovadas.length === 1 ? 'A questão sinalizada está marcada' : 'As questões sinalizadas estão marcadas'} abaixo.`
        : '');
  }

  // Uma prova só é editável de verdade enquanto ainda for um rascunho —
  // depois de enviada, a tela vira só leitura (ver aplicarTravamento).
  function provaEstaTravada() {
    return Boolean(Estado.provaAtualStatus) && Estado.provaAtualStatus !== 'rascunho';
  }

  // Desabilita o cabeçalho e as ações que alterariam a prova enviada;
  // "Duplicar como nova prova" é o único jeito de voltar a editar. Some
  // Salvar/Enviar da tela em vez de só desabilitar — botão apagado do
  // lado do aviso não ajudava em nada.
  function aplicarTravamento() {
    const travada = provaEstaTravada();
    avisoProvaTravadaEl.classList.toggle('oculto', !travada);
    btnSalvarRascunhoEl.classList.toggle('oculto', travada);
    btnEnviarCoordenadorEl.classList.toggle('oculto', travada);
    CAMPOS_CABECALHO_IDS.forEach((id) => {
      const campo = document.getElementById(id);
      if (campo) campo.disabled = travada;
    });
    btnAdicionarMaisEl.disabled = travada;
    return travada;
  }

  function renderizarRevisao() {
    if (!listaRevisaoEl) return;
    prepararCabecalhoProva();
    renderizarAvisoFeedback();
    const travada = aplicarTravamento();

    const selecionadas = questoesSelecionadas();
    const flags = new Set(Estado.provaFeedback?.questoesReprovadas || []);
    contadorRevisaoEl.textContent = `(${selecionadas.length} · ${formatarPontos(pontuacaoSelecionada())} pts)`;

    // Uma questão marcada que saiu da prova por outro caminho (ex.: o ✕
    // de outra sessão) não deve continuar contando pro lote.
    const idsAtuais = new Set(selecionadas.map((questao) => questao.id));
    idsParaRemoverEmLote.forEach((id) => { if (!idsAtuais.has(id)) idsParaRemoverEmLote.delete(id); });

    function atualizarBotaoRemoverLote() {
      const quantidade = idsParaRemoverEmLote.size;
      btnRemoverSelecionadasEl.textContent = `Remover selecionadas (${quantidade})`;
      btnRemoverSelecionadasEl.classList.toggle('oculto', travada || quantidade === 0);
    }

    if (!selecionadas.length) {
      listaRevisaoEl.innerHTML = '<div class="lista-vazia">Nenhuma questão selecionada. Volte para o passo 2.</div>';
      document.getElementById('btnGerarPdf').disabled = true;
      document.getElementById('btnGerarDocx').disabled = true;
      btnSalvarRascunhoEl.disabled = true;
      btnEnviarCoordenadorEl.disabled = true;
      atualizarBotaoRemoverLote();
      return;
    }

    document.getElementById('btnGerarPdf').disabled = false;
    document.getElementById('btnGerarDocx').disabled = false;
    btnSalvarRascunhoEl.disabled = travada;
    btnEnviarCoordenadorEl.disabled = travada;
    listaRevisaoEl.innerHTML = selecionadas.map((questao, indice) => `
      <article class="item-revisao ${flags.has(questao.id) ? 'reprovada-pela-direcao' : ''}" data-id="${escapeHtml(questao.id)}">
        <div class="ordem">${indice + 1}</div>
        <div class="item-corpo">
          <div class="item-cabecalho">
            <span class="codigo">${escapeHtml(questao.codigo)}</span>
            <span class="pontos">${formatarPontos(questao.valor)} pts</span>
            <span class="item-origem">${escapeHtml(questao.assunto)} · ${escapeHtml(rotuloPeriodo(questao))}</span>
            ${flags.has(questao.id) ? '<span class="tag-reprovada">Reprovada pela Direção</span>' : ''}
          </div>
          <p class="item-texto">${escapeHtml(resumir(textoLimpo(questao), 180) || '(vazio)')}</p>
        </div>
        <div class="item-controles">
          ${travada ? '' : `<label class="item-check-remocao" title="Marcar para remover em lote">
            <input type="checkbox" data-check-remover ${idsParaRemoverEmLote.has(questao.id) ? 'checked' : ''}>
          </label>`}
          <button type="button" data-mover="-1" aria-label="Subir" ${indice === 0 || travada ? 'disabled' : ''}>↑</button>
          <button type="button" data-mover="1" aria-label="Descer" ${indice === selecionadas.length - 1 || travada ? 'disabled' : ''}>↓</button>
          <button type="button" data-remover aria-label="Tirar da prova" ${travada ? 'disabled' : ''}>✕</button>
        </div>
      </article>
    `).join('');

    listaRevisaoEl.querySelectorAll('.item-revisao').forEach((elemento) => {
      const id = elemento.dataset.id;
      elemento.querySelectorAll('[data-mover]').forEach((botao) => {
        botao.addEventListener('click', () => moverQuestao(id, Number(botao.dataset.mover)));
      });
      elemento.querySelector('[data-remover]').addEventListener('click', () => {
        idsParaRemoverEmLote.delete(id);
        alternarSelecao(id);
        renderizarRevisao();
        window.App.renderizarBanco();
      });
      elemento.querySelector('[data-check-remover]')?.addEventListener('change', (evento) => {
        if (evento.target.checked) idsParaRemoverEmLote.add(id);
        else idsParaRemoverEmLote.delete(id);
        atualizarBotaoRemoverLote();
      });
    });

    atualizarBotaoRemoverLote();
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
        body: JSON.stringify({ ...dados, questaoIds: ids, id: Estado.provaAtualId || undefined }),
      });

      // Em caso de erro o servidor responde JSON, não o arquivo.
      if (!resposta.ok) {
        const erro = await resposta.json().catch(() => ({}));
        throw new Error(erro.erro || `Falha ao gerar o ${formato.toUpperCase()} (HTTP ${resposta.status}).`);
      }

      // O servidor devolve o ID da prova registrada num cabeçalho (a
      // resposta em si é o arquivo binário) — próximas ações (salvar,
      // enviar, gerar o outro formato) atualizam o mesmo registro. Uma
      // prova que ainda não existia nasce em rascunho.
      const idRegistrado = resposta.headers.get('X-Prova-Id');
      if (idRegistrado) {
        if (!Estado.provaAtualId) Estado.provaAtualStatus = 'rascunho';
        Estado.provaAtualId = idRegistrado;
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

  /* ------------------------------- salvar rascunho / enviar ao coordenador */

  // Usada tanto por "Salvar rascunho" quanto por "Enviar para o
  // coordenador" — a única diferença entre as duas ações é o endpoint.
  // Só reaproveita o ID da prova atual se ela ainda for um rascunho: uma
  // prova já enviada para o coordenador nunca é editada por aqui — uma
  // correção depois disso sempre vira uma prova nova.
  async function enviarAcaoProva(endpoint, { rotuloCarregando, aoConcluir }) {
    const ids = Estado.selecionadas.slice();
    if (!ids.length || provaEstaTravada()) return;

    const botoes = [btnSalvarRascunhoEl, btnEnviarCoordenadorEl];
    botoes.forEach((botao) => { botao.disabled = true; });
    statusEnvioEl.textContent = rotuloCarregando;
    statusEnvioEl.className = 'status';

    const idEditavel = Estado.provaAtualStatus === 'rascunho' ? Estado.provaAtualId : undefined;

    try {
      const dados = dadosDoCabecalho();
      const prova = await window.App.pedirJson(`/api/provas/${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...dados, questaoIds: ids, id: idEditavel }),
      });

      Estado.provaAtualId = prova.id;
      Estado.provaAtualStatus = prova.status;
      aoConcluir(prova, Boolean(idEditavel));

      window.App.carregarQuestoes();
      window.Painel?.renderizar();
    } catch (err) {
      statusEnvioEl.textContent = err.message;
      statusEnvioEl.className = 'status erro';
    } finally {
      botoes.forEach((botao) => { botao.disabled = false; });
    }
  }

  function salvarRascunho() {
    enviarAcaoProva('rascunho', {
      rotuloCarregando: 'Salvando rascunho...',
      aoConcluir: (prova, eraEdicao) => {
        statusEnvioEl.textContent = eraEdicao
          ? 'Rascunho salvo.'
          : 'Rascunho criado. Você já pode continuar editando e salvando por aqui.';
        statusEnvioEl.className = 'status ok';
      },
    });
  }

  function enviarParaCoordenador() {
    enviarAcaoProva('enviar', {
      rotuloCarregando: 'Enviando para o coordenador...',
      aoConcluir: () => {
        statusEnvioEl.textContent = 'Prova enviada para o coordenador. Ela virou só leitura por aqui — acompanhe a revisão pelo Painel.';
        statusEnvioEl.className = 'status ok';
      },
    });
  }

  // "Duplicar como nova prova": única saída da tela travada. Esquece o
  // vínculo com a prova enviada — o que já estiver no formulário (mesmas
  // questões, mesmo cabeçalho) vira o ponto de partida de uma prova nova,
  // sem tocar na que o coordenador já revisou.
  function duplicarProva() {
    Estado.provaAtualId = null;
    Estado.provaAtualStatus = null;
    statusEnvioEl.textContent = 'Duplicado. Esta agora é uma prova nova — edite à vontade e salve ou envie quando quiser.';
    statusEnvioEl.className = 'status ok';
    renderizarRevisao();
  }

  /* --------------------------------------------- ligações de tela */

  document.getElementById('btnContinuarRevisao').addEventListener('click', () => mostrarView('revisao'));
  document.getElementById('btnAdicionarMais').addEventListener('click', () => mostrarView('banco'));
  document.getElementById('btnVoltarMontagem').addEventListener('click', () => mostrarView('montar'));
  document.getElementById('btnGerarPdf').addEventListener('click', () => gerarProva('pdf'));
  document.getElementById('btnGerarDocx').addEventListener('click', () => gerarProva('docx'));
  btnSalvarRascunhoEl.addEventListener('click', salvarRascunho);
  btnEnviarCoordenadorEl.addEventListener('click', enviarParaCoordenador);
  btnDuplicarProvaEl.addEventListener('click', duplicarProva);
  btnRemoverSelecionadasEl.addEventListener('click', () => {
    if (!idsParaRemoverEmLote.size) return;
    idsParaRemoverEmLote.forEach((id) => alternarSelecao(id));
    idsParaRemoverEmLote.clear();
    renderizarRevisao();
    window.App.renderizarBanco();
  });

  // Data de hoje já preenchida no cabeçalho da prova.
  const campoData = document.getElementById('campoData');
  if (!campoData.value) campoData.value = new Date().toISOString().slice(0, 10);

  // Chamado pelo Painel ao começar uma prova nova ou reabrir uma
  // existente, para que a mensagem da prova anterior não vaze para a
  // próxima. O travamento em si (aviso, campos desabilitados) é decidido
  // dentro de renderizarRevisao, a partir de Estado.provaAtualStatus.
  function resetarEnvio() {
    idsParaRemoverEmLote.clear();
    statusEnvioEl.textContent = '';
    statusEnvioEl.className = 'status';
  }

  window.MontagemProva = { renderizarMontagem, renderizarRevisao, resetarEnvio };
  renderizarMontagem();
})();
