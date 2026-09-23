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
    Estado, EstadoUsuario, escapeHtml, formatarPontos, pedirJson, mostrarView, renderizarBanco,
  } = window.App;

  const indicadoresEl = document.getElementById('indicadoresPainel');
  const tabelaEl = document.getElementById('tabelaProvas');
  const contadorEl = document.getElementById('contadorProvas');
  const buscaEl = document.getElementById('buscaPainel');

  const STATUS = {
    rascunho: { rotulo: 'Rascunho', classe: 'rascunho' },
    em_revisao: { rotulo: 'Em análise', classe: 'revisao' },
    aprovada: { rotulo: 'Aprovada', classe: 'aprovada' },
    reprovada: { rotulo: 'Reprovada', classe: 'reprovada' },
  };

  function ehDirecao() {
    return EstadoUsuario.atual?.perfil === 'direcao';
  }

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
      ? `${formatarPontos(prova.pontuacaoTotal)} pontos`
      : '—';
    const direcao = ehDirecao();

    // O status é só leitura pra todo mundo: quem decide é a Direção, na
    // tela de Revisão — o professor não tem como alterá-lo por aqui.
    const statusHtml = `<span class="status-badge ${status.classe}">${escapeHtml(status.rotulo)}</span>`;

    // A Direção pode excluir qualquer prova; o professor só a própria,
    // enquanto ainda for rascunho.
    const podeExcluir = direcao || prova.status === 'rascunho';
    const botaoExcluir = podeExcluir ? '<button type="button" class="excluir" data-excluir>Excluir</button>' : '';
    // O "Enviar por e-mail" não fica mais aqui na listagem — mora dentro
    // das telas de revisão e geração do PDF (Passo 3 do professor e
    // Revisão da Direção), onde a prova já está aberta.

    return `
      <tr data-id="${escapeHtml(prova.id)}">
        <td class="prova-titulo" data-th="Prova">${escapeHtml(prova.titulo)}</td>
        <td data-th="Disciplina">${escapeHtml(prova.curso || '—')}</td>
        <td class="numerica" data-th="Questões">${escapeHtml(String(prova.quantidadeQuestoes || 0))}</td>
        <td class="numerica" data-th="Valor">${escapeHtml(valor)}</td>
        <td data-th="Status">${statusHtml}</td>
        <td class="discreta" data-th="Última atualização">${escapeHtml(dataRelativa(prova.atualizadoEm || prova.criadoEm))}</td>
        <td class="acao" data-th="">
          <span class="acao-padrao"><button type="button" data-abrir>${direcao ? 'Revisar →' : 'Ver →'}</button>${botaoExcluir}</span>
        </td>
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
      linha.querySelector('[data-abrir]').addEventListener('click', () => {
        if (ehDirecao()) window.RevisaoDirecao?.abrir(prova);
        else abrirProva(prova);
      });
      const botaoExcluir = linha.querySelector('[data-excluir]');
      if (botaoExcluir) {
        botaoExcluir.addEventListener('click', (evento) => {
          evento.stopPropagation();
          pedirConfirmacaoExclusao(linha, prova);
        });
      }
    });
  }

  // Troca a célula de ações pela confirmação inline, sem popup do
  // navegador — mesmo padrão do "Excluir" no Banco de Questões.
  function pedirConfirmacaoExclusao(linha, prova) {
    const celulaAcao = linha.querySelector('.acao');
    celulaAcao.innerHTML = `
      <span class="confirmacao-exclusao">
        <span>Excluir esta prova?</span>
        <button type="button" class="confirmar-exclusao">Confirmar</button>
        <button type="button" class="cancelar-exclusao">Cancelar</button>
      </span>
    `;

    celulaAcao.querySelector('.cancelar-exclusao').addEventListener('click', (evento) => {
      evento.stopPropagation();
      renderizarTabela();
    });

    celulaAcao.querySelector('.confirmar-exclusao').addEventListener('click', async (evento) => {
      evento.stopPropagation();
      const botaoConfirmar = evento.currentTarget;
      botaoConfirmar.disabled = true;
      try {
        await pedirJson(`/api/provas/${encodeURIComponent(prova.id)}`, { method: 'DELETE' });
        provas = provas.filter((item) => item.id !== prova.id);
        renderizarIndicadores();
        renderizarTabela();
      } catch (err) {
        celulaAcao.innerHTML = `<span class="acao-erro">${escapeHtml(err.message)}</span>`;
      }
    });
  }

  /* ------------------------------------------------------- ações */

  // "Ver" recarrega a prova no fluxo de montagem: as questões dela viram
  // a seleção atual e o professor cai direto no passo de revisão, de onde
  // pode gerar o PDF ou o DOCX de novo. Mesmo uma questão já excluída do
  // banco continua aparecendo — vem do retrato salvo com a prova (ver
  // arquivarQuestoesDeProva) — então não há popup de aviso aqui: a prova
  // é mostrada inteira, sem interromper o fluxo.
  function abrirProva(prova) {
    if (!prova) return;

    // A Direção pode ter reprovado (ou só deixado um comentário) — isso
    // vira um aviso fixo no passo de revisão, não um popup que some.
    // Aparece sempre que a Direção já se posicionou (aprovou, reprovou ou
    // está analisando) — mesmo sem comentário, o professor precisa ver o
    // resultado no topo da tela.
    Estado.provaFeedback = (prova.status !== 'rascunho'
      || prova.comentarioCoordenador || (prova.questoesReprovadas || []).length)
      ? {
        id: prova.id,
        status: prova.status,
        comentario: prova.comentarioCoordenador || '',
        questoesReprovadas: prova.questoesReprovadas || [],
      }
      : null;

    Estado.provaAtualId = prova.id;
    Estado.provaAtualStatus = prova.status;
    Estado.provaOrigemId = null;
    Estado.selecionadas = [...(prova.questaoIds || [])];
    window.App.salvarSelecao();
    window.MontagemProva?.preencherCabecalho(prova);
    window.MontagemProva?.resetarEnvio();
    renderizarBanco();
    mostrarView('revisao');
  }

  async function carregarProvas() {
    try {
      const dados = await pedirJson('/api/provas?limite=20');
      provas = dados.provas || [];
      window.App.arquivarQuestoesDeProva(provas);
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

  document.getElementById('btnCriarProva').addEventListener('click', () => {
    Estado.provaFeedback = null;
    Estado.provaAtualId = null;
    Estado.provaAtualStatus = null;
    Estado.provaOrigemId = null;
    window.MontagemProva?.resetarEnvio();
    mostrarView('montar');
  });

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
