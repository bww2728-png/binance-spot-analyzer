import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  findPivots, clusterEquals, detectSweeps, detectFVGs, candidateZones,
  isRoundNumber, referenceLevels, pivotStrengthFor, atr14, bandPctFor
} from '../liquidity/structure.mjs';
import { computeCvd } from '../liquidity/derivatives.mjs';
import {
  bookImbalance, detectIceberg, detectSpoof, estimateLiqClusters, nearestLiqCluster
} from '../liquidity/orderbook.mjs';
import { scoreZones, DEFAULT_WEIGHTS } from '../liquidity/score.mjs';
import { matchZones, adaptCalibration, latestCalibration, DEFAULT_CALIBRATION } from '../liquidity/calibrate.mjs';
import { planAppends, buildSnapshot, toCandles } from '../liquidity/engine.mjs';

const candle = (time, open, high, low, close) => ({ time, open, high, low, close });

test('findPivots: قمة سوينغ بين قيمتين أقل — حتمية', () => {
  const cs = [10, 11, 12, 11, 10].map((p, i) => candle(i, p, p, p, p));
  const pivots = findPivots(cs, 1);
  assert.equal(pivots.length, 1);
  assert.equal(pivots[0].index, 2);
  assert.equal(pivots[0].kind, 'high');
  assert.equal(pivots[0].price, 12);
});

test('findPivots: قاع سوينغ بين قيمتين أعلى', () => {
  const cs = [12, 11, 10, 11, 12].map((p, i) => candle(i, p, p, p, p));
  const pivots = findPivots(cs, 1);
  assert.equal(pivots.length, 1);
  assert.equal(pivots[0].kind, 'low');
  assert.equal(pivots[0].price, 10);
});

test('clusterEquals: قمتان متساويان ضمن 0.2% → عنقود بنقطتين', () => {
  const pivots = [
    { kind: 'high', price: 100.0, index: 0 },
    { kind: 'high', price: 100.15, index: 5 },
    { kind: 'low', price: 90.0, index: 3 }
  ];
  const clusters = clusterEquals(pivots, 0.002);
  const eqh = clusters.find(c => c.kind === 'high');
  assert.equal(eqh.count, 2);
  const ssl = clusters.find(c => c.kind === 'low');
  assert.equal(ssl.count, 1);
});

test('clusterEquals: قمم بعيدة لا تتجمّع', () => {
  const pivots = [
    { kind: 'high', price: 100.0, index: 0 },
    { kind: 'high', price: 101.0, index: 5 }
  ];
  const clusters = clusterEquals(pivots, 0.002);
  assert.equal(clusters.length, 2);
});

test('detectSweeps: ذيل يخترق القمة ويغلق تحتها → سحب BSL', () => {
  const cs = [
    candle(0, 10, 10, 10, 10),
    candle(1, 11, 11, 11, 11),
    candle(2, 12, 12, 12, 12), // pivot high 12 (strength 1)
    candle(3, 11, 11, 11, 11),
    candle(4, 11.5, 12.1, 11.5, 11.9) // ذيل فوق 12 وإغلاق تحته
  ];
  const pivots = findPivots(cs, 1);
  const sweeps = detectSweeps(cs, pivots, { strength: 1 });
  assert.equal(sweeps.length, 1);
  assert.equal(sweeps[0].kind, 'BSL');
  assert.equal(sweeps[0].level, 12);
});

test('detectSweeps: إغلاق فوق المستوى = قبول اختراق لا سحب', () => {
  const cs = [
    candle(0, 10, 10, 10, 10),
    candle(1, 11, 11, 11, 11),
    candle(2, 12, 12, 12, 12),
    candle(3, 11, 11, 11, 11),
    candle(4, 12.05, 12.3, 12.0, 12.2) // إغلاق فوق المستوى
  ];
  const pivots = findPivots(cs, 1);
  const sweeps = detectSweeps(cs, pivots, { strength: 1 });
  assert.equal(sweeps.length, 0);
});

test('detectFVGs: فجوة صاعدة ثلاثية الشموع', () => {
  const cs = [
    candle(0, 10, 10, 9, 10),
    candle(1, 10.4, 10.6, 10.2, 10.5),
    candle(2, 10.8, 11, 10.7, 10.9) // low 10.7 > high 10 → فجوة
  ];
  const fvgs = detectFVGs(cs);
  assert.equal(fvgs.length, 1);
  assert.equal(fvgs[0].dir, 'bull');
  assert.equal(fvgs[0].bottom, 10);
  assert.equal(fvgs[0].top, 10.7);
});

test('computeCvd: دلتا = 2×takerBuy − الحجم (حتمية)', () => {
  const k = (vol, takerBuy) => ['0', '1', '1', '1', '1', String(vol), '0', '0', '0', String(takerBuy)];
  const r = computeCvd([k(100, 70), k(100, 40)], 50);
  assert.equal(r.recentSum, 40 + (-20));
  assert.equal(r.window, 2);
});

test('bookImbalance: أثقال الشراء → نسبة > 1', () => {
  const r = bookImbalance([[99.7, 10]], [[100.3, 5]]);
  assert.equal(r, 2);
});

test('detectIceberg: مستوى ضُرب 5 مرات بأحجام متقاربة', () => {
  const trades = Array.from({ length: 5 }, (_, i) => ({ price: 100 + i * 1e-7, qty: 1 }));
  const out = detectIceberg(trades, { minHits: 4 });
  assert.equal(out.length, 1);
  assert.equal(out[0].hits, 5);
  assert.ok(out[0].sizeConsistency > 0.9);
});

test('detectSpoof: مستوى كبير اختفى دون تنفيذ', () => {
  const prev = [[100, 100], [99, 1], [98, 1]];
  const next = [[99, 1], [98, 1], [100.5, 1]];
  const out = detectSpoof(prev, next, () => 0, { minQtyRatio: 2 });
  assert.equal(out.length, 1);
  assert.equal(out[0].price, 100);
  assert.equal(out[0].qty, 100);
});

test('detectSpoof: مستوى اختفى لكن نُفذ عند سعره → ليس Spoof', () => {
  const prev = [[100, 100], [99, 1], [98, 1]];
  const next = [[99, 1], [98, 1]];
  const out = detectSpoof(prev, next, (p) => (p === 100 ? 90 : 0), { minQtyRatio: 2 });
  assert.equal(out.length, 0);
});

test('estimateLiqClusters: عناقيد على جانبي السعر بأوزان الرافعات', () => {
  const clusters = estimateLiqClusters(100, 1_000_000, 0);
  assert.equal(clusters.length, 8);
  const long10 = clusters.find(c => c.side === 'long' && c.lev === 10);
  assert.equal(Math.round(long10.price * 100) / 100, 90.5);
  // تمويل موجب → وزن الطويلين أثقل
  const shifted = estimateLiqClusters(100, 1_000_000, 0.0005);
  const longShifted = shifted.find(c => c.side === 'long' && c.lev === 10);
  assert.ok(longShifted.magnitude > long10.magnitude);
});

test('nearestLiqCluster: أقرب عنقود ضمن المسافة فقط', () => {
  const clusters = estimateLiqClusters(100, 1_000_000, 0);
  assert.ok(nearestLiqCluster(90.6, clusters));
  assert.equal(nearestLiqCluster(95, clusters, 0.001), null);
});

test('scoreZones: EQH + سحب + رقم مستدير → درجة فوق العتبة مع أسباب', () => {
  const candidates = [{
    type: 'BSL', price: 100, anchorTime: 5, clusterCount: 2, swept: true, sweptAt: 6, fvgNear: false
  }];
  const zones = scoreZones(candidates, {}, { refLevels: { high: 100.2, low: 90 } });
  assert.equal(zones.length, 1);
  assert.equal(zones[0].score, DEFAULT_WEIGHTS.pivotBase + DEFAULT_WEIGHTS.clusterEach + DEFAULT_WEIGHTS.sweptBonus + DEFAULT_WEIGHTS.roundBonus + DEFAULT_WEIGHTS.refLevelBonus);
  assert.ok(zones[0].reasons.some(r => r.includes('EQH')));
  assert.ok(zones[0].reasons.some(r => r.includes('سحب')));
});

test('scoreZones: حد الدني يفلتر الضعيف', () => {
  const zones = scoreZones(
    [{ type: 'SSL', price: 97.3, anchorTime: 1, clusterCount: 1, swept: false, sweptAt: null, fvgNear: false }],
    {}, { minScore: 95, refLevels: { high: 110, low: 90 } }
  );
  assert.equal(zones.length, 0);
});

test('isRoundNumber: 100 صحيح و101.5 خطأ', () => {
  assert.ok(isRoundNumber(100));
  assert.ok(isRoundNumber(0.001));
  assert.ok(!isRoundNumber(101.5));
});

test('matchZones: مطابقة آلي↔يدوي ضمن التسامح', () => {
  const manual = [{ type: 'BSL', price: 100 }];
  const auto = [{ type: 'BSL', price: 100.2 }, { type: 'SSL', price: 95 }];
  const r = matchZones(manual, auto);
  assert.equal(r.matchedManual, 1);
  assert.equal(r.matchedAuto, 1);
  assert.equal(r.recall, 1);
  assert.equal(r.precision, 0.5);
});

test('adaptCalibration: دقة منخفضة → رفع الحد، تغطية منخفضة → خفضه', () => {
  const cal = { ...DEFAULT_CALIBRATION, minScore: 50 };
  const up = adaptCalibration(cal, { precision: 0.3, recall: 0.9 });
  assert.equal(up.minScore, 55);
  const down = adaptCalibration(cal, { precision: 0.9, recall: 0.4 });
  assert.equal(down.minScore, 45);
  const capped = adaptCalibration({ ...cal, minScore: 80 }, { precision: 0.1, recall: 1 });
  assert.equal(capped.minScore, 80);
});

test('latestCalibration: الأحدث يفوز والتالف يُتجاهل', () => {
  const evs = [
    { meta: '{\"minScore\":40}' },
    { meta: 'not-json' },
    { meta: '{\"minScore\":60}' }
  ];
  assert.equal(latestCalibration(evs).minScore, 40);
  assert.equal(latestCalibration([]).minScore, DEFAULT_CALIBRATION.minScore);
});

test('buildSnapshot: جديد / نقل feedback / استبعاد المرفوض', () => {
  const now = Date.now();
  const zone = (score, price = 100, type = 'BSL') => ({
    type, price, score, anchorTime: 5, clusterCount: 2, swept: false, sweptAt: null, reasons: ['x'], bandPct: 0.002
  });

  // جديد — anchorTime يجب أن يُنقل للقطة (تثبيت العلامة على شمعة الاكتشاف)
  let snap = buildSnapshot({ symbol: 'BTCUSDT', perTf: { '5m': [zone(60)] }, existingAuto: [], now });
  assert.equal(snap.symbol, 'BTCUSDT');
  assert.equal(snap.zones.length, 1);
  assert.ok(snap.zones[0].id.startsWith('auto-BTCUSDT-5m-BSL'));
  assert.equal(snap.zones[0].source, 'auto');
  assert.equal(snap.zones[0].anchorTime, 5);
  assert.ok(snap.zones[0].bandPct > 0);

  // نقل feedback: نفس المنطقة بدرجة أعلى تحتفظ بالتأكيد
  const existing = [{
    id: 'auto-1', symbol: 'BTCUSDT', type: 'BSL', price: 100, timeframe: '5m',
    score: 50, reasons: [], swept: false, active: true, source: 'auto', feedback: 'confirm'
  }];
  snap = buildSnapshot({ symbol: 'BTCUSDT', perTf: { '5m': [zone(60)] }, existingAuto: existing, now });
  assert.equal(snap.zones.length, 1);
  assert.equal(snap.zones[0].id, 'auto-1');
  assert.equal(snap.zones[0].feedback, 'confirm');
  assert.equal(snap.zones[0].score, 60);

  // استبعاد المرفوض
  const rejected = [{ ...existing[0], feedback: 'reject' }];
  snap = buildSnapshot({ symbol: 'BTCUSDT', perTf: { '5m': [zone(60)] }, existingAuto: rejected, now });
  assert.equal(snap.zones.length, 0);
});

test('candidateZones: العنقود الواحد → منطقة واحدة لا تكرار', () => {
  // 3 قمم متساوية عند 12 → منطقة BSL واحدة بclusterCount 3
  const zig = [10, 11, 12, 11, 10, 11, 12.01, 11, 10, 11, 12.02, 11, 10.5];
  const cs = zig.map((p, i) => candle(i * 60000, p, p, p, p));
  const out = candidateZones(cs, { strength: 1, pivotsLimit: 10 });
  const bsl = out.zones.filter(z => z.type === 'BSL');
  assert.equal(bsl.length, 1);
  assert.equal(bsl[0].clusterCount, 3);
});

test('toCandles: تحويل خام بينانس إلى شموع', () => {
  const raw = [[1700000000000, '1', '2', '0.5', '1.5']];
  const cs = toCandles(raw);
  assert.equal(cs[0].time, 1700000000);
  assert.equal(cs[0].high, 2);
  assert.equal(cs[0].low, 0.5);
});

test('candidateZones: تكامل الهيكل على متسلسلة اصطناعية', () => {
  // متسلسلة متعرجة بقمتين متساويتين عند 12
  const zig = [10, 11, 12, 11, 10, 11, 12.02, 11, 10, 11, 12.1, 11, 10.5];
  const cs = zig.map((p, i) => candle(i * 60000, p, p, p, p));
  const out = candidateZones(cs, { strength: 1, pivotsLimit: 10 });
  assert.ok(out.zones.length >= 2);
  const bsl = out.zones.filter(z => z.type === 'BSL');
  assert.ok(bsl.some(z => z.clusterCount >= 2));
  assert.ok(out.pivots.length >= 3);
  assert.ok(Array.isArray(out.sweeps));
});

test('pivotStrengthFor: فريمات غير معروفة → 3', () => {
  assert.equal(pivotStrengthFor('5m'), 3);
  assert.equal(pivotStrengthFor('4h'), 5);
  assert.equal(pivotStrengthFor('9x'), 3);
});

test('referenceLevels: أعلى وأدنى النافذة الأخيرة', () => {
  const cs = [candle(0, 1, 5, 1, 2), candle(1, 2, 10, 0.5, 3), candle(2, 3, 4, 2, 3)];
  const r = referenceLevels(cs);
  assert.equal(r.high, 10);
  assert.equal(r.low, 0.5);
});

test('atr14 + bandPctFor: المتقلب عرضه أوسع، والحدود محترمة', () => {
  const flat = Array.from({ length: 30 }, (_, i) => candle(i, 100, 100.1, 99.9, 100));
  const wild = Array.from({ length: 30 }, (_, i) => candle(i, 100, 104, 96, 100));
  const bandFlat = bandPctFor(flat, 100);
  const bandWild = bandPctFor(wild, 100);
  assert.ok(bandWild > bandFlat * 5);
  assert.ok(bandFlat >= 0.0005 && bandFlat <= 0.012);
  assert.ok(bandWild >= 0.0005 && bandWild <= 0.012);
  // بيانات غير كافية → الاحتياط 0.15%
  assert.equal(bandPctFor(flat.slice(0, 5), 100), 0.0015);
  // candidateZones يعيّن bandPct لكل منطقة
  const zig = [10, 11, 12, 11, 10, 11, 12.01, 11, 10, 11, 12.02, 11, 10.5];
  const cs = zig.map((p, i) => candle(i * 60000, p, p, p, p));
  const out = candidateZones(cs, { strength: 1, pivotsLimit: 10 });
  for (const z of out.zones) assert.ok(z.bandPct > 0 && z.bandPct <= 0.012);
});
