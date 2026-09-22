// classificadorTipoIA.js
// Classificação ASSISTIDA por IA do TIPO de uma questão (múltipla escolha
// x dissertativa) — complementa a classificação automática por regra, que
// só olha se existem linhas "A) ..." no texto (ver extratorQuestoes.js e
// o cálculo de "questao.alternativas" feito lá). Essa classificação por
// regra erra sobretudo quando o marcador das alternativas veio fora do
// padrão (OCR malfeito, "1)", "-", "a." em vez de "A)") — daí o professor
// poder pedir uma segunda opinião pra IA em vez de só trocar o tipo na
// mão (ver botão "Verificar tipo com IA" e o <select> de tipo em
// public/app.js, dentro de identificarErenderizarQuestoes).
//
// Sob demanda, igual ao corretorIA.js: só roda quando o professor clica,
// nunca automático em lote nem no upload. Nada é salvo sozinho — o
// professor sempre revisa o resultado antes de "Salvar questão".

const { chamarGeminiJson, mensagemDeErro } = require('./geminiClient');

function montarPrompt(enunciado, alternativas) {
  const blocoAlternativas = alternativas && alternativas.length
    ? `\nTrechos que hoje estão marcados como alternativas:\n${alternativas.join('\n')}`
    : '\n(Nenhum trecho está marcado como alternativa no momento.)';

  return `Você está revisando a CLASSIFICAÇÃO de uma questão de prova escolar: ela é de MÚLTIPLA ESCOLHA (o aluno escolhe entre opções de resposta, tipo A/B/C/D) ou DISSERTATIVA (resposta livre, escrita pelo aluno)? A classificação automática de um sistema de regras pode ter errado — normalmente porque as opções de resposta vieram com marcador fora do padrão (ex.: "1)", "-", "a." em vez de "A)"), ou porque um texto sem nenhuma opção de resposta foi confundido com uma.

Enunciado atual:
${enunciado}${blocoAlternativas}

Decida o tipo certo e devolva o enunciado e as alternativas (se houver) reorganizados:
- Se for múltipla escolha: devolva cada alternativa como uma linha própria no formato "A) texto", "B) texto" etc., preservando o texto de cada opção EXATAMENTE como está (só ajuste o marcador, nunca o conteúdo).
- Se for dissertativa: devolva "alternativas" como array vazio; se algum trecho hoje marcado como alternativa na verdade faz parte do enunciado (não é uma opção de resposta), devolva-o de volta dentro do enunciado, sem alterar seu conteúdo.
- NUNCA invente opções ou conteúdo que não estão no texto, e NUNCA apague texto real — só reclassifique e reorganize marcadores.

Responda ESTRITAMENTE em JSON, sem markdown, sem texto antes ou depois, no formato:
{"tipo": "multipla_escolha" ou "dissertativa", "enunciado": "texto do enunciado", "alternativas": ["A) ...", "B) ..."] (array vazio se dissertativa), "observacao": "por que essa classificação e o que foi ajustado, em português, no máximo 2 frases, ou string vazia se nada precisou mudar"}`;
}

// Classifica o tipo da questão via Gemini. Nunca lança erro pra quem
// chamou: qualquer falha devolve { disponivel: false, motivo }, deixando
// o texto e o tipo escolhidos pelo professor intactos no front-end.
async function detectarTipoComIA({ enunciado, alternativas }) {
  if (!enunciado || !enunciado.trim()) {
    return { disponivel: false, motivo: 'Nada para classificar.' };
  }

  try {
    const resultado = await chamarGeminiJson({
      apiKey: process.env.GEMINI_API_KEY,
      prompt: montarPrompt(enunciado, alternativas || []),
      maxOutputTokens: 500,
      nomeChamador: 'classificadorTipoIA',
    });
    if (typeof resultado.enunciado !== 'string' || !resultado.enunciado.trim()) {
      throw new Error('Resposta da IA não trouxe um enunciado válido.');
    }
    const tipo = resultado.tipo === 'multipla_escolha' ? 'multipla_escolha' : 'dissertativa';
    // Só confia em "alternativas" quando o tipo devolvido for múltipla
    // escolha — se a IA disse "dissertativa", ignora qualquer alternativa
    // que ela tenha deixado no array por engano.
    const alternativasCorrigidas = tipo === 'multipla_escolha' && Array.isArray(resultado.alternativas)
      ? resultado.alternativas
      : [];

    return {
      disponivel: true,
      tipo,
      enunciado: resultado.enunciado,
      alternativas: alternativasCorrigidas,
      observacao: resultado.observacao || '',
    };
  } catch (err) {
    return { disponivel: false, motivo: mensagemDeErro(err) };
  }
}

module.exports = { detectarTipoComIA };
