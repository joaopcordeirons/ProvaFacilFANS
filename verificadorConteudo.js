// verificadorConteudo.js
// Verificação de COERÊNCIA de conteúdo (isso é diferente de ortografia/
// gramática, que já é feita pelo LanguageTool em corretorGramatical.js).
// Aqui a pergunta é "essa questão faz sentido? a alternativa combina com
// o enunciado? o OCR não bagunçou tudo?" — coisa que exige uma IA de
// verdade lendo o texto, não dá pra fazer com regras.
//
// Usa a API do Gemini (Google AI Studio) porque ela tem um nível
// gratuito real, sem cartão de crédito — só um limite de uso por
// minuto/dia. Por isso essa verificação é OPCIONAL e sob demanda (só
// roda quando o professor clica em "Verificar conteúdo"), nunca
// automática em todo upload — assim o limite gratuito não estoura com
// muitos professores usando ao mesmo tempo.
//
// Chave gratuita em: https://aistudio.google.com/apikey
// Configurar em GEMINI_API_KEY no .env.

// Modelo usado para a verificação. "gemini-flash-latest" é um alias que
// o próprio Google mantém sempre apontando para o modelo "flash" mais
// atual — evita que o código quebre de novo quando um modelo específico
// (ex.: gemini-2.0-flash) for desativado no futuro. Se quiser travar
// numa versão específica, defina GEMINI_MODEL no .env (ex.: gemini-3.7-flash).
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-flash-latest';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
// 12s por tentativa: com MAX_TENTATIVAS=3 + esperas entre elas, o pior
// caso fica em ~40s, com folga dentro do maxDuration=60s da função na
// Vercel (ver vercel.json).
const TIMEOUT_MS = 12000;

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

function extrairJson(textoResposta) {
  const limpo = textoResposta.replace(/```json|```/g, '').trim();
  return JSON.parse(limpo);
}

// Quantas vezes tenta de novo quando o Gemini responde 429 (limite de
// uso) ou 503 (servidor do Google sobrecarregado — comum em modelos
// recém-lançados como o gemini-3.8-flash, mesmo com pouco uso próprio).
// Ambos costumam se resolver em segundos, então vale uma nova tentativa
// automática antes de desistir e mostrar erro pro professor.
const MAX_TENTATIVAS = 3;
const ESPERA_BASE_MS = 1500;

function esperar(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Faz uma única chamada ao Gemini. Lança erro (com .status quando vier
// da API) em vez de retornar { disponivel: false } — quem decide se
// tenta de novo ou desiste é o chamador (verificarConteudo).
async function chamarGemini(apiKey, enunciado, alternativas) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const resposta = await fetch(GEMINI_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Chaves novas do Google AI Studio vêm no formato "AQ...." (Auth
        // key). Diferente das antigas "AIzaSy..." (Standard key), que
        // aceitavam bem o parâmetro "?key=" na URL, as novas são mais
        // consistentes indo pelo cabeçalho x-goog-api-key — há relatos
        // de erro 401 "ACCESS_TOKEN_TYPE_UNSUPPORTED" usando "?key=" com
        // esse novo formato.
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: montarPrompt(enunciado, alternativas || []) }] }],
        generationConfig: {
          temperature: 0,
          maxOutputTokens: 300,
          // Modelos Gemini 3 (ex.: gemini-3.8-flash, resolvido a partir
          // de "gemini-flash-latest") usam thinkingLevel em vez de
          // thinkingBudget, e não suportam desligar o thinking por
          // completo. "low" reduz bastante a demora sem cair tanto na
          // precisão quanto thinkingBudget:0/nível mínimo (que causou
          // falsos positivos, ex.: acusar um enunciado completo como
          // "cortado").
          thinkingConfig: { thinkingLevel: 'low' },
        },
      }),
      signal: controller.signal,
    });

    if (resposta.status === 429) {
      // O corpo do erro do Google costuma citar qual cota estourou:
      // "PerDay" (limite diário — só reseta amanhã, não adianta tentar
      // de novo agora) vs "PerMinute" (limite por minuto — se resolve
      // sozinho em segundos). Sem isso, não dá pra saber qual dos dois
      // aconteceu, e avisar "tente em alguns minutos" pra um limite
      // diário é enganoso.
      const corpoErro = await resposta.text();
      console.warn('[verificadorConteudo] 429 do Gemini:', corpoErro);
      const ehDiario = /perday|per_day|dia\b/i.test(corpoErro);
      const erro = new Error('Limite de uso atingido');
      erro.status = 429;
      erro.ehDiario = ehDiario;
      erro.semRetry = ehDiario; // limite diário: tentar de novo agora não ajuda
      throw erro;
    }
    if (resposta.status === 503) {
      const erro = new Error('Servidor do Gemini sobrecarregado');
      erro.status = 503;
      throw erro;
    }
    if (resposta.status === 401 || resposta.status === 403) {
      const corpoErro = await resposta.text();
      console.warn('[verificadorConteudo] Erro de autenticação na chave Gemini:', resposta.status, corpoErro);
      const erro = new Error('Chave de API do Gemini inválida ou não autorizada. Confira o GEMINI_API_KEY configurado no servidor.');
      erro.status = resposta.status;
      erro.semRetry = true;
      throw erro;
    }
    if (resposta.status === 404) {
      console.warn('[verificadorConteudo] Modelo não encontrado:', GEMINI_MODEL);
      const erro = new Error(`Modelo de IA "${GEMINI_MODEL}" não existe ou foi desativado pelo Google. Ajuste GEMINI_MODEL no servidor.`);
      erro.status = resposta.status;
      erro.semRetry = true;
      throw erro;
    }
    if (!resposta.ok) {
      throw new Error(`Gemini respondeu status ${resposta.status}`);
    }

    const dados = await resposta.json();
    const candidato = dados?.candidates?.[0];
    const textoResposta = candidato?.content?.parts?.[0]?.text;
    if (!textoResposta) {
      // Motivo comum: o Gemini bloqueou a resposta por segurança
      // (finishReason "SAFETY") e não devolveu nenhum texto.
      const motivoBloqueio = candidato?.finishReason || 'sem candidato na resposta';
      throw new Error(`Resposta da IA veio vazia (finishReason: ${motivoBloqueio}). Corpo bruto: ${JSON.stringify(dados).slice(0, 300)}`);
    }

    let resultado;
    try {
      resultado = extrairJson(textoResposta);
    } catch (erroParse) {
      throw new Error(`Não consegui interpretar o JSON devolvido pela IA. Texto recebido: ${textoResposta.slice(0, 300)}`);
    }

    return {
      disponivel: true,
      coerente: Boolean(resultado.coerente),
      observacao: resultado.observacao || '',
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

// Verifica a coerência de uma questão via Gemini. Nunca lança erro pra
// quem chamou: qualquer falha (sem chave configurada, rede fora do ar,
// limite de uso estourado, resposta em formato inesperado) devolve
// { disponivel: false, motivo } em vez de quebrar o fluxo do professor.
// Faz retry automático em 429/503, com espera crescente entre tentativas.
async function verificarConteudo({ enunciado, alternativas }) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return { disponivel: false, motivo: 'GEMINI_API_KEY não configurada no servidor.' };
  }
  if (!enunciado || !enunciado.trim()) {
    return { disponivel: false, motivo: 'Nada para verificar.' };
  }

  let ultimoErro;
  for (let tentativa = 1; tentativa <= MAX_TENTATIVAS; tentativa++) {
    try {
      return await chamarGemini(apiKey, enunciado, alternativas);
    } catch (err) {
      ultimoErro = err;
      if (err.semRetry || tentativa === MAX_TENTATIVAS) break;
      if (err.status === 429 || err.status === 503) {
        console.warn(`[verificadorConteudo] Tentativa ${tentativa} falhou (${err.status}), tentando de novo...`);
        await esperar(ESPERA_BASE_MS * tentativa);
        continue;
      }
      break; // erro que não vale a pena repetir (parse, timeout, etc.)
    }
  }

  if (ultimoErro.status === 429) {
    return {
      disponivel: false,
      motivo: ultimoErro.ehDiario
        ? 'Limite gratuito DIÁRIO de uso da IA atingido. Só volta a funcionar amanhã (reset é no fuso do Google, ~21h de Brasília) — o resto do sistema continua normal, só esse botão fica indisponível até lá.'
        : 'Limite gratuito de uso da IA atingido no momento (por minuto). Tente de novo em instantes.',
    };
  }
  if (ultimoErro.status === 503) {
    return { disponivel: false, motivo: 'Servidor do Gemini está sobrecarregado no momento. Tente de novo em instantes.' };
  }
  if (ultimoErro.status === 401 || ultimoErro.status === 403 || ultimoErro.status === 404) {
    return { disponivel: false, motivo: ultimoErro.message };
  }

  console.warn('[verificadorConteudo] Não foi possível verificar com Gemini:', ultimoErro.message);
  // TEMPORÁRIO para diagnóstico: manda o motivo detalhado pro front-end,
  // em vez de só no log do servidor. Reverter para a mensagem genérica
  // assim que o problema for identificado e corrigido.
  return { disponivel: false, motivo: `[debug] ${ultimoErro.message}` };
}

module.exports = { verificarConteudo };
