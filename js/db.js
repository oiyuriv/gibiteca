// Banco local (IndexedDB): os gibis ficam guardados só neste aparelho.
// comics: dados de cada gibi (título, capa, progresso)
// pages:  uma imagem por página, chave [comicId, index]

const NAME = 'gibiteca';
let dbp = null;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const r = indexedDB.open(NAME, 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains('comics')) d.createObjectStore('comics', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('pages')) d.createObjectStore('pages', { keyPath: ['comicId', 'index'] });
    };
    r.onsuccess = () => {
      const d = r.result;
      d.onversionchange = () => d.close();
      resolve(d);
    };
    r.onerror = () => { dbp = null; reject(r.error); };
    r.onblocked = () => { dbp = null; reject(new Error('banco de dados bloqueado por outra aba')); };
  });
  return dbp;
}

const ask = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const finish = t => new Promise((res, rej) => {
  t.oncomplete = () => res();
  t.onerror = () => rej(t.error);
  t.onabort = () => rej(t.error || new Error('operação cancelada'));
});

async function tx(stores, mode = 'readonly') {
  const d = await open();
  return d.transaction(stores, mode);
}

export async function allComics() {
  const t = await tx('comics');
  return ask(t.objectStore('comics').getAll());
}

export async function putComic(comic) {
  const t = await tx('comics', 'readwrite');
  t.objectStore('comics').put(comic);
  return finish(t);
}

export async function putPage(comicId, index, blob) {
  const t = await tx('pages', 'readwrite');
  t.objectStore('pages').put({ comicId, index, blob });
  return finish(t);
}

export async function getPage(comicId, index) {
  const t = await tx('pages');
  const row = await ask(t.objectStore('pages').get([comicId, index]));
  return row ? row.blob : null;
}

export async function deleteComic(id) {
  const t = await tx(['comics', 'pages'], 'readwrite');
  t.objectStore('comics').delete(id);
  t.objectStore('pages').delete(IDBKeyRange.bound([id, 0], [id, Infinity]));
  return finish(t);
}

// Importações que não terminaram (app fechado no meio) deixam páginas soltas: limpa.
export async function loadReady() {
  const all = await allComics();
  const ready = [];
  for (const c of all) {
    if (c.status === 'ready') ready.push(c);
    else await deleteComic(c.id).catch(() => {});
  }
  return ready;
}
