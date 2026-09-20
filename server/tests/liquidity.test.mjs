import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  findPivots, clusterEquals, detectSweeps, detectFVGs, candidateZones,
  isRoundNumber, referenceLevels, pivotStrengthFor, atr14, bandPctFor
} from '../liquidity/structure.mjs';
import { computeCvd } from '../liquidity/derivatives.mjs';
import {
  bookImbalance, detectIceberg, detectSpoof, estimateLiqClusters, nearestLiqCluster, detectBubbles
} from '../liquidity/orderbook.mjs';
import { scoreZones, DEFAULT_WEIGHTS } from '../liquidity/score.mjs';
import { computeVolumeProfile, classifyLocation } from '../liquidity/volumeProfile.mjs';
import { sessionFactor, SESSION_WINDOWS } from '../liquidity/session.mjs';
import { matchZones, adaptCalibration, latestCalibration, DEFAULT_CALIBRATION } from '../liquidity/calibrate.mjs';
import { planAppends, buildSnapshot, applyFeedback, toCandles } from '../liquidity/engine.mjs';

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

test('scoreZones: EQH + رقم مستدير → درجة فوق العتبة مع أسباب — السحب لا يضخم', () => {
  const candidates = [{
    type: 'BSL', price: 100, anchorTime: 5, clusterCount: 2, swept: true, sweptAt: 6, fvgNear: false
  }];
  const zones = scoreZones(candidates, {}, { refLevels: { high: 100.2, low: 90 } });
  assert.equal(zones.length, 1);
  assert.equal(zones[0].score, DEFAULT_WEIGHTS.pivotBase + DEFAULT_WEIGHTS.clusterEach + DEFAULT_WEIGHTS.roundBonus + DEFAULT_WEIGHTS.refLevelBonus);
  assert.ok(zones[0].reasons.some(r => r.includes('EQH')));
  assert.ok(!zones[0].reasons.some(r => r.includes('سحب')));
  assert.equal(zones[0].meta, 'structural');
});

test('scoreZones: حد الدني يفلتر الضعيف', () => {
  const zones = scoreZones(
    [{ type: 'SSL', price: 97.3, anchorTime: 1, clusterCount: 1, swept: false, sweptAt: null, fvgNear: false }],
    {}, { minScore: 95, refLevels: { high: 110, low: 90 } }
  );
  assert.equal(zones.length, 0);
});

test('scoreZones: ينقل bandPct (عرض الفجوة الحقيقي ATR) — لا سقوط في buildSnapshot', () => {
  const zones = scoreZones(
    [{ type: 'BSL', price: 100, anchorTime: 2, clusterCount: 2, swept: false, sweptAt: null, fvgNear: false, bandPct: 0.0045 }],
    {}, { refLevels: { high: 100.2, low: 90 } }
  );
  assert.equal(zones.length, 1);
  assert.equal(zones[0].bandPct, 0.0045);
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

  // نقل الملاحظة مع اللقطة الجديدة
  const noted = [{ ...existing[0], note: 'سيولة قوية' }];
  snap = buildSnapshot({ symbol: 'BTCUSDT', perTf: { '5m': [zone(60)] }, existingAuto: noted, now });
  assert.equal(snap.zones[0].note, 'سيولة قوية');
});

test('applyFeedback: دمج مستقل لكل حقل — الأحدث يفوز', () => {
  const zones = [
    { id: 'z1', type: 'BSL', price: 100, timeframe: '5m', note: '', feedback: null },
    { id: 'z2', type: 'SSL', price: 90, timeframe: '5m', note: '', feedback: null },
    { id: 'z3', type: 'BSL', price: 110, timeframe: '15m', note: 'قديمة', feedback: null }
  ];

  // تأكيد + ملاحظة في حدث واحد
  let out = applyFeedback(zones, [
    { zoneId: 'z1', verdict: 'confirm', note: 'عنقود قمم متساوية' }
  ]);
  assert.equal(out[0].feedback, 'confirm');
  assert.equal(out[0].note, 'عنقود قمم متساوية');
  assert.equal(out[1].feedback, null); // بلا أحداث — لا تغيير

  // ملاحظة فقط لا تلمس verdict، وverdict لا يطمس الملاحظة (دمج مستقل)
  out = applyFeedback(zones, [
    { zoneId: 'z2', verdict: 'confirm' },
    { zoneId: 'z2', note: 'راقب السحب' }
  ]);
  assert.equal(out[1].feedback, 'confirm');
  assert.equal(out[1].note, 'راقب السحب');

  // الأحدث يفوز: رفض بعد تأكيد، ثم استعادة (clear) → null
  out = applyFeedback(zones, [
    { zoneId: 'z3', verdict: 'confirm' },
    { zoneId: 'z3', verdict: 'reject' }
  ]);
  assert.equal(out[2].feedback, 'reject');
  assert.equal(out[2].note, 'قديمة'); // الملاحظة الأصلية باقية
  out = applyFeedback(zones, [
    { zoneId: 'z3', verdict: 'reject' },
    { zoneId: 'z3', verdict: 'clear' }
  ]);
  assert.equal(out[2].feedback, null);

  // تفريغ الملاحظة صراحة ('') بينما verdict باقٍ
  out = applyFeedback(zones, [
    { zoneId: 'z1', verdict: 'confirm', note: 'مؤقتة' },
    { zoneId: 'z1', note: '' }
  ]);
  assert.equal(out[0].feedback, 'confirm');
  assert.equal(out[0].note, '');

  // أحداث JSON نصية (كما تخرج من events_log) + تالفة تُتجاهل
  out = applyFeedback(zones, [
    JSON.stringify({ zoneId: 'z1', verdict: 'reject' }),
    '{تالف'
  ]);
  assert.equal(out[0].feedback, 'reject');
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

/* ---- منطق المزاد (فابيو): الملف الحجمي + الموقع + الفقاعات + الجلسة ---- */

const candleV = (time, open, high, low, close, volume) => ({ time, open, high, low, close, volume });

test('computeVolumeProfile: جرس أحجام → POC عند الذروة وVAH/VAL تحيطان به', () => {
  const vols = [100, 200, 300, 400, 500, 500, 400, 300, 200, 100];
  const cs = vols.map((v, i) => candleV(i * 60000, 91 + i * 2, 92 + i * 2, 90 + i * 2, 91 + i * 2, v));
  const p = computeVolumeProfile(cs, 10);
  assert.equal(p.poc, 99); // مركز الحجة 4
  assert.ok(p.val <= p.poc && p.poc <= p.vah);
  assert.ok(p.vah - p.val >= 0.5 * (p.priceMax - p.priceMin));
  // الذروة النسبية للحجة عند 91 (بين 500) ليست POC الثانوي المطلوب هنا — الذروة عند 99
  assert.equal(p.profile[4], 500);
});

test('classifyLocation: داخل نطاق القيمة توازن وفوقه عدم توازن صعوداً', () => {
  const p = { poc: 105, vah: 110, val: 100, lvnZones: [], binHeight: 1, priceMin: 100, priceMax: 120, totalVolume: 1000, profile: [] };
  const inside = Array.from({ length: 30 }, (_, i) => candleV(i, 100, 100.5, 99.5, 100, 10));
  inside.push(candleV(30, 105, 105.5, 104.5, 105, 10));
  assert.equal(classifyLocation(inside, p).state, 'balance');
  const outside = [...inside, candleV(31, 110, 113, 109.8, 112.5, 10)];
  const loc = classifyLocation(outside, p);
  assert.equal(loc.state, 'imbalance_up');
  assert.ok(loc.confidence > 0);
});

test('detectBubbles: طبقة صفقة فردية ضخمة من أعلى شريحة الدفعة — بالاتجاهين', () => {
  const buyTrades = Array.from({ length: 100 }, () => ({ price: 100, qty: 1, isBuyerMaker: false }));
  buyTrades.push({ price: 100, qty: 100, isBuyerMaker: false });
  const bubbles = detectBubbles(buyTrades);
  assert.equal(bubbles.length, 1);
  assert.equal(bubbles[0].type, 'aggressive_buy');
  assert.equal(bubbles[0].notional, 10000);
  const sellTrades = Array.from({ length: 100 }, () => ({ price: 100, qty: 1, isBuyerMaker: true }));
  sellTrades.push({ price: 100, qty: 100, isBuyerMaker: true });
  assert.equal(detectBubbles(sellTrades)[0].type, 'aggressive_sell');
  assert.deepEqual(detectBubbles([{ price: 100, qty: 1 }]), []);
});

test('candidateZones: في التوازن حواف القيمة بركاً معلقة — لا عقد استمرار', () => {
  const profile = { poc: 105, vah: 110, val: 100, lvnZones: [{ price: 115, volume: 1, index: 5 }], binHeight: 1, priceMin: 100, priceMax: 120, totalVolume: 1000, profile: [] };
  const cs = Array.from({ length: 40 }, (_, i) => candleV(i * 60000, 100, 100.5, 99.5, 100, 10));
  cs.push(candleV(40 * 60000, 105, 105.5, 104.5, 105, 10));
  const out = candidateZones(cs, { strength: 1, pivotsLimit: 10, profile, location: { state: 'balance' } });
  assert.ok(out.zones.some(z => z.meta === 'profile_edge' && z.side === 'high' && z.type === 'BSL'));
  assert.ok(out.zones.some(z => z.meta === 'profile_edge' && z.side === 'low' && z.type === 'SSL'));
  assert.ok(!out.zones.some(z => z.meta === 'profile_lvn'));
  for (const z of out.zones) assert.ok(z.bandPct > 0);
});

test('candidateZones: خارج التوازن صعوداً — إعادة اختبار الحافة + عقدة استمرار فوق المسار', () => {
  const profile = { poc: 105, vah: 110, val: 100, lvnZones: [{ price: 115, volume: 1, index: 5 }], binHeight: 1, priceMin: 100, priceMax: 120, totalVolume: 1000, profile: [] };
  const cs = Array.from({ length: 40 }, (_, i) => candleV(i * 60000, 100, 100.5, 99.5, 100, 10));
  cs.push(candleV(40 * 60000, 112, 112.5, 111.5, 112, 10));
  const out = candidateZones(cs, { strength: 1, pivotsLimit: 10, profile, location: { state: 'imbalance_up' } });
  const retest = out.zones.find(z => z.meta === 'profile_edge_retest');
  assert.ok(retest && retest.type === 'SSL' && retest.price === 110);
  const lvn = out.zones.find(z => z.meta === 'profile_lvn');
  assert.ok(lvn && lvn.type === 'BSL' && lvn.price === 115);
  assert.ok(!out.zones.some(z => z.meta === 'profile_edge'));
});

test('candidateZones: قمة/قاع اليوم السابق — والجانب المكسور يُتجاهل', () => {
  const cs = Array.from({ length: 30 }, (_, i) => candleV(i * 60000, 100, 100.5, 99.5, 100, 10));
  cs.push(candleV(30 * 60000, 105, 105.5, 104.5, 105, 10));
  let out = candidateZones(cs, { strength: 1, pivotsLimit: 10, prevDayLevels: { high: 120, low: 92 } });
  const high = out.zones.find(z => z.meta === 'prev_day' && z.side === 'high');
  const low = out.zones.find(z => z.meta === 'prev_day' && z.side === 'low');
  assert.ok(high && high.type === 'BSL' && high.price === 120);
  assert.ok(low && low.type === 'SSL' && low.price === 92);
  // القمة المكسورة (تحت السعر) ليست سيولة معلقة
  out = candidateZones(cs, { strength: 1, pivotsLimit: 10, prevDayLevels: { high: 100.2, low: 92 } });
  assert.ok(!out.zones.some(z => z.meta === 'prev_day' && z.side === 'high'));
});

test('sessionFactor: الفئات الثلاث على الأوقات الحدية (UTC)', () => {
  assert.equal(sessionFactor(Date.UTC(2026, 8, 20, 13, 30)).tier, 'prime');
  assert.equal(sessionFactor(Date.UTC(2026, 8, 20, 11, 59)).tier, 'normal');
  assert.equal(sessionFactor(Date.UTC(2026, 8, 20, 12, 0)).tier, 'prime');
  assert.equal(sessionFactor(Date.UTC(2026, 8, 20, 16, 59)).tier, 'prime');
  assert.equal(sessionFactor(Date.UTC(2026, 8, 20, 17, 0)).tier, 'normal');
  assert.equal(sessionFactor(Date.UTC(2026, 8, 20, 21, 0)).tier, 'prime');
  assert.equal(sessionFactor(Date.UTC(2026, 8, 20, 23, 0)).tier, 'normal');
  assert.equal(sessionFactor(Date.UTC(2026, 8, 20, 3, 0)).tier, 'lull');
  assert.equal(sessionFactor(Date.UTC(2026, 8, 20, 1, 0)).tier, 'lull');
  assert.equal(sessionFactor(Date.UTC(2026, 8, 20, 5, 59)).tier, 'lull');
  assert.equal(sessionFactor(Date.UTC(2026, 8, 20, 6, 0)).tier, 'normal');
  assert.ok(SESSION_WINDOWS.prime.length >= 1);
});

test('scoreZones: منطقة المزاد — عقدة استمرار + موقع + زناد عدواني + جلسة ندرة', () => {
  const cand = { type: 'BSL', price: 115, anchorTime: 5, clusterCount: 1, swept: false, sweptAt: null, fvgNear: false, meta: 'profile_lvn', side: 'high' };
  const zones = scoreZones([cand], {
    bubbles: [{ type: 'aggressive_buy', price: 113, qty: 20, notional: 250000 }],
    session: { tier: 'prime' },
    location: { state: 'imbalance_up', confidence: 40 }
  }, { refLevels: { high: 130, low: 90 } });
  assert.equal(zones.length, 1);
  assert.equal(zones[0].score, DEFAULT_WEIGHTS.pivotBase + DEFAULT_WEIGHTS.profileLvnWeight + DEFAULT_WEIGHTS.locationWeight + DEFAULT_WEIGHTS.bubbleWeight + DEFAULT_WEIGHTS.sessionBonus);
  assert.ok(zones[0].reasons.some(r => r.includes('عقدة حجم منخفض')));
  assert.ok(zones[0].reasons.some(r => r.includes('فقاعة شراء')));
  assert.ok(zones[0].reasons.some(r => r.includes('عدم التوازن')));
  assert.ok(zones[0].reasons.some(r => r.includes('ندرة حادة')));
  assert.equal(zones[0].meta, 'profile_lvn');
});

test('scoreZones: حافة منطقة القيمة + قاع اليوم السابق + فتكة سيولة تخصم', () => {
  const edge = { type: 'SSL', price: 100.5, anchorTime: 5, clusterCount: 1, swept: false, sweptAt: null, fvgNear: false, meta: 'profile_edge', side: 'low' };
  const zones = scoreZones([edge], { session: { tier: 'lull' } }, { refLevels: { high: 110, low: 90 }, minScore: 40 });
  assert.equal(zones.length, 1);
  assert.equal(zones[0].score, DEFAULT_WEIGHTS.pivotBase + DEFAULT_WEIGHTS.profileEdgeWeight - DEFAULT_WEIGHTS.sessionPenalty);
  assert.ok(zones[0].reasons.some(r => r.includes('VAL')));
  assert.ok(zones[0].reasons.some(r => r.includes('فتكة سيولة')));
});
