// Abre o arquivo do gibi olhando o conteúdo (não a extensão): muito .cbr na verdade é ZIP e vice-versa.
// Devolve sempre a mesma "cara": lista de páginas em ordem + um gerador que entrega cada página.
import { openZip, isPageName, mimeFor } from './zip.js';

const isInfo = name => /(^|\/)comicinfo\.xml$/i.test(name);

function sniff(b) {
  const at = (i, ...v) => v.every((x, k) => b[i + k] === x);
  if (at(0, 0x50, 0x4b, 0x03, 0x04) || at(0, 0x50, 0x4b, 0x05, 0x06) || at(0, 0x50, 0x4b, 0x07, 0x08)) return 'zip';
  if (at(0, 0x52, 0x61, 0x72, 0x21, 0x1a, 0x07)) return 'rar'; // "Rar!" (RAR4 e RAR5)
  if (at(0, 0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c)) return '7z';
  if (at(0, 0x25, 0x50, 0x44, 0x46)) return 'pdf';
  return 'unknown';
}

export async function openComicArchive(file, compare) {
  const head = new Uint8Array(await file.slice(0, 8).arrayBuffer());
  const kind = sniff(head);
  if (kind === 'rar') return rarSource(file, compare);
  if (kind === '7z') throw new Error('arquivos .cb7 (7-Zip) ainda não são aceitos — só .cbz e .cbr');
  if (kind === 'pdf') throw new Error('PDF não é aceito — só .cbz e .cbr');
  try {
    return await zipSource(file, compare);
  } catch (err) {
    if (kind === 'zip') throw err;
    throw new Error('não reconheci o arquivo — ele precisa ser um .cbz ou .cbr');
  }
}

/* ---------- ZIP / CBZ ---------- */

async function zipSource(file, compare) {
  const zip = await openZip(file);
  const pages = zip.entries
    .filter(e => !e.dir && e.uncomp > 0 && isPageName(e.name))
    .sort((a, b) => compare(a.name, b.name));
  const ci = zip.entries.find(e => isInfo(e.name));
  let xml = null;
  if (ci) { try { xml = await (await zip.read(ci)).text(); } catch { /* ignora */ } }
  return {
    kind: 'cbz',
    count: pages.length,
    encrypted: pages.some(e => e.encrypted),
    info: () => xml,
    async *pages() {
      for (let i = 0; i < pages.length; i++) yield { index: i, blob: await zip.read(pages[i]) };
    },
  };
}

/* ---------- RAR / CBR ---------- */

// A biblioteca de RAR (WebAssembly, ~270 KB) só é carregada quando aparece um CBR.
let unrarP = null;
function loadUnrar() {
  if (!unrarP) {
    unrarP = Promise.all([
      import('./vendor/unrar/index.js'),
      fetch(new URL('./vendor/unrar/js/unrar.wasm', import.meta.url)).then(r => {
        if (!r.ok) throw new Error('não consegui carregar o leitor de CBR (sem internet na primeira vez?)');
        return r.arrayBuffer();
      }),
    ]).then(([mod, wasm]) => ({ mod, wasm }))
      .catch(err => { unrarP = null; throw err; });
  }
  return unrarP;
}

function rarError(err) {
  const r = err && err.reason;
  if (r === 'ERAR_MISSING_PASSWORD' || r === 'ERAR_BAD_PASSWORD') return new Error('o arquivo está protegido por senha');
  if (r === 'ERAR_BAD_DATA') return new Error('o arquivo está danificado (talvez o download não terminou)');
  if (r === 'ERAR_BAD_ARCHIVE' || r === 'ERAR_UNKNOWN_FORMAT') return new Error('não parece ser um CBR válido');
  if (r === 'ERAR_NO_MEMORY') return new Error('o arquivo é grande demais para a memória do aparelho');
  return err instanceof Error ? err : new Error(String(err));
}

const norm = name => String(name).replace(/\\/g, '/');

async function rarSource(file, compare) {
  const { mod, wasm } = await loadUnrar();
  const data = await file.arrayBuffer();
  let ex, headers, arc;
  try {
    ex = await mod.createExtractorFromData({ wasmBinary: wasm, data });
    const list = ex.getFileList();
    arc = list.arcHeader;
    headers = [...list.fileHeaders];
  } catch (err) {
    throw rarError(err);
  }
  if (arc && arc.flags && arc.flags.volume) {
    throw new Error('o CBR está dividido em partes (.part1, .part2…) — junte num arquivo só');
  }
  const files = headers.filter(h => !h.flags.directory);
  const pageNames = files.map(h => norm(h.name)).filter(isPageName).sort(compare);
  const order = new Map(pageNames.map((n, i) => [n, i]));
  const ciName = files.map(h => norm(h.name)).find(isInfo) || null;
  let xml = null;

  return {
    kind: 'cbr',
    count: pageNames.length,
    encrypted: files.some(h => order.has(norm(h.name)) && h.flags.encrypted),
    info: () => xml,
    async *pages() {
      let out;
      try {
        out = ex.extract({ files: h => order.has(norm(h.name)) || norm(h.name) === ciName }).files;
      } catch (err) { throw rarError(err); }
      while (true) {
        let step;
        try { step = out.next(); } catch (err) { throw rarError(err); }
        if (step.done) break;
        const f = step.value;
        const name = norm(f.fileHeader.name);
        const bytes = f.extraction;
        // a biblioteca guarda uma cópia de cada arquivo extraído; solta para não encher a memória
        try { delete ex.dataFiles[ex.getExtractedFileName(f.fileHeader.name)]; } catch { /* ok */ }
        f.extraction = null;
        if (!bytes) continue;
        if (name === ciName) {
          try { xml = new TextDecoder().decode(bytes); } catch { /* ignora */ }
          continue;
        }
        yield { index: order.get(name), blob: new Blob([bytes], { type: mimeFor(name) }) };
      }
    },
  };
}
