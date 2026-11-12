// Úložisko záznamov z rukavice (IndexedDB v prehliadači tohto počítača). Záznam = hlavička + kusy vzoriek po ~1000 riadkov,
// aby sa pri páde stránky nestratil celý záznam a aby sa do pamäte nenačítavalo viac, než treba.

export type RecordingHeader = {
  id?: number;
  userId: string;
  kind: 'drawing';
  startedAt: number;
  endedAt: number | null;
  sampleCount: number;
  columns: string[];
  meta: Record<string, unknown>;
  /** udalosti počas záznamu: zmena tvaru/úrovne, výsledok ťahu, vynulovanie polohy */
  events: Record<string, unknown>[];
};

const DB_NAME = 'rehapiano';
const DB_VERSION = 1;

const wrap = <T>(req: IDBRequest<T>) => new Promise<T>((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

let dbPromise: Promise<IDBDatabase> | null = null;
function db(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      if (typeof indexedDB === 'undefined') { reject(new Error('IndexedDB nie je dostupná')); return; }
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains('recordings')) d.createObjectStore('recordings', { keyPath: 'id', autoIncrement: true }).createIndex('userId', 'userId');
        if (!d.objectStoreNames.contains('chunks')) d.createObjectStore('chunks', { keyPath: ['recId', 'idx'] }).createIndex('recId', 'recId');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    dbPromise.catch(() => { dbPromise = null; });
  }
  return dbPromise;
}

export async function createRecording(h: RecordingHeader): Promise<number> {
  const d = await db();
  return (await wrap(d.transaction('recordings', 'readwrite').objectStore('recordings').add(h))) as number;
}

export async function putChunk(recId: number, idx: number, rows: number[][]): Promise<void> {
  const d = await db();
  await wrap(d.transaction('chunks', 'readwrite').objectStore('chunks').put({ recId, idx, rows }));
}

export async function finishRecording(recId: number, patch: Partial<RecordingHeader>): Promise<void> {
  const d = await db();
  const store = d.transaction('recordings', 'readwrite').objectStore('recordings');
  const cur = await wrap(store.get(recId));
  if (cur) await wrap(store.put({ ...cur, ...patch, id: recId }));
}

export async function listRecordings(userId: string): Promise<RecordingHeader[]> {
  const d = await db();
  const all = (await wrap(d.transaction('recordings').objectStore('recordings').index('userId').getAll(userId))) as RecordingHeader[];
  return all.sort((a, b) => b.startedAt - a.startedAt);
}

export async function readSamples(recId: number): Promise<number[][]> {
  const d = await db();
  const chunks = (await wrap(d.transaction('chunks').objectStore('chunks').index('recId').getAll(recId))) as { idx: number; rows: number[][] }[];
  return chunks.sort((a, b) => a.idx - b.idx).flatMap((c) => c.rows);
}

export async function deleteRecording(recId: number): Promise<void> {
  const d = await db();
  const tx = d.transaction(['recordings', 'chunks'], 'readwrite');
  tx.objectStore('recordings').delete(recId);
  const keys = await wrap(tx.objectStore('chunks').index('recId').getAllKeys(recId));
  for (const k of keys) tx.objectStore('chunks').delete(k);
  await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); });
}

export async function deleteUserRecordings(userId: string): Promise<void> {
  for (const r of await listRecordings(userId)) if (r.id !== undefined) await deleteRecording(r.id);
}
