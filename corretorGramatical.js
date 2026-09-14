// corretorGramatical.js
// Correção ortográfica e gramatical de verdade, usando o LanguageTool
// (https://languagetool.org) — motor de código aberto, o mesmo tipo de
// checagem usada em extensões de navegador e no LibreOffice. Por padrão
// usamos a API pública gratuita deles; se o uso crescer muito e esbarrar
// no limite de requisições da API pública, o LanguageTool também pode
// ser auto-hospedado de graça (é um container Docker) — só trocar a URL
// em LANGUAGETOOL_URL, sem mudar nada no resto do código.

const LANGUAGETOOL_URL = process.env.LANGUAGETOOL_URL || 'https://api.languagetool.org/v2/check';

// Tempo máximo de espera pela correção. Se o serviço estiver lento ou
// fora do ar, seguimos com o texto original em vez de travar o professor.
const TIMEOUT_MS = 8000;

// Aplica as correções sugeridas pelo LanguageTool no texto original.
// Percorre os "matches" do fim pro começo do texto, assim trocar um
// trecho não bagunça a posição (offset) dos trechos seguintes.
function aplicarCorrecoes(textoOriginal, matches) {
  const comSugestao = matches
    .filter((m) => Array.isArray(m.replacements) && m.replacements.length > 0)
    .sort((a, b) => b.offset - a.offset);

  let resultado = textoOriginal;
  for (const match of comSugestao) {
    const sugestao = match.replacements[0].value;
    resultado = resultado.slice(0, match.offset) + sugestao + resultado.slice(match.offset + match.length);
  }
  return resultado;
}

// Corrige ortografia/gramática de um texto em português. Nunca lança
// erro para quem chamou: se o serviço falhar, cair a rede ou estourar o
// tempo limite, devolve o texto original sem corrigir (aplicado: false),
// pra nunca travar o fluxo do professor por causa de um serviço externo.
async function corrigirTexto(texto) {
  const textoOriginal = String(texto || '');
  if (!textoOriginal.trim()) return { textoCorrigido: textoOriginal, aplicado: false };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const params = new URLSearchParams();
    params.append('text', textoOriginal);
    params.append('language', 'pt-BR');

    const resposta = await fetch(LANGUAGETOOL_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params,
      signal: controller.signal,
    });

    if (!resposta.ok) throw new Error(`LanguageTool respondeu status ${resposta.status}`);
    const dados = await resposta.json();
    const textoCorrigido = aplicarCorrecoes(textoOriginal, dados.matches || []);
    return { textoCorrigido, aplicado: true, totalCorrecoes: (dados.matches || []).length };
  } catch (err) {
    console.warn('[corretorGramatical] Não foi possível corrigir com LanguageTool, mantendo texto original:', err.message);
    return { textoCorrigido: textoOriginal, aplicado: false, erro: err.message };
  } finally {
    clearTimeout(timeoutId);
  }
}

module.exports = { corrigirTexto };
