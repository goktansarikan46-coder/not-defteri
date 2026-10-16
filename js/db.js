// Tüm veriler tabletin içinde, tarayıcının IndexedDB veritabanında tutulur.
//   folders   : { id, parentId ('root' ya da klasör id), name, createdAt }
//   notebooks : { id, folderId, title, fileId|null, pages: [{ id, kind: 'pdf'|'blank', pdfPage?, w, h }], thumb, createdAt, updatedAt, lastPage }
//   files     : { id, name, blob }            -> içe aktarılan orijinal PDF
//   ink       : { pageId, notebookId, strokes } -> sayfa üzerindeki kalem izleri

const DB_NAME = 'not-defteri';
const DB_VERSION = 1;
let dbPromise = null;

function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        db.createObjectStore('folders', { keyPath: 'id' }).createIndex('parentId', 'parentId');
        db.createObjectStore('notebooks', { keyPath: 'id' }).createIndex('folderId', 'folderId');
        db.createObjectStore('files', { keyPath: 'id' });
        db.createObjectStore('ink', { keyPath: 'pageId' }).createIndex('notebookId', 'notebookId');
      };
      req.onsuccess = () => {
        const db = req.result;
        // Başka bir sekme veritabanını yükseltmek/silmek isterse onu kilitleme; sonraki işlemde yeniden açılır.
        db.onversionchange = () => {
          db.close();
          dbPromise = null;
        };
        resolve(db);
      };
      req.onerror = () => reject(req.error);
      req.onblocked = () => console.warn('Veritabanı başka bir sekmede açık');
    });
  }
  return dbPromise;
}

function done(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function result(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function get(store, key) {
  const db = await open();
  return result(db.transaction(store).objectStore(store).get(key));
}

export async function getAll(store) {
  const db = await open();
  return result(db.transaction(store).objectStore(store).getAll());
}

export async function getAllByIndex(store, index, value) {
  const db = await open();
  return result(db.transaction(store).objectStore(store).index(index).getAll(value));
}

export async function put(store, value) {
  const db = await open();
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).put(value);
  return done(tx);
}

export async function del(store, key) {
  const db = await open();
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).delete(key);
  return done(tx);
}

// Birden çok depoya tek işlemde yazar: ya hepsi kaydedilir ya hiçbiri (yarım kalmış geri yükleme olmaz).
export async function putMany(records) {
  const stores = Object.keys(records);
  const db = await open();
  const tx = db.transaction(stores, 'readwrite');
  for (const store of stores) for (const value of records[store]) tx.objectStore(store).put(value);
  return done(tx);
}

export async function deleteNotebook(nb) {
  const db = await open();
  const tx = db.transaction(['notebooks', 'files', 'ink'], 'readwrite');
  tx.objectStore('notebooks').delete(nb.id);
  if (nb.fileId) tx.objectStore('files').delete(nb.fileId);
  const cursorReq = tx.objectStore('ink').index('notebookId').openKeyCursor(IDBKeyRange.only(nb.id));
  cursorReq.onsuccess = () => {
    const cursor = cursorReq.result;
    if (cursor) {
      tx.objectStore('ink').delete(cursor.primaryKey);
      cursor.continue();
    }
  };
  return done(tx);
}
