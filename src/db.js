// -------------------------------------------------------------------------
// Storage — one IndexedDB database, four object stores:
//   books    (keyPath id)      the imported .epub: bytes + parsed metadata
//   series   (keyPath id)      a named ordered group of book ids
//   progress (keyPath bookId)  per-book reading position + finished flag
//   kv       (plain key/value) misc app state (ui prefs, legacy migration)
// This module is the only place that talks to IndexedDB; everything above it
// works through the small get/put/delete helpers exported here.
// -------------------------------------------------------------------------
const DB_NAME = "webnovel-reader";
const DB_VERSION = 2;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("kv")) db.createObjectStore("kv");
      if (!db.objectStoreNames.contains("books")) db.createObjectStore("books", { keyPath: "id" });
      if (!db.objectStoreNames.contains("series")) db.createObjectStore("series", { keyPath: "id" });
      if (!db.objectStoreNames.contains("progress")) db.createObjectStore("progress", { keyPath: "bookId" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function tx(store, mode, fn) {
  return openDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction(store, mode);
        const os = t.objectStore(store);
        const out = fn(os);
        t.oncomplete = () => resolve(out?.result ?? out);
        t.onerror = () => reject(t.error);
      })
  );
}
export const dbGetAll = (store) => tx(store, "readonly", (os) => os.getAll());
export const dbPut = (store, value) => tx(store, "readwrite", (os) => os.put(value));
export const dbDelete = (store, key) => tx(store, "readwrite", (os) => os.delete(key));
export const kvGet = (key) => tx("kv", "readonly", (os) => os.get(key));
export const kvSet = (key, value) => tx("kv", "readwrite", (os) => os.put(value, key));
export const kvDelete = (key) => tx("kv", "readwrite", (os) => os.delete(key));
