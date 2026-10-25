/**
 * مستودع مختبر السيولة مع وضع احتياطي بذاكرة الجلسة.
 *
 * العيب المؤكد: مسار نشر Verdent لا يضخّ SUPABASE_SERVICE_ROLE_KEY، وجداول
 * المختبر في القاعدة مقصورة على service_role للكتابة، فتفشل كل كتابة ويبقى
 * المختبر فارغًا (recovery=failed) رغم نجاح القراءة.
 *
 * الحل هنا: تُجرَّب الكتابة الدائمة أولًا (service_role عند توفره)، وعند فشلها
 * تُحفظ البيانات في ذاكرة العملية ويستمر المختبر عملًا ببيانات الجلسة، مع:
 * - وسم صريح `persistenceMode = 'memory-fallback'` تظهره الواجهة بلا التباس.
 * - إعادة محاولة الكتابة الدائمة كل 5 دقائق للتعافي تلقائيًا عند تهيأ الصلاحية.
 * - القراءة تفضّل المصدر الدائم دائمًا، وتعود للذاكرة عند فشل قراءته أو عند
 *   إرجاعه فراغًا بينما تحمل الذاكرة بيانات أحدث لم يقبلها المصدر الدائم.
 * - لا يُخلط بين الفراغ الحقيقي (لا بيانات في المصدرين) وفشل القراءة.
 */
export function withMemoryFallback(base, { now = () => Date.now(), retryDelayMs = 5 * 60_000 } = {}) {
  const memory = {
    candles: new Map(), // key: symbol|timeframe → Map(open_time → row)
    scans: new Map(), // key: engine|symbol|timeframe → row
    events: [], // أحدث أولًا
    eventKeys: new Set(),
    samples: new Map() // sample_key → row
  };
  const state = {
    persistenceMode: 'supabase',
    lastWriteError: null,
    lastWriteErrorAt: null,
    durableWritesBlockedUntil: 0
  };
  const candleKey = (symbol, timeframe) => `${symbol}|${timeframe}`;
  const scanKey = (row) => `${row.engine}|${row.symbol}|${row.timeframe}`;

  const durableWritesBlocked = () => now() < state.durableWritesBlockedUntil;
  const noteWriteFailure = (error) => {
    state.persistenceMode = 'memory-fallback';
    state.lastWriteError = String(error?.message ?? error).slice(0, 240);
    state.lastWriteErrorAt = now();
    state.durableWritesBlockedUntil = now() + retryDelayMs;
  };
  const tryDurable = async (operation) => {
    if (durableWritesBlocked()) return false;
    try {
      await operation();
      state.persistenceMode = 'supabase';
      state.lastWriteError = null;
      state.durableWritesBlockedUntil = 0;
      return true;
    } catch (error) {
      noteWriteFailure(error);
      return false;
    }
  };

  const storeCandleRows = (rows) => {
    for (const row of rows ?? []) {
      const key = candleKey(row.symbol, row.timeframe);
      if (!memory.candles.has(key)) memory.candles.set(key, new Map());
      memory.candles.get(key).set(Number(row.open_time), { ...row });
    }
  };
  const memoryCandles = (symbol, timeframe, limit) => {
    const rows = [...(memory.candles.get(candleKey(symbol, timeframe))?.values() ?? [])]
      .sort((a, b) => Number(a.open_time) - Number(b.open_time));
    return limit ? rows.slice(-limit) : rows;
  };

  return {
    get persistenceMode() { return state.persistenceMode; },
    persistenceStatus: () => ({ ...state }),
    async listScans(symbol) {
      try {
        const rows = await base.listScans(symbol);
        if (rows?.length) return rows;
      } catch (error) {
        state.lastWriteError = state.lastWriteError ?? String(error?.message ?? error).slice(0, 240);
      }
      return [...memory.scans.values()]
        .filter((row) => row.symbol === symbol)
        .sort((a, b) => Number(b.computed_at) - Number(a.computed_at))
        .slice(0, 14);
    },
    async listEvents(symbol, limit = 200) {
      try {
        const rows = await base.listEvents(symbol, limit);
        if (rows?.length) return rows;
      } catch (error) {
        state.lastWriteError = state.lastWriteError ?? String(error?.message ?? error).slice(0, 240);
      }
      return memory.events
        .filter((row) => row.symbol === symbol)
        .slice(0, Math.min(Math.max(Number(limit) || 200, 1), 500));
    },
    async listCandles(symbol, timeframe, limit = 500) {
      try {
        const rows = await base.listCandles(symbol, timeframe, limit);
        if (rows?.length) return rows;
      } catch (error) {
        state.lastWriteError = state.lastWriteError ?? String(error?.message ?? error).slice(0, 240);
      }
      return memoryCandles(symbol, timeframe, limit);
    },
    async upsertCandles(rows) {
      storeCandleRows(rows);
      await tryDurable(() => base.upsertCandles(rows));
    },
    async upsertScan(row) {
      memory.scans.set(scanKey(row), { ...row });
      await tryDurable(() => base.upsertScan(row));
    },
    async insertZoneEvent(row) {
      if (!memory.eventKeys.has(row.idempotency_key)) {
        memory.eventKeys.add(row.idempotency_key);
        memory.events.unshift({ ...row });
        if (memory.events.length > 2000) {
          const dropped = memory.events.pop();
          memory.eventKeys.delete(dropped.idempotency_key);
        }
      }
      await tryDurable(() => base.insertZoneEvent(row));
    },
    async insertSample(row) {
      if (!memory.samples.has(row.sample_key)) memory.samples.set(row.sample_key, { ...row });
      await tryDurable(() => base.insertSample(row));
    },
    async pruneRaw(cutoff) {
      for (const rows of memory.candles.values()) {
        for (const [openTime, row] of rows) {
          if (Number(row.close_time) < Number(cutoff)) rows.delete(openTime);
        }
      }
      for (const [key, row] of memory.samples) {
        if (Number(row.sampled_at) < Number(cutoff)) memory.samples.delete(key);
      }
      await tryDurable(() => base.pruneRaw(cutoff));
    }
  };
}
