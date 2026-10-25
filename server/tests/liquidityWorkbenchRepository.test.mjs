import assert from 'node:assert/strict';
import { test } from 'node:test';
import { withMemoryFallback } from '../services/liquidityWorkbenchRepository.mjs';

const candleRow = (openTime, closeTime = openTime + 3_600_000 - 1) => ({
  symbol: 'BTCUSDT', timeframe: '1h', open_time: openTime, open: 1, high: 2, low: 0.5,
  close: 1.5, volume: 10, close_time: closeTime, taker_buy_base: 1, source: 'test', updated_at: openTime
});

test('وضع احتياطي: الكتابة الدائمة الفاشلة تُخزَّن في الذاكرة وتُقرأ منها بلا خطأ', async () => {
  const writes = [];
  const base = {
    listScans: async () => { throw new Error('Supabase REST 401'); },
    listEvents: async () => { throw new Error('Supabase REST 401'); },
    listCandles: async () => { throw new Error('Supabase REST 401'); },
    upsertCandles: async (rows) => { writes.push(rows); throw new Error('service role required'); },
    upsertScan: async () => { throw new Error('service role required'); },
    insertZoneEvent: async () => { throw new Error('service role required'); },
    insertSample: async () => { throw new Error('service role required'); },
    pruneRaw: async () => { throw new Error('service role required'); }
  };
  const repo = withMemoryFallback(base);
  assert.equal(repo.persistenceMode, 'supabase');
  await repo.upsertCandles([candleRow(1000), candleRow(2000)]);
  assert.equal(repo.persistenceMode, 'memory-fallback');
  const candles = await repo.listCandles('BTCUSDT', '1h');
  assert.equal(candles.length, 2);
  assert.equal(candles[0].open_time, 1000); // ترتيب تصاعدي مطابق لعقد القراءة الأصلية
  await repo.upsertCandles([candleRow(2000, 2000)]); // تحديث نفس الشمعة لا يكررها
  assert.equal((await repo.listCandles('BTCUSDT', '1h')).length, 2);
  assert.equal(writes.length, 1); // الكتابة الثانية داخل نافذة حظر إعادة المحاولة فلم تُجرَّب
});

test('وضع احتياطي: القراءة الدائمة الناجحة تتفوق على الذاكرة، والفراغ الحقيقي يبقى فراغًا', async () => {
  const base = {
    listScans: async () => [{ engine: 'combined', symbol: 'BTCUSDT', timeframe: '1h', computed_at: 5 }],
    listEvents: async () => [],
    listCandles: async () => [candleRow(500)],
    upsertCandles: async () => {},
    upsertScan: async () => {},
    insertZoneEvent: async () => {},
    insertSample: async () => {},
    pruneRaw: async () => {}
  };
  const repo = withMemoryFallback(base);
  await repo.upsertCandles([candleRow(1000)]); // نجحت في المصدر الدائم أيضًا
  assert.equal(repo.persistenceMode, 'supabase');
  assert.equal((await repo.listCandles('BTCUSDT', '1h'))[0].open_time, 500); // المصدر الدائم أولًا
  assert.deepEqual(await repo.listEvents('BTCUSDT'), []); // فراغ حقيقي لا يُستبدل بذاكرة فارغة
});

test('وضع احتياطي: إعادة محاولة الكتابة الدائمة بعد انتهاء نافذة الحظر تُعيد وضع supabase', async () => {
  let clock = 1000;
  let durableOk = false;
  const base = {
    listScans: async () => [],
    listEvents: async () => [],
    listCandles: async () => [],
    upsertCandles: async () => { if (!durableOk) throw new Error('still broken'); },
    upsertScan: async () => {},
    insertZoneEvent: async () => {},
    insertSample: async () => {},
    pruneRaw: async () => {}
  };
  const repo = withMemoryFallback(base, { now: () => clock, retryDelayMs: 60_000 });
  await repo.upsertCandles([candleRow(1)]);
  assert.equal(repo.persistenceMode, 'memory-fallback');
  await repo.upsertCandles([candleRow(2)]); // داخل نافذة الحظر: لا محاولة
  assert.equal(repo.persistenceMode, 'memory-fallback');
  durableOk = true;
  clock += 61_000;
  await repo.upsertCandles([candleRow(3)]);
  assert.equal(repo.persistenceMode, 'supabase');
});

test('وضع احتياطي: أحداث المناطق تُنزّل بالتكرار عبر idempotency_key وتُقرأ الأحدث أولًا', async () => {
  const base = {
    listScans: async () => { throw new Error('down'); },
    listEvents: async () => { throw new Error('down'); },
    listCandles: async () => { throw new Error('down'); },
    upsertCandles: async () => {},
    upsertScan: async (row) => { throw new Error('down'); },
    insertZoneEvent: async () => { throw new Error('down'); },
    insertSample: async () => {},
    pruneRaw: async () => {}
  };
  const repo = withMemoryFallback(base);
  const event = (idempotencyKey, eventAt) => ({
    idempotency_key: idempotencyKey, engine: 'e', symbol: 'BTCUSDT', timeframe: '1h',
    zone_id: 'z', event_type: 'discovered', event_at: eventAt, payload: {}
  });
  await repo.insertZoneEvent(event('a', 100));
  await repo.insertZoneEvent(event('a', 100)); // تكرار مقصود
  await repo.insertZoneEvent(event('b', 200));
  const events = await repo.listEvents('BTCUSDT', 10);
  assert.equal(events.length, 2);
  assert.equal(events[0].idempotency_key, 'b'); // الأحدث أولًا
  const scans = await repo.listScans('BTCUSDT');
  assert.deepEqual(scans, []);
});
