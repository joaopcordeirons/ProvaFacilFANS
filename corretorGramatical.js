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

// Se boa parte das linhas do texto tem cara de código-fonte (chaves,
// ponto e vírgula, palavras-chave de programação...), não faz sentido
// nenhum rodar um corretor ortográfico de PORTUGUÊS em cima disso: cada
// identificador/palavra reservada ("void", "scanf", "println"...) seria
// sinalizado como erro de digitação. Além de inútil, isso é o que causa
// o bug visto na prática: um texto com dezenas de "erros" consecutivos
// nessas condições pode facilmente estourar o limite de sugestões da API
// pública do LanguageTool, que a partir daí passa a devolver um AVISO
// interno (algo como "limite sugerido alcançado") no lugar da sugestão de
// verdade — e sem essa checagem, esse aviso acaba entrando no texto como
// se fosse uma correção legítima.
function pareceCodigoFonte(texto) {
  const linhas = texto.split('\n').map((l) => l.trim()).filter(Boolean);
  if (!linhas.length) return false;
  const linhasComCaraDeCodigo = linhas.filter((linha) =>
    /[{};]/.test(linha) ||
    /^(void|int|float|double|char|bool|string|for|while|if|else|switch|case|return|scanf|printf|println|print|def|function|class|public|private|static)\b/i.test(linha)
  ).length;
  return linhasComCaraDeCodigo / linhas.length >= 0.3;
}

// Aplica as correções sugeridas pelo LanguageTool no texto original.
// Percorre os "matches" do fim pro começo do texto, assim trocar um
// trecho não bagunça a posição (offset) dos trechos seguintes.
//
// Antes de aplicar qualquer sugestão, filtramos matches suspeitos — a API
// pública do LanguageTool pode devolver, junto com sugestões de verdade,
// avisos internos (limite de sugestões, limite de requisições etc.) na
// mesma estrutura de uma sugestão normal. Dois sinais confiáveis de que
// uma "sugestão" não é uma correção de verdade: (1) o mesmo texto de
// substituição aparece repetido em vários matches diferentes — uma
// sugestão ortográfica de verdade é específica pra cada erro, não se
// repete igual dezenas de vezes; (2) o tamanho da substituição é muito
// diferente do tamanho do trecho original — uma correção ortográfica
// normal troca uma palavra por outra de tamanho parecido, não por uma
// frase inteira entre parênteses.
function aplicarCorrecoes(textoOriginal, matches) {
  const comSugestao = matches.filter((m) => Array.isArray(m.replacements) && m.replacements.length > 0);

  const contagemPorSugestao = new Map();
  for (const match of comSugestao) {
    const valor = match.replacements[0].value;
    contagemPorSugestao.set(valor, (contagemPorSugestao.get(valor) || 0) + 1);
  }

  const validos = comSugestao
    .filter((match) => {
      const sugestao = match.replacements[0].value;
      // Sugestão repetida 3+ vezes no mesmo texto: cheiro forte de
      // mensagem genérica do serviço, não correção específica.
      if (contagemPorSugestao.get(sugestao) >= 3) return false;
      // Substituição muito maior que o trecho original (ex.: uma palavra
      // de poucos caracteres virando uma frase entre parênteses): também
      // não tem cara de correção ortográfica normal.
      const tamanhoOriginal = Math.max(match.length, 1);
      if (sugestao.length > tamanhoOriginal * 3 + 10) return false;
      return true;
    })
    .sort((a, b) => b.offset - a.offset);

  let resultado = textoOriginal;
  for (const match of validos) {
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

  if (pareceCodigoFonte(textoOriginal)) {
    return { textoCorrigido: textoOriginal, aplicado: false, motivo: 'texto com cara de código-fonte; corretor de português pulado' };
  }

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
