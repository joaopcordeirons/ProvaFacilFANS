/* app.js
 * Estado compartilhado, navegação entre telas, tela "Banco de Questões"
 * (layout mestre-detalhe de 3 painéis) e o drawer "Adicionar questão".
 *
 * A montagem da prova e a geração do PDF ficam em montarProva.js, que lê
 * o mesmo estado exposto aqui em window.App.
 */

const API_BASE = window.location.origin;
const CHAVE_SELECAO = 'provafacil:selecao';

const Estado = {
  questoes: [],                // tudo que veio do Firestore, na ordem do banco
  selecionadas: [],            // IDs escolhidos para a prova, na ordem de escolha
  detalheId: null,             // questão aberta no painel de detalhe
  filtro: { curso: null, periodo: 'todas', assunto: null, palavraChave: '', assunto_busca: '' },
  editando: false,
  // Preenchido ao reabrir uma prova pelo Painel (abrirProva) que já foi
  // revisada pela Direção: { id, status, comentario, questoesReprovadas }.
  // Usado pelo passo de revisão da montagem para mostrar o aviso e marcar
  // as questões sinalizadas. Fica null numa prova nova.
  provaFeedback: null,
  // ID da prova que está sendo montada nesta sessão, uma vez que ela já
  // tenha sido salva como rascunho, enviada para o coordenador ou tido um
  // arquivo gerado — para que a próxima ação (salvar de novo, enviar,
  // gerar outro formato) atualize o mesmo registro em vez de duplicá-lo.
  // Fica null enquanto a prova ainda não foi salva nenhuma vez.
  provaAtualId: null,
  // Status da prova referenciada por provaAtualId, tal como veio do
  // servidor da última vez ('rascunho' quando ainda dá para editar).
  // Junto com provaAtualId decide se a próxima ação (salvar/enviar)
  // atualiza esse registro ou cria um novo — nunca escreve por cima de
  // uma prova que não é mais um rascunho.
  provaAtualStatus: null,
  // Preenchido só por "Duplicar como nova prova": a prova de onde essa
  // cópia veio. Mandado ao servidor como dica pra recuperar o retrato de
  // uma questão que já foi excluída do banco, mesmo numa prova que ainda
  // nunca foi salva por conta própria.
  provaOrigemId: null,
  // Retrato (não a questão viva) de toda questão que apareceu em alguma
  // prova carregada e que já não existe mais no banco — id -> objeto.
  // Existe pra uma prova antiga continuar aparecendo inteira na tela
  // mesmo depois que uma das questões dela foi excluída (ver
  // arquivarQuestoesDeProva e questaoPorId).
  questoesArquivadas: {},
};

// Lista fixa de cursos/períodos, carregada uma vez de /api/constantes e
// usada pelos seletores de curso e período em várias telas.
const Constantes = { cursos: [], periodos: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] };

async function carregarConstantes() {
  try {
    const dados = await pedirJson('/api/constantes');
    Constantes.cursos = Array.isArray(dados.cursos) ? dados.cursos : [];
    if (Array.isArray(dados.periodos) && dados.periodos.length) Constantes.periodos = dados.periodos;
  } catch (_) { /* mantém os padrões acima */ }
}

// Cursos "em jogo" para o usuário logado: os que ele leciona (professor)
// ou todos (direção). Várias telas usam isso pra montar seletores.
function cursosDoUsuario() {
  const usuario = EstadoUsuario.atual;
  if (!usuario) return [];
  return usuario.perfil === 'direcao' ? Constantes.cursos : (usuario.cursos || []);
}

/* ---------------------------------------------------------------- utilidades */

function escapeHtml(texto) {
  const div = document.createElement('div');
  div.textContent = texto == null ? '' : texto;
  return div.innerHTML;
}

function formatarPontos(valor) {
  const numero = Number(valor);
  return (Number.isFinite(numero) ? numero : 0).toFixed(1).replace('.', ',');
}

function textoLimpo(questao) {
  return String(questao.texto || '').replace(/\*\*(.+?)\*\*/g, '$1').replace(/\s+/g, ' ').trim();
}

/* --------------------------------------------------- negrito nas questões
 * O professor seleciona um trecho do texto e clica no botão "Negrito"
 * (escrito por extenso de propósito — nada de ícone "B", que muita gente
 * não reconhece). O trecho fica em negrito NA HORA, visualmente, dentro do
 * próprio campo — igual ao Word — em vez de aparecer com asteriscos ou
 * qualquer símbolo que precise de explicação.
 *
 * Por baixo dos panos, ao salvar a questão, o negrito visual (<strong>) é
 * convertido para a marcação **assim**, que é o formato salvo no banco e
 * lido pelo PDF/DOCX na hora de montar a prova (dividirNegrito, em
 * modeloProva.js). Ao reabrir uma questão pra editar, o processo é
 * inverso: **assim** volta a aparecer como negrito de verdade no campo.
 */

// HTML da barra com o botão — usar antes do campo de texto (que deve ser
// um <div contenteditable="true">, não um <textarea>: só assim dá pra
// mostrar o negrito de verdade enquanto a pessoa edita).
function barraNegritoHtml() {
  return `
    <div class="barra-negrito">
      <button type="button" class="botao-negrito" aria-label="Deixar em negrito o texto selecionado no campo abaixo">
        <strong>Negrito</strong>
      </button>
      <span class="dica-negrito" aria-live="polite">Selecione um trecho do texto abaixo e clique aqui para deixá-lo em negrito.</span>
    </div>
  `;
}

// Converte o texto salvo (com **marcações**) no HTML inicial do campo de
// edição, já com <strong> de verdade no lugar dos asteriscos.
function htmlEdicaoComNegrito(texto) {
  return escapeHtml(String(texto || ''))
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\n/g, '<br>');
}

// Um nó é "negrito" se for <b>/<strong> ou tiver font-weight forte (o
// execCommand pode gerar qualquer um dos dois, dependendo do navegador).
function noEhNegrito(no) {
  if (no.nodeType !== Node.ELEMENT_NODE) return false;
  if (no.tagName === 'B' || no.tagName === 'STRONG') return true;
  const peso = no.style && no.style.fontWeight;
  return peso === 'bold' || peso === '700' || Number(peso) >= 600;
}

// Percorre o conteúdo de um campo contenteditable e devolve o texto puro
// com **marcações** no lugar do negrito visual — o formato salvo no banco.
function obterTextoComMarcadores(elemento) {
  function percorrer(no, negritoHerdado) {
    if (no.nodeType === Node.TEXT_NODE) {
      const valor = no.nodeValue || '';
      if (!valor) return '';
      return negritoHerdado ? `**${valor}**` : valor;
    }
    if (no.nodeType !== Node.ELEMENT_NODE) return '';
    if (no.tagName === 'BR') return '\n';
    const negritoAqui = negritoHerdado || noEhNegrito(no);
    const filhos = Array.from(no.childNodes).map((filho) => percorrer(filho, negritoAqui)).join('');
    // Navegadores costumam envolver cada linha nova (Enter) em <div>/<p>.
    return (no.tagName === 'DIV' || no.tagName === 'P') ? `${filhos}\n` : filhos;
  }
  const bruto = Array.from(elemento.childNodes).map((no) => percorrer(no, false)).join('');
  return bruto.replace(/\n+$/, '');
}

// Lê o valor atual de um campo de texto de questão, seja ele um
// <textarea> comum ou um <div contenteditable>.
function lerTextoDoCampo(elemento) {
  if (!elemento) return '';
  return elemento.tagName === 'TEXTAREA' ? elemento.value : obterTextoComMarcadores(elemento);
}

// Escreve um texto (com **marcações**) de volta num campo, respeitando o
// mesmo negrito visual de verdade.
function escreverTextoNoCampo(elemento, texto) {
  if (!elemento) return;
  if (elemento.tagName === 'TEXTAREA') elemento.value = texto;
  else elemento.innerHTML = htmlEdicaoComNegrito(texto);
}

// Trava um campo depois de salvo, sem depender de ser textarea ou div.
function travarCampo(elemento) {
  if (!elemento) return;
  if (elemento.tagName === 'TEXTAREA') elemento.readOnly = true;
  else elemento.contentEditable = 'false';
}

// Liga o botão "Negrito" a um campo contenteditable: aplica o negrito de
// verdade (document.execCommand) só no trecho selecionado. O aviso de
// "selecione primeiro" aparece escrito ao lado do botão (sem popup), e
// volta sozinho pro texto normal depois de alguns segundos.
function configurarNegrito(campo, botao) {
  if (!campo || !botao) return;

  // Força o navegador a usar <b>/<strong> em vez de <span style="...">,
  // pra obterTextoComMarcadores não precisar adivinhar todo tipo de CSS.
  try { document.execCommand('styleWithCSS', false, false); } catch (erro) { /* navegador antigo, ignora */ }

  const dicaEl = botao.parentElement ? botao.parentElement.querySelector('.dica-negrito') : null;
  const textoDicaPadrao = dicaEl ? dicaEl.textContent : '';
  let temporizadorAviso = null;

  function avisarSelecioneAntes() {
    if (!dicaEl) return;
    clearTimeout(temporizadorAviso);
    dicaEl.textContent = 'Primeiro selecione o trecho do texto que deve ficar em negrito.';
    dicaEl.classList.add('erro');
    temporizadorAviso = setTimeout(() => {
      dicaEl.textContent = textoDicaPadrao;
      dicaEl.classList.remove('erro');
    }, 4000);
  }

  // Evita que o clique no botão tire o foco/seleção do campo antes do
  // clique ser processado — essencial em contenteditable.
  botao.addEventListener('mousedown', (evento) => evento.preventDefault());
  botao.addEventListener('click', () => {
    const selecao = window.getSelection();
    if (!selecao || selecao.rangeCount === 0 || selecao.isCollapsed || !campo.contains(selecao.anchorNode)) {
      avisarSelecioneAntes();
      return;
    }
    if (dicaEl && dicaEl.classList.contains('erro')) {
      clearTimeout(temporizadorAviso);
      dicaEl.textContent = textoDicaPadrao;
      dicaEl.classList.remove('erro');
    }
    campo.focus();
    document.execCommand('bold');
  });
}

// Conveniência para os campos fixos do HTML: o botão fica na barra logo
// ao lado do campo com o id informado.
function configurarNegritoPorId(idCampo) {
  const campo = document.getElementById(idCampo);
  if (!campo) return;
  const container = campo.closest('label') || campo.parentElement;
  configurarNegrito(campo, container ? container.querySelector('.botao-negrito') : null);
}

function resumir(texto, limite) {
  return texto.length > limite ? `${texto.slice(0, limite)}…` : texto;
}

function rotuloPeriodo(questao) {
  return Number.isFinite(questao.periodo) ? `${questao.periodo}º período` : 'Período não informado';
}

function opcoesPeriodo(selecionado) {
  return Constantes.periodos.map((p) => `
    <option value="${p}" ${String(p) === String(selecionado) ? 'selected' : ''}>${p}º período</option>
  `).join('');
}

function opcoesCurso(selecionado) {
  return cursosDoUsuario().map((c) => `
    <option value="${escapeHtml(c)}" ${c === selecionado ? 'selected' : ''}>${escapeHtml(c)}</option>
  `).join('');
}

// A seleção sobrevive a um F5 — o professor pode montar a prova em duas
// sentadas. Se o navegador bloquear o localStorage, a tela continua
// funcionando só perde essa memória.
function lerSelecaoSalva() {
  try {
    const bruto = localStorage.getItem(CHAVE_SELECAO);
    const lista = bruto ? JSON.parse(bruto) : [];
    return Array.isArray(lista) ? lista.filter((id) => typeof id === 'string') : [];
  } catch (_) {
    return [];
  }
}

function salvarSelecao() {
  try {
    localStorage.setItem(CHAVE_SELECAO, JSON.stringify(Estado.selecionadas));
  } catch (_) { /* seleção fica só em memória */ }
}

function estaSelecionada(id) {
  return Estado.selecionadas.includes(id);
}

function alternarSelecao(id) {
  const posicao = Estado.selecionadas.indexOf(id);
  if (posicao >= 0) Estado.selecionadas.splice(posicao, 1);
  else Estado.selecionadas.push(id);
  salvarSelecao();
}

function questaoPorId(id) {
  return Estado.questoes.find((questao) => questao.id === id) || Estado.questoesArquivadas[id] || null;
}

// Chamado sempre que uma lista de provas é carregada (ver painel.js).
// Guarda o retrato de cada questão que a prova já não referencia mais no
// banco — assim ela continua aparecendo completa em qualquer lugar que
// use questaoPorId (a revisão da montagem, o drawer de revisão da
// Direção), mesmo que já tenha sido excluída.
function arquivarQuestoesDeProva(provas) {
  (Array.isArray(provas) ? provas : [provas]).forEach((prova) => {
    (prova?.questoesSnapshot || []).forEach((questao) => {
      if (questao?.id && !Estado.questoesArquivadas[questao.id]) {
        Estado.questoesArquivadas[questao.id] = { ...questao, codigo: 'Arquivada', arquivada: true };
      }
    });
  });
}

function questoesSelecionadas() {
  return Estado.selecionadas.map(questaoPorId).filter(Boolean);
}

function pontuacaoSelecionada() {
  return questoesSelecionadas().reduce((soma, questao) => soma + Number(questao.valor || 0), 0);
}

async function pedirJson(caminho, opcoes) {
  const resposta = await fetch(API_BASE + caminho, opcoes);
  const dados = await resposta.json().catch(() => ({}));
  if (!resposta.ok) throw new Error(dados.erro || 'Falha na comunicação com o servidor.');
  return dados;
}

// Como pedirJson, mas para respostas em PDF (prévia na tela): devolve o Blob.
async function pedirPdf(caminho, opcoes) {
  const resposta = await fetch(API_BASE + caminho, opcoes);
  if (!resposta.ok) {
    const dados = await resposta.json().catch(() => ({}));
    throw new Error(dados.erro || 'Falha ao montar a prévia do PDF.');
  }
  return resposta.blob();
}

/* --------------------------------------------------- envio de prova por e-mail */

// Monta o formulário inline de "Enviar por e-mail" dentro de `container`.
// Usado pelas telas de revisão (Passo 3 do professor e Revisão da Direção) —
// funciona pra prova em qualquer status, de rascunho a aprovada/reprovada,
// já que enviar o arquivo não muda nada no fluxo de decisão.
function montarFormularioEmail(container, prova, { aoCancelar, aoSucesso, aoErro, classeExtra = '' } = {}) {
  container.innerHTML = `
    <form class="form-enviar-email ${classeExtra}">
      <input type="text" class="campo-destinatarios" placeholder="e-mail@exemplo.com, outro@exemplo.com" required>
      <select class="campo-formato-email">
        <option value="pdf">PDF</option>
        <option value="docx">DOCX</option>
      </select>
      <input type="text" class="campo-mensagem-email" placeholder="Mensagem (opcional)">
      <button type="submit">Enviar</button>
      <button type="button" class="cancelar-envio-email">Cancelar</button>
    </form>
  `;

  container.querySelector('.campo-destinatarios').focus();

  container.querySelector('.cancelar-envio-email').addEventListener('click', (evento) => {
    evento.stopPropagation();
    aoCancelar?.();
  });

  const formulario = container.querySelector('.form-enviar-email');
  formulario.addEventListener('click', (evento) => evento.stopPropagation());
  formulario.addEventListener('submit', async (evento) => {
    evento.preventDefault();
    const destinatarios = container.querySelector('.campo-destinatarios').value
      .split(/[,;\s]+/)
      .map((email) => email.trim())
      .filter(Boolean);
    if (!destinatarios.length) return;

    const botaoEnviar = formulario.querySelector('button[type="submit"]');
    botaoEnviar.disabled = true;
    formulario.querySelector('.cancelar-envio-email').disabled = true;
    botaoEnviar.textContent = 'Enviando...';
    try {
      await pedirJson(`/api/provas/${encodeURIComponent(prova.id)}/enviar-email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          destinatarios,
          formato: container.querySelector('.campo-formato-email').value,
          mensagem: container.querySelector('.campo-mensagem-email').value,
        }),
      });
      aoSucesso?.();
    } catch (err) {
      botaoEnviar.disabled = false;
      formulario.querySelector('.cancelar-envio-email').disabled = false;
      botaoEnviar.textContent = 'Enviar';
      aoErro?.(err);
    }
  });
}

// Liga um botão "Enviar por e-mail" fixo da tela a uma área onde o
// formulário abre/fecha — usado no Passo 3 (revisão do professor) e no
// drawer de Revisão da Direção. `obterProva` devolve `{ id, titulo }` da
// prova atual, ou algo "falsy" se ela ainda não existir no servidor.
function ligarBotaoEnviarEmail(botaoEl, areaFormEl, statusEl, obterProva) {
  botaoEl.addEventListener('click', () => {
    if (areaFormEl.querySelector('.form-enviar-email')) return; // já está aberto

    const prova = obterProva();
    if (!prova || !prova.id) {
      statusEl.textContent = 'Salve ou gere a prova antes de enviar por e-mail.';
      statusEl.className = 'status erro';
      return;
    }

    statusEl.textContent = '';
    statusEl.className = 'status';
    botaoEl.disabled = true;

    montarFormularioEmail(areaFormEl, prova, {
      classeExtra: 'largo',
      aoCancelar: () => {
        areaFormEl.innerHTML = '';
        botaoEl.disabled = false;
      },
      aoSucesso: () => {
        areaFormEl.innerHTML = '';
        botaoEl.disabled = false;
        statusEl.textContent = 'Prova enviada por e-mail.';
        statusEl.className = 'status ok';
      },
      aoErro: (err) => {
        statusEl.textContent = err.message;
        statusEl.className = 'status erro';
      },
    });
  });
}

/* ---------------------------------------------------------------- navegação */

const VIEWS = {
  painel: 'viewPainel', banco: 'viewBanco', montar: 'viewMontar', revisao: 'viewRevisao', perfil: 'viewPerfil',
};

function mostrarView(nome) {
  Object.entries(VIEWS).forEach(([chave, id]) => {
    document.getElementById(id).classList.toggle('oculto', chave !== nome);
  });
  document.querySelectorAll('.nav-item[data-ir-para]').forEach((botao) => {
    const alvo = botao.dataset.irPara;
    botao.classList.toggle('ativo', alvo === nome || (nome === 'revisao' && alvo === 'montar'));
  });
  window.scrollTo({ top: 0 });
  fecharMenuMobile();

  if (nome === 'painel') window.Painel?.renderizar();
  if (nome === 'montar') window.MontagemProva?.renderizarMontagem();
  if (nome === 'revisao') window.MontagemProva?.renderizarRevisao();
  if (nome === 'perfil') window.Perfil?.renderizar();
}

document.querySelectorAll('.nav-item[data-ir-para]').forEach((botao) => {
  botao.addEventListener('click', () => mostrarView(botao.dataset.irPara));
});

/* ---------------------------------------- menu lateral (off-canvas no celular) */

const sidebarEl = document.getElementById('sidebar');
const sidebarOverlayEl = document.getElementById('sidebarOverlay');

function abrirMenuMobile() {
  sidebarEl.classList.add('aberta');
  sidebarOverlayEl.classList.remove('oculto');
}
function fecharMenuMobile() {
  sidebarEl.classList.remove('aberta');
  sidebarOverlayEl.classList.add('oculto');
}
document.getElementById('btnAbrirMenu')?.addEventListener('click', abrirMenuMobile);
document.getElementById('btnFecharMenu')?.addEventListener('click', fecharMenuMobile);
sidebarOverlayEl.addEventListener('click', fecharMenuMobile);
window.addEventListener('resize', () => {
  if (window.innerWidth > 760) fecharMenuMobile();
});

/* -------------------------------------------- Banco de Questões (3 painéis) */

const filtrosCursoEl = document.getElementById('filtrosCurso');
const grupoFiltroCursoEl = document.getElementById('grupoFiltroCurso');
const disciplinaAtualEl = document.getElementById('disciplinaAtual');
const filtrosPeriodoEl = document.getElementById('filtrosPeriodo');
const filtrosAssuntoEl = document.getElementById('filtrosAssunto');
const listaQuestoesEl = document.getElementById('listaQuestoes');
const resumoListaEl = document.getElementById('resumoLista');
const painelDetalheEl = document.getElementById('painelDetalhe');
const buscaPalavraChaveEl = document.getElementById('buscaPalavraChave');
const buscaAssuntoEl = document.getElementById('buscaAssunto');
const acoesExclusaoBancoEl = document.getElementById('acoesExclusaoBanco');
const btnModoExclusaoBancoEl = document.getElementById('btnModoExclusaoBanco');

// Enquanto ativo, a caixinha de cada questão (a mesma que normalmente
// marca "p/ prova") passa a marcar "excluir do banco" — em vez de dois
// checkboxes lado a lado, um só muda de função, pra não confundir.
let modoExclusaoBanco = false;

// IDs marcados para excluir do banco em lote — separado da seleção "p/
// prova" (que usa .caixa-selecao); marcar uma questão pra excluir não
// deveria também tirar/pôr ela na prova em montagem.
const idsParaExcluirDoBanco = new Set();

// Filtro do painel da esquerda (curso/período/assunto) + as duas buscas do topo.
function questoesFiltradas() {
  const { curso, periodo, assunto, palavraChave, assunto_busca: assuntoBusca } = Estado.filtro;
  return Estado.questoes.filter((questao) => {
    if (curso && questao.curso !== curso) return false;
    if (periodo !== 'todas' && String(questao.periodo) !== String(periodo)) return false;
    if (assunto && questao.assunto !== assunto) return false;
    if (assuntoBusca && !String(questao.assunto || '').toLowerCase().includes(assuntoBusca)) return false;
    if (palavraChave && !textoLimpo(questao).toLowerCase().includes(palavraChave)) return false;
    return true;
  });
}

// Título do painel + filtro de curso: só aparecem quando faz sentido —
// professor com 1 curso só não precisa escolher nada, e o título já
// mostra qual é.
function renderizarCabecalhoCurso() {
  const cursos = cursosDoUsuario();
  disciplinaAtualEl.textContent = cursos.length === 1
    ? cursos[0]
    : (EstadoUsuario.atual?.perfil === 'direcao' ? 'Todos os cursos' : 'Banco de Questões');

  if (cursos.length <= 1) {
    grupoFiltroCursoEl.classList.add('oculto');
    return;
  }
  grupoFiltroCursoEl.classList.remove('oculto');

  const contagem = new Map();
  Estado.questoes.forEach((questao) => {
    if (questao.curso) contagem.set(questao.curso, (contagem.get(questao.curso) || 0) + 1);
  });

  filtrosCursoEl.innerHTML = cursos.map((c) => `
    <button type="button" class="filtro-item ${Estado.filtro.curso === c ? 'ativo' : ''}" data-curso="${escapeHtml(c)}">
      <span>${escapeHtml(c)}</span><span class="filtro-contagem">${contagem.get(c) || 0}</span>
    </button>
  `).join('');
  filtrosCursoEl.querySelectorAll('[data-curso]').forEach((botao) => {
    botao.addEventListener('click', () => {
      Estado.filtro.curso = Estado.filtro.curso === botao.dataset.curso ? null : botao.dataset.curso;
      renderizarBanco();
    });
  });
}

function renderizarFiltros() {
  renderizarCabecalhoCurso();

  const total = Estado.questoes.length;
  const contagemPeriodo = new Map();
  Estado.questoes.forEach((questao) => {
    contagemPeriodo.set(questao.periodo, (contagemPeriodo.get(questao.periodo) || 0) + 1);
  });

  const periodos = [
    ['todas', 'Todas as questões', total],
    ...Constantes.periodos.map((p) => [String(p), `${p}º período`, contagemPeriodo.get(p) || 0]),
  ];
  filtrosPeriodoEl.innerHTML = periodos.map(([chave, rotulo, quantidade]) => `
    <button type="button" class="filtro-item ${String(Estado.filtro.periodo) === chave ? 'ativo' : ''}" data-periodo="${chave}">
      <span>${rotulo}</span><span class="filtro-contagem">${quantidade}</span>
    </button>
  `).join('');

  const porAssunto = new Map();
  Estado.questoes.forEach((questao) => {
    const assunto = questao.assunto || 'Outros';
    porAssunto.set(assunto, (porAssunto.get(assunto) || 0) + 1);
  });

  const assuntos = [...porAssunto.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  filtrosAssuntoEl.innerHTML = assuntos.length
    ? assuntos.map(([assunto, quantidade]) => `
        <button type="button" class="filtro-item ${Estado.filtro.assunto === assunto ? 'ativo' : ''}" data-assunto="${escapeHtml(assunto)}">
          <span>${escapeHtml(assunto)}</span><span class="filtro-contagem">${quantidade}</span>
        </button>
      `).join('')
    : '<div class="filtro-vazio">Nenhum assunto cadastrado ainda.</div>';

  // Alimenta o autocomplete de assunto usado no drawer e na edição.
  document.getElementById('assuntosConhecidos').innerHTML = assuntos
    .map(([assunto]) => `<option value="${escapeHtml(assunto)}">`).join('');

  filtrosPeriodoEl.querySelectorAll('[data-periodo]').forEach((botao) => {
    botao.addEventListener('click', () => {
      Estado.filtro.periodo = botao.dataset.periodo;
      renderizarBanco();
    });
  });
  filtrosAssuntoEl.querySelectorAll('[data-assunto]').forEach((botao) => {
    botao.addEventListener('click', () => {
      // Clicar de novo no assunto já ativo limpa o filtro.
      Estado.filtro.assunto = Estado.filtro.assunto === botao.dataset.assunto ? null : botao.dataset.assunto;
      renderizarBanco();
    });
  });
}

function renderizarLista() {
  const questoes = questoesFiltradas();

  // Uma questão marcada que já saiu do banco por outro caminho não deve
  // continuar contando pro lote.
  const idsNoBanco = new Set(Estado.questoes.map((questao) => questao.id));
  idsParaExcluirDoBanco.forEach((id) => { if (!idsNoBanco.has(id)) idsParaExcluirDoBanco.delete(id); });

  const plural = (quantidade, singular, plural_) => `${quantidade} ${quantidade === 1 ? singular : plural_}`;
  resumoListaEl.textContent = modoExclusaoBanco
    ? plural(questoes.length, 'questão', 'questões')
    : `${plural(questoes.length, 'questão', 'questões')} · ${plural(Estado.selecionadas.length, 'selecionada', 'selecionadas')} p/ prova`;
  btnModoExclusaoBancoEl.textContent = modoExclusaoBanco ? 'Cancelar seleção' : 'Selecionar para excluir';

  if (!questoes.length) {
    listaQuestoesEl.innerHTML = '<div class="lista-vazia">Nenhuma questão encontrada com esses filtros.</div>';
    atualizarBarraExclusaoBanco();
    return;
  }

  // Mantém o detalhe apontando para algo visível na lista.
  if (!questoes.some((questao) => questao.id === Estado.detalheId)) {
    Estado.detalheId = questoes[0].id;
    Estado.editando = false;
  }

  listaQuestoesEl.innerHTML = questoes.map((questao) => `
    <article class="item-questao ${questao.id === Estado.detalheId ? 'aberta' : ''}" data-id="${escapeHtml(questao.id)}">
      <button type="button"
        class="caixa-selecao ${modoExclusaoBanco ? 'modo-exclusao' : ''} ${(modoExclusaoBanco ? idsParaExcluirDoBanco.has(questao.id) : estaSelecionada(questao.id)) ? 'marcada' : ''}"
        data-marcar="${escapeHtml(questao.id)}"
        aria-label="${modoExclusaoBanco
          ? (idsParaExcluirDoBanco.has(questao.id) ? 'Desmarcar exclusão' : 'Marcar para excluir')
          : (estaSelecionada(questao.id) ? 'Remover da prova' : 'Adicionar à prova')}"></button>
      <div class="item-corpo">
        <div class="item-cabecalho">
          <span class="codigo">${escapeHtml(questao.codigo)}</span>
          <span class="pontos">${formatarPontos(questao.valor)} pts</span>
        </div>
        <p class="item-texto">${escapeHtml(resumir(textoLimpo(questao), 110) || '(vazio)')}</p>
        <div class="item-meta">${escapeHtml(questao.assunto)} · ${escapeHtml(rotuloPeriodo(questao))}${cursosDoUsuario().length > 1 ? ` · ${escapeHtml(questao.curso || '—')}` : ''}</div>
      </div>
    </article>
  `).join('');

  listaQuestoesEl.querySelectorAll('.item-questao').forEach((elemento) => {
    elemento.addEventListener('click', () => {
      Estado.detalheId = elemento.dataset.id;
      Estado.editando = false;
      renderizarBanco();
    });
  });
  listaQuestoesEl.querySelectorAll('[data-marcar]').forEach((botao) => {
    botao.addEventListener('click', (evento) => {
      evento.stopPropagation(); // marcar não deve trocar o detalhe aberto
      const id = botao.dataset.marcar;
      if (modoExclusaoBanco) {
        if (idsParaExcluirDoBanco.has(id)) idsParaExcluirDoBanco.delete(id);
        else idsParaExcluirDoBanco.add(id);
        renderizarLista();
      } else {
        alternarSelecao(id);
        renderizarBanco();
      }
    });
  });

  atualizarBarraExclusaoBanco();
}

// Botão "Selecionar para excluir" / "Cancelar seleção" no topo da lista.
btnModoExclusaoBancoEl.addEventListener('click', () => {
  modoExclusaoBanco = !modoExclusaoBanco;
  if (!modoExclusaoBanco) idsParaExcluirDoBanco.clear();
  renderizarLista();
});

// Barra que aparece acima da lista assim que pelo menos uma questão é
// marcada para excluir — some sozinha quando o lote fica vazio ou o modo
// é cancelado.
function atualizarBarraExclusaoBanco() {
  const quantidade = idsParaExcluirDoBanco.size;
  if (!modoExclusaoBanco || !quantidade) {
    acoesExclusaoBancoEl.classList.add('oculto');
    acoesExclusaoBancoEl.innerHTML = '';
    return;
  }

  acoesExclusaoBancoEl.classList.remove('oculto');
  acoesExclusaoBancoEl.innerHTML = `
    <span>${quantidade} ${quantidade === 1 ? 'questão marcada' : 'questões marcadas'}</span>
    <div class="lista-acoes-massa-botoes">
      <button type="button" class="btn-link" id="btnLimparExclusaoBanco">Limpar marcação</button>
      <button type="button" class="btn-link-perigo" id="btnExcluirSelecionadasBanco">Excluir selecionadas</button>
    </div>
  `;
  document.getElementById('btnLimparExclusaoBanco').addEventListener('click', () => {
    idsParaExcluirDoBanco.clear();
    renderizarLista();
  });
  document.getElementById('btnExcluirSelecionadasBanco').addEventListener('click', confirmarExclusaoEmLote);
}

// Troca a barra por uma confirmação inline — excluir do banco é
// permanente, então merece uma segunda pergunta, igual à exclusão de uma
// questão só (ver confirmarRemocao).
function confirmarExclusaoEmLote() {
  const quantidade = idsParaExcluirDoBanco.size;
  if (!quantidade) return;

  acoesExclusaoBancoEl.innerHTML = `
    <span>Excluir ${quantidade} ${quantidade === 1 ? 'questão' : 'questões'} permanentemente?</span>
    <div class="lista-acoes-massa-botoes">
      <button type="button" class="btn-link" id="btnCancelarConfirmacaoLote">Cancelar</button>
      <button type="button" class="btn-link-perigo" id="btnConfirmarExclusaoLote">Confirmar</button>
    </div>
  `;

  document.getElementById('btnCancelarConfirmacaoLote').addEventListener('click', () => renderizarLista());

  document.getElementById('btnConfirmarExclusaoLote').addEventListener('click', async (evento) => {
    evento.target.disabled = true;
    const ids = [...idsParaExcluirDoBanco];
    // Em paralelo — Promise.allSettled não deixa uma exclusão que falhar
    // derrubar as outras, mas não fica esperando uma de cada vez.
    const resultados = await Promise.allSettled(
      ids.map((id) => pedirJson(`/api/questoes/${encodeURIComponent(id)}`, { method: 'DELETE' })),
    );
    const erros = resultados
      .filter((resultado) => resultado.status === 'rejected')
      .map((resultado) => resultado.reason?.message || 'Falha desconhecida.');

    idsParaExcluirDoBanco.clear();
    modoExclusaoBanco = false;
    // Some da prova em montagem também, senão o PDF quebraria depois.
    const idsExcluidos = new Set(ids);
    Estado.selecionadas = Estado.selecionadas.filter((id) => !idsExcluidos.has(id));
    salvarSelecao();
    Estado.detalheId = null;
    await carregarQuestoes();

    if (erros.length) {
      acoesExclusaoBancoEl.classList.remove('oculto');
      acoesExclusaoBancoEl.innerHTML = `<span class="erro">Algumas questões não puderam ser excluídas: ${escapeHtml(erros[0])}</span>`;
    }
  });
}

function renderizarDetalhe() {
  const questao = questaoPorId(Estado.detalheId);

  if (!questao) {
    painelDetalheEl.innerHTML = '<div class="detalhe-vazio">Selecione uma questão na lista para ver os detalhes.</div>';
    return;
  }

  if (Estado.editando) {
    renderizarFormularioEdicao(questao);
    return;
  }

  const selecionada = estaSelecionada(questao.id);
  painelDetalheEl.innerHTML = `
    <div class="detalhe-topo">
      <div class="detalhe-identificacao">
        <span class="codigo">${escapeHtml(questao.codigo)}</span>
        <span class="etiqueta">${escapeHtml(rotuloPeriodo(questao).toUpperCase())}</span>
      </div>
      <div class="detalhe-acoes-topo">
        <button type="button" class="btn-secundario" id="btnEditarQuestao">Editar</button>
        <button type="button" class="btn-tracejado compacto" id="btnRemoverQuestao">Remover</button>
      </div>
    </div>

    <h2 class="detalhe-assunto">${escapeHtml(questao.assunto)}</h2>
    <blockquote class="detalhe-enunciado">${questao.texto ? htmlEdicaoComNegrito(questao.texto) : '(vazio)'}</blockquote>

    <dl class="detalhe-dados">
      <div><dt>Curso</dt><dd>${escapeHtml(questao.curso || '—')}</dd></div>
      <div><dt>Valor</dt><dd>${formatarPontos(questao.valor)} pts</dd></div>
      <div><dt>Origem</dt><dd>${escapeHtml(questao.tipoOrigem || 'manual')}</dd></div>
      <div><dt>Usada em</dt><dd>${questao.usadaEm || 0} prova(s)</dd></div>
      <div><dt>Cadastrada em</dt><dd>${questao.criadoEm ? new Date(questao.criadoEm).toLocaleDateString('pt-BR') : '—'}</dd></div>
    </dl>

    <div class="detalhe-acoes">
      <button type="button" class="btn-escuro" id="btnAlternarProva">
        ${selecionada ? 'Remover da prova atual' : 'Adicionar à prova atual'}
      </button>
      <button type="button" class="btn-secundario" id="btnIrMontagem">
        Montar prova (${Estado.selecionadas.length})
      </button>
    </div>
    <div class="status" id="statusDetalhe"></div>
  `;

  document.getElementById('btnAlternarProva').addEventListener('click', () => {
    alternarSelecao(questao.id);
    renderizarBanco();
  });
  document.getElementById('btnIrMontagem').addEventListener('click', () => mostrarView('montar'));
  document.getElementById('btnEditarQuestao').addEventListener('click', () => {
    Estado.editando = true;
    renderizarDetalhe();
  });
  document.getElementById('btnRemoverQuestao').addEventListener('click', () => confirmarRemocao(questao));
}

function renderizarFormularioEdicao(questao) {
  painelDetalheEl.innerHTML = `
    <div class="detalhe-topo">
      <div class="detalhe-identificacao">
        <span class="codigo">${escapeHtml(questao.codigo)}</span>
        <span class="etiqueta">Editando</span>
      </div>
    </div>

    <label class="campo">Enunciado (e alternativas, uma por linha)
      ${barraNegritoHtml()}
      <div id="edicaoTexto" class="editor editor-questao" contenteditable="true">${htmlEdicaoComNegrito(questao.texto)}</div>
    </label>

    <div class="campos-lado-a-lado">
      <label class="campo">Assunto
        <input type="text" id="edicaoAssunto" list="assuntosConhecidos" value="${escapeHtml(questao.assunto)}">
      </label>
      <label class="campo">Valor (pts)
        <input type="number" id="edicaoValor" min="0.5" max="100" step="0.5" value="${Number(questao.valor) || 1}">
      </label>
    </div>

    <div class="campos-lado-a-lado">
      <label class="campo">Período
        <select id="edicaoPeriodo">${opcoesPeriodo(questao.periodo)}</select>
      </label>
      <label class="campo">Ano
        <input type="number" id="edicaoAno" min="1990" max="2100" value="${questao.ano || ''}" placeholder="2024">
      </label>
    </div>

    ${cursosDoUsuario().length > 1 ? `
      <label class="campo">Curso
        <select id="edicaoCurso">${opcoesCurso(questao.curso)}</select>
      </label>
    ` : ''}

    <div class="detalhe-acoes">
      <button type="button" class="btn-escuro" id="btnSalvarEdicao">Salvar alterações</button>
      <button type="button" class="btn-secundario" id="btnCancelarEdicao">Cancelar</button>
    </div>
    <div class="status" id="statusDetalhe"></div>
  `;

  const statusEl = document.getElementById('statusDetalhe');
  configurarNegritoPorId('edicaoTexto');

  document.getElementById('btnCancelarEdicao').addEventListener('click', () => {
    Estado.editando = false;
    renderizarDetalhe();
  });

  document.getElementById('btnSalvarEdicao').addEventListener('click', async (evento) => {
    const texto = lerTextoDoCampo(document.getElementById('edicaoTexto')).trim();
    if (!texto) {
      statusEl.textContent = 'O enunciado não pode ficar vazio.';
      statusEl.className = 'status erro';
      return;
    }
    evento.target.disabled = true;
    statusEl.textContent = 'Salvando...';
    statusEl.className = 'status';
    try {
      await pedirJson(`/api/questoes/${encodeURIComponent(questao.id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          texto,
          assunto: document.getElementById('edicaoAssunto').value,
          valor: document.getElementById('edicaoValor').value,
          periodo: document.getElementById('edicaoPeriodo').value,
          ano: document.getElementById('edicaoAno').value,
          curso: document.getElementById('edicaoCurso')?.value,
        }),
      });
      Estado.editando = false;
      await carregarQuestoes();
    } catch (err) {
      evento.target.disabled = false;
      statusEl.textContent = err.message;
      statusEl.className = 'status erro';
    }
  });
}

function confirmarRemocao(questao) {
  const statusEl = document.getElementById('statusDetalhe');
  statusEl.className = 'status';
  statusEl.innerHTML = `
    <div class="confirmacao-exclusao">
      <span>Excluir esta questão permanentemente?</span>
      <button type="button" class="confirmar-exclusao">Confirmar</button>
      <button type="button" class="cancelar-exclusao">Cancelar</button>
    </div>
  `;

  statusEl.querySelector('.cancelar-exclusao').addEventListener('click', () => {
    statusEl.innerHTML = '';
  });
  statusEl.querySelector('.confirmar-exclusao').addEventListener('click', async (evento) => {
    evento.target.disabled = true;
    try {
      await pedirJson(`/api/questoes/${encodeURIComponent(questao.id)}`, { method: 'DELETE' });
      // Some da prova em montagem também, senão o PDF quebraria depois.
      const posicao = Estado.selecionadas.indexOf(questao.id);
      if (posicao >= 0) {
        Estado.selecionadas.splice(posicao, 1);
        salvarSelecao();
      }
      Estado.detalheId = null;
      await carregarQuestoes();
    } catch (err) {
      evento.target.disabled = false;
      statusEl.innerHTML = `<span class="erro">${escapeHtml(err.message)}</span>`;
    }
  });
}

function renderizarBanco() {
  renderizarFiltros();
  renderizarLista();
  renderizarDetalhe();
  window.MontagemProva?.renderizarMontagem();
}

async function carregarQuestoes() {
  resumoListaEl.textContent = 'Carregando…';
  try {
    const dados = await pedirJson('/api/questoes?limite=100');
    // "Q1, Q2, Q3..." é a posição da questão no banco — serve de código
    // curto para o professor se referir a ela nas telas.
    Estado.questoes = (dados.questoes || []).map((questao, indice) => ({
      ...questao,
      codigo: `Q${indice + 1}`,
    }));

    // Limpa da seleção o que não existe mais no banco.
    const idsValidos = new Set(Estado.questoes.map((questao) => questao.id));
    const antes = Estado.selecionadas.length;
    Estado.selecionadas = Estado.selecionadas.filter((id) => idsValidos.has(id));
    if (Estado.selecionadas.length !== antes) salvarSelecao();

    renderizarBanco();
    // Os indicadores do painel contam questões do banco.
    window.Painel?.renderizar({ recarregar: false });
  } catch (err) {
    listaQuestoesEl.innerHTML = '';
    resumoListaEl.innerHTML = `<span class="erro">${escapeHtml(err.message)}</span>`;
    painelDetalheEl.innerHTML = '<div class="detalhe-vazio">Não foi possível carregar o banco de questões.</div>';
  }
}

buscaPalavraChaveEl.addEventListener('input', () => {
  Estado.filtro.palavraChave = buscaPalavraChaveEl.value.trim().toLowerCase();
  renderizarLista();
  renderizarDetalhe();
});
buscaAssuntoEl.addEventListener('input', () => {
  Estado.filtro.assunto_busca = buscaAssuntoEl.value.trim().toLowerCase();
  renderizarLista();
  renderizarDetalhe();
});

/* ------------------------------------------- Drawer "Adicionar questão" */

const drawerEl = document.getElementById('drawer');
const drawerOverlayEl = document.getElementById('drawerOverlay');

function abrirDrawer() {
  drawerEl.classList.remove('oculto');
  drawerOverlayEl.classList.remove('oculto');
}
function fecharDrawer() {
  drawerEl.classList.add('oculto');
  drawerOverlayEl.classList.add('oculto');
}
document.getElementById('btnAbrirDrawer').addEventListener('click', abrirDrawer);
document.getElementById('btnNovaQuestao').addEventListener('click', abrirDrawer);
document.getElementById('btnFecharDrawer').addEventListener('click', fecharDrawer);
drawerOverlayEl.addEventListener('click', fecharDrawer);

document.querySelectorAll('.drawer-tab').forEach((botaoAba) => {
  botaoAba.addEventListener('click', () => {
    document.querySelectorAll('.drawer-tab').forEach((b) => b.classList.remove('ativo'));
    botaoAba.classList.add('ativo');
    const abaAlvo = botaoAba.dataset.tab;
    document.querySelectorAll('.drawer-painel').forEach((painel) => {
      painel.classList.toggle('oculto', painel.dataset.painel !== abaAlvo);
    });
  });
});

const btnPdf = document.getElementById('btnPdf');
const btnDocx = document.getElementById('btnDocx');
const btnImagem = document.getElementById('btnImagem');
const dropArea = document.getElementById('dropArea');
const inputArquivo = document.getElementById('inputArquivo');
const btnTirarFoto = document.getElementById('btnTirarFoto');
const inputFoto = document.getElementById('inputFoto');
const nomeArquivoEl = document.getElementById('nomeArquivo');
const tipoAceitoEl = document.getElementById('tipoAceito');
const btnEnviar = document.getElementById('btnEnviar');
const statusEl = document.getElementById('status');
const cardResultado = document.getElementById('cardResultado');
const metaEl = document.getElementById('meta');
const textoEl = document.getElementById('textoExtraido');
const btnCopiar = document.getElementById('btnCopiar');
const statusIdentificacaoEl = document.getElementById('statusIdentificacao');
const listaQuestoesIdentificadasEl = document.getElementById('listaQuestoesIdentificadas');

let tipo = 'pdf'; // 'pdf' | 'docx' | 'imagem'
let arquivoSelecionado = null;

function definirTipo(novoTipo) {
  tipo = novoTipo;
  const ehPdf = tipo === 'pdf';
  const ehDocx = tipo === 'docx';
  const ehImagem = tipo === 'imagem';
  btnPdf.classList.toggle('ativo', ehPdf);
  btnDocx.classList.toggle('ativo', ehDocx);
  btnImagem.classList.toggle('ativo', ehImagem);
  inputArquivo.accept = ehPdf ? '.pdf' : ehDocx ? '.docx' : 'image/jpeg,image/png,image/webp,image/gif,image/bmp,image/tiff';
  tipoAceitoEl.textContent = ehPdf ? 'Aceita: .pdf' : ehDocx ? 'Aceita: .docx' : 'Aceita: JPG, PNG, WEBP, GIF, BMP ou TIFF';
  dropArea.querySelector('p strong').textContent = ehImagem ? 'Clique para escolher da galeria' : 'Clique para escolher';
  btnTirarFoto.classList.toggle('oculto', !ehImagem);
  limparSelecao();
}

function limparSelecao() {
  arquivoSelecionado = null;
  nomeArquivoEl.textContent = '';
  btnEnviar.disabled = true;
  statusEl.textContent = '';
  statusEl.className = 'status';
}

function selecionarArquivo(arquivo) {
  const extensoesImagem = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.tif', '.tiff'];
  const extensaoEsperada = tipo === 'pdf' ? '.pdf' : '.docx';
  const valido = tipo === 'imagem'
    ? extensoesImagem.some((ext) => arquivo.name.toLowerCase().endsWith(ext))
    : arquivo.name.toLowerCase().endsWith(extensaoEsperada);
  if (!valido) {
    statusEl.textContent = tipo === 'imagem'
      ? 'Selecione uma imagem JPG, PNG, WEBP, GIF, BMP ou TIFF.'
      : `Selecione um arquivo ${extensaoEsperada}.`;
    statusEl.className = 'status erro';
    return;
  }
  arquivoSelecionado = arquivo;
  nomeArquivoEl.textContent = arquivo.name;
  btnEnviar.disabled = false;
  statusEl.textContent = '';
  statusEl.className = 'status';
}

btnPdf.addEventListener('click', () => definirTipo('pdf'));
btnDocx.addEventListener('click', () => definirTipo('docx'));
btnImagem.addEventListener('click', () => definirTipo('imagem'));

dropArea.addEventListener('click', () => inputArquivo.click());
inputArquivo.addEventListener('change', (e) => {
  if (e.target.files[0]) selecionarArquivo(e.target.files[0]);
});

// No celular, o atributo capture="environment" faz o navegador abrir a
// câmera traseira direto, em vez de mostrar a galeria — é isso que separa
// "tirar uma foto agora" de "escolher um arquivo já existente".
btnTirarFoto.addEventListener('click', () => inputFoto.click());
inputFoto.addEventListener('change', (e) => {
  if (e.target.files[0]) selecionarArquivo(e.target.files[0]);
});

['dragenter', 'dragover'].forEach((evento) => {
  dropArea.addEventListener(evento, (e) => {
    e.preventDefault();
    dropArea.classList.add('arrastando');
  });
});
['dragleave', 'drop'].forEach((evento) => {
  dropArea.addEventListener(evento, (e) => {
    e.preventDefault();
    dropArea.classList.remove('arrastando');
  });
});
dropArea.addEventListener('drop', (e) => {
  const arquivo = e.dataTransfer.files[0];
  if (arquivo) selecionarArquivo(arquivo);
});

btnEnviar.addEventListener('click', async () => {
  if (!arquivoSelecionado) return;

  btnEnviar.disabled = true;
  statusEl.textContent = tipo === 'imagem' ? 'Lendo imagem com OCR (a primeira pode demorar mais)...' : 'Extraindo...';
  statusEl.className = 'status';
  cardResultado.classList.add('oculto');

  const formData = new FormData();
  formData.append('arquivo', arquivoSelecionado);

  const endpoint = tipo === 'pdf'
    ? '/api/questoes/extrair-pdf'
    : tipo === 'docx' ? '/api/questoes/extrair-docx' : '/api/questoes/extrair-imagem';

  try {
    const resposta = await fetch(API_BASE + endpoint, { method: 'POST', body: formData });
    const conteudo = await resposta.text();
    let dados;
    try {
      dados = JSON.parse(conteudo);
    } catch (_) {
      throw new Error(
        resposta.status >= 500
          ? `O servidor retornou um erro ${resposta.status}. Confira os logs. Detalhe: ${conteudo.slice(0, 180)}`
          : conteudo.slice(0, 180) || 'Resposta inválida do servidor.'
      );
    }

    if (!resposta.ok) throw new Error(dados.erro || 'Erro ao extrair o texto.');

    statusEl.textContent = 'Extração concluída.';
    statusEl.className = 'status ok';

    const partesMeta = [`Arquivo: ${dados.nomeArquivo}`];
    if (typeof dados.paginas === 'number') partesMeta.push(`${dados.paginas} página(s)`);
    if (dados.avisos && dados.avisos.length) partesMeta.push(`${dados.avisos.length} aviso(s) de conversão`);
    if (typeof dados.confianca === 'number') partesMeta.push(`confiança OCR: ${dados.confianca}%`);
    metaEl.textContent = partesMeta.join(' · ');

    textoEl.value = dados.texto || '(nenhum texto encontrado)';
    cardResultado.classList.remove('oculto');

    await identificarErenderizarQuestoes(
      dados.texto || '', tipo, arquivoSelecionado?.name || null,
      listaQuestoesIdentificadasEl, statusIdentificacaoEl,
    );
  } catch (err) {
    statusEl.textContent = err.message;
    statusEl.className = 'status erro';
  } finally {
    btnEnviar.disabled = false;
  }
});

btnCopiar.addEventListener('click', () => {
  textoEl.select();
  document.execCommand('copy');
  btnCopiar.textContent = 'Copiado';
  setTimeout(() => (btnCopiar.textContent = 'Copiar texto bruto'), 1500);
});

// Monta o texto final de uma questão (enunciado + alternativas, se houver)
// a partir do que foi identificado automaticamente.
function montarTextoQuestao(questao) {
  const partes = [questao.enunciado];
  if (questao.alternativas && questao.alternativas.length) {
    partes.push('', ...questao.alternativas);
  }
  return partes.join('\n').trim();
}

async function salvarQuestaoNoFirebase(dados) {
  return pedirJson('/api/questoes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(dados),
  });
}

// Chama o motor de identificação de questões (regras, roda no servidor,
// sem custo) e desenha um card editável para cada questão encontrada, já
// sem cabeçalho/instruções/rodapé. O professor confere, classifica
// (assunto, período e valor em pontos) e salva cada uma individualmente.
async function identificarErenderizarQuestoes(textoBruto, tipoOrigem, nomeArquivo, containerEl, statusAlvoEl, emailMeta = null) {
  containerEl.innerHTML = '';
  if (!textoBruto.trim()) {
    statusAlvoEl.textContent = '';
    return;
  }

  statusAlvoEl.textContent = 'Identificando questões...';
  statusAlvoEl.className = 'status';

  let questoes = [];
  let correcaoAplicada = true;
  try {
    const dados = await pedirJson('/api/questoes/identificar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ texto: textoBruto }),
    });
    questoes = dados.questoes || [];
    correcaoAplicada = dados.correcaoAplicada !== false;
  } catch (err) {
    statusAlvoEl.textContent = `Não foi possível identificar automaticamente: ${err.message}`;
    statusAlvoEl.className = 'status erro';
    return;
  }

  if (questoes.length === 0) {
    statusAlvoEl.textContent = '';
    containerEl.innerHTML = `
      <div class="aviso-identificacao">
        Nenhuma questão foi reconhecida automaticamente nesse texto (pode ter sobrado só
        cabeçalho/instrução, ou o formato fugiu do padrão). Revise o texto original e tente
        reformular com uma numeração mais clara (ex.: "1.", "2)"), se for o caso.
      </div>`;
    return;
  }

  statusAlvoEl.textContent = `${questoes.length} questão(ões) identificada(s). Confira cada uma antes de salvar.`;
  statusAlvoEl.className = 'status ok';
  if (!correcaoAplicada) {
    statusAlvoEl.textContent += ' (correção automática de português indisponível no momento — revise com atenção.)';
  }

  questoes.forEach((questao) => {
    const item = document.createElement('div');
    item.className = 'questao-candidata';
    item.innerHTML = `
      <div class="questao-candidata-cabecalho">
        <strong>Questão ${questao.numero}</strong>
        <span class="badge">${questao.alternativas && questao.alternativas.length ? 'múltipla escolha' : 'dissertativa'}</span>
      </div>
      ${barraNegritoHtml()}
      <div class="texto-questao-candidata editor" contenteditable="true">${htmlEdicaoComNegrito(montarTextoQuestao(questao))}</div>
      <div class="classificacao">
        <label class="campo">Assunto
          <input type="text" class="campo-assunto" list="assuntosConhecidos" placeholder="Ex.: Padrões de Projeto">
        </label>
        <label class="campo">Valor (pts)
          <input type="number" class="campo-valor" min="0.5" max="100" step="0.5" value="1">
        </label>
        <label class="campo">Período
          <select class="campo-periodo">${opcoesPeriodo()}</select>
        </label>
        <label class="campo">Ano
          <input type="number" class="campo-ano" min="1990" max="2100" placeholder="2024">
        </label>
        ${cursosDoUsuario().length > 1 ? `
          <label class="campo">Curso
            <select class="campo-curso">${opcoesCurso()}</select>
          </label>
        ` : ''}
      </div>
      <div class="acoes">
        <button class="salvar btn-salvar-candidata">Salvar questão</button>
        <button class="verificar btn-verificar-candidata" type="button">Verificar conteúdo com IA</button>
        <button class="corrigir btn-corrigir-ia-candidata" type="button">Corrigir com IA</button>
        <button class="excluir btn-descartar-candidata">Descartar</button>
      </div>
      <div class="status-inline"></div>
      <div class="verificacao-conteudo oculto"></div>
    `;
    containerEl.appendChild(item);

    const textareaEl = item.querySelector('.texto-questao-candidata');
    const avisoEl = item.querySelector('.status-inline');
    configurarNegrito(textareaEl, item.querySelector('.botao-negrito'));

    item.querySelector('.btn-descartar-candidata').addEventListener('click', () => item.remove());

    item.querySelector('.btn-verificar-candidata').addEventListener('click', async (evento) => {
      const botao = evento.target;
      const caixaVerificacao = item.querySelector('.verificacao-conteudo');
      botao.disabled = true;
      botao.textContent = 'Verificando...';
      caixaVerificacao.classList.remove('oculto');
      caixaVerificacao.className = 'verificacao-conteudo';
      caixaVerificacao.textContent = 'Consultando IA (Gemini)...';
      try {
        // Usa o texto atual do textarea (o professor pode já ter editado).
        // Separa linhas de alternativa (A), B) etc.) do resto, mas MANTÉM
        // todas as outras linhas juntas no enunciado — dissertativas longas
        // podem ocupar várias linhas.
        const linhas = lerTextoDoCampo(textareaEl).split('\n');
        const alternativasAtuais = linhas.filter((l) => /^[A-E]\)/.test(l.trim()));
        const enunciadoAtual = linhas.filter((l) => !/^[A-E]\)/.test(l.trim())).join('\n');
        const dados = await pedirJson('/api/questoes/verificar-conteudo', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enunciado: enunciadoAtual, alternativas: alternativasAtuais }),
        });
        if (!dados.disponivel) {
          caixaVerificacao.className = 'verificacao-conteudo indisponivel';
          caixaVerificacao.textContent = dados.motivo || 'Verificação indisponível no momento.';
        } else if (dados.coerente) {
          caixaVerificacao.className = 'verificacao-conteudo ok';
          caixaVerificacao.textContent = `O conteúdo parece coerente.${dados.observacao ? ' ' + dados.observacao : ''}`;
        } else {
          caixaVerificacao.className = 'verificacao-conteudo alerta';
          caixaVerificacao.textContent = `Possível problema: ${dados.observacao || 'revise o conteúdo desta questão.'}`;
        }
      } catch (err) {
        caixaVerificacao.className = 'verificacao-conteudo indisponivel';
        caixaVerificacao.textContent = err.message;
      } finally {
        botao.disabled = false;
        botao.textContent = 'Verificar conteúdo com IA';
      }
    });

    item.querySelector('.btn-corrigir-ia-candidata').addEventListener('click', async (evento) => {
      const botao = evento.target;
      const caixaVerificacao = item.querySelector('.verificacao-conteudo');
      botao.disabled = true;
      botao.textContent = 'Corrigindo...';
      caixaVerificacao.classList.remove('oculto');
      caixaVerificacao.className = 'verificacao-conteudo';
      caixaVerificacao.textContent = 'Consultando IA (Gemini)...';
      try {
        const linhas = lerTextoDoCampo(textareaEl).split('\n');
        const alternativasAtuais = linhas.filter((l) => /^[A-E]\)/.test(l.trim()));
        const enunciadoAtual = linhas.filter((l) => !/^[A-E]\)/.test(l.trim())).join('\n');
        const dados = await pedirJson('/api/questoes/corrigir-com-ia', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enunciado: enunciadoAtual, alternativas: alternativasAtuais }),
        });
        if (!dados.disponivel) {
          caixaVerificacao.className = 'verificacao-conteudo indisponivel';
          caixaVerificacao.textContent = dados.motivo || 'Correção indisponível no momento.';
        } else {
          // Só atualiza o textarea — o professor decide se salva depois de
          // revisar. Nada é salvo automaticamente.
          const partes = [dados.enunciado];
          if (dados.alternativas && dados.alternativas.length) partes.push('', ...dados.alternativas);
          escreverTextoNoCampo(textareaEl, partes.join('\n').trim());
          const possivelPerdaDeConteudo = (dados.observacao || '').toLowerCase().startsWith('[atenção]');
          const observacaoLimpa = (dados.observacao || '').replace(/^\[atenção\]\s*/i, '');
          caixaVerificacao.className = possivelPerdaDeConteudo
            ? 'verificacao-conteudo alerta'
            : 'verificacao-conteudo ok';
          caixaVerificacao.textContent = observacaoLimpa
            ? `${possivelPerdaDeConteudo ? '' : 'Corrigido: '}${observacaoLimpa} Revise antes de salvar.`
            : 'A IA não encontrou nada pra corrigir aqui.';
        }
      } catch (err) {
        caixaVerificacao.className = 'verificacao-conteudo indisponivel';
        caixaVerificacao.textContent = err.message;
      } finally {
        botao.disabled = false;
        botao.textContent = 'Corrigir com IA';
      }
    });

    item.querySelector('.btn-salvar-candidata').addEventListener('click', async (evento) => {
      if (!lerTextoDoCampo(textareaEl).trim()) {
        avisoEl.className = 'status-inline erro';
        avisoEl.textContent = 'A questão não pode ficar vazia.';
        return;
      }
      const botao = evento.target;
      botao.disabled = true;
      item.querySelector('.btn-descartar-candidata').disabled = true;
      avisoEl.className = 'status-inline';
      avisoEl.textContent = 'Salvando no Firebase...';
      try {
        await salvarQuestaoNoFirebase({
          texto: lerTextoDoCampo(textareaEl),
          tipoOrigem,
          nomeArquivo,
          assunto: item.querySelector('.campo-assunto').value,
          valor: item.querySelector('.campo-valor').value,
          periodo: item.querySelector('.campo-periodo').value,
          ano: item.querySelector('.campo-ano').value,
          curso: item.querySelector('.campo-curso')?.value || cursosDoUsuario()[0],
          emailMessageId: emailMeta?.messageId || null,
          emailFonte: emailMeta?.fonte || null,
        });
        item.classList.add('salva');
        avisoEl.className = 'status-inline';
        avisoEl.textContent = 'Salva com sucesso.';
        travarCampo(textareaEl);
        botao.textContent = 'Salva';
        item.querySelector('.btn-descartar-candidata').classList.add('oculto');
        carregarQuestoes();
      } catch (err) {
        avisoEl.className = 'status-inline erro';
        avisoEl.textContent = err.message;
        botao.disabled = false;
        item.querySelector('.btn-descartar-candidata').disabled = false;
      }
    });
  });
}

/* ------------------------------------------------------ aba Texto e E-mail */

const editorQuestao = document.getElementById('editorQuestao');
configurarNegrito(
  editorQuestao,
  editorQuestao ? editorQuestao.parentElement.querySelector('.botao-negrito') : null,
);
const statusEditadaEl = document.getElementById('statusEditada');
const listaQuestoesIdentificadasManualEl = document.getElementById('listaQuestoesIdentificadasManual');

document.getElementById('btnSalvarEditada').addEventListener('click', async () => {
  const texto = lerTextoDoCampo(editorQuestao).trim();
  if (!texto) {
    statusEditadaEl.textContent = 'Escreva ou cole um texto antes de identificar.';
    statusEditadaEl.className = 'status erro';
    return;
  }
  const botao = document.getElementById('btnSalvarEditada');
  botao.disabled = true;
  try {
    await identificarErenderizarQuestoes(
      texto, 'manual', 'questao-escrita',
      listaQuestoesIdentificadasManualEl, statusEditadaEl,
    );
  } finally {
    botao.disabled = false;
  }
});

const btnVerificarEmail = document.getElementById('btnVerificarEmail');
const statusEmailEl = document.getElementById('statusEmail');
const listaEmailsEl = document.getElementById('listaEmails');

const btnCopiarEnderecoEmail = document.getElementById('btnCopiarEnderecoEmail');
btnCopiarEnderecoEmail?.addEventListener('click', async () => {
  const endereco = document.getElementById('enderecoEmailSistema').textContent;
  try {
    await navigator.clipboard.writeText(endereco);
  } catch (_) {
    // Sem permissão de clipboard (ex.: contexto não seguro) — usuário copia manualmente.
  }
  btnCopiarEnderecoEmail.textContent = 'Copiado';
  setTimeout(() => (btnCopiarEnderecoEmail.textContent = 'Copiar'), 1500);
});

function mostrarErroNoCard(elemento, mensagem) {
  const card = elemento.closest('.email-item');
  if (!card) return;
  let aviso = card.querySelector('.status-inline');
  if (!aviso) {
    aviso = document.createElement('div');
    aviso.className = 'status-inline erro';
    card.appendChild(aviso);
  }
  aviso.textContent = mensagem;
}

btnVerificarEmail.addEventListener('click', async () => {
  btnVerificarEmail.disabled = true;
  statusEmailEl.textContent = 'Buscando e-mails enviados por você...';
  statusEmailEl.className = 'status';
  listaEmailsEl.innerHTML = '';

  try {
    const dados = await pedirJson('/api/questoes/verificar-email', { method: 'POST' });

    statusEmailEl.textContent = dados.quantidade === 0
      ? 'Nenhum e-mail seu encontrado na caixa de entrada do sistema.'
      : `${dados.quantidade} e-mail(s) seu(s) encontrado(s).`;
    statusEmailEl.className = 'status ok';

    dados.emails.forEach((email) => {
      const anexosHtml = (email.anexos || []).map((anexo, indice) => `
        <div class="anexo">
          <div class="anexo-nome">
            ${escapeHtml(anexo.nomeArquivo || 'anexo')}
            ${anexo.jaSalvo ? '<span class="badge-processado">já salvo</span>' : ''}
          </div>
          <div class="corpo">${escapeHtml(anexo.erro ? 'Erro: ' + anexo.erro : (anexo.texto || ''))}</div>
          ${anexo.texto ? `<button class="salvar salvar-email-anexo" data-anexo="${indice}">${anexo.jaSalvo ? 'Processar de novo' : 'Identificar questões do anexo'}</button>` : ''}
        </div>
      `).join('');

      const item = document.createElement('div');
      item.className = 'email-item';
      item.innerHTML = `
        <div class="assunto">
          ${escapeHtml(email.assunto || '(sem assunto)')}
          ${email.corpoJaSalvo ? '<span class="badge-processado">corpo já salvo</span>' : ''}
        </div>
        <div class="remetente">${escapeHtml(email.de || '')}${email.data ? ' · ' + new Date(email.data).toLocaleDateString('pt-BR') : ''}</div>
        <div class="corpo">${escapeHtml(email.textoCorpo || '(corpo vazio)')}</div>
        ${email.textoCorpo ? `<button class="salvar salvar-email-corpo">${email.corpoJaSalvo ? 'Processar de novo' : 'Identificar questões do corpo'}</button>` : ''}
        <button class="excluir remover-email" title="Também exclui o e-mail da caixa de entrada (vai para a Lixeira do Gmail)">Remover da tela</button>
        ${anexosHtml}
        <div class="status status-email-item"></div>
        <div class="candidatas-email"></div>
      `;
      listaEmailsEl.appendChild(item);

      const containerCandidatas = item.querySelector('.candidatas-email');
      const statusItemEl = item.querySelector('.status-email-item');

      item.querySelector('.remover-email').addEventListener('click', async (evento) => {
        if (!email.uid) {
          item.remove();
          return;
        }
        const confirmou = window.confirm(
          'Isso remove o e-mail da tela e também o exclui da caixa de entrada (ele vai para a Lixeira do Gmail). Deseja continuar?'
        );
        if (!confirmou) return;

        const botao = evento.target;
        botao.disabled = true;
        botao.textContent = 'Removendo...';
        try {
          await pedirJson('/api/questoes/excluir-email', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ uid: email.uid }),
          });
          item.remove();
        } catch (err) {
          botao.disabled = false;
          botao.textContent = 'Remover da tela';
          mostrarErroNoCard(botao, err.message);
        }
      });
      item.querySelector('.salvar-email-corpo')?.addEventListener('click', async (evento) => {
        evento.target.disabled = true;
        try {
          await identificarErenderizarQuestoes(
            email.textoCorpo, 'email', email.assunto || 'email', containerCandidatas, statusItemEl,
            { messageId: email.messageId, fonte: 'corpo' },
          );
        } catch (err) {
          mostrarErroNoCard(evento.target, err.message);
        } finally {
          evento.target.disabled = false;
        }
      });
      item.querySelectorAll('.salvar-email-anexo').forEach((botao) => botao.addEventListener('click', async (evento) => {
        evento.target.disabled = true;
        const anexo = email.anexos[Number(evento.target.dataset.anexo)];
        try {
          await identificarErenderizarQuestoes(
            anexo.texto, anexo.tipo || 'email-anexo', anexo.nomeArquivo || 'anexo',
            containerCandidatas, statusItemEl,
            { messageId: email.messageId, fonte: anexo.nomeArquivo || 'anexo' },
          );
        } catch (err) {
          mostrarErroNoCard(evento.target, err.message);
        } finally {
          evento.target.disabled = false;
        }
      }));
    });
  } catch (err) {
    statusEmailEl.textContent = err.message;
    statusEmailEl.className = 'status erro';
  } finally {
    btnVerificarEmail.disabled = false;
  }
});

/* -------------------------------------------------------------- sessão/usuário */

const EstadoUsuario = { atual: null };

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

// Preenche o avatar/nome da sidebar e do topo do painel com os dados do
// usuário autenticado (chega uma única vez, na inicialização).
function aplicarUsuarioNaInterface(usuario) {
  const legenda = [rotuloPerfil(usuario.perfil), usuario.cargo || null].filter(Boolean).join(' · ');
  document.querySelectorAll('#avatarSidebar, #avatarTopo, #avatarMobile').forEach((el) => {
    el.textContent = iniciais(usuario.nome);
  });
  const nomeEl = document.getElementById('contaNomeSidebar');
  const legendaEl = document.getElementById('contaLegendaSidebar');
  if (nomeEl) nomeEl.textContent = usuario.nome;
  if (legendaEl) legendaEl.textContent = legenda || rotuloPerfil(usuario.perfil);
  const avatarTopo = document.getElementById('avatarTopo');
  if (avatarTopo) avatarTopo.title = usuario.nome;

  // Sugestão inicial do campo "Professor(a)" na revisão da prova — o
  // usuário pode alterar livremente antes de gerar o PDF.
  const campoProfessor = document.getElementById('campoProfessor');
  if (campoProfessor && !campoProfessor.value) campoProfessor.value = usuario.nome;
}

async function carregarSessao() {
  try {
    const { usuario } = await pedirJson('/api/auth/me');
    EstadoUsuario.atual = usuario;
    aplicarUsuarioNaInterface(usuario);
  } catch (_) {
    window.location.href = '/login.html';
  }
}

document.getElementById('btnSair')?.addEventListener('click', async () => {
  try {
    await pedirJson('/api/auth/logout', { method: 'POST' });
  } finally {
    window.location.href = '/login.html';
  }
});

/* ------------------------------------------------------------- inicialização */

Estado.selecionadas = lerSelecaoSalva();

// Superfície usada por montarProva.js e perfil.js.
window.App = {
  Estado,
  EstadoUsuario,
  API_BASE,
  escapeHtml,
  formatarPontos,
  textoLimpo,
  resumir,
  rotuloPeriodo,
  estaSelecionada,
  alternarSelecao,
  salvarSelecao,
  questaoPorId,
  arquivarQuestoesDeProva,
  questoesSelecionadas,
  pontuacaoSelecionada,
  pedirJson,
  pedirPdf,
  ligarBotaoEnviarEmail,
  mostrarView,
  carregarQuestoes,
  renderizarBanco,
  abrirDrawer,
  Constantes,
  cursosDoUsuario,
  opcoesPeriodo,
  opcoesCurso,
};

Promise.all([carregarConstantes(), carregarSessao()]).then(() => carregarQuestoes());
