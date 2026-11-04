// Leitor de ZIP/CBZ mínimo.
// Lê só o índice que fica no fim do arquivo e extrai cada página sob demanda com File.slice,
// então nem um CBZ de 500 MB precisa caber inteiro na memória do celular.

const MIME = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', jpe: 'image/jpeg', jfif: 'image/jpeg',
  png: 'image/png', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif',
  bmp: 'image/bmp', jxl: 'image/jxl',
};

const ext = name => (name.split('.').pop() || '').toLowerCase();
export const mimeFor = name => MIME[ext(name)] || 'application/octet-stream';

export function isPageName(name) {
  if (!MIME[ext(name)]) return false;
  // ignora lixo do macOS e arquivos ocultos
  return !name.split('/').some(part => part.startsWith('.') || part === '__MACOSX');
}

const utf8 = new TextDecoder('utf-8', { fatal: true });
const latin = new TextDecoder('windows-1252');
function decodeName(bytes) {
  try { return utf8.decode(bytes); } catch { return latin.decode(bytes); }
}

async function bytesAt(file, start, end) {
  return new DataView(await file.slice(start, end).arrayBuffer());
}

export async function openZip(file) {
  const size = file.size;
  if (size < 22) throw new Error('o arquivo está vazio ou incompleto');

  // 1. acha o "fim do diretório central" (EOCD) nos últimos 64 KB
  const tailLen = Math.min(size, 65557);
  const tailStart = size - tailLen;
  const tail = await bytesAt(file, tailStart, size);
  let eocd = -1;
  for (let i = tailLen - 22; i >= 0; i--) {
    if (tail.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('não parece ser um CBZ/ZIP (talvez esteja corrompido ou seja um CBR)');

  let count = tail.getUint16(eocd + 10, true);
  let cdSize = tail.getUint32(eocd + 12, true);
  let cdOffset = tail.getUint32(eocd + 16, true);

  // ZIP64 (arquivos com mais de 4 GB ou mais de 65 mil entradas)
  let zip64 = false;
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    const loc = eocd - 20;
    if (loc >= 0 && tail.getUint32(loc, true) === 0x07064b50) {
      const z64 = Number(tail.getBigUint64(loc + 8, true));
      const z = await bytesAt(file, z64, z64 + 56);
      if (z.getUint32(0, true) === 0x06064b50) {
        zip64 = true;
        count = Number(z.getBigUint64(32, true));
        cdSize = Number(z.getBigUint64(40, true));
        cdOffset = Number(z.getBigUint64(48, true));
      }
    }
  }

  // Alguns ZIPs têm bytes extras no começo; corrige o deslocamento se for o caso.
  let shift = 0;
  if (!zip64) {
    const realCdStart = tailStart + eocd - cdSize;
    if (realCdStart > cdOffset) { shift = realCdStart - cdOffset; cdOffset = realCdStart; }
  }

  // 2. lê o diretório central inteiro (lista de arquivos)
  const cd = await bytesAt(file, cdOffset, cdOffset + cdSize);
  const entries = [];
  let p = 0;
  while (p + 46 <= cd.byteLength && cd.getUint32(p, true) === 0x02014b50) {
    const flags = cd.getUint16(p + 8, true);
    const method = cd.getUint16(p + 10, true);
    let comp = cd.getUint32(p + 20, true);
    let uncomp = cd.getUint32(p + 24, true);
    const nLen = cd.getUint16(p + 28, true);
    const xLen = cd.getUint16(p + 30, true);
    const cLen = cd.getUint16(p + 32, true);
    let off = cd.getUint32(p + 42, true);
    const name = decodeName(new Uint8Array(cd.buffer, cd.byteOffset + p + 46, nLen)).replace(/\\/g, '/');

    let x = p + 46 + nLen;
    const xEnd = x + xLen;
    while (x + 4 <= xEnd) {
      const id = cd.getUint16(x, true);
      const len = cd.getUint16(x + 2, true);
      if (id === 0x0001) {
        let q = x + 4;
        if (uncomp === 0xffffffff) { uncomp = Number(cd.getBigUint64(q, true)); q += 8; }
        if (comp === 0xffffffff) { comp = Number(cd.getBigUint64(q, true)); q += 8; }
        if (off === 0xffffffff) { off = Number(cd.getBigUint64(q, true)); q += 8; }
      }
      x += 4 + len;
    }

    entries.push({
      name, method, comp, uncomp, off: off + shift,
      encrypted: (flags & 1) === 1,
      dir: name.endsWith('/'),
    });
    p += 46 + nLen + xLen + cLen;
  }
  if (!entries.length) throw new Error('o arquivo não tem nada dentro');

  // 3. extrai uma entrada (retorna Blob já com o tipo certo)
  async function read(entry) {
    if (entry.encrypted) throw new Error('o arquivo está protegido por senha');
    const h = await bytesAt(file, entry.off, entry.off + 30);
    if (h.getUint32(0, true) !== 0x04034b50) throw new Error('página corrompida dentro do arquivo');
    const start = entry.off + 30 + h.getUint16(26, true) + h.getUint16(28, true);
    const raw = file.slice(start, start + entry.comp);
    const type = mimeFor(entry.name);
    if (entry.method === 0) {
      return new Blob([await raw.arrayBuffer()], { type });
    }
    if (entry.method === 8) {
      if (typeof DecompressionStream === 'undefined') {
        throw new Error('este navegador é antigo demais para abrir CBZ compactado — atualize o sistema');
      }
      const stream = raw.stream().pipeThrough(new DecompressionStream('deflate-raw'));
      const buf = await new Response(stream).arrayBuffer();
      return new Blob([buf], { type });
    }
    throw new Error(`o arquivo usa uma compressão que não dá pra abrir aqui (tipo ${entry.method})`);
  }

  return { entries, read };
}
