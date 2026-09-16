// zipDocx.js
// Leitor/escritor mínimo de arquivos ZIP, só com o que um .docx precisa.
//
// Um .docx é um ZIP com XML dentro. Para gerar a prova no modelo da FANS
// a gente abre o template oficial (assets/Template-Avaliacao-FANS.docx),
// troca apenas o word/document.xml e fecha o ZIP de novo — assim estilos,
// fontes, numeração, rodapé, logo e configuração de página continuam
// exatamente os do template aprovado.
//
// Usa só zlib (nativo do Node), sem dependência nova no package.json —
// um pacote a mais seria mais uma coisa para o empacotador da Vercel
// deixar de fora.

const zlib = require('zlib');

const ASSINATURA_ARQUIVO_LOCAL = 0x04034b50;
const ASSINATURA_DIRETORIO_CENTRAL = 0x02014b50;
const ASSINATURA_FIM_DIRETORIO = 0x06054b50;

/**
 * Lê um ZIP inteiro para a memória.
 *
 * Percorre o diretório central (fim do arquivo) em vez dos cabeçalhos
 * locais: é lá que ficam os tamanhos definitivos, mesmo quando o ZIP foi
 * gravado em streaming (data descriptor).
 *
 * @param {Buffer} buffer conteúdo do .zip/.docx
 * @returns {Map<string, Buffer>} nome da entrada -> conteúdo já descomprimido
 */
function lerZip(buffer) {
  const posicaoFim = localizarFimDiretorio(buffer);
  if (posicaoFim < 0) throw new Error('Arquivo ZIP inválido: fim do diretório central não encontrado.');

  const totalEntradas = buffer.readUInt16LE(posicaoFim + 10);
  let posicao = buffer.readUInt32LE(posicaoFim + 16);

  const entradas = new Map();
  for (let i = 0; i < totalEntradas; i += 1) {
    if (buffer.readUInt32LE(posicao) !== ASSINATURA_DIRETORIO_CENTRAL) {
      throw new Error('Arquivo ZIP inválido: entrada do diretório central corrompida.');
    }

    const metodo = buffer.readUInt16LE(posicao + 10);
    const tamanhoComprimido = buffer.readUInt32LE(posicao + 20);
    const tamanhoNome = buffer.readUInt16LE(posicao + 28);
    const tamanhoExtra = buffer.readUInt16LE(posicao + 30);
    const tamanhoComentario = buffer.readUInt16LE(posicao + 32);
    const inicioCabecalhoLocal = buffer.readUInt32LE(posicao + 42);
    const nome = buffer.toString('utf8', posicao + 46, posicao + 46 + tamanhoNome);

    // O cabeçalho local tem seus próprios campos de nome/extra, que podem
    // ter tamanhos diferentes dos do diretório central.
    if (buffer.readUInt32LE(inicioCabecalhoLocal) !== ASSINATURA_ARQUIVO_LOCAL) {
      throw new Error(`Arquivo ZIP inválido: cabeçalho local de "${nome}" corrompido.`);
    }
    const nomeLocal = buffer.readUInt16LE(inicioCabecalhoLocal + 26);
    const extraLocal = buffer.readUInt16LE(inicioCabecalhoLocal + 28);
    const inicioDados = inicioCabecalhoLocal + 30 + nomeLocal + extraLocal;
    const bruto = buffer.subarray(inicioDados, inicioDados + tamanhoComprimido);

    if (!nome.endsWith('/')) {
      entradas.set(nome, metodo === 0 ? Buffer.from(bruto) : zlib.inflateRawSync(bruto));
    }

    posicao += 46 + tamanhoNome + tamanhoExtra + tamanhoComentario;
  }

  return entradas;
}

/**
 * Grava um ZIP novo a partir das entradas em memória.
 *
 * @param {Map<string, Buffer>|Array<[string, Buffer]>} entradas
 * @returns {Buffer}
 */
function escreverZip(entradas) {
  const lista = Array.from(entradas instanceof Map ? entradas.entries() : entradas);
  const pedacosArquivos = [];
  const pedacosDiretorio = [];
  let deslocamento = 0;

  lista.forEach(([nome, conteudoOriginal]) => {
    const conteudo = Buffer.isBuffer(conteudoOriginal)
      ? conteudoOriginal
      : Buffer.from(String(conteudoOriginal), 'utf8');
    const nomeBuffer = Buffer.from(nome, 'utf8');
    const comprimido = zlib.deflateRawSync(conteudo, { level: 9 });
    const crc = crc32(conteudo);

    const cabecalhoLocal = Buffer.alloc(30);
    cabecalhoLocal.writeUInt32LE(ASSINATURA_ARQUIVO_LOCAL, 0);
    cabecalhoLocal.writeUInt16LE(20, 4);   // versão mínima
    cabecalhoLocal.writeUInt16LE(0x0800, 6); // flag de nome em UTF-8
    cabecalhoLocal.writeUInt16LE(8, 8);    // método: deflate
    cabecalhoLocal.writeUInt16LE(0, 10);   // hora (fixa: ZIP reprodutível)
    cabecalhoLocal.writeUInt16LE(0x21, 12); // data (fixa: 01/01/1996)
    cabecalhoLocal.writeUInt32LE(crc, 14);
    cabecalhoLocal.writeUInt32LE(comprimido.length, 18);
    cabecalhoLocal.writeUInt32LE(conteudo.length, 22);
    cabecalhoLocal.writeUInt16LE(nomeBuffer.length, 26);
    cabecalhoLocal.writeUInt16LE(0, 28);

    pedacosArquivos.push(cabecalhoLocal, nomeBuffer, comprimido);

    const entradaDiretorio = Buffer.alloc(46);
    entradaDiretorio.writeUInt32LE(ASSINATURA_DIRETORIO_CENTRAL, 0);
    entradaDiretorio.writeUInt16LE(20, 4);
    entradaDiretorio.writeUInt16LE(20, 6);
    entradaDiretorio.writeUInt16LE(0x0800, 8);
    entradaDiretorio.writeUInt16LE(8, 10);
    entradaDiretorio.writeUInt16LE(0, 12);
    entradaDiretorio.writeUInt16LE(0x21, 14);
    entradaDiretorio.writeUInt32LE(crc, 16);
    entradaDiretorio.writeUInt32LE(comprimido.length, 20);
    entradaDiretorio.writeUInt32LE(conteudo.length, 24);
    entradaDiretorio.writeUInt16LE(nomeBuffer.length, 28);
    entradaDiretorio.writeUInt32LE(deslocamento, 42);

    pedacosDiretorio.push(entradaDiretorio, nomeBuffer);
    deslocamento += cabecalhoLocal.length + nomeBuffer.length + comprimido.length;
  });

  const diretorio = Buffer.concat(pedacosDiretorio);
  const fim = Buffer.alloc(22);
  fim.writeUInt32LE(ASSINATURA_FIM_DIRETORIO, 0);
  fim.writeUInt16LE(lista.length, 8);
  fim.writeUInt16LE(lista.length, 10);
  fim.writeUInt32LE(diretorio.length, 12);
  fim.writeUInt32LE(deslocamento, 16);

  return Buffer.concat([...pedacosArquivos, diretorio, fim]);
}

// O comentário final do ZIP tem tamanho variável, então o fim do
// diretório central é procurado de trás para frente.
function localizarFimDiretorio(buffer) {
  const minimo = Math.max(0, buffer.length - 66000);
  for (let i = buffer.length - 22; i >= minimo; i -= 1) {
    if (buffer.readUInt32LE(i) === ASSINATURA_FIM_DIRETORIO) return i;
  }
  return -1;
}

const TABELA_CRC = (() => {
  const tabela = new Int32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let valor = i;
    for (let bit = 0; bit < 8; bit += 1) {
      valor = valor & 1 ? (valor >>> 1) ^ 0xedb88320 : valor >>> 1;
    }
    tabela[i] = valor;
  }
  return tabela;
})();

function crc32(buffer) {
  let crc = -1;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = (crc >>> 8) ^ TABELA_CRC[(crc ^ buffer[i]) & 0xff];
  }
  return (crc ^ -1) >>> 0;
}

module.exports = { lerZip, escreverZip };
