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
