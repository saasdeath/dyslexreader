// Tiny IndexedDB wrapper. Everything is stored in this browser, on this device.
//
// Stores:
//   books      { id, title, author, format, lang, cover, addedAt, totalChars, sectionStarts }
//   content    { id, sections: [{ title, html, chars }], toc, anchors, resources: { key: Blob } }
//   files      { id, blob }               the original file (used for "Original" PDF pages)
//   positions  { bookId, title, author, anchor, progress, lastOpenedAt, updatedAt }
//   highlights { id, bookId, s, b1, o1, b2, o2, text, color, note, createdAt, updatedAt, deleted }

const NAME = 'dyslexreader';
const VERSION = 1;
let opening;

function open() {
  opening ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore('books', { keyPath: 'id' });
      db.createObjectStore('content', { keyPath: 'id' });
      db.createObjectStore('files', { keyPath: 'id' });
      db.createObjectStore('positions', { keyPath: 'bookId' });
      db.createObjectStore('highlights', { keyPath: 'id' }).createIndex('bookId', 'bookId');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return opening;
}

// Runs fn(store) in a transaction and resolves when the transaction has committed.
async function run(name, mode, fn) {
  const tx = (await open()).transaction(name, mode);
  const req = fn(tx.objectStore(name));
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve(req?.result);
    tx.onerror = tx.onabort = () => reject(tx.error || new Error('The browser did not allow saving. In a private window, books cannot be stored: please use a normal window.'));
  });
}

export const db = {
  get: (store, key) => run(store, 'readonly', (s) => s.get(key)),
  all: (store) => run(store, 'readonly', (s) => s.getAll()),
  put: (store, value) => run(store, 'readwrite', (s) => s.put(value)),
  del: (store, key) => run(store, 'readwrite', (s) => s.delete(key)),
  byBook: (store, bookId) => run(store, 'readonly', (s) => s.index('bookId').getAll(bookId)),
  putMany: (store, values) => run(store, 'readwrite', (s) => { values.forEach((v) => s.put(v)); }),
};

// Ask the browser not to clear our data when the device is low on space.
export function persist() {
  navigator.storage?.persist?.().catch(() => {});
}
