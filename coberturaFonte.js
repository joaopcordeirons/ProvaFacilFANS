// coberturaFonte.js
// Lê a tabela "cmap" de uma fonte TrueType para descobrir quais
// caracteres Unicode ela sabe desenhar de verdade — sem depender de
// nenhuma biblioteca nova, só do módulo `fs` que já vem no Node.
//
// Serve para decidir, caractere por caractere, se um texto deve usar a
// fonte principal do PDF (Liberation Sans) ou a fonte reserva com
// cobertura maior (DejaVu Sans) — ver fontesPdf.js. Sem essa checagem,
// um símbolo fora do alcance da fonte principal sai em branco (ou, com
// as fontes padrão do pdfkit, vira lixo — foi o bug do bullet "●／%Ï").

const fs = require('fs');

function lerU16(buffer, offset) { return buffer.readUInt16BE(offset); }
function lerU32(buffer, offset) { return buffer.readUInt32BE(offset); }

// Formato 4 da cmap: o mais comum em fontes TrueType, cobre o plano
// multilíngue básico (até U+FFFF) — de sobra para o que aparece numa
// prova. Layout descrito na especificação OpenType, tabela "cmap".
function lerFormato4(buffer, inicio) {
  const segCountX2 = lerU16(buffer, inicio + 6);
  const segCount = segCountX2 / 2;
  const enderecoFimSegmentos = inicio + 14;
  const enderecoInicioSegmentos = enderecoFimSegmentos + segCountX2 + 2; // +2 pula o "reservedPad"
  const enderecoDeltas = enderecoInicioSegmentos + segCountX2;
  const enderecoOffsetsIntervalo = enderecoDeltas + segCountX2;

  const cobertura = new Set();
  for (let segmento = 0; segmento < segCount; segmento += 1) {
    const fim = lerU16(buffer, enderecoFimSegmentos + segmento * 2);
    const inicioIntervalo = lerU16(buffer, enderecoInicioSegmentos + segmento * 2);
    if (inicioIntervalo === 0xffff && fim === 0xffff) continue; // segmento de fechamento

    const offsetIntervalo = lerU16(buffer, enderecoOffsetsIntervalo + segmento * 2);
    for (let codigo = inicioIntervalo; codigo <= fim; codigo += 1) {
      let glifo;
      if (offsetIntervalo === 0) {
        const delta = buffer.readInt16BE(enderecoDeltas + segmento * 2);
        glifo = (codigo + delta) & 0xffff;
      } else {
        const enderecoGlifo = enderecoOffsetsIntervalo + segmento * 2
          + offsetIntervalo + (codigo - inicioIntervalo) * 2;
        if (enderecoGlifo + 2 > buffer.length) continue;
        glifo = lerU16(buffer, enderecoGlifo);
        if (glifo !== 0) {
          const delta = buffer.readInt16BE(enderecoDeltas + segmento * 2);
          glifo = (glifo + delta) & 0xffff;
        }
      }
      if (glifo !== 0) cobertura.add(codigo);
    }
  }
  return cobertura;
}

/**
 * Devolve o conjunto de pontos de código Unicode com glifo real numa
 * fonte TrueType/OpenType.
 *
 * Se a tabela não puder ser lida (formato incomum, arquivo corrompido),
 * devolve `null` — quem chama trata isso como "cobertura desconhecida"
 * e usa a fonte mesmo assim, em vez de travar a geração da prova.
 *
 * @param {string} caminho caminho do arquivo .ttf
 * @returns {Set<number>|null}
 */
function lerCoberturaTTF(caminho) {
  try {
    const buffer = fs.readFileSync(caminho);
    const numTabelas = lerU16(buffer, 4);

    let offsetCmap = null;
    for (let i = 0; i < numTabelas; i += 1) {
      const registro = 12 + i * 16;
      if (buffer.toString('ascii', registro, registro + 4) === 'cmap') {
        offsetCmap = lerU32(buffer, registro + 8);
        break;
      }
    }
    if (offsetCmap === null) return null;

    // Prioriza a subtabela Windows/Unicode BMP (plataforma 3, codificação
    // 1) — a mesma que leitores de PDF costumam usar para texto comum.
    const numSubtabelas = lerU16(buffer, offsetCmap + 2);
    let offsetSubtabelaEscolhida = null;
    for (let i = 0; i < numSubtabelas; i += 1) {
      const registro = offsetCmap + 4 + i * 8;
      if (lerU16(buffer, registro) === 3 && lerU16(buffer, registro + 2) === 1) {
        offsetSubtabelaEscolhida = offsetCmap + lerU32(buffer, registro + 4);
        break;
      }
    }
    if (offsetSubtabelaEscolhida === null) return null;

    const formato = lerU16(buffer, offsetSubtabelaEscolhida);
    if (formato !== 4) return null; // formatos raros não são necessários aqui

    return lerFormato4(buffer, offsetSubtabelaEscolhida);
  } catch (err) {
    return null;
  }
}

module.exports = { lerCoberturaTTF };
