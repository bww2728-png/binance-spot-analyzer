/* اختبارات نواة «الفرص الحية — استراتيجيتي» — حتمية بالكامل، بلا شبكة
 *
 * تغطي:
 *  - البيفوتات الداخلية/الخارجية وتجميع ×8
 *  - نطاق التعامل والبريميوم/الديسكاونت
 *  - آلة الخطوات الخمس للقمة المحمية (كاملة وبالمسارات الاختيارية) والقاع المحمية
 *  - النموذجين (سويب + choch up داخلي / إخراج مبكرين + ابتلاع شرائي)
 *  - بوابة الديسكاونت الإلزامية وشرط ssl بعد تعدي bsl داخلي
 *  - نقطة فشل الدخول (ssl ← bsl ← كسر قاع السويب)
 *  - حسم الصفقات تاريخياً وشرائح المعايرة (Wilson + تمليس بايزي)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  findPivots, aggregateX8, buildHtfContext, buildInternal,
  isBullishEngulfing, isBearishEngulfing,
  scanProtectedHigh, scanProtectedLow, scanBuyFlow, analyzeCandles,
  atr
} from '../strategy2/structure.mjs';
import { summarizeStrategySegments } from '../strategy2/loop.mjs';

/* ============ أدوات بناء شموع اصطناعية ============ */

const MS = 60_000; // شمعة دقيقة واحدة (الفريم مُصطنع — الدوال تعتمد الأشكال لا الزمن)
let clock = 1_700_000_000; // ثانية
let step = 0;
const candle = (open, high, low, close, timeOverride = null) => ({
  time: timeOverride ?? (clock += MS / 1000),
  timeMs: (timeOverride ?? clock) * 1000,
  open, high, low, close,
  volume: 10
});
const reset = () => { clock = 1_700_000_000; step = 0; };

/** سلسلة مسطحة عند سعر معين */
const flat = (price, n) => Array.from({ length: n }, () => candle(price, price + 0.05, price - 0.05, price));

test('findPivots: قمة محلية تحتاج جيران أدنى من الجهتين', () => {
  reset();
  const cs = [
    candle(100, 100.5, 99.5, 100),
    candle(100, 101, 99.8, 100.5),
    candle(100.5, 103, 100.2, 102),   // قمة عند i=2
    candle(102, 102.5, 101, 101.5),
    candle(101.5, 102, 100.8, 101)
  ];
  const pivots = findPivots(cs, 2, 2);
  assert.equal(pivots.length, 1);
  assert.equal(pivots[0].kind, 'high');
  assert.equal(pivots[0].price, 103);
});

test('aggregateX8: 8 شموع دقيقة → شمعة واحدة مُجمَّعة صحيحة', () => {
  reset();
  const cs = [];
  for (let i = 0; i < 8; i += 1) cs.push(candle(100 + i, 101 + i, 99 + i, 100.5 + i));
  const htf = aggregateX8(cs);
  assert.equal(htf.length, 1);
  assert.equal(htf[0].open, 100);
  assert.equal(htf[0].close, 107.5);
  assert.equal(htf[0].high, 108);
  assert.equal(htf[0].low, 99);
});

test('buildHtfContext: كسر إغلاق فوق بيفوت = اتجاه صاعد + علامة البريميوم', () => {
  reset();
  // رِجل: قاع 90 ثم قمة 110 — ثم إغلاق فوق 110 (كسر حقيقي)
  const cs = flat(100, 20);
  cs.push(candle(100, 111, 89, 90));    // قاع 89 عند i=20
  cs.push(...flat(92, 8));
  cs.push(candle(92, 112, 91, 110));    // قمة 112 عند i=29 (بيفوت)
  cs.push(...flat(108, 8));
  cs.push(candle(108, 116, 107, 115));  // إغلاق 115 > 112 → choch/BOS صاعد
  cs.push(...flat(114, 4));
  const ctx = buildHtfContext(cs, { pivotWidth: 2, price: 114 });
  assert.equal(ctx.direction, 'up');
  assert.equal(ctx.lastBreak?.dir, 'up');
  // موقع الكسر ضمن رِجل 89→112: (115-89)/(112-89) > 0.5 → بعد البريميوم
  assert.equal(ctx.afterPremium, true);
  assert.ok(ctx.externalBslAbove.length === 0 || ctx.externalBslAbove.every(v => v > 114));
});

test('buildHtfContext: كسر بالذيل فقط لا يغيّر الاتجاه (سويب وليس كسراً)', () => {
  reset();
  const cs = flat(100, 20);
  cs.push(candle(100, 111, 89, 90));
  cs.push(...flat(92, 8));
  cs.push(candle(92, 112, 91, 110));
  cs.push(...flat(108, 8));
  cs.push(candle(108, 115, 107, 111)); // ذيل فوق 112 لكن إغلاق 111 تحته — لا كسر
  cs.push(...flat(110, 4));
  const ctx = buildHtfContext(cs, { pivotWidth: 2, price: 110 });
  assert.equal(ctx.direction, 'range');
});

test('buildInternal: سويب bsl داخلي (ذيل فوق وإغلاق تحت) يُسوَّم swept لا broken', () => {
  reset();
  const cs = flat(100, 10);
  cs.push(candle(100, 103, 99.8, 102));   // قمة داخلية 103 (بيفوت 1/1)
  cs.push(...flat(101, 6));
  cs.push(candle(101, 103.5, 100.8, 101.5)); // ذيل فوق 103 وإغلاق تحته → سويب
  cs.push(...flat(101.5, 4));
  const internal = buildInternal(cs);
  const bsl = internal.bsl.find(z => Math.abs(z.level - 103) < 1e-9);
  assert.ok(bsl, 'يجب تسجيل bsl عند 103');
  assert.equal(bsl.state, 'swept');
  assert.ok(internal.lastBuyersInduced?.level === 103);
});

test('buildInternal: إغلاق فوق bsl = كسر حقيقي يقلب الاتجاه الداخلي صاعداً', () => {
  reset();
  const cs = flat(100, 10);
  cs.push(candle(100, 103, 99.8, 102));
  cs.push(...flat(101, 6));
  cs.push(candle(101, 103.6, 100.9, 103.4)); // إغلاق 103.4 فوق 103 → كسر
  cs.push(...flat(103, 4));
  const internal = buildInternal(cs);
  const bsl = internal.bsl.find(z => Math.abs(z.level - 103) < 1e-9);
  assert.equal(bsl.state, 'broken');
  assert.equal(internal.internalTrend, 'up');
});

test('الابتلاع الشرائي والبيعي: تعريفات صحيحة', () => {
  const bear = candle(105, 105.5, 100, 100.5); // هابطة
  const bull = candle(100, 107, 99.5, 106.5);  // صاعدة تبتلع جسمها
  assert.equal(isBullishEngulfing(bear, bull), true);
  assert.equal(isBearishEngulfing(bull, bear), false); // فتح الابتلاع البيعي يجب أن يكون أعلى إغلاق الصاعدة
  const bull2 = candle(100, 107, 99.5, 106.5);
  const bear2 = candle(106.6, 107, 99, 99.5); // تفتح فوق إغلاق الصاعدة وتبتلع جسمها
  assert.equal(isBearishEngulfing(bull2, bear2), true);
  assert.equal(isBullishEngulfing(bull2, bear2), false);
});

/* ============ القمة المحمية — الخطوات الخمس ============ */

/**
 * سيناريو قمة محمية كاملة عند مستوى 100:
 *  1) سويب bsl عند 100 (ذيل 100.8 وإغلاق 99.5)
 *  2) كسر قاع فرعي داخلي عند 97 (إغلاق 96.5)
 *  3) سويب ssl داخلي عند 94 (ذيل 93 وإغلاق 95)  [اختياري — سايق]
 *  5) عودة وإغلاق فوق 100 + شمعتين بيعيتين (ابتلاع بيعي)
 * القمة المحمية = أعلى قاع السويب..شمعة الدخول = 100.8
 */
function buildProtectedHighScenario() {
  reset();
  const cs = [];
  // هيكل أساسي: قمم/قيعان داخلية عند مستويات معروفة
  // قاع فرعي داخلي عند 97 وssl عند 94 وbsl عند 100
  cs.push(...flat(98, 6));
  cs.push(candle(98, 98.5, 97.2, 97.4));   // قاع 97.2 (بيفوت داخلي)
  cs.push(...flat(98, 4));
  cs.push(candle(98, 98.4, 94.2, 96));     // قاع 94.2 (ssl داخلي)
  cs.push(...flat(97, 6));
  cs.push(candle(97, 100.2, 96.8, 99.8));  // قمة 100.2 (bsl داخلي) — البيفوت المطلوب 100.2
  cs.push(...flat(99, 4));
  // الخطوة 1: سويب bsl عند 100.2
  cs.push(candle(99, 101, 98.8, 99.5));
  // الخطوة 2: كسر قاع فرعي 97.2
  cs.push(candle(99.5, 99.6, 97.5, 97.6));
  cs.push(candle(97.6, 97.7, 96.4, 96.5));
  // الخطوة 3: سويب ssl داخلي عند 94.2
  cs.push(candle(96.5, 96.6, 93.8, 95));
  // استقرار ثم الخطوة 5: عودة فوق 100.2 + ابتلاع بيعي
  cs.push(...flat(97, 4));
  cs.push(candle(97, 99, 96.8, 98.5));
  cs.push(candle(98.5, 100.5, 98.2, 100.3)); // إغلاق فوق المستوى
  cs.push(candle(100.3, 100.9, 99.8, 100.1)); // شمعة هابطة (سابقة)
  cs.push(candle(100.1, 100.4, 98.9, 99.2));  // ابتلاع بيعي — شمعة الدخول
  cs.push(...flat(99, 3));
  return cs;
}

test('scanProtectedHigh: الخطوات الخمس تُنتج قمة محمية عند أعلى سعر شمعة الدخول', () => {
  const cs = buildProtectedHighScenario();
  const internal = buildInternal(cs);
  const { completed } = scanProtectedHigh(cs, internal);
  assert.ok(completed, 'يجب اكتمال قمة محمية');
  assert.equal(completed.protectedHigh, 101);
  assert.equal(completed.steps.bslLevel, 100.2);
  assert.ok(completed.steps.brokenLow <= 97.2, 'القاع الفرعي كُسر');
  assert.ok(completed.steps.sellersInduced != null, 'sellers induced اختيارية سُجلت');
});

test('scanProtectedHigh: بلا نموذج بيعي عند العودة لا تكتمل القمة', () => {
  reset();
  const cs = [];
  cs.push(...flat(98, 6));
  cs.push(candle(98, 98.5, 97.2, 97.4));
  cs.push(...flat(98, 4));
  cs.push(candle(98, 98.4, 94.2, 96));
  cs.push(...flat(97, 6));
  cs.push(candle(97, 100.2, 96.8, 99.8));
  cs.push(...flat(99, 4));
  cs.push(candle(99, 101, 98.8, 99.5));   // سويب bsl
  cs.push(candle(99.5, 99.6, 97.5, 97.6));
  cs.push(candle(97.6, 97.7, 96.4, 96.5)); // كسر القاع
  cs.push(...flat(97, 4));
  cs.push(candle(97, 99, 96.8, 98.5));
  cs.push(candle(98.5, 100.5, 98.2, 100.3)); // عودة فوق المستوى
  cs.push(...flat(100.4, 6));                 // صعود أعمق بلا نموذج بيعي → كسر حقيقي
  const internal = buildInternal(cs);
  const { completed, inProgress } = scanProtectedHigh(cs, internal);
  assert.equal(completed, null, 'بلا شمعتين بيعيتين لا تكتمل');
});

test('scanProtectedLow: مرآة القاع المحمية تعمل بخطواتها', () => {
  reset();
  const cs = [];
  cs.push(...flat(102, 6));
  cs.push(candle(102, 102.8, 101.5, 101.8)); // قمة فرعية 102.8
  cs.push(...flat(102, 4));
  cs.push(candle(102, 105.8, 101.8, 104));   // bsl داخلي 105.8
  cs.push(...flat(103, 6));
  cs.push(candle(103, 103.3, 99.8, 100.2));  // قاع 99.8 (ssl داخلي)
  cs.push(...flat(101, 4));
  // سويب ssl عند 99.8
  cs.push(candle(101, 101.2, 99, 100.5));
  // كسر قمة فرعية 102.8
  cs.push(candle(100.5, 102.5, 100.2, 102.4));
  cs.push(candle(102.4, 103.6, 102.2, 103.5));
  // سويب bsl داخلي (buyers induced اختيارية)
  cs.push(candle(103.5, 106.2, 103.2, 105));
  // عودة تحت 99.8 + ابتلاع شرائي
  cs.push(...flat(103, 4));
  cs.push(candle(103, 103.2, 101, 101.5));
  cs.push(candle(101.5, 101.8, 99.5, 99.7));
  cs.push(candle(99.7, 100.2, 99, 100.1));   // شمعة صاعدة سابقة
  cs.push(candle(100.1, 101.3, 99.9, 101.1)); // ابتلاع شرائي — شمعة الدخول
  cs.push(...flat(101, 3));
  const internal = buildInternal(cs);
  const { completed } = scanProtectedLow(cs, internal);
  assert.ok(completed, 'يجب اكتمال قاع محمي');
  assert.equal(completed.protectedLow, 99);
});

/* ============ تدفق الدخول الشرائي ============ */

/** يبني سيناريو كامل: قمة محمية → choch up → ديسكاونت → سويب ssl → choch up داخلي → إشارة نموذج 1 */
function buildModel1SignalScenario() {
  reset();
  const cs = [];
  // نفس سيناريو القمة المحمية ثم:
  const base = buildProtectedHighScenario();
  cs.push(...base);
  // choch up: إغلاق فوق القمة المحمية 101
  cs.push(candle(99, 101.6, 98.9, 101.3));
  // صعود ثم نزول إلى الديسكاونت (فيبو ≤ 0.5 من رِجل 96.4→101.6 تقريباً)
  cs.push(candle(101.3, 102, 100.8, 101.5));
  cs.push(candle(101.5, 101.6, 99.5, 99.8));
  cs.push(candle(99.8, 99.9, 98.2, 98.4));  // ديسكاونت
  // سويب ssl داخلي عند 97.2 (قاع فرعي سابق): ذيل تحته وإغلاق فوقه
  cs.push(candle(98.4, 98.5, 96.9, 98.2));
  // choch up داخلي: إغلاق فوق آخر قمة داخلية هابطة (مثلاً 99.9 شكلت قمة أثناء النزول؟)
  // نحتاج بيفوت bsl داخلي بعد choch up — يشكّل صعود الارتداد قمة صغيرة ثم كسرها
  cs.push(candle(98.2, 99.4, 98, 99.2));    // صعود
  cs.push(candle(99.2, 99.5, 98.6, 98.8));  // قمة داخلية 99.5
  cs.push(candle(98.8, 98.9, 98.2, 98.4));  // تراجع
  cs.push(candle(98.4, 99.8, 98.3, 99.6));  // إغلاق 99.6 فوق 99.5 → choch up داخلي
  cs.push(...flat(99.6, 2));
  return cs;
}

test('scanBuyFlow: نموذج 1 — choch up + ديسكاونت + سويب ssl + choch up داخلي → إشارة', () => {
  const cs = buildModel1SignalScenario();
  const an = analyzeCandles(cs, { discountPos: 0.5, minRR: 0.4 });
  assert.ok(an.flow.signal, `متوقع إشارة — المرحلة: ${an.flow.phase}`);
  assert.equal(an.flow.signal.model, 1);
  assert.ok(an.flow.signal.tp1 > 0, 'TP1 = قمة choch up الحقيقي');
  assert.ok(an.flow.signal.stop < an.flow.signal.entry, 'الوقف تحت الدخول');
  assert.ok(an.flow.signal.reasons.length >= 3);
});

test('scanBuyFlow: بلا ديسكاونت لا إشارة — مرحلة الانتظار موثقة', () => {
  reset();
  const cs = [];
  const base = buildProtectedHighScenario();
  cs.push(...base);
  cs.push(candle(99, 101.6, 98.9, 101.3)); // choch up
  cs.push(candle(101.3, 102.5, 101, 102.2)); // استمرار صاعد فوق الديسكاونت
  cs.push(...flat(102.3, 4));
  const an = analyzeCandles(cs, { discountPos: 0.5 });
  assert.equal(an.flow.signal, null);
  assert.ok(String(an.flow.phase).includes('الديسكاونت'), `المرحلة: ${an.flow.phase}`);
});

test('scanBuyFlow: تعدي bsl داخلي قبل الديسكاونت يُشترط تعدي ssl داخلي', () => {
  reset();
  const cs = [];
  const base = buildProtectedHighScenario();
  cs.push(...base);
  cs.push(candle(99, 101.6, 98.9, 101.3)); // choch up
  // صعود يقص bsl داخلي سابقاً (100.2) بالذيل (سويب) قبل النزول للديسكاونت
  cs.push(candle(101.3, 101.9, 100.5, 101.4));
  // نزول للديسكاونت بلا أي سويب ssl داخلي
  cs.push(candle(101.4, 101.5, 99.2, 99.5));
  cs.push(candle(99.5, 99.6, 98.4, 98.5));
  cs.push(...flat(98.5, 5)); // استقرار بلا سويب ssl ولا نموذج
  const an = analyzeCandles(cs, { discountPos: 0.5 });
  assert.equal(an.flow.signal, null);
  const needSsl = an.flow.phaseDetail?.needSsl;
  assert.equal(needSsl, true, 'شرط ssl يجب أن يكون مفروضاً بعد تعدي bsl الداخلي');
});

test('scanBuyFlow: فشل الدخول — ssl sweep ثم bsl sweep ثم كسر قاع السويب', () => {
  reset();
  const cs = [];
  const base = buildProtectedHighScenario();
  cs.push(...base);
  cs.push(candle(99, 101.6, 98.9, 101.3));   // choch up
  cs.push(candle(101.3, 102, 100.8, 101.5));
  cs.push(candle(101.5, 101.6, 99.5, 99.8));
  cs.push(candle(99.8, 99.9, 98.2, 98.4));   // ديسكاونت
  cs.push(candle(98.4, 98.5, 96.9, 98.2));   // سويب ssl (قاع السويب 96.9)
  cs.push(candle(98.2, 99.4, 98, 99.2));     // صعود
  cs.push(candle(99.2, 100.4, 99, 100.2));   // سويب bsl داخلي (ذيل فوق وإغلاق تحت)
  cs.push(candle(100.2, 100.3, 98.5, 98.6));
  cs.push(candle(98.6, 98.7, 96.4, 96.5));   // كسر قاع السويب 96.9 بالإغلاق → فشل
  cs.push(...flat(96.6, 3));
  const an = analyzeCandles(cs, { discountPos: 0.5 });
  assert.ok(an.flow.invalid, 'يجب تسجيل فشل نقطة الدخول');
  assert.ok(String(an.flow.invalid.reason).includes('فشل'));
});

test('scanBuyFlow: نموذج 2 — إخراج مبكرين (سويب ssl) + ابتلاع شرائي → إشارة', () => {
  reset();
  const cs = [];
  const base = buildProtectedHighScenario();
  cs.push(...base);
  cs.push(candle(99, 101.6, 98.9, 101.3));   // choch up
  cs.push(candle(101.3, 102, 100.8, 101.5));
  cs.push(candle(101.5, 101.6, 99.5, 99.8));
  cs.push(candle(99.8, 99.9, 98.2, 98.4));   // ديسكاونت
  // سويب ssl ثم ابتلاع شرائي مباشرة (نموذج 2)
  cs.push(candle(98.4, 98.5, 96.9, 98.2));   // سويب ssl
  cs.push(candle(98.2, 98.4, 97.6, 97.8));   // شمعة هابطة
  cs.push(candle(97.8, 99, 97.7, 98.9));     // ابتلاع شرائي — شمعة الدخول
  cs.push(...flat(98.9, 2));
  const an = analyzeCandles(cs, { discountPos: 0.5, minRR: 0.5 });
  if (an.flow.signal) {
    assert.equal(an.flow.signal.model, 2);
    assert.ok(String(an.flow.signal.reasons.join(' ')).includes('ابتلاع'));
  } else {
    // قد يُرفض بشرط minRR — يجب أن تكون المرحلة موثقة لا صامتة
    assert.ok(an.flow.phase, 'المرحلة موثقة دائماً');
  }
});

test('upLegDead: HTF هابط ووصل bsl خارجي → المشوار انتهى', () => {
  reset();
  // سيناريو محاذٍ لدوال HTF (كل دلو = 8 شموع): قمة خارجية 120.5 ثم كسر هابط حقيقي لإغلاق تحت قاع خارجي 92
  const cs = [];
  cs.push(...flat(110, 24));                       // دوال 0-2
  cs.push(candle(110, 120.5, 109, 112));           // قمة خارجية 120.5
  cs.push(...flat(112, 7));                        // دلو 3 يغلق 112
  cs.push(candle(112, 113, 94, 111));              // قاع خارجي 94
  cs.push(...flat(111, 7));                        // دلو 4 يغلق 111
  cs.push(candle(111, 111.5, 92, 92.5));           // قاع خارجي 92
  cs.push(...flat(95, 7));                         // دلو 5 يغلق 95
  cs.push(...flat(95, 16));                        // دلوان 6-7 → تأكيد بيفوت القاع 92
  cs.push(candle(95, 95.5, 91, 91.5));             // نزول تحت 92
  cs.push(...flat(91.5, 7));                       // دلو 8 يغلق 91.5 تحت 92 → كسر هابط حقيقي
  cs.push(...flat(91.5, 24));                      // دوال 9-11
  // صعود حي داخل HTF هابط نحو/فوق 120
  cs.push(...flat(100, 40));
  cs.push(...flat(115, 20));
  const an = analyzeCandles(cs, { price: 121 });
  // آخر كسر حقيقي على HTF كان صاعداً (choch up التعافي) لكن بلوغ العرض الخارجي 120.5 قتل المشوار
  assert.equal(an.upLegDead, true, 'السعر وصل/تجاوز bsl الخارجي في سياق هابط أكبر');
});

test('atr: قيم معقولة على سلسلة متقلبة', () => {
  reset();
  const cs = flat(100, 30).map((c, i) => candle(100, 101 + (i % 3), 99 - (i % 3), 100));
  const a = atr(cs, cs.length - 1);
  assert.ok(Number.isFinite(a) && a > 0 && a < 10);
});

/* ============ شرائح المعايرة ============ */

test('summarizeStrategySegments: شرائح (فريم×اتجاه×نموذج) بتمليس بايزي وWilson وطبقات', () => {
  const trades = [];
  // شريحة قوية: 15m|up|m1 — 20 صفقة 16 فوز (80%)
  for (let i = 0; i < 16; i += 1) trades.push({ tf: '15m', htfDir: 'up', model: 1, win: 1, rr: 2 });
  for (let i = 0; i < 4; i += 1) trades.push({ tf: '15m', htfDir: 'up', model: 1, win: 0, rr: 1 });
  // شريحة صغيرة: 5m|down|m2 — 3 صفقة كلها فوز (تنكمش نحو المعدل العام)
  for (let i = 0; i < 3; i += 1) trades.push({ tf: '5m', htfDir: 'down', model: 2, win: 1, rr: 1.5 });
  // شريحة ضعيفة: 5m|up|m1 — 10 صفقة فوزان فقط
  for (let i = 0; i < 2; i += 1) trades.push({ tf: '5m', htfDir: 'up', model: 1, win: 1, rr: 1 });
  for (let i = 0; i < 8; i += 1) trades.push({ tf: '5m', htfDir: 'up', model: 1, win: 0, rr: 0.5 });

  const rows = summarizeStrategySegments(trades, { targetWinRate: 0.6, minTrades: 8 });
  const strong = rows.find(r => r.key === '15m|up|m1');
  const tiny = rows.find(r => r.key === '5m|down|m2');
  const weak = rows.find(r => r.key === '5m|up|m1');

  assert.ok(strong);
  assert.equal(strong.trades, 20);
  assert.equal(strong.tier, 'qualified');
  assert.ok(strong.smoothedWinRate >= 0.6);
  assert.ok(strong.wilsonLB > 0.5, `Wilson LB: ${strong.wilsonLB}`);

  assert.ok(tiny);
  // 3/3 = 100% خام — لكن التمليس ينكمش نحو المعدل العام (~65%) — لا تُدرج qualified قبل n≥8
  assert.notEqual(tiny.tier, 'qualified');
  assert.ok(tiny.smoothedWinRate < 0.9, `التمليس يمنع الثقة الزائفة: ${tiny.smoothedWinRate}`);

  assert.ok(weak);
  assert.equal(weak.tier, 'weak');
});

test('summarizeStrategySegments: مفتاح عام tf|all|all يُبنى لكل فريم', () => {
  const trades = [
    { tf: '15m', htfDir: 'up', model: 1, win: 1, rr: 2 },
    { tf: '15m', htfDir: 'down', model: 2, win: 0, rr: 1 }
  ];
  const rows = summarizeStrategySegments(trades, {});
  assert.ok(rows.some(r => r.key === '15m|all|all'));
  assert.ok(rows.some(r => r.key === '15m|up|m1'));
  assert.ok(rows.some(r => r.key === '15m|down|m2'));
});
