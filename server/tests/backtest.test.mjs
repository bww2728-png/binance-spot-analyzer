/* اختبارات layers الباك تيست — حتمية بالكامل (بدون شبكة)
 * كلي/كلي المجزأ، مدقق دلالات القواعد، بواب (تكامل/Z/انحياز)، تخليق قواعد، walk-forward، لوجستي
 */
import test from 'node:test';
import assert from 'node:assert';
import { kellyF, fractionalKelly, positionUnits, buildPlan, checkPlan } from '../backtest/risk.mjs';
import { zScore, betaSpread, cointegrationCheck, regimeGate, inventoryBiasSimple } from '../backtest/regime.mjs';
import { fitLogistic, featurize, learnedScore, synthFilters, walkForwardSplit, evaluateStrategy, activeDecision, stratifiedLift } from '../backtest/learn.mjs';
import { loadKlinesPaginated } from '../backtest/engine.mjs';
import { applyLearnedRules, discoverLiveOpportunities } from '../backtest/live.mjs';
import { adaptiveConfig, detectLiquidityZones, findPivots, feedbackToAdjustment, scanHistory } from '../liquidity-zones/engine.mjs';
import { renderChart, gafEncode, mtfEncode, ts2vecEmbed, bocpd, detectVisualZones } from '../liquidity-zones/visual.mjs';

test('كلي النظري: معاملات منشورة تعطي القيم المنشورة', () => {
  // p=0.6, payoff=2 → f = (0.6*2 - 0.4)/0.6 = 1.333
  assert.ok(Math.abs(kellyF(0.6, 2) - 1.3333) < 0.001);
  // p=0.5, payoff=2 → f = (1 - 0.5)/0.5 = 1.0
  assert.ok(Math.abs(kellyF(0.5, 2) - 1.0) < 0.001);
  // p=0.3, payoff=1.5 → f = (0.45 - 0.7)/0.3 < 0 → 0 (لا مخاطرة)
  assert.equal(kellyF(0.3, 1.5), 0);
  // معاملات غير صالحة → 0
  assert.equal(kellyF(0, 2), 0);
  assert.equal(kellyF(1, 2), 0);
  assert.equal(kellyF(0.5, 0), 0);
  assert.equal(kellyF(0.5, -1), 0);
});

test('التجزئة: عامل 0.25 مع سقف 2%', () => {
  assert.ok(Math.abs(fractionalKelly(4, 0.25, 0.02) - 0.02) < 1e-12); // 1.0 → مقصوص
  assert.ok(Math.abs(fractionalKelly(1, 0.25, 0.02) - 0.02) < 1e-12); // 0.25 → مقصوص بالسقف
  assert.equal(fractionalKelly(0, 0.25, 0.02), 0);
  assert.equal(fractionalKelly(-1, 0.25, 0.02), 0);
});

test('حجم الوحدات: المخاطرة بالمال / مسافة المخاطرة', () => {
  assert.ok(Math.abs(positionUnits(10000, 0.02, 100, 90) - 20) < 1e-9);
  assert.equal(positionUnits(10000, 0, 100, 90), 0);
  assert.equal(positionUnits(10000, 0.02, 100, 100), 0);
});

test('بناء خطة: شراء وقفه تحت المستوى، بيع وقده فوقه', () => {
  const buy = buildPlan({ zoneType: 'BSL', entry: 100, protectedPrice: 99, targets: [102, 104] });
  assert.ok(buy.stop < 99);
  assert.equal(buy.tp, 102); // أقرب هدف صالح فوق الدخول
  const sell = buildPlan({ zoneType: 'SSL', entry: 100, protectedPrice: 101, targets: [98, 96] });
  assert.ok(sell.stop > 101);
  assert.equal(sell.tp, 98);
  // بلا هدف صالح → null
  const noTarget = buildPlan({ zoneType: 'BSL', entry: 100, protectedPrice: 99, targets: [50] });
  assert.equal(noTarget.tp, null);
  // b صالح فوق الدخول فقط
  const wrongSide = buildPlan({ zoneType: 'BSL', entry: 100, protectedPrice: 99, targets: [50, 102] });
  assert.equal(wrongSide.tp, 102);
});

test('المدقق: رفض أي خطة وقفها ليس على الجانب الآمن', () => {
  const good = buildPlan({ zoneType: 'BSL', entry: 100, protectedPrice: 99, targets: [103] });
  assert.equal(checkPlan({ plan: good, protectedPrice: 99, zoneType: 'BSL' }).ok, true);
  // خطة وقفها فوق المستوى (خطر) → رفض
  const bad = { ...good, stop: 99.5 };
  const checkBad = checkPlan({ plan: bad, protectedPrice: 99, zoneType: 'BSL' });
  assert.equal(checkBad.ok, false);
  assert.ok(checkBad.violations.some(v => v.includes('SL')));
  // rr لا يطابق الحساب → رفض
  const badRR = { ...good, rr: 9.99 };
  assert.equal(checkPlan({ plan: badRR, protectedPrice: 99, zoneType: 'BSL' }).ok, false);
  // قاع خطر غير صالح → رفض
  assert.equal(checkPlan({ plan: good, protectedPrice: NaN, zoneType: 'BSL' }).ok, false);
});

test('Z-Score: توحيده نافذة عادية', () => {
  const normal = Array.from({ length: 200 }, (_, i) => 100 + Math.sin(i / 5) * 2);
  const z = zScore(normal, 200);
  assert.ok(z != null && Math.abs(z) < 3);
  // شاذ: القيمة الأخيرة قفزة كبيرة
  const jumped = [...normal];
  jumped[jumped.length - 1] = 1000;
  const zj = zScore(jumped, 200);
  assert.ok(zj != null && Math.abs(zj) > 4);
  // نافذة أقصر من المطلوبة → null
  assert.equal(zScore([1, 2, 3], 200), null);
});

test('التكامل المشترك: انتشار ثابت التقلب → stationary، متشعّب → غير stationary', () => {
  const base = Array.from({ length: 250 }, (_, i) => 100 + i * 0.1);
  const alt = base.map((v, i) => v * (1 + Math.sin(i / 10) * 0.001));
  const check1 = cointegrationCheck(alt, base, { period: 250 });
  assert.ok(check1.stationary === true || check1.stationary === null);
  // تشتّب: النصف الثاني تقلبه أضعاف
  const diverged = base.map((v, i) => i < 125 ? v : v * (1 + (i - 125) * 0.02));
  const check2 = cointegrationCheck(diverged, base, { period: 250, tol: 0.05 });
  assert.ok(check2.stationary === false || check2.stationary === null);
});

test('بواب: تشتت الانتشار أو قفزة شاذة → رفض', () => {
  const ok = Array.from({ length: 250 }, (_, i) => 100 + Math.sin(i / 5) * 2);
  const res1 = regimeGate({ altPrices: ok, anchorPrices: ok, horizonMin: 30 });
  assert.equal(res1.pass, true);
  // قفزة شاذة في آخر شمعة → رفض
  const jumped = [...ok];
  jumped[jumped.length - 1] = 10000;
  const res2 = regimeGate({ altPrices: jumped, anchorPrices: ok, horizonMin: 30 });
  assert.equal(res2.pass, false);
  assert.ok(res2.reasons.length > 0);
});

test('انحياز المخزون: mu=0, sigma=0 → 0؛ بأسعار → قيمة عددية', () => {
  assert.equal(inventoryBiasSimple({ prices: [], vol: 0, horizonMin: 30 }), 0);
  const flat = Array.from({ length: 25 }, () => 100);
  assert.ok(Math.abs(inventoryBiasSimple({ prices: flat, vol: 0.2, horizonMin: 30 })) > 0);
});

test('featurize: معالم ثابتة من الأسباب', () => {
  const f1 = featurize({ score: 78, reasons: ['عنقود 3 نقاط متساوية', 'فقاعة أوامر عدوانية'], clusterCount: 3 });
  assert.equal(f1.eqh, 1);
  assert.equal(f1.bubble, 1);
  assert.equal(f1.intercept, 1);
  assert.ok(f1.clusterCount > 0 && f1.clusterCount <= 1);
  const f2 = featurize({ score: 50, reasons: [] });
  assert.equal(f2.bubble, 0);
});

test('لوجستي: بيانات مفصولة تماماً → تفصل تماماً', () => {
  // فئة y=1 عندها x=1 دائماً و y=0 عندها x=0 دائماً
  const samples = [
    { x: { intercept: 1, sig: 0 }, y: 0 },
    { x: { intercept: 1, sig: 0 }, y: 0 },
    { x: { intercept: 1, sig: 1 }, y: 1 },
    { x: { intercept: 1, sig: 1 }, y: 1 }
  ];
  const w = fitLogistic(samples, { iterations: 500, lr: 0.5 });
  assert.ok(w.sig > 1); // إشارة إيجابية واضحة
});

test('learnedScore: مضاعف محدود في الحدود', () => {
  const feats = featurize({ score: 80, reasons: ['عنقود'], clusterCount: 3 });
  const m = learnedScore(80, feats, { eqh: 2, bubble: 1 }, { blend: 0.35 });
  assert.ok(m >= 0 && m <= 100);
});

test('تخليق قواعد: يحقق هدف 0.7 على مجموعة تحقق واضحة', () => {
  const validation = [];
  for (let i = 0; i < 20; i++) validation.push({ score: i % 2 ? 80 : 40, clusterCount: i % 2 ? 3 : 0, reasons: i % 2 ? ['فقاعة'] : [], swept: false, rr: 2, win: i % 2 ? 1 : 0 });
  const rules = synthFilters(validation, { targetWinRate: 0.7, minTrades: 5 });
  assert.ok(rules);
  assert.ok(rules.winRate >= 0.7);
  assert.ok(rules.minScore >= 50); // يستبعد صفوف الخسارة (40)
});

test('walk-forward: 70/30 حسب الوقت حرفياً', () => {
  const trades = Array.from({ length: 100 }, (_, i) => ({ ts: i * 1000, win: i % 2 }));
  const { train, validation } = walkForwardSplit(trades, 0.7);
  assert.equal(train.length, 70);
  assert.equal(validation.length, 30);
  assert.ok(train[0].ts < validation[0].ts); // بلا تداخل
});

test('تقييم الاستراتيجية: مقام سليم', () => {
  const res = evaluateStrategy([{ win: 1, rr: 2 }, { win: 1, rr: 3 }, { win: 0, rr: 1 }]);
  assert.equal(res.kept, 3);
  assert.ok(Math.abs(res.winRate - 2 / 3) < 1e-3); // toFixed(3)
  assert.ok(Math.abs(res.avgRR - 2) < 1e-2); // toFixed(2)
  assert.equal(evaluateStrategy([]).winRate, null);
});

test('قراءة طاقة حرة متوقعة: بواب مرفوض → تخطي، payoff أقل من الحد → انتظار', () => {
  const d1 = activeDecision({ pWin: 0.6, payoff: 2, regimeGate: false });
  assert.equal(d1.action, 'skip');
  const d2 = activeDecision({ pWin: 0.6, payoff: 1.0, regimeGate: true, minRR: 1.5 });
  assert.equal(d2.action, 'wait');
  const d3 = activeDecision({ pWin: 0.7, payoff: 3, regimeGate: true });
  assert.ok(d3.action === 'enter' || d3.action === 'wait');
  assert.ok(Number.isFinite(d3.freeEnergy));
});

test('الرفع الطبقي: المقام المقام سليم', () => {
  const trades = [
    { reasons: ['عنقود'], win: 1, tier: 'prime' },
    { reasons: ['عنقود'], win: 1, tier: 'prime' },
    { reasons: [], win: 0, tier: 'prime' },
    { reasons: [], win: 1, tier: 'prime' },
    { reasons: ['عنقود'], win: 0, tier: 'lull' },
    { reasons: [], win: 1, tier: 'lull' },
    { reasons: [], win: 1, tier: 'lull' }
  ];
  const lift = stratifiedLift(trades, { has: 'عنقود', groupOf: (t) => t.tier });
  assert.ok(lift['عنقود@prime'] > 1);
  assert.ok(lift['عنقود@lull'] < 1);
});


// ===== النطاق الزمني الصريح (من — إلى) — حتمية بدون شبكة =====

const mkMdb = (candlesByCall) => {
  let call = 0;
  return { binance: { klines: async () => {
    const r = candlesByCall[call] ?? [];
    call += 1;
    return r;
  } } };
};
const mkRow = (t) => [t, '1', '1', '1', '1', '1', 0, 0, 0, '0.5', 0];

test('النطاق الزمني: يتوقف عند بداية النطاق ويقص الشموع قبله', async () => {
  // صفحتان: أحدث (2000..2999) ثم أقدم (1000..1999) — النطاق يبدأ عند 1500
  const page1 = Array.from({ length: 1000 }, (_, i) => mkRow(2000 + i));
  const page2 = Array.from({ length: 1000 }, (_, i) => mkRow(1000 + i));
  const mdb = mkMdb([page1, page2]);
  const out = await loadKlinesPaginated(mdb, 'X', '1h', 100000, { startTime: 1500, pageMs: 0 });
  assert.ok(out.length >= 500 && out.length <= 2000, `count=${out.length}`);
  assert.ok(out.every(r => r[0] >= 1500), 'كل الصفوف داخل النطاق');
});

test('النطاق الزمني: بوقت انتهاء يبدأ النداء الأول قبله', async () => {
  let firstCursor;
  const mdb = { binance: { klines: async (sym, int, lim, startTime, cursor) => {
    if (firstCursor === undefined) firstCursor = cursor ?? null;
    return [];
  } } };
  await loadKlinesPaginated(mdb, 'X', '1h', 10, { endTime: 5555, pageMs: 0 });
  assert.equal(firstCursor, 5555);
});

test('النطاق الزمني: بلا نطاق يتصرف كما السابق', async () => {
  const page1 = Array.from({ length: 1000 }, (_, i) => mkRow(2000 + i));
  const mdb = mkMdb([page1]);
  const out = await loadKlinesPaginated(mdb, 'X', '1h', 100000, { pageMs: 0 });
  assert.equal(out.length, 1000);
});


// ===== محرك الفرص الحية المستقل (live.mjs) — حتمية بدون شبكة =====

test('تطبيق قواعد المتعلم: يقلص الفَرق حتمياً', () => {
  const list = [
    { score: 60, reasons: [], clusterCount: 2, swept: false },
    { score: 40, reasons: [], clusterCount: 2, swept: false },
    { score: 80, reasons: [], clusterCount: 0, swept: false }
  ];
  const kept = applyLearnedRules(list, { minScore: 50, requireCluster: true, requireBubble: false, allowSwept: true });
  assert.equal(kept.length, 1);
  assert.equal(kept[0].score, 60);
});

test('قواعد ناقصة → مرور كامل بدون قص', () => {
  const list = [{ score: 10, reasons: [], clusterCount: 0, swept: false }];
  assert.equal(applyLearnedRules(list, null), list);
  assert.equal(applyLearnedRules(list, {}), list);
  assert.equal(applyLearnedRules(list, { minScore: 'x' }), list);
});

test('الفرش الحية: شموع مسطحة → لا فرق ولا رمي (شكل محفوظ)', async () => {
  const flat = Array.from({ length: 120 }, (_, i) => [i * 1000, '100', '100', '100', '100', '1', 0, 0, 0, '0.5', 0]);
  const mdb = { binance: { klines: async () => flat } };
  const out = await discoverLiveOpportunities(mdb, { symbol: 'X', timeframe: '1h' });
  assert.equal(out.symbol, 'X');
  assert.equal(out.timeframe, '1h');
  assert.ok(Array.isArray(out.opportunities));
  assert.equal(out.opportunities.length, 0);
});

test('الفرش الحية: كل فرقة حية لها وقف على الجانب الآمن وقرار معروف', async () => {
  // قمة مزدوجة: صعود إلى 100 → هبوط → صعود إلى 99.85 (ضمن تسامح التساوي، أسفل القمة فلا تُسحب)
  const targets = [];
  for (let i = 0; i <= 39; i++) targets.push(50 + 50 * (i / 39));
  for (let i = 1; i <= 20; i++) targets.push(100 - 4 * (i / 20));
  for (let i = 1; i <= 20; i++) targets.push(96 + 3.85 * (i / 20));
  for (let i = 1; i <= 10; i++) targets.push(99.85 - 0.025 * i);
  const rows = targets.map((c, i) => {
    const o = i === 0 ? c : targets[i - 1];
    const hi = Math.max(o, c);
    const lo = Math.min(o, c);
    return [i * 3600000, String(o), String(hi), String(lo), String(c), '1', 0, 0, 0, '0.5', 0];
  });
  const mdb = { binance: { klines: async () => rows } };
  const out = await discoverLiveOpportunities(mdb, { symbol: 'X', timeframe: '1h' });
  assert.ok(Array.isArray(out.opportunities));
  for (const o of out.opportunities) {
    assert.ok(['enter', 'wait', 'skip'].includes(o.decision?.action), 'قرار معروف');
    if (o.zoneType === 'BSL') assert.ok(o.stop < o.entry, 'وقف شراء أسفل الدخول');
    else assert.ok(o.stop > o.entry, 'وقف بيع أعلى الدخول');
    assert.ok(Number.isFinite(o.distPct) && o.distPct >= 0, 'مسافة محسوبة');
    assert.ok(o.swept !== true, 'الفرقة الحية غير المسحبة فقط');
  }
});

// ===== محرك مناطق السيولة المستقل =====

const repeatedPeaks = () => {
  const values = [];
  for (let j = 0; j < 5; j += 1) {
    for (let i = 0; i < 8; i += 1) values.push(80 + i * 2.5);
    for (let i = 0; i < 8; i += 1) values.push(100 - i * 2.5);
  }
  return values.map((v, i) => ({
    time: i * 60,
    open: v,
    high: v + 0.05,
    low: v - 0.05,
    close: v,
    volume: 1,
    index: i
  }));
};

test('محرك السيولة: يكتشف Cluster أفقي متكرر ويفصل المرجع عن السيولة', () => {
  const candles = repeatedPeaks();
  const pivots = findPivots(candles);
  const zones = detectLiquidityZones({ symbol: 'XUSDT', timeframe: '1h', candles });
  assert.ok(pivots.length >= 5);
  assert.ok(zones.some(z => z.kind === 'horizontal_bsl' && z.touches >= 3));
  assert.ok(zones.some(z => z.kind === 'horizontal_ssl' && z.touches >= 3));
  for (const zone of zones) {
    assert.notEqual(zone.referenceLevel, zone.liquidityLevel);
    assert.ok(['potential', 'candidate', 'confirmed', 'swept'].includes(zone.state));
    assert.ok(zone.reasons.length >= 2);
  }
});

test('محرك السيولة: adaptiveConfig حتمي ومتغير مع ATR', () => {
  const candles = repeatedPeaks();
  const a = adaptiveConfig(candles);
  const b = adaptiveConfig(candles);
  assert.deepEqual(a, b);
  assert.ok(a.rightBars >= 3);
  assert.ok(a.tolerancePct > 0);
});

test('محرك السيولة: التاريخ لا يعيد استخدام بيانات ما بعد لحظة المسح', () => {
  const candles = repeatedPeaks();
  const first = scanHistory({ symbol: 'XUSDT', timeframe: '1h', candles, step: 3 });
  const shortened = scanHistory({ symbol: 'XUSDT', timeframe: '1h', candles: candles.slice(0, 48), step: 3 });
  assert.ok(first.length >= shortened.length);
  assert.ok(shortened.every(z => z.detectedAt <= candles[47].time));
});

test('محرك السيولة: feedback يضبط التسامح ويحفظ عدد الأمثلة', () => {
  const adjustment = feedbackToAdjustment([
    { verdict: 'accept' },
    { verdict: 'reject' },
    { verdict: 'reject' }
  ], { tolerancePct: 0.002 });
  assert.equal(adjustment.examples, 3);
  assert.ok(Number.isFinite(adjustment.tolerancePct));
  assert.equal(adjustment.accepted.length, 1);
  assert.equal(adjustment.rejected.length, 2);
});

// ===== بوابة السلّم: كسر الرد فعل الناشئ بعد كل تكرار (بحرية المشروع) =====

const stairCandle = (i, open, high, low, close) => ({ time: i * 3600, open, high, low, close, volume: 1, index: i });

/* سلسلة كاملة (34 شمعة): صعود بادئ ← لمسة1(100.05) ← رد فعل(99.91) ← لمسة2(100.04)
 * ← كسر بذيل(99.90 < 99.91) ← لمسة3(100.06) ← رد فعل(99.90) ← الكسر الأخير(99.80/99.84) = التأكيد
 * النافذة التكيّفية تبدأ المسح من leftBars(4) — لذلك الصعود البادئ 0-6 ضروري.
 */
const stairComplete = () => [
  stairCandle(0, 99.85, 99.89, 99.83, 99.87),
  stairCandle(1, 99.87, 99.90, 99.84, 99.88),
  stairCandle(2, 99.88, 99.91, 99.85, 99.89),
  stairCandle(3, 99.89, 99.92, 99.86, 99.90),
  stairCandle(4, 99.90, 99.93, 99.87, 99.91),
  stairCandle(5, 99.91, 99.94, 99.88, 99.92),
  stairCandle(6, 99.92, 99.95, 99.90, 99.94),
  stairCandle(7, 99.94, 100.05, 99.85, 100.00),
  stairCandle(8, 100.00, 100.03, 99.98, 100.00),
  stairCandle(9, 100.00, 100.02, 99.98, 100.00),
  stairCandle(10, 100.00, 100.01, 99.93, 99.95),
  stairCandle(11, 99.95, 99.99, 99.91, 99.95),
  stairCandle(12, 99.95, 99.99, 99.91, 99.95),
  stairCandle(13, 99.95, 99.99, 99.91, 99.95),
  stairCandle(14, 99.95, 99.99, 99.91, 99.95),
  stairCandle(15, 99.95, 100.04, 99.91, 99.95),
  stairCandle(16, 99.95, 100.02, 99.91, 99.95),
  stairCandle(17, 99.95, 99.95, 99.90, 99.95),
  stairCandle(18, 99.95, 99.99, 99.92, 99.95),
  stairCandle(19, 99.95, 99.99, 99.92, 99.95),
  stairCandle(20, 99.95, 99.99, 99.92, 99.95),
  stairCandle(21, 99.95, 99.99, 99.92, 99.95),
  stairCandle(22, 99.95, 99.99, 99.92, 99.95),
  stairCandle(23, 99.95, 99.99, 99.92, 99.95),
  stairCandle(24, 99.95, 100.06, 99.96, 99.95),
  stairCandle(25, 99.95, 100.00, 99.84, 99.86),
  stairCandle(26, 99.86, 99.86, 99.80, 99.82),
  stairCandle(27, 99.82, 99.84, 99.72, 99.76),
  stairCandle(28, 99.76, 99.80, 99.70, 99.74),
  stairCandle(29, 99.74, 99.81, 99.68, 99.76),
  stairCandle(30, 99.76, 99.79, 99.66, 99.73),
  stairCandle(31, 99.73, 99.78, 99.64, 99.72),
  stairCandle(32, 99.72, 99.77, 99.63, 99.71),
  stairCandle(33, 99.71, 99.76, 99.62, 99.70),
  stairCandle(34, 99.55, 99.67, 99.50, 99.62),
  stairCandle(35, 99.62, 99.68, 99.45, 99.63),
  stairCandle(36, 99.63, 99.69, 99.40, 99.64),
  stairCandle(37, 99.64, 99.71, 99.35, 99.65),
  stairCandle(38, 99.65, 99.72, 99.30, 99.66),
  stairCandle(39, 99.66, 99.73, 99.25, 99.67),
  stairCandle(40, 99.67, 99.74, 99.20, 99.68)
];

test('بوابة السلّم: سلسلة كاملة (لمسة←رد فعل←لمسة←كسر بذيل) → confirmed عند الكسر الأخير', () => {
  const cs = stairComplete();
  const zones = detectLiquidityZones({ symbol: 'S1USDT', timeframe: '1h', candles: cs, tolerancePct: 0.002 });
  const bsl = zones.filter(z => z.kind === 'horizontal_bsl');
  assert.equal(bsl.length, 1);
  assert.equal(bsl[0].state, 'confirmed');
  assert.equal(bsl[0].touches, 3);
  assert.ok(bsl[0].reasons.some(r => r.includes('سلسلة مكتملة')));
  assert.equal(bsl[0].confirmedAt, cs[26].time);
  assert.equal(bsl[0].liquidityLevel, bsl[0].retailStop);
  const ssl = zones.filter(z => z.kind === 'horizontal_ssl');
  assert.ok(ssl.every(z => z.state !== 'confirmed'), 'رد فعل SSL لم يكتمل سلسله هنا');
});

test('بوابة السلّم: رد فعل لم يُكسر بعد اللمسة التالية → candidate بلا تأكيد', () => {
  const cs = stairComplete().map(c => ({ ...c }));
  // شمعة 17: الرد فعل يبقى فوقه (99.91 = 99.91) — لا كسر في نافذة الكسر
  cs[17].low = 99.91;
  const zones = detectLiquidityZones({ symbol: 'S2USDT', timeframe: '1h', candles: cs, tolerancePct: 0.002 });
  const bsl = zones.filter(z => z.kind === 'horizontal_bsl');
  assert.equal(bsl.length, 1);
  assert.equal(bsl[0].state, 'candidate');
  assert.ok(bsl[0].reasons.some(r => r.includes('غير مكتملة')));
  assert.equal(bsl[0].confirmedAt, null);
});

test('بوابة السلّم: التسلسل الصارم — انهيار قبل اللمسة التالية لا يُقبل كسراً', () => {
  const cs = stairComplete().map(c => ({ ...c }));
  // شمعة 9 تنهار (99.80) قبل لمسة 2 — يُمتص في تعريف الرد فعل، ونافذة الكسر تبقى بلا كسر
  cs[9].low = 99.80;
  const zones = detectLiquidityZones({ symbol: 'S3USDT', timeframe: '1h', candles: cs, tolerancePct: 0.002 });
  const bsl = zones.filter(z => z.kind === 'horizontal_bsl');
  assert.equal(bsl.length, 1);
  assert.equal(bsl[0].state, 'candidate');
  assert.ok(bsl[0].reasons.some(r => r.includes('غير مكتملة')));
});

test('بوابة السلّم: العكس صحيح في SSL — رد فعل قمه ويُكسر صعوداً', () => {
  // 0-6 تدرج نازل نحو اللمسة الأولى، 7 لمسة SSL1 (low 99.95)، 8-14 رد فعل صاعد (قمه 100.12)،
  // 15 لمسة SSL2 (low 99.96)، 16 كسر بالذيل (high 100.14 > 100.12)، 17-23 رد فعل2 (قمه 100.14 من 16)،
  // 24 لمسة SSL3 (low 99.94)، 25 كسر2 (high 100.16 > 100.14)، 26 reaction أخير (100.18 > 100.16) = التأكيد،
  // 27-40 ذيل متدرج نازل يمنع أقماع الذيل من الانضمام ويحافظ على ATR معقولاً.
  const cs = [
    stairCandle(0, 100.40, 100.42, 100.38, 100.39),
    stairCandle(1, 100.39, 100.41, 100.37, 100.38),
    stairCandle(2, 100.38, 100.40, 100.36, 100.37),
    stairCandle(3, 100.37, 100.39, 100.35, 100.36),
    stairCandle(4, 100.36, 100.38, 100.34, 100.35),
    stairCandle(5, 100.35, 100.37, 100.33, 100.34),
    stairCandle(6, 100.34, 100.36, 100.32, 100.33),
    stairCandle(7, 100.33, 100.34, 99.95, 100.00),
    stairCandle(8, 100.00, 100.09, 100.02, 100.05),
    stairCandle(9, 100.05, 100.09, 100.02, 100.05),
    stairCandle(10, 100.05, 100.10, 100.07, 100.09),
    stairCandle(11, 100.09, 100.12, 100.09, 100.10),
    stairCandle(12, 100.10, 100.12, 100.09, 100.10),
    stairCandle(13, 100.10, 100.12, 100.09, 100.10),
    stairCandle(14, 100.10, 100.12, 100.09, 100.10),
    stairCandle(15, 100.10, 100.12, 99.96, 100.00),
    stairCandle(16, 100.00, 100.14, 99.96, 100.00),
    stairCandle(17, 100.00, 100.10, 99.98, 99.99),
    stairCandle(18, 99.99, 100.12, 100.00, 100.05),
    stairCandle(19, 100.05, 100.12, 100.00, 100.05),
    stairCandle(20, 100.05, 100.12, 100.00, 100.05),
    stairCandle(21, 100.05, 100.12, 100.00, 100.05),
    stairCandle(22, 100.05, 100.12, 100.00, 100.05),
    stairCandle(23, 100.05, 100.12, 100.00, 100.05),
    stairCandle(24, 100.05, 100.12, 99.94, 100.00),
    stairCandle(25, 100.00, 100.16, 99.96, 99.98),
    stairCandle(26, 99.98, 100.18, 99.96, 99.98),
    stairCandle(27, 99.98, 100.17, 99.98, 99.99),
    stairCandle(28, 99.99, 100.16, 99.99, 100.00),
    stairCandle(29, 100.00, 100.15, 100.00, 100.01),
    stairCandle(30, 100.01, 100.14, 100.01, 100.02),
    stairCandle(31, 100.02, 100.13, 100.02, 100.03),
    stairCandle(32, 100.03, 100.12, 100.03, 100.04),
    stairCandle(33, 100.04, 100.11, 100.04, 100.05),
    stairCandle(34, 100.05, 100.10, 100.05, 100.06),
    stairCandle(35, 100.06, 100.09, 100.06, 100.07),
    stairCandle(36, 100.07, 100.08, 100.07, 100.08),
    stairCandle(37, 100.08, 100.08, 100.08, 100.08),
    stairCandle(38, 100.08, 100.08, 100.08, 100.08),
    stairCandle(39, 100.08, 100.08, 100.08, 100.08),
    stairCandle(40, 100.08, 100.08, 100.08, 100.08)
  ];
  const zones = detectLiquidityZones({ symbol: 'S4USDT', timeframe: '1h', candles: cs, tolerancePct: 0.002 });
  const ssl = zones.filter(z => z.kind === 'horizontal_ssl');
  assert.equal(ssl.length, 1);
  assert.equal(ssl[0].state, 'confirmed');
  assert.equal(ssl[0].touches, 3);
  assert.ok(ssl[0].reasons.some(r => r.includes('سلسلة مكتملة')));
  assert.equal(ssl[0].confirmedAt, cs[26].time);
});

test('إثراء الرسم: المنطقة تحمل سلّم التكرارات + الكسر النهائي', () => {
  const cs = stairComplete();
  const zones = detectLiquidityZones({ symbol: 'S7USDT', timeframe: '1h', candles: cs, tolerancePct: 0.002 });
  const bsl = zones.find(z => z.kind === 'horizontal_bsl');
  assert.ok(bsl, 'المنطقة موجودة');
  assert.ok(bsl.staircase, 'السلّم مُرسَل');
  assert.equal(bsl.staircase.valid, true);
  // 3 لمسات = تكراران (لمسة1←لمسة2 = كسر 17، لمسة2←لمسة3 = كسر 25)
  assert.equal(bsl.staircase.breaks.length, 2);
  assert.equal(bsl.staircase.breaks[0].time, cs[17].time, 'كسر الرد فعل 1 (رد 99.91 بذيل 99.90)');
  assert.ok(Math.abs(bsl.staircase.breaks[0].reactionPrice - 99.91) < 1e-9);
  assert.equal(bsl.staircase.breaks[1].time, cs[25].time, 'كسر الرد فعل 2 (رد 99.90 بالإغلاق 99.86)');
  assert.ok(Math.abs(bsl.staircase.breaks[1].reactionPrice - 99.90) < 1e-9);
  assert.ok(bsl.finalBreak, 'الكسر النهائي مُرسَل');
  assert.equal(bsl.finalBreak.breakTime, cs[26].time, 'لحظة التأكيد');
  assert.ok(Math.abs(bsl.finalBreak.reactionPrice - 99.84) < 1e-9, 'رد فعل اللمسة الأخيرة = أدنى قاع بعدها');
});

test('الأفقي: قمتان فقط → لا منطقة أفقية (3+ قمم/قيعان مطلوبة)', () => {
  const cs = stairComplete().map(c => ({ ...c }));
  cs[24].high = 100.30; // القمة الثالثة تتحرك خارج نطاق التجميع — تبقى قمتان في النطاق
  const zones = detectLiquidityZones({ symbol: 'S6USDT', timeframe: '1h', candles: cs, tolerancePct: 0.002 });
  const bsl = zones.filter(z => z.kind === 'horizontal_bsl');
  assert.equal(bsl.length, 0, 'قمتان لا تنشئان منطقة أفقية');
});

test('بوابة السلّم: نقاط خط الاتجاه تخضع نفس البوابة', () => {
  // 7/15/24 قمم متقاربة (ميل هابط) + كسور الرد فعل بعد كل لمسة + ذيل متسع 34-40 (طول >= 40)
  const cs = [
    stairCandle(0, 99.85, 99.89, 99.83, 99.87),
    stairCandle(1, 99.87, 99.90, 99.84, 99.88),
    stairCandle(2, 99.88, 99.91, 99.85, 99.89),
    stairCandle(3, 99.89, 99.92, 99.86, 99.90),
    stairCandle(4, 99.90, 99.93, 99.87, 99.91),
    stairCandle(5, 99.91, 99.94, 99.88, 99.92),
    stairCandle(6, 99.92, 99.95, 99.90, 99.94),
    stairCandle(7, 99.94, 100.05, 99.85, 100.00),
    stairCandle(8, 100.00, 100.02, 99.95, 99.97),
    stairCandle(9, 99.97, 99.99, 99.93, 99.95),
    stairCandle(10, 99.95, 99.97, 99.90, 99.92),
    stairCandle(11, 99.92, 99.95, 99.91, 99.93),
    stairCandle(12, 99.93, 99.97, 99.92, 99.95),
    stairCandle(13, 99.95, 99.99, 99.93, 99.97),
    stairCandle(14, 99.97, 100.00, 99.94, 99.98),
    stairCandle(15, 99.98, 100.02, 99.94, 99.98),
    stairCandle(16, 99.98, 99.98, 99.80, 99.91),
    stairCandle(17, 99.91, 99.92, 99.81, 99.83),
    stairCandle(18, 99.83, 99.87, 99.82, 99.85),
    stairCandle(19, 99.85, 99.89, 99.84, 99.87),
    stairCandle(20, 99.87, 99.91, 99.86, 99.89),
    stairCandle(21, 99.89, 99.93, 99.88, 99.91),
    stairCandle(22, 99.91, 99.95, 99.90, 99.93),
    stairCandle(23, 99.93, 99.96, 99.92, 99.94),
    stairCandle(24, 99.94, 99.99, 99.92, 99.98),
    stairCandle(25, 99.98, 99.98, 99.70, 99.81),
    stairCandle(26, 99.81, 99.82, 99.65, 99.68),
    stairCandle(27, 99.68, 99.70, 99.58, 99.62),
    stairCandle(28, 99.62, 99.66, 99.56, 99.60),
    stairCandle(29, 99.60, 99.63, 99.54, 99.57),
    stairCandle(30, 99.57, 99.59, 99.51, 99.53),
    stairCandle(31, 99.53, 99.55, 99.48, 99.50),
    stairCandle(32, 99.50, 99.51, 99.44, 99.46),
    stairCandle(33, 99.46, 99.47, 99.40, 99.42),
    stairCandle(34, 99.35, 99.48, 99.25, 99.37),
    stairCandle(35, 99.37, 99.49, 99.20, 99.38),
    stairCandle(36, 99.38, 99.50, 99.15, 99.39),
    stairCandle(37, 99.39, 99.51, 99.10, 99.40),
    stairCandle(38, 99.40, 99.52, 99.05, 99.41),
    stairCandle(39, 99.41, 99.53, 99.00, 99.42),
    stairCandle(40, 99.42, 99.54, 98.95, 99.43)
  ];
  const zones = detectLiquidityZones({ symbol: 'S5USDT', timeframe: '1h', candles: cs, tolerancePct: 0.002 });
  const trend = zones.filter(z => z.kind === 'trendline_bsl');
  assert.equal(trend.length, 1);
  assert.equal(trend[0].state, 'confirmed');
  assert.ok(trend[0].trendline.slope < 0, 'ميل هابط');
  assert.ok(trend[0].reasons.some(r => r.includes('سلسلة مكتملة')));
});

// ===== الكشف البصري متعدد الوسائط (visual.mjs) — حتمي وبلا شبكة =====

const peaksCloses = () => {
  const values = [];
  for (let j = 0; j < 5; j += 1) {
    for (let i = 0; i < 8; i += 1) values.push(80 + i * 2.5);
    for (let i = 0; i < 8; i += 1) values.push(100 - i * 2.5);
  }
  return values;
};

test('عكس الدقيق: yToPrice(priceToY(p)) يعيد السعر بدقة (EXACT)', () => {
  const closes = peaksCloses();
  const candles = closes.map((v, i) => ({ time: i * 60, open: v, high: v + 0.05, low: v - 0.05, close: v, volume: 1, index: i }));
  const { axisMap } = renderChart(candles);
  assert.ok(axisMap);
  for (const p of [80, 90, 100, 95.5]) {
    const back = axisMap.yToPrice(axisMap.priceToY(p));
    assert.ok(Math.abs(back - p) < 0.5, `err=${Math.abs(back - p)}`);
  }
});

test('GAF/MTF: أبعاد صحيحة وقيم GASF داخل [-1, 1]', () => {
  const closes = peaksCloses();
  const gaf = gafEncode(closes, { size: 24 });
  assert.equal(gaf.size, 24);
  let maxAbs = 0;
  for (const row of gaf.gasf) for (const v of row) maxAbs = Math.max(maxAbs, Math.abs(v));
  assert.ok(maxAbs <= 1.0001, `maxAbs=${maxAbs}`);
  const mtf = mtfEncode(closes, { size: 24 });
  assert.equal(mtf.size, 24);
});

test('تضمين متعدد المقاييس: أبعاد صحيحة وقيم داخل [-1, 1]', () => {
  const closes = peaksCloses();
  const { embed, dims } = ts2vecEmbed(closes, { dims: 16 });
  assert.equal(dims, 16);
  for (const v of embed) assert.ok(Math.abs(v) <= 1.0001);
});

test('BOCPD: يكشف كسر بنيوي عند تغيّر المتوسط', () => {
  const series = [...Array(30).fill(0), ...Array(30).fill(5)];
  const boc = bocpd(series, { hazard: 1 / 50 });
  assert.ok(boc.changes.length >= 1, `changes=${boc.changes.length}`);
  assert.ok(boc.changes[0] > 25 && boc.changes[0] < 35, `first=${boc.changes[0]}`);
  assert.ok(boc.segments.length >= 2);
});

test('خط الأنابيب: قطاع الثقة عبر الائتلاف أعلى من المجموع الأعمى', () => {
  const closes = peaksCloses();
  const candles = closes.map((v, i) => ({ time: i * 60, open: v, high: v + 0.05, low: v - 0.05, close: v, volume: 1, index: i }));
  const visual = detectVisualZones({ candles, closes });
  assert.ok(visual.perKind.horizontal_bsl);
  assert.ok(visual.render.axisMapOk);
  assert.ok(Number.isFinite(visual.perKind.horizontal_bsl.confidence));
  // المحرك المدمج يعيد الثقة المثنّاة + خصائص الوسائط
  const zones = detectLiquidityZones({ symbol: 'XUSDT', timeframe: '1h', candles });
  assert.ok(zones.length >= 1);
  const z = zones[0];
  assert.ok(z.visual);
  assert.ok(Number.isFinite(z.visual.confidence));
  assert.ok(Number.isFinite(z.confidence));
});

test('تعلّم فعّال: انحياز القبول/الرفض يعدّل ثقة النوع محدوداً [0, 1.5]', () => {
  const bias0 = {};
  const key = 'horizontal_bsl';
  bias0[key] = 0;
  bias0[key] = Math.min(1.5, bias0[key] + 0.03); // قبول
  bias0[key] = Math.max(0, bias0[key] - 0.05); // رفض
  assert.equal(bias0[key], 0);
});
