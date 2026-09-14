// formatadorQuestoes.js
// Formatação visual das questões (capitalização, pontuação, espaçamento,
// alternativas padronizadas) sem nenhuma chamada externa. A correção
// ortográfica/gramatical de verdade (o que exige "entender" a língua)
// fica por conta do LanguageTool, em corretorGramatical.js — aqui só
// arruma a aparência de cima do texto já corrigido. remove espaço antes de vírgula/
// ponto/interrogação, garante um espaço depois, colapsa espaços/linhas
// duplicadas.
function ajustarEspacamentoEPontuacao(texto) {
  return texto
    .replace(/[ \t]+/g, ' ')
    .replace(/ +([,.;:!?])/g, '$1')
    .replace(/([,.;:!?])(?=[^\s"'”’)\]])/g, '$1 ')
    .replace(/([!?]){2,}/g, '$1')
    .replace(/,{2,}/g, ',')
    .split('\n').map((l) => l.trim()).join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function capitalizarPrimeiraLetra(texto) {
  const indice = texto.search(/[A-Za-zÀ-ÿ]/);
  if (indice === -1) return texto;
  return texto.slice(0, indice) + texto[indice].toUpperCase() + texto.slice(indice + 1);
}

// Capitaliza a primeira letra do enunciado e a primeira letra de cada
// frase depois de ". ", "! " ou "? ".
function capitalizarFrases(texto) {
  const comPrimeiraMaiuscula = capitalizarPrimeiraLetra(texto);
  return comPrimeiraMaiuscula.replace(/([.!?]\s+)([a-zà-ÿ])/g, (m, sep, letra) => sep + letra.toUpperCase());
}

function garantirPontuacaoFinal(texto) {
  if (!texto) return texto;
  const ultimoChar = texto.slice(-1);
  if ('.!?…:;'.includes(ultimoChar)) return texto;
  return `${texto}.`;
}

// Formata o enunciado: ajeita espaçamento, capitaliza frases e garante
// pontuação final. A correção ortográfica/gramatical já foi feita antes
// disso, pelo LanguageTool (ver corretorGramatical.js).
function formatarEnunciado(enunciado) {
  let texto = ajustarEspacamentoEPontuacao(enunciado);
  texto = capitalizarFrases(texto);
  texto = garantirPontuacaoFinal(texto);
  return texto;
}

// Formata uma alternativa já separada da letra (ex.: recebe "B) 56" e
// devolve "B) 56", ou recebe texto sem a letra e uma letra à parte).
function formatarAlternativa(alternativaTexto) {
  const match = alternativaTexto.match(/^([a-eA-E])\)\s*(.*)$/s);
  if (!match) {
    // Já veio sem o padrão esperado — só ajeita espaçamento.
    const texto = ajustarEspacamentoEPontuacao(alternativaTexto);
    return capitalizarPrimeiraLetra(texto);
  }
  const letra = match[1].toUpperCase();
  let conteudo = ajustarEspacamentoEPontuacao(match[2]);
  conteudo = capitalizarPrimeiraLetra(conteudo);
  return `${letra}) ${conteudo}`;
}

// Função principal: recebe { enunciado, alternativas } (formato usado
// pelo motor de identificação de questões) e devolve a mesma estrutura,
// já corrigida e formatada.
function formatarQuestao(questao) {
  return {
    ...questao,
    enunciado: formatarEnunciado(questao.enunciado || ''),
    alternativas: (questao.alternativas || []).map(formatarAlternativa),
  };
}

module.exports = { formatarQuestao, formatarEnunciado, formatarAlternativa };
