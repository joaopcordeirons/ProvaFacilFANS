// verificadorConteudo.js
// Verificação de COERÊNCIA de conteúdo (isso é diferente de ortografia/
// gramática, que já é feita pelo LanguageTool em corretorGramatical.js,
// e diferente de reescrever o texto, que é o corretorIA.js). Aqui a
// pergunta é "essa questão faz sentido? a alternativa combina com o
// enunciado? o OCR não bagunçou tudo?" — só aponta problemas, nunca
// reescreve nada.
//
// Usa a API do Gemini via geminiClient.js (retry, timeouts, seleção de
// modelo). É opcional e sob demanda (só roda quando o professor clica em
// "Verificar conteúdo"), nunca automática em todo upload — assim o
// limite gratuito não estoura com muitos professores usando ao mesmo
// tempo.
//
// Chave gratuita em: https://aistudio.google.com/apikey
// Configurar em GEMINI_API_KEY no .env.

const { chamarGeminiJson, mensagemDeErro } = require('./geminiClient');

function montarPrompt(enunciado, alternativas) {
  const blocoAlternativas = alternativas && alternativas.length
    ? `\nAlternativas:\n${alternativas.join('\n')}`
    : '\n(Questão dissertativa, sem alternativas.)';

  return `Você está revisando uma questão de prova escolar que foi extraída por OCR ou digitada por um professor. Avalie APENAS se o conteúdo faz sentido — não repita a questão, não corrija ortografia.

Verifique:
1) O enunciado é compreensível e faz sentido (não é uma salada de palavras causada por erro de leitura)?
2) Se houver alternativas, elas realmente respondem ao que o enunciado pergunta, e não são todas iguais ou vazias?
3) Existe algum problema óbvio de conteúdo (ex.: pergunta incompleta, falta uma alternativa correta evidente, contradição)?

Questão:
${enunciado}${blocoAlternativas}

Responda ESTRITAMENTE em JSON, sem markdown, sem texto antes ou depois, no formato:
{"coerente": true ou false, "observacao": "explicação breve em português, no máximo 2 frases, ou string vazia se estiver tudo certo"}`;
}

// Verifica a coerência de uma questão via Gemini. Nunca lança erro pra
// quem chamou: qualquer falha devolve { disponivel: false, motivo } em
// vez de quebrar o fluxo do professor.
async function verificarConteudo({ enunciado, alternativas }) {
  if (!enunciado || !enunciado.trim()) {
    return { disponivel: false, motivo: 'Nada para verificar.' };
  }

  try {
    const resultado = await chamarGeminiJson({
      apiKey: process.env.GEMINI_API_KEY,
      prompt: montarPrompt(enunciado, alternativas || []),
      maxOutputTokens: 300,
      nomeChamador: 'verificadorConteudo',
    });
    return {
      disponivel: true,
      coerente: Boolean(resultado.coerente),
      observacao: resultado.observacao || '',
    };
  } catch (err) {
    return { disponivel: false, motivo: mensagemDeErro(err) };
  }
}

module.exports = { verificarConteudo };
