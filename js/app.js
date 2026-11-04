import { openComicArchive } from './archive.js';
import * as db from './db.js';
import { Reader } from './reader.js';

const $ = s => document.querySelector(s);
const collator = new Intl.Collator('pt-BR', { numeric: true, sensitivity: 'base' });
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const icon = id => `<svg><use href="#i-${id}"/></svg>`;

/* ---------- preferências ---------- */

const PREFS_KEY = 'gibiteca.prefs';
const prefs = (() => {
  const base = { sort: 'recent', mode: 'auto', sound: true };
  try { return { ...base, ...JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') }; } catch { return base; }
})();
const savePrefs = () => { try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* ok */ } };

const state = { comics: [], q: '', fresh: new Set() };
const coverURLs = new Map();

function coverURL(c) {
  if (!c.cover) return '';
  if (!coverURLs.has(c.id)) coverURLs.set(c.id, URL.createObjectURL(c.cover));
  return coverURLs.get(c.id);
}

/* ---------- títulos e séries ---------- */

function cleanTitle(fileName) {
  let t = fileName.replace(/\.(cbz|cbr|zip|rar)$/i, '').replace(/[_]+/g, ' ');
  const noTags = t.replace(/\s*[([{][^)\]}]*[)\]}]/g, '').trim();
  if (noTags) t = noTags;
  return t.replace(/\s{2,}/g, ' ').trim() || fileName;
}

const SERIES_RX = /^(.*?\S)\s+(?:#\s?|n[º°o]\.?\s?|vol(?:ume)?\.?\s?|v\.\s?|ed(?:i[çc][ãa]o)?\.?\s?|cap(?:[íi]tulo)?\.?\s?|ch(?:apter)?\.?\s?|issue\s|parte\s|part\s)?(\d{1,4}(?:[.,]\d+)?)$/i;
function guessSeries(title) {
  const m = title.match(SERIES_RX);
  if (m && /\p{L}/u.test(m[1])) {
    return { series: m[1].replace(/[\s\-–—:,.]+$/, ''), number: parseFloat(m[2].replace(',', '.')) };
  }
  return { series: title, number: null };
}

function parseComicInfo(xml) {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const g = t => (doc.getElementsByTagName(t)[0]?.textContent || '').trim();
  return {
    title: g('Title'), series: g('Series'), number: g('Number'), year: g('Year'),
    writer: g('Writer'), summary: g('Summary'), manga: /^yes/i.test(g('Manga')),
  };
}

/* ---------- importar CBZ ---------- */

function loadImage(blob) {
  return new Promise((resolve, reject) => {
    const u = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => resolve({ img, done: () => URL.revokeObjectURL(u) });
    img.onerror = () => { URL.revokeObjectURL(u); reject(new Error('imagem inválida')); };
    img.src = u;
  });
}

async function makeThumb(blob) {
  const { img, done } = await loadImage(blob);
  const w = 480;
  const h = Math.round((w * img.naturalHeight) / img.naturalWidth) || 720;
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  const ctx = cv.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, w, h);
  const aspect = img.naturalWidth / img.naturalHeight;
  done();
  const thumb = await new Promise(r => cv.toBlob(r, 'image/jpeg', 0.84));
  cv.width = cv.height = 0;
  return { thumb, aspect };
}

async function measure(blob) {
  try {
    const { img, done } = await loadImage(blob);
    const a = img.naturalWidth / img.naturalHeight;
    done();
    return a;
  } catch { return null; }
}

function pickAspect(list) {
  const portrait = list.filter(a => a && a > 0.4 && a < 1).sort((a, b) => a - b);
  if (!portrait.length) return 0.66;
  return portrait[Math.floor(portrait.length / 2)];
}

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

// título, série e sentido de leitura: do ComicInfo.xml quando existe, senão do nome do arquivo
function metaFrom(fileName, xml) {
  let info = {};
  if (xml) { try { info = parseComicInfo(xml); } catch { /* ignora */ } }
  const title = info.series ? info.series + (info.number ? ` #${info.number}` : '') : (info.title || cleanTitle(fileName));
  const guess = guessSeries(title);
  return {
    title,
    subtitle: info.series && info.title ? info.title : '',
    series: info.series || guess.series,
    number: info.number ? parseFloat(String(info.number).replace(',', '.')) : guess.number,
    writer: info.writer || '',
    year: info.year || '',
    rtl: !!info.manga,
  };
}

async function importOne(file, onProgress) {
  const src = await openComicArchive(file, collator.compare);
  if (!src.count) throw new Error('não achei nenhuma página (imagem) dentro do arquivo');
  if (src.encrypted) throw new Error('o arquivo está protegido por senha');

  const comic = {
    id: uid(),
    ...metaFrom(file.name, src.info()),
    fileName: file.name,
    format: src.kind,
    size: file.size,
    pageCount: src.count,
    addedAt: Date.now(),
    lastReadAt: 0,
    lastPage: 0,
    finished: false,
    aspect: 0.66,
    status: 'importing',
  };
  await db.putComic(comic);

  try {
    const aspects = [];
    const sample = new Set([1, 2, Math.floor(src.count / 2)]);
    let bytes = 0;
    let done = 0;
    for await (const { index, blob } of src.pages()) {
      bytes += blob.size;
      await db.putPage(comic.id, index, blob);
      if (index === 0) {
        const { thumb, aspect } = await makeThumb(blob);
        comic.cover = thumb;
        aspects.push(aspect);
      } else if (sample.has(index)) {
        aspects.push(await measure(blob));
      }
      onProgress(++done, src.count);
    }
    if (done < src.count || !comic.cover) throw new Error('algumas páginas não puderam ser lidas');
    // no CBR o ComicInfo.xml só aparece durante a extração
    if (src.kind === 'cbr' && src.info()) Object.assign(comic, metaFrom(file.name, src.info()));
    comic.aspect = pickAspect(aspects);
    comic.bytes = bytes;
    comic.status = 'ready';
    await db.putComic(comic);
    return comic;
  } catch (err) {
    await db.deleteComic(comic.id).catch(() => {});
    throw err;
  }
}

let importing = false;
const queue = [];

async function importFiles(fileList) {
  const files = [...fileList].filter(f => f && f.size !== undefined);
  if (!files.length) return;
  queue.push(...files);
  if (importing) { $('#importCount').textContent = `+${queue.length} na fila`; return; }
  importing = true;
  try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {}); } catch { /* ok */ }
  let lock = null;
  try { lock = await navigator.wakeLock?.request('screen'); } catch { /* ok */ }

  const card = $('#importCard');
  card.hidden = false;
  let added = 0;
  let total = 0;
  while (queue.length) {
    const f = queue.shift();
    total++;
    const title = cleanTitle(f.name);
    $('#importName').textContent = title;
    $('#importCount').textContent = 'abrindo…';
    $('#importBar').style.width = '0%';
    try {
      if (state.comics.some(c => c.fileName === f.name && c.size === f.size)) {
        toast(`"${title}" já está na estante`);
        continue;
      }
      const comic = await importOne(f, (done, n) => {
        $('#importCount').textContent = `${done}/${n} págs${queue.length ? ` · +${queue.length}` : ''}`;
        $('#importBar').style.width = `${(done / n) * 100}%`;
      });
      state.comics.push(comic);
      state.fresh.add(comic.id);
      added++;
      render();
    } catch (err) {
      console.error(err);
      toast(`Não deu pra abrir "${title}": ${err.message || err}`, 5000);
    }
  }
  card.hidden = true;
  importing = false;
  try { lock && lock.release(); } catch { /* ok */ }
  if (added) toast(added === 1 ? 'Gibi novo na estante!' : `${added} gibis novos na estante!`);
}

/* ---------- estante ---------- */

function sortKey(c) { return c.lastReadAt || c.addedAt; }

function visibleComics() {
  const q = state.q.trim().toLowerCase();
  let list = state.comics;
  if (q) {
    const nq = q.normalize('NFD').replace(/\p{Diacritic}/gu, '');
    list = list.filter(c => `${c.title} ${c.series} ${c.subtitle} ${c.writer}`.toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '').includes(nq));
  }
  list = [...list];
  if (prefs.sort === 'az') list.sort((a, b) => collator.compare(a.title, b.title));
  else list.sort((a, b) => sortKey(b) - sortKey(a));
  return list;
}

function columns() {
  const w = $('#shelves').clientWidth || window.innerWidth - 32;
  const min = w < 500 ? 96 : 120;
  return Math.max(3, Math.min(9, Math.floor((w - 24 + 16) / (min + 16))));
}

// etiqueta da prateleira: só "#3" dentro da série; fora dela, o número vem antes para não sumir no corte
function shortTitle(c) {
  if (c.number != null && c.series && c.series !== c.title) return `#${c.number}`;
  return c.title;
}
function shelfLabel(c) {
  if (c.number != null && c.series && c.series !== c.title) return `#${c.number} ${c.series}`;
  return c.title;
}

function coverHTML(c) {
  const pct = c.pageCount > 1 ? Math.round((c.lastPage / (c.pageCount - 1)) * 100) : 0;
  let badge = '';
  if (!c.lastReadAt) badge = '<b class="cv-badge">NOVO!</b>';
  else if (c.finished) badge = `<b class="cv-badge done" title="Lido">${icon('check')}</b>`;
  const prog = c.lastReadAt && !c.finished && c.lastPage > 0 ? `<span class="cv-prog"><i style="width:${pct}%"></i></span>` : '';
  const fresh = state.fresh.has(c.id) ? ' drop-in' : '';
  return `<button class="cv${fresh}" type="button" data-id="${c.id}" aria-label="${esc(c.title)}"><img src="${coverURL(c)}" alt="" draggable="false">${prog}${badge}</button>`;
}

function shelvesHTML(items, cols, labelFn = shortTitle) {
  let html = '';
  for (let i = 0; i < items.length; i += cols) {
    const row = items.slice(i, i + cols);
    html += `<div class="shelf" style="--cols:${cols}"><div class="shelf-row">${row.map(coverHTML).join('')}</div>`
      + `<div class="shelf-board"><div class="shelf-labels">${row.map(c => `<span class="lbl">${esc(labelFn(c))}</span>`).join('')}</div></div></div>`;
  }
  return html;
}

function render() {
  const all = state.comics;
  const list = visibleComics();
  const cols = columns();

  const totalBytes = all.reduce((s, c) => s + (c.bytes || c.size || 0), 0);
  $('#libCount').textContent = all.length
    ? `${all.length} ${all.length === 1 ? 'gibi' : 'gibis'} · ${fmtBytes(totalBytes)}`
    : 'sua estante de quadrinhos';
  $('#libTools').hidden = all.length < 2;
  document.querySelectorAll('#sortSeg button').forEach(b => b.classList.toggle('on', b.dataset.sort === prefs.sort));
  $('#empty').hidden = all.length > 0;
  $('#noResults').hidden = !(all.length && !list.length);

  // continuar lendo
  const hero = $('#hero');
  const current = state.q ? null : [...all].filter(c => c.lastReadAt && !c.finished && c.lastPage > 0).sort((a, b) => b.lastReadAt - a.lastReadAt)[0];
  if (current) {
    const pct = Math.round(((current.lastPage + 1) / current.pageCount) * 100);
    hero.hidden = false;
    hero.dataset.id = current.id;
    hero.innerHTML = `<div class="hero-cover"><img src="${coverURL(current)}" alt=""></div>
      <div class="hero-body"><div class="kicker">Continuar lendo</div><h2>${esc(current.title)}</h2>
      <p>Página ${current.lastPage + 1} de ${current.pageCount}</p>
      <div class="bar"><i style="width:${pct}%"></i></div>
      <span class="btn">${icon('book')}Continuar</span></div>`;
  } else {
    hero.hidden = true;
  }

  let html = '';
  if (prefs.sort === 'series' && !state.q) {
    const groups = new Map();
    for (const c of list) {
      const k = c.series || c.title;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(c);
    }
    const loose = [];
    const named = [];
    for (const [name, items] of groups) (items.length > 1 ? named : loose).push([name, items]);
    named.sort((a, b) => collator.compare(a[0], b[0]));
    for (const [name, items] of named) {
      items.sort((a, b) => (a.number ?? 1e9) - (b.number ?? 1e9) || collator.compare(a.title, b.title));
      html += `<div class="series"><h3 class="series-name">${esc(name)} <small>${items.length} edições</small></h3>${shelvesHTML(items, cols)}</div>`;
    }
    if (loose.length) {
      const items = loose.map(g => g[1][0]).sort((a, b) => collator.compare(a.title, b.title));
      html += `<div class="series"><h3 class="series-name">${named.length ? 'Avulsos' : 'Todos'} <small>${items.length}</small></h3>${shelvesHTML(items, cols, shelfLabel)}</div>`;
    }
  } else {
    html = shelvesHTML(list, cols, shelfLabel);
  }
  $('#shelves').innerHTML = html;
  state.fresh.clear();
}

function fmtBytes(n) {
  if (!n) return '0 MB';
  if (n < 1e9) return `${Math.max(1, Math.round(n / 1e6))} MB`;
  return `${(n / 1e9).toFixed(1).replace('.', ',')} GB`;
}

/* ---------- leitor ---------- */

let saveTimer = 0;
const reader = new Reader($('#reader'), {
  prefs,
  getPage: (id, i) => db.getPage(id, i),
  toast: (m) => toast(m),
  requestClose: () => closeReader(),
  onProgress(comic, page, atEnd, final) {
    comic.lastPage = page;
    comic.lastReadAt = Date.now();
    if (atEnd) comic.finished = true;
    clearTimeout(saveTimer);
    const save = () => db.putComic(comic).catch(() => {});
    if (final) save(); else saveTimer = setTimeout(save, 500);
  },
  onClosed() { render(); },
});

function openComic(id, fromEl, restart = false) {
  const c = state.comics.find(x => x.id === id);
  if (!c) return;
  if (restart) { c.finished = false; c.lastPage = 0; }
  const start = c.finished ? 0 : c.lastPage;
  let from = null;
  const img = fromEl && fromEl.querySelector('img');
  if (img && img.src) from = { rect: img.getBoundingClientRect(), src: img.src };
  try { history.pushState({ reader: id }, ''); } catch { /* ok */ }
  reader.open(c, start, from);
}

function closeReader() {
  if (history.state && history.state.reader) history.back();
  else reader.close();
}

window.addEventListener('popstate', () => {
  if (!$('#sheet').hidden) closeSheet(true);
  if (reader.isOpen) reader.close();
});

/* ---------- folhas (menus) ---------- */

function openSheet(html, onClick) {
  const sheet = $('#sheet');
  const panel = $('#sheetPanel');
  sheet.classList.remove('closing');
  panel.innerHTML = html;
  sheet.hidden = false;
  sheet.onclick = e => {
    if (e.target.closest('[data-close]')) { closeSheet(); return; }
    onClick && onClick(e);
  };
}

function closeSheet(instant = false) {
  const sheet = $('#sheet');
  if (sheet.hidden) return;
  if (instant) { sheet.hidden = true; return; }
  sheet.classList.add('closing');
  setTimeout(() => { sheet.hidden = true; sheet.classList.remove('closing'); }, 180);
}

function comicSheet(id) {
  const c = state.comics.find(x => x.id === id);
  if (!c) return;
  const meta = [`${c.pageCount} páginas`, fmtBytes(c.bytes || c.size), c.writer, c.year].filter(Boolean).join(' · ');
  const progress = c.finished ? 'Já lido ✓' : c.lastReadAt ? `Parou na página ${c.lastPage + 1}` : 'Ainda não aberto';
  openSheet(`
    <div class="sheet-head"><img src="${coverURL(c)}" alt=""><div><h3>${esc(c.title)}</h3><p>${esc(meta)}<br>${progress}</p></div></div>
    <button class="act" data-a="read">${icon('book')}${c.lastReadAt && !c.finished ? 'Continuar lendo' : 'Ler'}</button>
    ${c.lastPage > 0 || c.finished ? `<button class="act" data-a="restart">${icon('restart')}Ler do começo</button>` : ''}
    <button class="act" data-a="rtl">${icon('swap')}Sentido de leitura<span class="act-sub">${c.rtl ? 'Mangá ←' : 'Ocidental →'}</span></button>
    <button class="act" data-a="rename">${icon('edit')}Renomear</button>
    ${c.lastReadAt ? `<button class="act" data-a="unread">${icon('restart')}Marcar como não lido</button>` : ''}
    <button class="act danger" data-a="delete">${icon('trash')}Tirar da estante</button>
  `, async e => {
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (!a) return;
    const el = document.querySelector(`.cv[data-id="${id}"]`);
    if (a === 'read') { closeSheet(true); openComic(id, el); }
    else if (a === 'restart') { closeSheet(true); openComic(id, el, true); }
    else if (a === 'rtl') { c.rtl = !c.rtl; await db.putComic(c); comicSheet(id); }
    else if (a === 'unread') { c.lastReadAt = 0; c.lastPage = 0; c.finished = false; await db.putComic(c); closeSheet(); render(); }
    else if (a === 'rename') renameSheet(c);
    else if (a === 'delete') deleteSheet(c);
  });
}

function renameSheet(c) {
  openSheet(`
    <h3 class="sheet-title">Renomear</h3>
    <label class="field"><span>Título</span><input id="fTitle" value="${esc(c.title)}" maxlength="140" autocomplete="off"></label>
    <label class="field"><span>Série (para agrupar na estante)</span><input id="fSeries" value="${esc(c.series)}" maxlength="140" autocomplete="off"></label>
    <div class="row-btns"><button class="btn ghost" data-close type="button">Cancelar</button><button class="btn" data-a="save" type="button">Salvar</button></div>
  `, async e => {
    if (!e.target.closest('[data-a="save"]')) return;
    const t = $('#fTitle').value.trim();
    const s = $('#fSeries').value.trim();
    if (t) c.title = t;
    const g = guessSeries(c.title);
    c.series = s || g.series;
    if (g.series === c.series) c.number = g.number;
    await db.putComic(c);
    closeSheet();
    render();
  });
  setTimeout(() => $('#fTitle')?.focus(), 250);
}

function deleteSheet(c) {
  openSheet(`
    <div class="sheet-head"><img src="${coverURL(c)}" alt=""><div><h3>Tirar "${esc(c.title)}" da estante?</h3><p>O gibi é apagado deste aparelho. O arquivo original no seu Drive continua lá.</p></div></div>
    <div class="row-btns"><button class="btn ghost" data-close type="button">Cancelar</button><button class="btn danger" data-a="del" type="button">${icon('trash')}Tirar</button></div>
  `, async e => {
    if (!e.target.closest('[data-a="del"]')) return;
    await db.deleteComic(c.id);
    state.comics = state.comics.filter(x => x.id !== c.id);
    if (coverURLs.has(c.id)) { URL.revokeObjectURL(coverURLs.get(c.id)); coverURLs.delete(c.id); }
    closeSheet();
    render();
    toast('Gibi removido da estante');
  });
}

function readerSheet() {
  const c = reader.c;
  const seg = (key, opts, cur) => `<div class="seg">${opts.map(([v, l]) => `<button type="button" data-${key}="${v}" class="${cur === v ? 'on' : ''}">${l}</button>`).join('')}</div>`;
  openSheet(`
    <h3 class="sheet-title">Ajustes de leitura</h3>
    <div class="opt-group"><span>Sentido de leitura deste gibi</span>${seg('dir', [['ltr', 'Ocidental →'], ['rtl', '← Mangá']], c.rtl ? 'rtl' : 'ltr')}</div>
    <div class="opt-group"><span>Páginas na tela</span>${seg('mode', [['auto', 'Automático'], ['single', 'Uma'], ['double', 'Duas']], prefs.mode)}</div>
    <div class="switch-row">Som de virar página<button type="button" class="switch ${prefs.sound ? 'on' : ''}" data-sound aria-label="Som de virar página"></button></div>
    <p class="info-text muted" style="font-size:13px;margin:10px 0 0">Automático: uma página com o celular em pé, revista aberta (duas páginas) com ele deitado.</p>
  `, async e => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.dir) {
      c.rtl = b.dataset.dir === 'rtl';
      await db.putComic(c);
      reader.setRtl(c.rtl);
    } else if (b.dataset.mode) {
      prefs.mode = b.dataset.mode;
      savePrefs();
      reader.layout();
    } else if (b.hasAttribute('data-sound')) {
      prefs.sound = !prefs.sound;
      savePrefs();
    } else return;
    readerSheet();
  });
}

async function infoSheet() {
  let used = '', pct = 0;
  try {
    const est = await navigator.storage.estimate();
    used = `${fmtBytes(est.usage)} usados de ${fmtBytes(est.quota)} disponíveis para o app`;
    pct = est.quota ? Math.min(100, (est.usage / est.quota) * 100) : 0;
  } catch { /* ok */ }
  let persisted = false;
  try { persisted = await navigator.storage.persisted(); } catch { /* ok */ }
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  openSheet(`
    <h3 class="sheet-title">Gibiteca</h3>
    <div class="info-text">
      <p>Seus gibis ficam guardados <b>só neste aparelho</b> — nada é enviado pra internet. Funciona até sem sinal.</p>
      ${used ? `<div class="storage-box">${used}<div class="bar"><i style="width:${pct.toFixed(1)}%"></i></div></div>` : ''}
      ${standalone ? '' : `<p><b>Importante no iPhone:</b> no Safari, toque em Compartilhar → <b>Adicionar à Tela de Início</b> e abra sempre pelo ícone. Assim o iPhone não apaga sua estante.</p>`}
      ${persisted ? '<p class="muted">✓ Armazenamento protegido contra limpeza automática.</p>' : ''}
      <ul class="tips">
        <li>Toque no <b>+</b> e escolha os .cbz ou .cbr (no iPhone: “Escolher Arquivo” → Google Drive).</li>
        <li>Segure uma capa para renomear, mudar o sentido (mangá) ou tirar da estante.</li>
        <li>No gibi: toque nas bordas ou arraste para virar; pinça ou toque duplo para zoom.</li>
        <li>Deite o celular para ver a revista aberta, com duas páginas.</li>
      </ul>
    </div>
    ${state.comics.length ? `<button class="act danger" data-a="wipe">${icon('trash')}Esvaziar a estante</button>` : ''}
  `, e => {
    if (e.target.closest('[data-a="wipe"]')) wipeSheet();
  });
}

function wipeSheet() {
  openSheet(`
    <h3 class="sheet-title">Esvaziar a estante?</h3>
    <p class="info-text">Isso apaga os ${state.comics.length} gibis deste aparelho. Os arquivos no Drive não são afetados.</p>
    <div class="row-btns"><button class="btn ghost" data-close type="button">Cancelar</button><button class="btn danger" data-a="yes" type="button">Apagar tudo</button></div>
  `, async e => {
    if (!e.target.closest('[data-a="yes"]')) return;
    for (const c of state.comics) await db.deleteComic(c.id);
    state.comics = [];
    for (const u of coverURLs.values()) URL.revokeObjectURL(u);
    coverURLs.clear();
    closeSheet();
    render();
  });
}

/* ---------- avisos ---------- */

let toastTimer = 0;
function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

/* ---------- eventos ---------- */

function bindLibrary() {
  $('#btnAdd').addEventListener('click', () => $('#filePick').click());
  $('#filePick').addEventListener('change', e => {
    const files = [...e.target.files];
    e.target.value = '';
    importFiles(files);
  });
  $('#btnInfo').addEventListener('click', infoSheet);
  $('#search').addEventListener('input', e => { state.q = e.target.value; render(); });
  $('#sortSeg').addEventListener('click', e => {
    const b = e.target.closest('[data-sort]');
    if (!b) return;
    prefs.sort = b.dataset.sort;
    savePrefs();
    render();
  });
  $('#hero').addEventListener('click', () => {
    const id = $('#hero').dataset.id;
    openComic(id, $('#hero .hero-cover'));
  });

  // toque abre; segurar abre o menu do gibi
  const shelves = $('#shelves');
  let lp = null;
  let suppressUntil = 0;
  shelves.addEventListener('pointerdown', e => {
    const cv = e.target.closest('.cv');
    if (!cv) return;
    cv.classList.add('pressed');
    lp = {
      cv, x: e.clientX, y: e.clientY,
      t: setTimeout(() => {
        cv.classList.remove('pressed');
        suppressUntil = performance.now() + 800;
        if (navigator.vibrate) navigator.vibrate(12);
        comicSheet(cv.dataset.id);
        lp = null;
      }, 480),
    };
  });
  const cancelLp = () => { if (lp) { clearTimeout(lp.t); lp.cv.classList.remove('pressed'); lp = null; } };
  shelves.addEventListener('pointermove', e => { if (lp && Math.hypot(e.clientX - lp.x, e.clientY - lp.y) > 10) cancelLp(); });
  shelves.addEventListener('pointerup', cancelLp);
  shelves.addEventListener('pointercancel', cancelLp);
  shelves.addEventListener('pointerleave', cancelLp);
  shelves.addEventListener('contextmenu', e => {
    const cv = e.target.closest('.cv');
    if (!cv) return;
    e.preventDefault();
    cancelLp();
    if (performance.now() < suppressUntil) return;
    suppressUntil = performance.now() + 500;
    comicSheet(cv.dataset.id);
  });
  shelves.addEventListener('click', e => {
    const cv = e.target.closest('.cv');
    if (!cv || performance.now() < suppressUntil) return;
    openComic(cv.dataset.id, cv);
  });

  $('#rdBack').addEventListener('click', closeReader);
  $('#rdMenu').addEventListener('click', readerSheet);

  // arrastar arquivos (computador)
  let dragDepth = 0;
  const dz = $('#dropZone');
  window.addEventListener('dragenter', e => { if (e.dataTransfer?.types?.includes('Files')) { dragDepth++; dz.hidden = false; e.preventDefault(); } });
  window.addEventListener('dragover', e => { if (e.dataTransfer?.types?.includes('Files')) e.preventDefault(); });
  window.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) dz.hidden = true; });
  window.addEventListener('drop', e => {
    if (!e.dataTransfer?.files?.length) return;
    e.preventDefault();
    dragDepth = 0;
    dz.hidden = true;
    importFiles(e.dataTransfer.files);
  });

  let rw = window.innerWidth;
  window.addEventListener('resize', () => {
    if (reader.isOpen || Math.abs(window.innerWidth - rw) < 2) return;
    rw = window.innerWidth;
    render();
  });
  document.addEventListener('gesturestart', e => e.preventDefault());
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('#sheet').hidden) closeSheet(); });
}

/* ---------- início ---------- */

async function init() {
  bindLibrary();
  try {
    state.comics = await db.loadReady();
  } catch (err) {
    console.error(err);
    toast('Não consegui abrir a estante neste navegador.', 5000);
  }
  render();
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

window.gibiteca = { importFiles, state, reader };
init();
