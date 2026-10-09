import test from 'node:test';
import assert from 'node:assert/strict';

const { createMarketStreams } = await import('../market/streams.mjs');

const e451 = () => { const e = new Error('HTTP 451 from https://api-gcp.binance.com'); return Promise.reject(e); };
const eTmp = () => Promise.reject(new Error('socket hang up'));

function harness(seedKlines) {
  let t = 1_700_000_000_000;
  const warns = [];
  const m = createMarketStreams({
    now: () => t,
    log: { warn: (msg) => warns.push(String(msg)), log: () => {}, error: () => {} },
    seedKlines,
    config: { quarantineMs: 6 * 3600_000, maxSeedFails451: 2, maxSeedFailsOther: 15 }
  });
  return { m, warns, advance: (ms) => { t += ms; } };
}

test('مفتاح 451 دائم: محاولتان ثم حجر بلا شبكة ولا سجلات', async () => {
  let calls = 0;
  const { m, warns } = harness(() => { calls += 1; return e451(); });
  await m.ensureKlineSeed('XXXUSDT|5m');
  await m.ensureKlineSeed('XXXUSDT|5m');
  assert.equal(calls, 2);
  assert.ok(warns.some(w => w.includes('quarantine')), 'تحذير حجر واحد');
  const before = warns.length;
  await m.ensureKlineSeed('XXXUSDT|5m');
  await m.ensureKlineSeed('XXXUSDT|5m');
  assert.equal(calls, 2, 'لا نداءات أثناء الحجر');
  assert.equal(warns.length, before, 'لا سجلات أثناء الحجر');
  assert.equal(m.stats().quarantinedKeys, 1);
});

test('الحجر ينتهي بعد المدة (شفاء ذاتي) والنجاح يصفّر العداد', async () => {
  let calls = 0;
  let fail = true;
  const { m, advance } = harness(() => { calls += 1; return fail ? e451() : Promise.resolve([[1, 2, 3, 4, 5]]); });
  await m.ensureKlineSeed('YYYUSDT|5m');
  await m.ensureKlineSeed('YYYUSDT|5m');
  assert.equal(calls, 2);
  advance(7 * 3600_000); // تجاوز 6h
  fail = false;
  await m.ensureKlineSeed('YYYUSDT|5m');
  assert.equal(calls, 3);
  assert.equal(m.stats().quarantinedKeys, 0);
  assert.ok(m.hasKline('YYYUSDT|5m'), 'زُرع بعد الشفاء');
});

test('العطل العابر يُمهل 15 مرة قبل الحجر', async () => {
  let calls = 0;
  const { m } = harness(() => { calls += 1; return eTmp(); });
  for (let i = 0; i < 14; i += 1) await m.ensureKlineSeed('ZZZUSDT|5m');
  assert.equal(calls, 14);
  assert.equal(m.stats().quarantinedKeys, 0);
  await m.ensureKlineSeed('ZZZUSDT|5m');
  assert.equal(calls, 15);
  assert.equal(m.stats().quarantinedKeys, 1);
  await m.ensureKlineSeed('ZZZUSDT|5m');
  assert.equal(calls, 15, 'محجور الآن');
});
