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
    EstadoUsuario, cursosDoUsuario, opcoesCurso, opcoesPeriodo, ligarBotaoEnviarEmail,
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
  const painelAbaQuestoesEl = document.getElementById('painelAbaQuestoes');
  const painelAbaPreviaEl = document.getElementById('painelAbaPrevia');
  const statusPreviaEl = document.getElementById('statusPrevia');
  const linkPreviaNovaAbaEl = document.getElementById('linkPreviaNovaAba');
  const btnSalvarRascunhoEl = document.getElementById('btnSalvarRascunho');
  const btnEnviarCoordenadorEl = document.getElementById('btnEnviarCoordenador');
  const btnSalvarCabecalhoEl = document.getElementById('btnSalvarCabecalho');
  const avisoProvaTravadaEl = document.getElementById('avisoProvaTravada');
  const avisoProvaTravadaTituloEl = document.getElementById('avisoProvaTravadaTitulo');
  const avisoProvaTravadaTextoEl = document.getElementById('avisoProvaTravadaTexto');
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

  // Prévia do PDF na própria tela (aba "Prévia do PDF" do passo 3).
  let abaAtiva = 'questoes';
  let urlPrevia = null;
  let chavePrevia = null; // o que a prévia exibida representa (evita refazer à toa)
  let controladorPrevia = null;
  let temporizadorPrevia = null;

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
    const semComentario = feedback.status === 'em_revisao'
      ? 'A Direção ainda está avaliando esta prova.'
      : 'Nenhum comentário foi deixado.';
    avisoFeedbackEl.innerHTML = `<strong>${escapeHtml(rotulo)}</strong>`
      + (feedback.comentario ? escapeHtml(feedback.comentario) : semComentario)
      + (feedback.questoesReprovadas.length
        ? ` ${feedback.questoesReprovadas.length === 1 ? 'A questão sinalizada está marcada' : 'As questões sinalizadas estão marcadas'} abaixo.`
        : '');
  }

  // Uma prova só é editável de verdade (conteúdo e cabeçalho) enquanto
  // ainda for um rascunho — depois de enviada, a tela vira só leitura
  // (ver aplicarTravamento). A única exceção é o cabeçalho de uma prova
  // já aprovada, liberado à parte por provaPermiteEditarCabecalho.
  function provaEstaTravada() {
    return Boolean(Estado.provaAtualStatus) && Estado.provaAtualStatus !== 'rascunho';
  }

  // Uma prova aprovada continua travada por dentro (questões, envio), mas
  // o professor ainda pode corrigir o cabeçalho (curso, período, data
  // etc.) — não é conteúdo que a Direção revisou, então não precisa
  // reabrir a prova inteira nem duplicar para consertar um erro assim.
  function provaPermiteEditarCabecalho() {
    return Estado.provaAtualStatus === 'aprovada';
  }

  // Desabilita o cabeçalho e as ações que alterariam a prova enviada;
  // "Duplicar como nova prova" é o único jeito de voltar a editar as
  // questões. Numa prova aprovada, os campos do cabeçalho continuam
  // habilitados e "Salvar cabeçalho" aparece no lugar de Salvar/Enviar.
  function aplicarTravamento() {
    const travada = provaEstaTravada();
    const podeEditarCabecalho = provaPermiteEditarCabecalho();
    avisoProvaTravadaEl.classList.toggle('oculto', !travada);
    if (podeEditarCabecalho) {
      avisoProvaTravadaTituloEl.textContent = 'Prova aprovada — só o cabeçalho pode ser corrigido';
      avisoProvaTravadaTextoEl.textContent = 'Esta prova já foi aprovada pela Direção. As questões não podem mais ser alteradas, mas você pode corrigir os campos do cabeçalho abaixo (curso, período, data etc.) e salvar. Para mudar as questões, duplique-a como uma prova nova.';
    } else {
      avisoProvaTravadaTituloEl.textContent = 'Prova já enviada — só leitura';
      avisoProvaTravadaTextoEl.textContent = 'Esta prova já foi enviada para o coordenador e não pode mais ser alterada. Para corrigir algo, duplique-a como uma prova nova.';
    }
    btnSalvarRascunhoEl.classList.toggle('oculto', travada);
    btnEnviarCoordenadorEl.classList.toggle('oculto', travada);
    btnSalvarCabecalhoEl.classList.toggle('oculto', !podeEditarCabecalho);
    CAMPOS_CABECALHO_IDS.forEach((id) => {
      const campo = document.getElementById(id);
      if (campo) campo.disabled = travada && !podeEditarCabecalho;
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
      limparPrevia('Selecione ao menos uma questão para ver a prévia.');
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
            ${questao.arquivada ? '<span class="tag-arquivada" title="Foi excluída do banco depois desta prova ter sido montada">Excluída do banco</span>' : ''}
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
    agendarPrevia();
  }

  /* ------------------------------------------------ prévia do PDF */

  function definirStatusPrevia(texto, erro = false) {
    statusPreviaEl.textContent = texto;
    statusPreviaEl.className = `previa-status${erro ? ' erro' : ''}`;
  }

  function limparPrevia(mensagem) {
    controladorPrevia?.abort();
    clearTimeout(temporizadorPrevia);
    if (urlPrevia) URL.revokeObjectURL(urlPrevia);
    urlPrevia = null;
    chavePrevia = null;
    previaPdfEl.removeAttribute('src');
    linkPreviaNovaAbaEl.classList.add('oculto');
    definirStatusPrevia(mensagem || '');
  }

  function mostrarBlobNaPrevia(blob) {
    if (urlPrevia) URL.revokeObjectURL(urlPrevia);
    urlPrevia = URL.createObjectURL(blob);
    previaPdfEl.src = `${urlPrevia}#view=FitH`;
    linkPreviaNovaAbaEl.href = urlPrevia;
    linkPreviaNovaAbaEl.classList.remove('oculto');
  }

  // De onde vem a prévia: uma prova já enviada para a Direção é mostrada
  // exatamente como foi salva (é o que ela revisou); enquanto ainda é
  // rascunho, vale o que está no formulário agora.
  function origemDaPrevia() {
    const ids = Estado.selecionadas.slice();
    if (Estado.provaAtualId && provaEstaTravada()) {
      return { salva: true, ids, chave: `salva:${Estado.provaAtualId}` };
    }
    const corpo = { ...dadosDoCabecalho(), questaoIds: ids };
    return { salva: false, ids, corpo, chave: JSON.stringify(corpo) };
  }

  async function atualizarPrevia({ forcar = false } = {}) {
    if (!Estado.selecionadas.length) {
      limparPrevia('Selecione ao menos uma questão para ver a prévia.');
      return;
    }
    const origem = origemDaPrevia();
    if (!forcar && origem.chave === chavePrevia) return;

    controladorPrevia?.abort();
    const controlador = new AbortController();
    controladorPrevia = controlador;
    definirStatusPrevia('Montando a prévia…');

    try {
      const blob = origem.salva
        ? await window.App.pedirPdf(`/api/provas/${encodeURIComponent(Estado.provaAtualId)}/previa-pdf`, { signal: controlador.signal })
        : await window.App.pedirPdf('/api/provas/previa-pdf', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...origem.corpo, id: Estado.provaAtualId || undefined }),
          signal: controlador.signal,
        });
      if (controlador.signal.aborted) return;
      mostrarBlobNaPrevia(blob);
      chavePrevia = origem.chave;
      definirStatusPrevia(origem.salva
        ? 'Prova como foi salva e enviada para a Direção.'
        : 'Prévia do que está no formulário agora.');
    } catch (err) {
      if (err.name === 'AbortError') return;
      definirStatusPrevia(err.message, true);
    }
  }

  // Só refaz a prévia quando ela está na tela — e espera o professor
  // parar de digitar/reordenar antes de pedir o PDF ao servidor.
  function agendarPrevia() {
    clearTimeout(temporizadorPrevia);
    if (abaAtiva !== 'previa') return;
    temporizadorPrevia = setTimeout(() => atualizarPrevia(), 350);
  }

  function selecionarAba(aba) {
    abaAtiva = aba;
    document.querySelectorAll('[data-aba-revisao]').forEach((botao) => {
      botao.classList.toggle('ativa', botao.dataset.abaRevisao === aba);
    });
    painelAbaQuestoesEl.classList.toggle('oculto', aba !== 'questoes');
    painelAbaPreviaEl.classList.toggle('oculto', aba !== 'previa');
    const telaVisivel = !document.getElementById('viewRevisao').classList.contains('oculto');
    if (aba === 'previa' && telaVisivel) atualizarPrevia();
  }

  // Preenche o cabeçalho com o que ficou salvo na prova — assim a tela e a
  // prévia refletem a prova aberta, e não o que sobrou da anterior. Campos
  // que a prova não guardou (provas antigas) ficam como estão.
  function preencherCabecalho(prova) {
    prepararCabecalhoProva();
    const definir = (id, valor) => {
      const campo = document.getElementById(id);
      if (campo && valor !== undefined && valor !== null && valor !== '') campo.value = valor;
    };
    definir('campoTitulo', prova.titulo);
    definir('campoCurso', prova.curso);
    definir('campoPeriodo', prova.periodo);
    definir('campoEtapa', prova.etapa);
    definir('campoValorProva', prova.valorProva);
    definir('campoProfessor', prova.professor);
    definir('campoInstrucoes', prova.instrucoes);
    definir('campoLinhas', prova.linhasResposta);
    const [dia, mes, ano] = String(prova.data || '').split('/');
    if (dia && mes && ano) campoData.value = `${ano}-${mes.padStart(2, '0')}-${dia.padStart(2, '0')}`;
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
      // Dica pro servidor recuperar o retrato de uma questão já excluída
      // do banco quando esta prova ainda não tem registro próprio (ver
      // duplicarProva) — só é usada como fallback, nunca como conteúdo.
      origemId: Estado.provaOrigemId || undefined,
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
        Estado.provaOrigemId = null; // a prova já tem retrato próprio agora
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

      // Só o PDF dá para conferir na própria tela: o arquivo recém-gerado
      // vira a prévia e a aba dela é aberta.
      if (formato === 'pdf') {
        mostrarBlobNaPrevia(blob);
        const origem = origemDaPrevia();
        chavePrevia = origem.chave;
        definirStatusPrevia(origem.salva
          ? 'Prova como foi salva e enviada para a Direção.'
          : 'PDF gerado agora. Prévia do que está no formulário.');
        selecionarAba('previa');
        window.scrollTo({ top: 0, behavior: 'smooth' });
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
      Estado.provaOrigemId = null; // a prova já tem retrato próprio agora
      window.App.arquivarQuestoesDeProva(prova);
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

  // Salva só o cabeçalho de uma prova já aprovada — usa a rota própria
  // (/cabecalho) em vez de rascunho/enviar, que exigem status "rascunho".
  // Não mexe em questões nem no histórico de revisão da Direção.
  async function salvarCabecalho() {
    if (!Estado.provaAtualId || !provaPermiteEditarCabecalho()) return;

    btnSalvarCabecalhoEl.disabled = true;
    statusEnvioEl.textContent = 'Salvando cabeçalho...';
    statusEnvioEl.className = 'status';

    try {
      const dados = dadosDoCabecalho();
      const prova = await window.App.pedirJson(`/api/provas/${encodeURIComponent(Estado.provaAtualId)}/cabecalho`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(dados),
      });

      Estado.provaAtualStatus = prova.status;
      statusEnvioEl.textContent = 'Cabeçalho atualizado.';
      statusEnvioEl.className = 'status ok';
      window.Painel?.renderizar();
      if (abaAtiva === 'previa') atualizarPrevia({ forcar: true });
    } catch (err) {
      statusEnvioEl.textContent = err.message;
      statusEnvioEl.className = 'status erro';
    } finally {
      btnSalvarCabecalhoEl.disabled = false;
    }
  }

  // "Duplicar como nova prova": única saída da tela travada. Esquece o
  // vínculo com a prova enviada — o que já estiver no formulário (mesmas
  // questões, mesmo cabeçalho) vira o ponto de partida de uma prova nova,
  // sem tocar na que o coordenador já revisou. Guarda de onde veio em
  // provaOrigemId só pra, se alguma questão já tiver sido excluída do
  // banco, o servidor ainda saber de onde puxar o retrato dela.
  function duplicarProva() {
    Estado.provaOrigemId = Estado.provaAtualId;
    Estado.provaAtualId = null;
    Estado.provaAtualStatus = null;
    statusEnvioEl.textContent = 'Duplicado. Esta agora é uma prova nova — edite à vontade e salve ou envie quando quiser.';
    statusEnvioEl.className = 'status ok';
    Estado.provaFeedback = null; // o parecer era da prova anterior
    selecionarAba('questoes');
    renderizarRevisao();
  }

  /* --------------------------------------------- ligações de tela */

  document.getElementById('btnContinuarRevisao').addEventListener('click', () => mostrarView('revisao'));
  document.getElementById('btnAdicionarMais').addEventListener('click', () => mostrarView('banco'));
  document.getElementById('btnVoltarMontagem').addEventListener('click', () => mostrarView('montar'));
  document.getElementById('btnGerarPdf').addEventListener('click', () => gerarProva('pdf'));
  document.getElementById('btnGerarDocx').addEventListener('click', () => gerarProva('docx'));

  // "Enviar por e-mail" funciona pra prova em qualquer status — de
  // rascunho a aprovada — desde que ela já tenha sido salva ou gerada ao
  // menos uma vez (Estado.provaAtualId). É só compartilhar o arquivo, não
  // muda nada no fluxo de revisão.
  ligarBotaoEnviarEmail(
    document.getElementById('btnEnviarEmailRevisao'),
    document.getElementById('areaEnviarEmailRevisao'),
    document.getElementById('statusEnvioEmailRevisao'),
    () => (Estado.provaAtualId ? { id: Estado.provaAtualId } : null),
  );
  btnSalvarRascunhoEl.addEventListener('click', salvarRascunho);
  btnEnviarCoordenadorEl.addEventListener('click', enviarParaCoordenador);
  btnSalvarCabecalhoEl.addEventListener('click', salvarCabecalho);
  btnDuplicarProvaEl.addEventListener('click', duplicarProva);
  document.querySelectorAll('[data-aba-revisao]').forEach((botao) => {
    botao.addEventListener('click', () => selecionarAba(botao.dataset.abaRevisao));
  });
  document.getElementById('btnAtualizarPrevia').addEventListener('click', () => atualizarPrevia({ forcar: true }));
  CAMPOS_CABECALHO_IDS.forEach((id) => {
    const campo = document.getElementById(id);
    if (!campo) return;
    campo.addEventListener('input', agendarPrevia);
    campo.addEventListener('change', agendarPrevia);
  });
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
    // A mensagem e o formulário de "Enviar por e-mail" também não devem
    // vazar de uma prova pra outra.
    document.getElementById('areaEnviarEmailRevisao').innerHTML = '';
    document.getElementById('statusEnvioEmailRevisao').textContent = '';
    document.getElementById('btnEnviarEmailRevisao').disabled = false;
    // Prova já enviada não tem o que editar: o que interessa é vê-la como
    // ficou. Rascunho e prova nova abrem na lista de questões.
    limparPrevia('');
    selecionarAba(provaEstaTravada() ? 'previa' : 'questoes');
  }

  window.MontagemProva = { renderizarMontagem, renderizarRevisao, resetarEnvio, preencherCabecalho };
  renderizarMontagem();
})();
