export function withDurablePersistence(base) {
  const state = {
    persistenceMode: base.persistenceMode ?? 'unknown',
    lastError: null,
    lastErrorAt: null
  };

  const call = async (operation) => {
    try {
      const result = await operation();
      state.persistenceMode = base.persistenceMode ?? 'supabase';
      state.lastError = null;
      state.lastErrorAt = null;
      return result;
    } catch (error) {
      state.persistenceMode = 'unavailable';
      state.lastError = String(error?.message ?? error).slice(0, 240);
      state.lastErrorAt = Date.now();
      throw error;
    }
  };

  return {
    get persistenceMode() { return state.persistenceMode; },
    persistenceStatus: () => ({ ...state }),
    listScans: (...args) => call(() => base.listScans(...args)),
    listEvents: (...args) => call(() => base.listEvents(...args)),
    listCandles: (...args) => call(() => base.listCandles(...args)),
    upsertCandles: (...args) => call(() => base.upsertCandles(...args)),
    upsertScan: (...args) => call(() => base.upsertScan(...args)),
    upsertPoints: (...args) => call(() => base.upsertPoints(...args)),
    ...(typeof base.upsertPointLinks === 'function' ? { upsertPointLinks: (...args) => call(() => base.upsertPointLinks(...args)) } : {}),
    ...(typeof base.listPointLinks === 'function' ? { listPointLinks: (...args) => call(() => base.listPointLinks(...args)) } : {}),
    listPoints: (...args) => call(() => base.listPoints(...args)),
    insertZoneEvent: (...args) => call(() => base.insertZoneEvent(...args)),
    insertSample: (...args) => call(() => base.insertSample(...args)),
    pruneRaw: (...args) => call(() => base.pruneRaw(...args))
  };
}
