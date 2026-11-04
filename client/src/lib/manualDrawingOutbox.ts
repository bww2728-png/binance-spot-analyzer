import type { ManualDrawing } from './manualLiquidity';

const DB_NAME = 'manual-liquidity-outbox-v1';
const STORE_NAME = 'pending';

type PendingMutation = { key: string; operation: 'save' | 'delete'; symbol: string; timeframe: string; drawing: ManualDrawing | null; drawingId: string; updatedAt: number };

function openDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME, { keyPath: 'key' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('تعذر فتح صندوق الحفظ المؤقت'));
  });
}

async function transaction<T>(mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest<T>) {
  const database = await openDatabase();
  return new Promise<T>((resolve, reject) => {
    const tx = database.transaction(STORE_NAME, mode);
    const request = operation(tx.objectStore(STORE_NAME));
    let result: T;
    request.onsuccess = () => { result = request.result; };
    request.onerror = () => reject(request.error ?? new Error('تعذر تحديث صندوق الحفظ المؤقت'));
    tx.oncomplete = () => { database.close(); resolve(result); };
    tx.onerror = () => { database.close(); reject(tx.error ?? new Error('تعذر إتمام تحديث صندوق الحفظ المؤقت')); };
    tx.onabort = () => { database.close(); reject(tx.error ?? new Error('أُلغي تحديث صندوق الحفظ المؤقت')); };
  });
}

const contextKey = (symbol: string, timeframe: string, drawingId: string) => `${symbol}|${timeframe}|${drawingId}`;

export async function queueManualMutation(mutation: Omit<PendingMutation, 'key' | 'updatedAt'>) {
  const record: PendingMutation = { ...mutation, key: contextKey(mutation.symbol, mutation.timeframe, mutation.drawingId), updatedAt: Date.now() };
  await transaction('readwrite', (store) => store.put(record));
}

export async function listPendingManualMutations(symbol: string, timeframe: string) {
  const records = await transaction('readonly', (store) => store.getAll()) as PendingMutation[];
  return records.filter((record) => record.symbol === symbol && record.timeframe === timeframe).sort((a, b) => a.updatedAt - b.updatedAt);
}

export async function clearPendingManualMutation(symbol: string, timeframe: string, drawingId: string) {
  await transaction('readwrite', (store) => store.delete(contextKey(symbol, timeframe, drawingId)));
}
