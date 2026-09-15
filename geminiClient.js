// geminiClient.js
// Cliente compartilhado pra chamar a API do Gemini: retry automático em
// 429 (distinguindo limite diário de por minuto)/503, seleção do
// parâmetro de "thinking" certo pra cada família de modelo, e timeouts
// com folga dentro do maxDuration da função na Vercel. Usado por
// verificadorConteudo.js (checagem de coerência) e corretorIA.js
// (correção de formatação assistida por IA) — mesma lógica de robustez
// nos dois, sem duplicar código.

// Modelo usado nas chamadas. IMPORTANTE: NÃO usamos o alias
// "gemini-flash-latest" — ele aponta pro modelo Flash mais recente do
// Google, e modelos recém-lançados (ex.: gemini-3.8-flash) vêm com cota
// GRATUITA diária muito mais restrita (~20 requisições/dia, contra
// centenas/dia dos modelos "-lite" já estabelecidos). Também não dá pra
// usar gemini-2.5-flash-lite: foi desativado pelo Google pra novos
// usuários (erro 404 "no longer available to new users"), que recomenda
// gemini-3.5-flash-lite como substituto — variante "lite" de uma geração
// já estabelecida, bom equilíbrio entre qualidade e cota gratuita pras
// tarefas simples que fazemos aqui. Se quiser usar outro, defina
// GEMINI_MODEL no .env.
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

// 12s por tentativa: com MAX_TENTATIVAS=3 + esperas entre elas, o pior
// caso fica em ~40s, com folga dentro do maxDuration=60s da função na
// Vercel (ver vercel.json).
const TIMEOUT_MS = 12000;

// Quantas vezes tenta de novo quando o Gemini responde 429 (limite de
// uso) ou 503 (servidor do Google sobrecarregado — comum em modelos
// recém-lançados, mesmo com pouco uso próprio). Ambos costumam se
// resolver em segundos, então vale tentar de novo antes de desistir.
const MAX_TENTATIVAS = 3;
const ESPERA_BASE_MS = 1500;

function esperar(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Gemini 3.x usa thinkingLevel e não aceita thinkingBudget; Gemini 2.x
// usa thinkingBudget e rejeita thinkingLevel com erro. Usar o parâmetro
// errado pra família quebra a chamada, então detectamos pelo nome.
function montarThinkingConfig(modelo) {
  const ehGemini3 = /^gemini-3/.test(modelo);
  return ehGemini3
    ? { thinkingLevel: 'low' }
    : { thinkingBudget: 0 };
}

function extrairJson(textoResposta) {
  const limpo = textoResposta.replace(/```json|```/g, '').trim();
  return JSON.parse(limpo);
}

// Faz uma única chamada ao Gemini e devolve o texto bruto da resposta.
// Lança erro (com .status quando vier da API) em vez de decidir sozinho
// se tenta de novo — isso é responsabilidade de chamarGeminiJson.
async function chamarGeminiUmaVez(apiKey, prompt, maxOutputTokens, nomeChamador) {
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
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0,
          maxOutputTokens,
          thinkingConfig: montarThinkingConfig(GEMINI_MODEL),
        },
      }),
      signal: controller.signal,
    });

    if (resposta.status === 429) {
      // O corpo do erro do Google costuma citar qual cota estourou:
      // "PerDay" (limite diário — só reseta amanhã) vs "PerMinute"
      // (limite por minuto — se resolve sozinho em segundos).
      const corpoErro = await resposta.text();
      console.warn(`[${nomeChamador}] 429 do Gemini:`, corpoErro);
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
      console.warn(`[${nomeChamador}] Erro de autenticação na chave Gemini:`, resposta.status, corpoErro);
      const erro = new Error('Chave de API do Gemini inválida ou não autorizada. Confira o GEMINI_API_KEY configurado no servidor.');
      erro.status = resposta.status;
      erro.semRetry = true;
      throw erro;
    }
    if (resposta.status === 404) {
      console.warn(`[${nomeChamador}] Modelo não encontrado:`, GEMINI_MODEL);
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
    return textoResposta;
  } finally {
    clearTimeout(timeoutId);
  }
}

// Chama o Gemini com retry automático em 429 (por minuto)/503, e devolve
// o JSON já parseado da resposta (o prompt deve pedir JSON estrito).
// Lança erro estruturado (.status, .ehDiario, .semChave) se todas as
// tentativas falharem — use mensagemDeErro() pra converter isso numa
// mensagem pronta pro professor.
async function chamarGeminiJson({ apiKey, prompt, maxOutputTokens = 300, nomeChamador = 'geminiClient' }) {
  if (!apiKey) {
    const erro = new Error('GEMINI_API_KEY não configurada no servidor.');
    erro.semChave = true;
    throw erro;
  }

  let ultimoErro;
  for (let tentativa = 1; tentativa <= MAX_TENTATIVAS; tentativa++) {
    try {
      const textoResposta = await chamarGeminiUmaVez(apiKey, prompt, maxOutputTokens, nomeChamador);
      try {
        return extrairJson(textoResposta);
      } catch (erroParse) {
        throw new Error(`Não consegui interpretar o JSON devolvido pela IA. Texto recebido: ${textoResposta.slice(0, 300)}`);
      }
    } catch (err) {
      ultimoErro = err;
      if (err.semRetry || tentativa === MAX_TENTATIVAS) break;
      if (err.status === 429 || err.status === 503) {
        console.warn(`[${nomeChamador}] Tentativa ${tentativa} falhou (${err.status}), tentando de novo...`);
        await esperar(ESPERA_BASE_MS * tentativa);
        continue;
      }
      break; // erro que não vale a pena repetir (parse, timeout, etc.)
    }
  }
  throw ultimoErro;
}

// Converte um erro lançado por chamarGeminiJson numa mensagem em
// português, pronta pra mostrar pro professor.
function mensagemDeErro(erro) {
  if (erro.semChave) return erro.message;
  if (erro.status === 429) {
    return erro.ehDiario
      ? 'Limite gratuito DIÁRIO de uso da IA atingido. Reseta à meia-noite no horário do Pacífico (EUA) — por volta de 4h-5h da manhã no horário de Brasília. O resto do sistema continua normal, só esse botão fica indisponível até lá.'
      : 'Limite gratuito de uso da IA atingido no momento (por minuto). Tente de novo em instantes.';
  }
  if (erro.status === 503) return 'Servidor do Gemini está sobrecarregado no momento. Tente de novo em instantes.';
  if (erro.status === 401 || erro.status === 403 || erro.status === 404) return erro.message;

  console.warn('[geminiClient] Erro não classificado:', erro.message);
  // TEMPORÁRIO para diagnóstico: manda o motivo detalhado pro front-end,
  // em vez de só no log do servidor. Reverter para uma mensagem genérica
  // assim que o fluxo estiver validado em produção.
  return `[debug] ${erro.message}`;
}

module.exports = { chamarGeminiJson, mensagemDeErro, GEMINI_MODEL };
