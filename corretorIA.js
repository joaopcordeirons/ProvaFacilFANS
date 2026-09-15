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

  return `Você está corrigindo a FORMATAÇÃO de uma questão de prova escolar extraída por OCR ou digitada às pressas por um professor. Sua tarefa é limpar problemas óBVIOS de OCR/digitação — NÃO reescrever o conteúdo, NÃO completar informação que não está lá, NÃO mudar o sentido da pergunta, e acima de tudo NÃO APAGAR conteúdo real.

Corrija apenas:
- Palavras coladas, cortadas ou com caracteres estranhos vindos de erro de leitura (ex.: "compi lador" -> "compilador").
- Dígitos ou símbolos soltos GRUDADOS num marcador de alternativa, que claramente não fazem parte nem do marcador nem do texto da resposta (ex.: "a)54 Verdadeiro" -> marcador "a)" + texto "Verdadeiro"; o "54" é ruído solto ENTRE o marcador e a resposta, não faz parte de nenhum dos dois).
- Espaçamento e pontuação quebrados pela extração.
- Se o enunciado e as alternativas vieram tudo colado numa linha só (sem quebra de linha entre eles), separe cada alternativa numa linha, preservando o texto de cada uma.

REGRA MAIS IMPORTANTE, sempre que tiver dúvida: NUNCA apague um trecho inteiro (uma alternativa, uma frase, uma palavra de resposta como "Verdadeiro"/"Falso") só porque ele está com formatação estranha ou fora do padrão esperado. "Ruído" é APENAS caractere solto sem nenhum significado (número perdido, símbolo repetido, letra solta) — nunca uma palavra ou frase que poderia ser parte da resposta. Na dúvida entre apagar ou manter, MANTENHA e explique a dúvida em "observacao".

NÃO faça:
- Não invente conteúdo que não está no texto original.
- Não apague nenhuma alternativa de resposta, mesmo que pareça redundante, óbvia, ou fora do formato esperado.
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
    const alternativasCorrigidas = Array.isArray(resultado.alternativas) ? resultado.alternativas : [];

    // Segunda camada de proteção, além do prompt: se o texto corrigido
    // veio bem mais curto que o original, é sinal de que algo real pode
    // ter sido apagado (ex.: uma alternativa inteira), não só ruído.
    // Nesse caso, avisa isso com destaque em vez de confiar cegamente no
    // texto que voltou — o professor decide o que fazer.
    const tamanhoOriginal = (enunciado + (alternativas || []).join('')).length;
    const tamanhoCorrigido = (resultado.enunciado + alternativasCorrigidas.join('')).length;
    const encolheuMuito = tamanhoOriginal > 20 && tamanhoCorrigido < tamanhoOriginal * 0.6;

    return {
      disponivel: true,
      enunciado: resultado.enunciado,
      alternativas: alternativasCorrigidas,
      observacao: encolheuMuito
        ? `⚠ O texto ficou bem mais curto que o original — confira com atenção se nada de conteúdo real (uma alternativa, uma resposta) foi apagado por engano. ${resultado.observacao || ''}`.trim()
        : (resultado.observacao || ''),
    };
  } catch (err) {
    return { disponivel: false, motivo: mensagemDeErro(err) };
  }
}

module.exports = { corrigirComIA };
