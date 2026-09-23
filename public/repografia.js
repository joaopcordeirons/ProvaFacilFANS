/* repografia.js
 * Tela da Repografia: lista só as provas já aprovadas pela Direção e
 * permite abrir/baixar o PDF de cada uma. Página independente da SPA
 * principal — sem banco de questões, sem montagem de prova, sem revisão.
 */

const API_BASE = window.location.origin;

async function pedirJson(caminho, opcoes) {
  const resposta = await fetch(API_BASE + caminho, opcoes);
  const dados = await resposta.json().catch(() => ({}));
  if (!resposta.ok) throw new Error(dados.erro || 'Falha na comunicação com o servidor.');
  return dados;
}

function escapeHtml(texto) {
  return String(texto ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function dataRelativa(iso) {
  if (!iso) return '—';
  const data = new Date(iso);
  if (Number.isNaN(data.getTime())) return '—';
  const hora = data.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  const dia = (valor) => new Date(valor.getFullYear(), valor.getMonth(), valor.getDate()).getTime();
  const diferenca = Math.round((dia(new Date()) - dia(data)) / 86400000);
  if (diferenca === 0) return `Hoje, ${hora}`;
  if (diferenca === 1) return `Ontem, ${hora}`;
  return `${data.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })}, ${hora}`;
}

/* -------------------------------------------------------------- conta */

async function carregarConta() {
  try {
    const { usuario } = await pedirJson('/api/auth/me');
    document.getElementById('contaNome').textContent = usuario.nome;
    document.getElementById('avatarConta').textContent = usuario.nome.trim().slice(0, 2).toUpperCase();
  } catch (_) {
    window.location.href = '/login.html';
  }
}

document.getElementById('btnSair').addEventListener('click', async () => {
  try {
    await pedirJson('/api/auth/logout', { method: 'POST' });
  } finally {
    window.location.href = '/login.html';
  }
});

/* -------------------------------------------------------------- lista */

const tabelaEl = document.getElementById('tabelaProvasRepografia');
const filtroOcultarEl = document.getElementById('filtroOcultarImpressas');

// Provas já carregadas, mantidas em memória para o filtro "ocultar já
// impressas" não precisar buscar tudo de novo no servidor a cada clique.
let provasCarregadas = [];

function linhaProva(prova) {
  const link = `/api/provas/${encodeURIComponent(prova.id)}/previa-pdf`;
  const impressa = !!prova.impressa;
  return `
    <tr class="${impressa ? 'linha-impressa' : ''}" data-id="${escapeHtml(prova.id)}">
      <td class="prova-titulo" data-th="Prova">${escapeHtml(prova.titulo)}</td>
      <td data-th="Disciplina">${escapeHtml(prova.curso || '—')}</td>
      <td class="numerica" data-th="Questões">${escapeHtml(String(prova.quantidadeQuestoes || 0))}</td>
      <td class="discreta" data-th="Aprovada em">${escapeHtml(dataRelativa(prova.atualizadoEm || prova.criadoEm))}</td>
      <td data-th="Impressa">
        <label class="impressa-toggle">
          <input type="checkbox" class="marcarImpressa" data-id="${escapeHtml(prova.id)}" ${impressa ? 'checked' : ''}>
          <span class="impressa-rotulo ${impressa ? 'feita' : 'pendente'}">${impressa ? 'Impressa' : 'Pendente'}</span>
        </label>
      </td>
      <td class="acao" data-th="">
        <a href="${link}" target="_blank" rel="noopener">Abrir PDF ↗</a>
      </td>
    </tr>
  `;
}

function renderizarTabela() {
  const ocultarImpressas = filtroOcultarEl.checked;
  const visiveis = ocultarImpressas
    ? provasCarregadas.filter((prova) => !prova.impressa)
    : provasCarregadas;

  if (!provasCarregadas.length) {
    tabelaEl.innerHTML = '<div class="lista-vazia">Nenhuma prova aprovada no momento.</div>';
    return;
  }
  if (!visiveis.length) {
    tabelaEl.innerHTML = '<div class="lista-vazia">Todas as provas já foram impressas.</div>';
    return;
  }

  tabelaEl.innerHTML = `
    <table class="tabela-provas">
      <thead>
        <tr>
          <th>Prova</th><th>Disciplina</th><th class="numerica">Questões</th>
          <th>Aprovada em</th><th>Impressa</th><th></th>
        </tr>
      </thead>
      <tbody>${visiveis.map(linhaProva).join('')}</tbody>
    </table>
  `;

  tabelaEl.querySelectorAll('.marcarImpressa').forEach((checkbox) => {
    checkbox.addEventListener('change', () => alternarImpressao(checkbox));
  });
}

// Marca/desmarca no servidor assim que o professor da Repografia clica na
// caixinha, e atualiza o estado local (sem recarregar a lista inteira) —
// se der erro, desfaz o clique e avisa.
async function alternarImpressao(checkbox) {
  const id = checkbox.dataset.id;
  const impressa = checkbox.checked;
  checkbox.disabled = true;
  try {
    const { prova } = await pedirJson(`/api/provas/${encodeURIComponent(id)}/impressao`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ impressa }),
    });
    const indice = provasCarregadas.findIndex((p) => p.id === id);
    if (indice !== -1) provasCarregadas[indice] = prova;
    renderizarTabela();
  } catch (err) {
    checkbox.checked = !impressa;
    checkbox.disabled = false;
    alert(err.message || 'Não foi possível atualizar. Tente novamente.');
  }
}

async function carregarProvas() {
  try {
    const { provas } = await pedirJson('/api/provas?limite=50');
    provasCarregadas = provas;
    renderizarTabela();
  } catch (err) {
    tabelaEl.innerHTML = `<div class="lista-vazia">${escapeHtml(err.message)}</div>`;
  }
}

filtroOcultarEl.addEventListener('change', renderizarTabela);

carregarConta();
carregarProvas();
