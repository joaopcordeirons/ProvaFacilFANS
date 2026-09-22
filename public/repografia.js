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

function linhaProva(prova) {
  const link = `/api/provas/${encodeURIComponent(prova.id)}/previa-pdf`;
  return `
    <tr>
      <td class="prova-titulo" data-th="Prova">${escapeHtml(prova.titulo)}</td>
      <td data-th="Disciplina">${escapeHtml(prova.curso || '—')}</td>
      <td class="numerica" data-th="Questões">${escapeHtml(String(prova.quantidadeQuestoes || 0))}</td>
      <td class="discreta" data-th="Aprovada em">${escapeHtml(dataRelativa(prova.atualizadoEm || prova.criadoEm))}</td>
      <td class="acao" data-th="">
        <a href="${link}" target="_blank" rel="noopener">Abrir PDF ↗</a>
      </td>
    </tr>
  `;
}

async function carregarProvas() {
  try {
    const { provas } = await pedirJson('/api/provas?limite=50');
    if (!provas.length) {
      tabelaEl.innerHTML = '<div class="lista-vazia">Nenhuma prova aprovada no momento.</div>';
      return;
    }
    tabelaEl.innerHTML = `
      <table class="tabela-provas">
        <thead>
          <tr>
            <th>Prova</th><th>Disciplina</th><th class="numerica">Questões</th>
            <th>Aprovada em</th><th></th>
          </tr>
        </thead>
        <tbody>${provas.map(linhaProva).join('')}</tbody>
      </table>
    `;
  } catch (err) {
    tabelaEl.innerHTML = `<div class="lista-vazia">${escapeHtml(err.message)}</div>`;
  }
}

carregarConta();
carregarProvas();
