// Files stay in this browser. Only the transcript/reference joins workspace data.
const DB_NAME = "planpilot-source-documents";
const STORE = "documents";

async function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error("This browser could not store the source file."));
  });
}

async function transaction<T>(mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const request = operation(tx.objectStore(STORE));
    tx.oncomplete = () => { db.close(); resolve(request.result); };
    tx.onerror = tx.onabort = () => { db.close(); reject(new Error("Could not save the source file in this browser.")); };
  });
}

export const saveSourceDocument = (id: string, file: Blob) => transaction("readwrite", (store) => store.put(file, id));
export const loadSourceDocument = (id: string): Promise<Blob | undefined> => transaction("readonly", (store) => store.get(id));
export const clearSourceDocuments = () => transaction("readwrite", (store) => store.clear());
