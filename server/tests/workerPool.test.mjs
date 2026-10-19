/**
 * اختبار مُجمّع العمال: يثبت أن تنفيذ فحص السيولة في خيط منفصل يعطي نتيجة
 * مطابقة حرفياً للتنفيذ داخل الخيط الرئيسي، وأنه يتحمل الأعطال والمهل.
 *
 * هذا هو الضمان المطلوب: تحسين الأداء (نقل العمل خارج حلقة الأحداث) بلا أي
 * تغيير في القرار أو في الشروط.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkerPool } from '../services/workerPool.mjs';
import { scanHistory, detectLiquidityZones } from '../liquidity-zones/engine.mjs';

const silentLog = { log: () => {}, warn: () => {}, error: () => {} };

function seeded(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

function makeCandles(n = 200, seed = 3) {
  const rnd = seeded(seed);
  const closes = [];
  let v = 100;
  for (let i = 0; i < n; i += 1) { v += (i % 40 < 20 ? 1 : -1) * (0.5 + rnd() * 0.3); closes.push(Number(v.toFixed(6))); }
  return closes.map((c, i) => ({
    time: 1_700_000_000 + i * 60, open: closes[Math.max(0, i - 1)], high: c + 0.6, low: c - 0.6,
    close: c, volume: 100 + (i % 17), index: i
  }));
}

/** يستبعد الطوابع الزمنية الفعلية من المقارنة (تختلف بطبيعتها بين الخيطين) */
const strip = (zones) => JSON.parse(JSON.stringify(zones, (k, v) => (k === 'detectedAt' ? undefined : v)));

test('العامل يعطي نفس نتيجة scanHistory داخل العملية حرفياً', async () => {
  const pool = createWorkerPool({ size: 2, log: silentLog });
  try {
    const candles = makeCandles(220, 11);
    const args = { symbol: 'BTCUSDT', timeframe: '5m', candles, step: 5, maxZones: 40 };
    const local = scanHistory(args);
    const remote = await pool.run('scanHistory', args);
    assert.equal(remote.length, local.length, `نفس العدد (${local.length})`);
    assert.deepEqual(strip(remote), strip(local), 'نفس المناطق حرفياً');
  } finally {
    await pool.close();
  }
});

test('العامل يعطي نفس نتيجة detectLiquidityZones حرفياً', async () => {
  const pool = createWorkerPool({ size: 1, log: silentLog });
  try {
    const candles = makeCandles(180, 22);
    const args = { symbol: 'ETHUSDT', timeframe: '1m', candles, endIndex: candles.length - 1 };
    const local = detectLiquidityZones(args);
    const remote = await pool.run('detectLiquidityZones', args);
    assert.deepEqual(strip(remote), strip(local), 'نفس المناطق حرفياً');
  } finally {
    await pool.close();
  }
});

test('الحساب لا يحجب حلقة الأحداث الرئيسية', async () => {
  const pool = createWorkerPool({ size: 2, log: silentLog });
  try {
    const candles = makeCandles(420, 5); // حمولة ثقيلة نسبياً
    let ticks = 0;
    const timer = setInterval(() => { ticks += 1; }, 5);
    const t0 = Date.now();
    await pool.run('scanHistory', { symbol: 'SOLUSDT', timeframe: '15m', candles, step: 3, maxZones: 60 });
    const elapsed = Date.now() - t0;
    clearInterval(timer);
    // أثناء الحساب يجب أن تستمر مؤقّتات الحلقة الرئيسية بالعمل
    const expected = Math.floor(elapsed / 5) * 0.5; // سماح 50%
    assert.ok(ticks >= expected, `الحلقة ظلّت حيّة: ${ticks} نبضة خلال ${elapsed}ms (المتوقع ≥ ${Math.floor(expected)})`);
  } finally {
    await pool.close();
  }
});

test('مهام متوازية متعددة تعود كلها بالنتيجة الصحيحة', async () => {
  const pool = createWorkerPool({ size: 3, log: silentLog });
  try {
    const jobs = [];
    for (let i = 0; i < 6; i += 1) {
      const candles = makeCandles(140, 100 + i);
      jobs.push({ candles, args: { symbol: `S${i}USDT`, timeframe: '1h', candles, step: 4, maxZones: 20 } });
    }
    const results = await Promise.all(jobs.map(j => pool.run('scanHistory', j.args)));
    results.forEach((r, i) => {
      const local = scanHistory(jobs[i].args);
      assert.equal(r.length, local.length, `مهمة ${i}: نفس العدد`);
    });
    const snap = pool.snapshot();
    assert.equal(snap.tasks, 6, 'كل المهام نُفّذت');
    assert.equal(snap.busy, 0, 'لا عامل مشغول بعد الانتهاء');
  } finally {
    await pool.close();
  }
});

test('مهلة المهمة تُكتشف ولا تُعلّق المجمّع', async () => {
  const pool = createWorkerPool({ size: 1, log: silentLog, taskTimeoutMs: 20 });
  try {
    const candles = makeCandles(600, 9); // أثقل من المهلة القصيرة
    await assert.rejects(
      () => pool.run('scanHistory', { symbol: 'XUSDT', timeframe: '1h', candles, step: 1, maxZones: 100 }),
      /مهلة|انتهى العامل|terminated/i,
      'يجب أن تفشل المهمة بمهلة'
    );
    // المجمّع يبقى صالحاً للاستخدام بعد المهلة (بمهلة واقعية للمهمة الجديدة)
    const small = makeCandles(120, 4);
    const r = await pool.run(
      'scanHistory',
      { symbol: 'YUSDT', timeframe: '1h', candles: small, step: 6, maxZones: 5 },
      { timeoutMs: 30_000 }
    );
    assert.ok(Array.isArray(r), 'المجمّع استُعيد ويخدم مهام جديدة');
    assert.equal(pool.snapshot().restarts >= 1, true, 'العامل العالق أُعيد تشغيله');
  } finally {
    await pool.close();
  }
});

test('المجمّع يرفض العمل بعد الإغلاق', async () => {
  const pool = createWorkerPool({ size: 1, log: silentLog });
  await pool.close();
  await assert.rejects(() => pool.run('scanHistory', {}), /مغلق/);
});
