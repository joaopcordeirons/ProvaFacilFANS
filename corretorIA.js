// corretorIA.js
// Correção ASSISTIDA por IA de uma questão — diferente do
// corretorGramatical.js (só ortografia, via LanguageTool) e do
// verificadorConteudo.js (só aponta problemas, nunca reescreve). Aqui a
// IA efetivamente reescreve o enunciado/alternativas, limpando bagunça
// de OCR e formatação — mas com instruções explícitas pra NÃO inventar
// conteúdo nem mudar o sentido da questão.
//
// É 100% sob demanda: só roda quando o professor clica em "Corrigir com
// IA" numa questão específica — nunca automático em lote ou no upload —
// pra não pressionar a cota gratuita da API (ver geminiClient.js e o
// histórico de limites em verificadorConteudo.js). Nada é salvo
// automaticamente: o professor sempre revisa o resultado no textarea
// antes de decidir "Salvar questão".

const { chamarGeminiJson, mensagemDeErro } = require('./geminiClient');

function montarPrompt(enunciado, alternativas) {
  const blocoAlternativas = alternativas && alternativas.length
    ? `\nAlternativas:\n${alternativas.join('\n')}`
    : '\n(Questão dissertativa, sem alternativas — devolva "alternativas" como array vazio.)';

  return `Você está corrigindo a FORMATAÇÃO de uma questão de prova escolar extraída por OCR ou digitada às pressas por um professor. Sua tarefa é limpar problemas óBVIOS de OCR/digitação — NÃO reescrever o conteúdo, NÃO completar informação que não está lá, NÃO mudar o sentido da pergunta.

Corrija apenas:
- Palavras coladas, cortadas ou com caracteres estranhos vindos de erro de leitura (ex.: "compi lador" -> "compilador").
- Marcadores de alternativa com ruído colado que claramente não é parte da resposta (ex.: "a)54 Verdadeiro" -> "Verdadeiro", descartando o "54" solto).
- Espaçamento e pontuação quebrados pela extração.

NÃO faça:
- Não invente conteúdo que não está no texto original.
- Se uma frase parece incompleta e não há como saber o que faltava, mantenha como está e explique isso em "observacao" — não tente adivinhar o final.
- Não corrija estilo ou ortografia "normal" (isso já é feito por outra ferramenta) — só o que for claramente ruído de extração.

Questão original:
${enunciado}${blocoAlternativas}

Responda ESTRITAMENTE em JSON, sem markdown, sem texto antes ou depois, no formato:
{"enunciado": "texto corrigido do enunciado", "alternativas": ["A) ...", "B) ..."] (array vazio se não houver alternativas), "observacao": "o que foi alterado, em português, no máximo 2 frases, ou string vazia se nada precisou de correção"}`;
}

// Corrige a formatação de uma questão via Gemini. Nunca lança erro pra
// quem chamou: qualquer falha devolve { disponivel: false, motivo },
// deixando o texto original intacto no front-end.
async function corrigirComIA({ enunciado, alternativas }) {
  if (!enunciado || !enunciado.trim()) {
    return { disponivel: false, motivo: 'Nada para corrigir.' };
  }

  try {
    const resultado = await chamarGeminiJson({
      apiKey: process.env.GEMINI_API_KEY,
      prompt: montarPrompt(enunciado, alternativas || []),
      maxOutputTokens: 500,
      nomeChamador: 'corretorIA',
    });
    if (typeof resultado.enunciado !== 'string' || !resultado.enunciado.trim()) {
      throw new Error('Resposta da IA não trouxe um enunciado corrigido válido.');
    }
    return {
      disponivel: true,
      enunciado: resultado.enunciado,
      alternativas: Array.isArray(resultado.alternativas) ? resultado.alternativas : [],
      observacao: resultado.observacao || '',
    };
  } catch (err) {
    return { disponivel: false, motivo: mensagemDeErro(err) };
  }
}

module.exports = { corrigirComIA };
