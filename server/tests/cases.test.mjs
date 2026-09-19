import { test } from 'node:test';
import assert from 'node:assert/strict';
import { closedCandles, deriveStats, assembleCase, DECISION_ACTORS } from '../cases.mjs';

const candle = (time, open, high, low, close) => ({ time, open, high, low, close });

test('closedCandles: يستبعد الشمعة الجارية (منع الاستشراق)', () => {
  const tfSec = 3600; // 1h
  const decidedAtSec = 100 * 3600; // إغلاق شمعة 99 بالضبط، شمعة 100 ما تزال جارية
  const cs = [
    candle(98 * tfSec, 100, 105, 99, 104),
    candle(99 * tfSec, 104, 106, 100, 101),
    candle(100 * tfSec, 101, 102, 99, 99.5) // جارية: time + tfSec > decidedAtSec
  ];
  const out = closedCandles(cs, tfSec, decidedAtSec);
  assert.equal(out.length, 2);
  assert.equal(out[0].time, 98 * tfSec);
  assert.equal(out[1].time, 99 * tfSec);
});

test('closedCandles: يدافع تجاه مدخلات غير مصفوفة', () => {
  assert.deepEqual(closedCandles(null, 60, 100), []);
  assert.deepEqual(closedCandles(undefined, 60, 100), []);
});

test('deriveStats: يستخدم الإغلاقات فقط — قمم/قيعان متساوية تكوّن EQH/EQL', () => {
  const tfSec = 3600;
  const decidedAtSec = 22 * tfSec; // شمعة 22 (بها سعر متطرف) تبقى «جارية» وتُستبعد
  const cs = [];
  const bars = [
    [96, 97], [95, 97], [93, 96], [91, 94], [90, 93], [92, 96], [95, 99], [97, 99],
    [98, 100], [96, 99], [93, 97], [90, 94], [91, 95], [94, 98], [96, 99], [97, 99],
    [98, 100], [97, 99], [94, 97], [90, 94], [92, 96], [95, 98], [300, 320]
  ];
  bars.forEach(([l, h], i) => cs.push(candle(i * tfSec, l, h, l, h)));
  const d = deriveStats(cs, { tfSec, decidedAtSec });
  assert.equal(d.closedCount, 22);
  assert.equal(d.lastClose, bars[21][1]); // إغلاق آخر شمعة مغلقة فقط — لا البار 22 المتطرف
  const s = d.stats;
  const eqh = s.eqh.find(c => c.price === 100);
  assert.ok(eqh, 'يجب أن تتجمع القمم المتساوية عند 100');
  assert.equal(eqh.count, 2);
  const eql = s.eql.find(c => c.price === 90);
  assert.ok(eql, 'يجب أن تتجمع القيعان المتساوية عند 90');
  assert.equal(eql.count, 2);
  assert.equal(s.refHigh, 100); // البار الجاري المتطرف (320) غير محسوب
  assert.ok(Array.isArray(s.zones));
  assert.ok(Array.isArray(s.pivots));
});

test('deriveStats: لا شموع مغلقة → stats معدومة', () => {
  const tfSec = 3600;
  const decidedAtSec = 100 * 3600;
  const cs = [candle(100 * tfSec, 100, 101, 99, 100.5)];
  const d = deriveStats(cs, { tfSec, decidedAtSec });
  assert.equal(d.closedCount, 0);
  assert.equal(d.lastClose, null);
  assert.equal(d.stats, null);
});

test('assembleCase: يُجمّع لقطة كاملة ويتسامح مع فشل المناخ (بدون شبكة)', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('offline in test'); };
  try {
    const decidedAt = Date.now();
    const decidedAtSec = Math.floor(decidedAt / 1000);
    const snapshot = {
      livePrice: 99.5,
      charts: [{ tf: '1h', tfSec: 3600, candles: [candle((decidedAtSec - 7200), 100, 105, 99, 104)] }],
      zones: [],
      analysis: { trend: 'up' },
      analysisAfter: { trend: 'up', note: 'x' },
      note: 'نوع سيولة قوي',
      zone: null
    };
    const db = { binance: { klines: async () => { throw new Error('offline'); } } };
    const p = await assembleCase({ symbol: 'BTCUSDT', actor: 'zone_create', decidedAt, snapshot, db });
    assert.equal(p.meta.symbol, 'BTCUSDT');
    assert.equal(p.meta.actor, 'zone_create');
    assert.equal(p.meta.livePrice, 99.5);
    assert.equal(p.chart['1h'].tfSec, 3600);
    assert.equal(p.note, 'نوع سيولة قوي');
    assert.equal(p.thermal.fearGreed?.available, false);
    assert.equal(p.thermal.stables?.available, false);
    assert.equal(p.thermal.funding, null);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('DECISION_ACTORS: يحتوي جميع أنواع القرار الثمانية', () => {
  assert.deepEqual(
    [...DECISION_ACTORS].sort(),
    ['analysis_edit', 'coin_add', 'coin_remove', 'zone_auto_feedback', 'zone_auto_note', 'zone_create', 'zone_delete', 'zone_edit'].sort()
  );
});