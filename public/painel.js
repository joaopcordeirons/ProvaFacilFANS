/* painel.js
 * Tela 02 · Painel do professor: os quatro indicadores do topo e a
 * tabela de provas recentes.
 *
 * Os números não são fixos — saem do banco de questões já carregado em
 * window.App.Estado e das provas registradas em /api/provas (cada prova
 * gerada em PDF ou DOCX vira um documento lá).
 */

(function () {
  const {
    Estado, escapeHtml, formatarPontos, pedirJson, mostrarView, renderizarBanco,
  } = window.App;

  const indicadoresEl = document.getElementById('indicadoresPainel');
  const tabelaEl = document.getElementById('tabelaProvas');
  const contadorEl = document.getElementById('contadorProvas');
  const buscaEl = document.getElementById('buscaPainel');

  const STATUS = {
    rascunho: { rotulo: 'Rascunho', classe: 'rascunho' },
    em_revisao: { rotulo: 'Em revisão', classe: 'revisao' },
    aprovada: { rotulo: 'Aprovada', classe: 'aprovada' },
  };

  let provas = [];
  let erroCarregamento = null;
  let busca = '';

  /* ------------------------------------------------------- utilidades */

  // "2026/2": o semestre letivo em que estamos, usado no rótulo do
  // primeiro indicador e para contar só as provas deste semestre.
  function semestreAtual(data = new Date()) {
    return { ano: data.getFullYear(), metade: data.getMonth() < 6 ? 1 : 2 };
  }

  function rotuloSemestre() {
    const { ano, metade } = semestreAtual();
    return `${ano}/${metade}`;
  }

  function doSemestreAtual(prova) {
    if (!prova.criadoEm) return false;
    const criada = new Date(prova.criadoEm);
    const atual = semestreAtual();
    return criada.getFullYear() === atual.ano && semestreAtual(criada).metade === atual.metade;
  }

  // "Hoje, 09:14" / "Ontem, 16:40" / "21/08, 11:02" — como o professor
  // leria a data numa lista de trabalho.
  function dataRelativa(iso) {
    if (!iso) return '—';
    const data = new Date(iso);
    if (Number.isNaN(data.getTime())) return '—';

    const hora = data.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    const dia = (valor) => new Date(valor.getFullYear(), valor.getMonth(), valor.getDate()).getTime();
    const hoje = dia(new Date());
    const diferenca = Math.round((hoje - dia(data)) / 86400000);

    if (diferenca === 0) return `Hoje, ${hora}`;
    if (diferenca === 1) return `Ontem, ${hora}`;
    return `${data.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })}, ${hora}`;
  }

  // O assunto com mais questões no banco vira o quarto indicador — é o
  // que o professor mais usa, então é o número que interessa a ele.
  function assuntoPredominante() {
    const contagem = new Map();
    Estado.questoes.forEach((questao) => {
      const assunto = questao.assunto || 'Outros';
      contagem.set(assunto, (contagem.get(assunto) || 0) + 1);
    });
    let escolhido = null;
    contagem.forEach((quantidade, assunto) => {
      if (!escolhido || quantidade > escolhido.quantidade) escolhido = { assunto, quantidade };
    });
    return escolhido;
  }

  function numeroGrande(valor) {
    return String(valor).padStart(2, '0');
  }

  /* ----------------------------------------------------- indicadores */

  function renderizarIndicadores() {
    const doSemestre = provas.filter(doSemestreAtual).length;
    const aprovadas = provas.filter((prova) => prova.status === 'aprovada').length;
    const predominante = assuntoPredominante();

    const cartoes = [
      { numero: numeroGrande(doSemestre), rotulo: `Provas criadas — ${rotuloSemestre()}` },
      { numero: numeroGrande(aprovadas), rotulo: 'Aprovadas pela direção' },
      { numero: numeroGrande(Estado.questoes.length), rotulo: 'Questões na banca' },
      predominante
        ? { numero: numeroGrande(predominante.quantidade), rotulo: `Questões · ${predominante.assunto}` }
        : { numero: '00', rotulo: 'Questões por assunto' },
    ];

    indicadoresEl.innerHTML = cartoes.map((cartao) => `
      <div class="indicador">
        <div class="indicador-numero">${escapeHtml(cartao.numero)}</div>
        <div class="indicador-rotulo">${escapeHtml(cartao.rotulo)}</div>
      </div>
    `).join('');
  }

  /* --------------------------------------------- tabela de provas */

  function provasVisiveis() {
    if (!busca) return provas;
    return provas.filter((prova) => `${prova.titulo} ${prova.curso}`.toLowerCase().includes(busca));
  }

  function linhaProva(prova) {
    const status = STATUS[prova.status] || STATUS.rascunho;
    const valor = prova.pontuacaoTotal
      ? `${formatarPontos(prova.pontuacaoTotal)} pts`
      : '—';

    return `
      <tr data-id="${escapeHtml(prova.id)}">
        <td class="prova-titulo" data-th="Prova">${escapeHtml(prova.titulo)}</td>
        <td data-th="Disciplina">${escapeHtml(prova.curso || '—')}</td>
        <td class="numerica" data-th="Questões">${escapeHtml(String(prova.quantidadeQuestoes || 0))}</td>
        <td class="numerica" data-th="Valor">${escapeHtml(valor)}</td>
        <td data-th="Status">
          <select class="status-prova ${status.classe}" data-status aria-label="Situação da prova">
            ${Object.entries(STATUS).map(([chave, item]) => `
              <option value="${chave}" ${chave === prova.status ? 'selected' : ''}>${item.rotulo}</option>
            `).join('')}
          </select>
        </td>
        <td class="discreta" data-th="Última atualização">${escapeHtml(dataRelativa(prova.atualizadoEm || prova.criadoEm))}</td>
        <td class="acao" data-th=""><button type="button" data-abrir>Ver →</button></td>
      </tr>
    `;
  }

  function renderizarTabela() {
    if (erroCarregamento) {
      contadorEl.textContent = '';
      tabelaEl.innerHTML = `<div class="lista-vazia">${escapeHtml(erroCarregamento)}</div>`;
      return;
    }

    const lista = provasVisiveis();
    contadorEl.textContent = lista.length ? `(${lista.length})` : '';

    if (!lista.length) {
      tabelaEl.innerHTML = busca
        ? '<div class="lista-vazia">Nenhuma prova com esse termo. Tente buscar no Banco de Questões.</div>'
        : '<div class="lista-vazia">Nenhuma prova gerada ainda. Monte a primeira em “Criar nova prova”.</div>';
      return;
    }

    tabelaEl.innerHTML = `
      <table class="tabela-provas">
        <thead>
          <tr>
            <th>Prova</th><th>Disciplina</th><th class="numerica">Questões</th>
            <th class="numerica">Valor</th><th>Status</th><th>Última atualização</th><th></th>
          </tr>
        </thead>
        <tbody>${lista.map(linhaProva).join('')}</tbody>
      </table>
    `;

    tabelaEl.querySelectorAll('tr[data-id]').forEach((linha) => {
      const prova = provas.find((item) => item.id === linha.dataset.id);
      linha.querySelector('[data-abrir]').addEventListener('click', () => abrirProva(prova));
      linha.querySelector('[data-status]').addEventListener('change', (evento) => {
        mudarStatus(prova, evento.target.value);
      });
    });
  }

  /* ------------------------------------------------------- ações */

  // "Ver" recarrega a prova no fluxo de montagem: as questões dela viram
  // a seleção atual e o professor cai direto no passo de revisão, de onde
  // pode gerar o PDF ou o DOCX de novo.
  function abrirProva(prova) {
    if (!prova) return;
    const existentes = (prova.questaoIds || []).filter((id) => window.App.questaoPorId(id));
    if (!existentes.length) {
      window.alert('As questões desta prova não estão mais no banco.');
      return;
    }
    if (existentes.length < (prova.questaoIds || []).length) {
      window.alert('Algumas questões desta prova foram excluídas do banco e ficaram de fora.');
    }

    Estado.selecionadas = existentes;
    window.App.salvarSelecao();
    renderizarBanco();
    mostrarView('revisao');
  }

  async function mudarStatus(prova, status) {
    const anterior = prova.status;
    prova.status = status;
    renderizarIndicadores();
    renderizarTabela();
    try {
      await pedirJson(`/api/provas/${encodeURIComponent(prova.id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      });
    } catch (err) {
      // Não deu para salvar: volta ao que estava para a tela não mentir.
      prova.status = anterior;
      renderizarIndicadores();
      renderizarTabela();
      window.alert(err.message);
    }
  }

  async function carregarProvas() {
    try {
      const dados = await pedirJson('/api/provas?limite=20');
      provas = dados.provas || [];
      erroCarregamento = null;
    } catch (err) {
      provas = [];
      erroCarregamento = err.message;
    }
  }

  /* ------------------------------------------------ ligações de tela */

  buscaEl.addEventListener('input', () => {
    busca = buscaEl.value.trim().toLowerCase();
    renderizarTabela();
  });

  // Enter leva a busca para o Banco de Questões, onde ela procura dentro
  // do enunciado das questões.
  buscaEl.addEventListener('keydown', (evento) => {
    if (evento.key !== 'Enter' || !busca) return;
    const campoBanco = document.getElementById('buscaPalavraChave');
    campoBanco.value = buscaEl.value.trim();
    Estado.filtro.palavraChave = busca;
    renderizarBanco();
    mostrarView('banco');
  });

  document.getElementById('btnCriarProva').addEventListener('click', () => mostrarView('montar'));

  // Chamado pela navegação (mostrarView) e depois de carregar o banco.
  async function renderizar({ recarregar = true } = {}) {
    renderizarIndicadores();
    if (recarregar) await carregarProvas();
    renderizarIndicadores();
    renderizarTabela();
  }

  window.Painel = { renderizar };
  renderizar();
})();
