import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clusterByAtr,
  perIterationStaircase,
  fitTrendline,
  buildHorizontalZone,
  ZONE_DEFAULTS
} from '../liquidity-zones/v2/zones.mjs';
import { detectLiquidityZonesV2, LIQUIDITY_KINDS_V2 } from '../liquidity-zones/v2/index.mjs';
import { normalizeCandles } from '../liquidity-zones/engine.mjs';

/**
 * اختبارات وحدة مناطق v2. تحرس الإصلاحات الثلاثة المذكورة في رأس الملف:
 *  - التسامح بـATR لا بنسبة ثابتة.
 *  - حد اللمسات ۲ لا ۳.
 *  - خط الاتجاه بتركيب حقيقي بفحص الانحرافات، لا بآخر ثلاث نقاط.
 */

function candlesFrom(rows, step = 300) {
  return normalizeCandles(rows.map((r, i) => [
    1_700_000_000_000 + i * step * 1000, r[0], r[1], r[2], r[3], 10, 0, 0, 0, 5
  ]));
}
const pt = (index, price, kind, atr = 1, prominenceAtr = 2) => ({ index, price, kind, atr, prominenceAtr, time: 1_700_000_000 + index * 300 });

// ============================================================================
// 1) لمستان تُقبلان (إصلاح عيب الحدّ 3)
// ============================================================================
test('لمستان تكفيان لتكوين منطقة', () => {
  const clusters = clusterByAtr([pt(1, 100, 'high'), pt(5, 100.1, 'high')], 0.25, {});
  assert.equal(clusters.length, 1, 'لمستان متقاربتان = تجمّع واحد');
  assert.equal(clusters[0].touches, 2, 'عدّاد اللمسات = 2');
});

// ============================================================================
// 2) التسامح مبني على ATR
// ============================================================================
test('التسامح بـATR: 0.2×ATR تجمّع واحد، و0.6×ATR تجمّعان', () => {
  const near = clusterByAtr([pt(1, 100, 'high', 10), pt(5, 102, 'high', 10)], 0.25, {});
  assert.equal(near.length, 1, '0.2×ATR داخل التسامح (0.25)');
  const far = clusterByAtr([pt(1, 100, 'high', 10), pt(5, 106, 'high', 10)], 0.25, {});
  assert.equal(far.length, 2, '0.6×ATR خارج التسامح');
});

// ============================================================================
// 3) الوقف المرجعي المزدوج
// ============================================================================
test('الوقف المرجعي المزدوج: 2×ATR محسوباً بدقة + القمة الفرعية التالية', () => {
  // قمة عند 3 بقيمة 112، قيعان/قمم تالية، ثم منطقة أفقية
  const rows = [];
  for (let i = 0; i < 60; i += 1) {
    const base = 100 + Math.sin(i / 4) * 6;
    rows.push([base, base + 2, base - 2, base + 1]);
  }
  const cs = candlesFrom(rows);
  cs[3].high = 112;
  const cluster = {
    id: 'c1',
    price: 112,
    points: [pt(3, 112, 'high', 4), pt(40, 111, 'high', 4)],
    touches: 2,
    lastPoint: pt(40, 111, 'high', 4),
    lastIndex: 40,
    firstIndex: 3
  };
  const zone = buildHorizontalZone({
    symbol: 'TESTUSDT', timeframe: '5m', cluster, candles: cs, endIndex: 59,
    opts: { ...ZONE_DEFAULTS, referenceAltFor: () => 118 }
  });
  assert.equal(zone.referenceAlt, 118, 'القمة الفرعية التالية تُعرض كخط دفاع ثانٍ');
  /**
   * مرجعان مختلفان — وكلاهما مقصود:
   *  - `retailStop` = قاعدة صاحب النظام حرفاً: أقصى سعر للقمة + 2×ATR = 112 + 8 = 120.
   *  - `liquidityLevel` = صيغة المحرك الأول كما هي (max(أقصى لمسة, التماس الأخير + 2×ATR))
   *    = max(112, 111 + 8) = 119. تُحفظ حرفيةً لأنها **عتبة المسح المنشورة**؛ تغييرها
   *    يجعل مقارنة الظل بلا معنى (كل الحالات تتغيّر بلا دليل).
   */
  assert.equal(zone.retailStop, 120, 'وقف الريتيل بقاعدة صاحب النظام = 112 + 2×4');
  assert.equal(zone.liquidityLevel, 119, 'عتبة المسح بصيغة المحرك الأول = max(112, 111+8)');
  assert.notEqual(zone.retailStop, zone.liquidityLevel, 'المرجعان مختلفان ويُعرضان معاً (طلب صريح)');
  assert.equal(zone.distanceAtr, 1.75, 'المسافة إلى عتبة المسح = |119−112|/4');
  assert.ok(zone.zoneBox.high >= zone.zoneBox.low, 'صندوق المنطقة مرتب');
  assert.deepEqual(Object.keys(zone).filter(k => ['breakSteps', 'staircase', 'invalidation', 'structureEvents'].includes(k)).sort(),
    ['breakSteps', 'invalidation', 'staircase', 'structureEvents'], 'حقول العرض البصري موجودة');
});

// ============================================================================
// 4) الحالات بالترتيب وبعتبة المسح
// ============================================================================
test('الحالات: potential/candidate/confirmed/swept بعتبة الوقف المرجعي', () => {
  // لمسة واحدة → لا منطقة (دون الحد الأدنى)
  const one = clusterByAtr([pt(1, 100, 'high')], 0.25, {});
  assert.equal(one[0].touches, 1, 'لمسة واحدة لا تُنتج منطقة معتمدة');

  const cs = candlesFrom(Array.from({ length: 60 }, (_, i) => [100, 101, 99, 100]));
  // سلّم كامل: لمسة 5، رد فعل قاع 98، لمسة 20، ثم كسر الرد في 25
  const cluster = { id: 'c2', price: 110, points: [pt(5, 110, 'high', 3), pt(20, 110, 'high', 3)], touches: 2, lastPoint: pt(20, 110, 'high', 3), lastIndex: 20, firstIndex: 5 };
  cs[8].low = 98; cs[9].low = 97.5; // رد الفعل بعد اللمسة الأولى (أدنى قاع = 97.5)
  /**
   * الكسر المطلوب يقع **بعد اللمسة التالية** (عند 20) لا بين اللمستين — وهذا نصّ القاعدة:
   * «رد فعل ← كسر ← ثم اللمسة التالية». فإن لم نضع شمعة بعد 20 تكسر 97.5 تبقى السلسلة ناقصة.
   */
  cs[25].low = 96;
  const st = perIterationStaircase(cs, [5, 20], 'down', 59);
  assert.equal(st.valid, true, 'الكسر وقع بعد اللمسة التالية ⇒ السلسلة مكتملة');
  const zone = buildHorizontalZone({ symbol: 'S', timeframe: '5m', cluster, candles: cs, endIndex: 59, opts: { ...ZONE_DEFAULTS } });
  assert.equal(zone.state, 'confirmed', 'سلسلة مكتملة ⇒ confirmed');

  // مسح: شمعة تبلغ سعر الوقف المرجعي
  const cs2 = candlesFrom(Array.from({ length: 60 }, (_, i) => [100, 101, 99, 100]));
  cs2[45].high = 110 + 3 * 2 + 0.5; // يتجاوز الوقف (110 + 2×ATR)
  const zone2 = buildHorizontalZone({ symbol: 'S', timeframe: '5m', cluster, candles: cs2, endIndex: 59, opts: { ...ZONE_DEFAULTS } });
  assert.equal(zone2.state, 'swept', 'بلوغ سعر الوقف المرجعي ⇒ swept');
  assert.ok(zone2.invalidation?.reason, 'سبب الإبطال مذكور للعرض');
});

// ============================================================================
// 5) سلّم اللمسات: كسر مفقود ⇒ ليس confirmed
// ============================================================================
test('سلّم اللمسات: لمسة بلا كسر بينها وبين التالية ⇒ ليست confirmed', () => {
  const cs = candlesFrom(Array.from({ length: 60 }, (_, i) => [100, 101, 99, 100]));
  // لا نصنع أي كسر لرد الفعل بين اللمستين 5 و20
  const st = perIterationStaircase(cs, [5, 20], 'down', 59);
  assert.equal(st.valid, false, 'لم يقع الكسر المطلوب');
  assert.equal(st.missingAt, 0, 'موقع النقص معلن');
});

// ============================================================================
// 6) خط الاتجاه: 3 نقاط، انحراف، وإسقاط سالب
// ============================================================================
test('خط الاتجاه يُركَّب بأقل المربعات ويرفض الشاذ والإسقاط السالب', () => {
  const flat = candlesFrom(Array.from({ length: 60 }, (_, i) => [100, 101, 99, 100]));
  // نقطتان → لا خط
  assert.equal(fitTrendline([pt(5, 120, 'high'), pt(30, 115, 'high')], flat, 59, {}), null, 'نقطتان لا تكفيان');

  // ثلاث نقاط على خط هابط تماماً: 120، 115، 110 (كل 10 شموع) → الميل −0.5
  const onLine = [pt(10, 120, 'high'), pt(20, 115, 'high'), pt(30, 110, 'high')];
  const fitted = fitTrendline(onLine, flat, 59, {});
  assert.ok(fitted, 'خط مركَّب من ثلاث نقاط متراصفة');
  assert.equal(Number(fitted.slope.toFixed(4)), -0.5, 'الميل = −0.5');
  assert.equal(fitted.errorAtr, 0, 'انحراف صفر للنقاط المتراصفة');

  // نقطة شاذة تنحرف بأكثر من maxDeviationAtr
  const outlier = [pt(10, 120, 'high'), pt(20, 115, 'high'), pt(30, 140, 'high')];
  assert.equal(fitTrendline(outlier, flat, 59, { maxDeviationAtr: 1 }), null, 'الشاذ يُرفض');

  // إسقاط سالب: خط هابط حاد من قيم صغيرة
  const steep = [pt(10, 3, 'high'), pt(20, 2, 'high'), pt(30, 1, 'high'), pt(40, 0.5, 'high')];
  const steepFit = fitTrendline(steep, flat, 59, { maxDeviationAtr: 5 });
  assert.ok(steepFit === null || steepFit.projected > 0, 'لا يُنشر إسقاط سالب');
});

// ============================================================================
// 7) الحتمية ومدخلات فاسدة
// ============================================================================
test('حتمية ومعالجة مدخلات فاسدة في المحرك الموحّد', () => {
  const rows = Array.from({ length: 80 }, (_, i) => {
    const base = 100 + Math.sin(i / 5) * 8;
    return [base, base + 3, base - 3, base + 1];
  });
  const cs = candlesFrom(rows);
  const a = detectLiquidityZonesV2({ symbol: 'D', timeframe: '5m', candles: cs, endIndex: 79 });
  const b = detectLiquidityZonesV2({ symbol: 'D', timeframe: '5m', candles: cs, endIndex: 79 });
  assert.deepEqual(a.map(z => z.id), b.map(z => z.id), 'نفس المدخل ⇒ نفس المناطق حرفياً');
  assert.ok(a.every(z => LIQUIDITY_KINDS_V2.includes(z.kind)), 'كل الأنواع من القائمة المعلنة');
  assert.ok(a.every(z => z.source === 'liquidity-engine-v2'), 'مصدر المنطقة معلن');

  assert.deepEqual(detectLiquidityZonesV2({}), []);
  assert.deepEqual(detectLiquidityZonesV2({ symbol: 'X', timeframe: '5m', candles: [], endIndex: 0 }), []);
  assert.doesNotThrow(() => detectLiquidityZonesV2({ symbol: 'X', timeframe: '5m', candles: [[1, 1, 1, 1], [null, NaN, NaN, null]], endIndex: 1 }));
  assert.deepEqual(clusterByAtr(null, 0.25, {}), []);
  assert.deepEqual(clusterByAtr([{ price: NaN }], 0.25, {}), []);
});

/**
 * عطل مُثبت بالقياس: كان الخط يُرفض كاملاً إن شذّت **أي** نقطة بأكثر من السماحية، فأنتج
 * المحرك v2 **صفر خط اتجاه** على 4,000+ عيّنة حقيقية بينما المحرك الأول أنتج 176 —
 * أي أن تعريف «ثلاث نقاط أو أكثر» لم يكن يعمل. الاختبار يحرس الإصلاح: النقطة الأسوأ
 * تُستبعد وحدها، ويُقبل الخط إن بقيت النقاط المتراصفة كافية.
 */
test('خط الاتجاه: استبعاد النقطة الأسوأ وحدها بدل رفض الخط كله', () => {
  const flat = candlesFrom(Array.from({ length: 60 }, (_, i) => [100, 101, 99, 100]));
  // ثلاث نقاط متراصفة تماماً على خط هابط + نقطة شاذة واحدة
  const withOutlier = [
    pt(10, 200, 'high'), pt(20, 190, 'high'), pt(30, 180, 'high'),
    pt(40, 260, 'high') // شاذة تماماً
  ];
  const fitted = fitTrendline(withOutlier, flat, 59, { maxDeviationAtr: 0.5, minPointProminenceAtr: 0 });
  assert.ok(fitted, 'الخط يُقبل بعد استبعاد النقطة الشاذة (كان يُرفض قبل الإصلاح)');
  assert.equal(fitted.points.length, 3, 'النقاط المتراصفة الثلاث بقيت');
  assert.equal(fitted.droppedPoints, 1, 'عدد النقاط المستبعدة معلن');
  assert.equal(Number(fitted.slope.toFixed(4)), -1, 'الميل الحقيقي للنقاط المتراصفة = −1');
  assert.ok(fitted.maxDeviationAtr <= 0.5, 'السماحية محترمة على النقاط الباقية');

  // وبلا نقطة كافية بعد الاستبعاد: يبقى الرفض صحيحاً
  const onlyThree = [pt(10, 200, 'high'), pt(20, 190, 'high'), pt(40, 260, 'high')];
  assert.equal(fitTrendline(onlyThree, flat, 59, { maxDeviationAtr: 0.5 }), null,
    'ثلاث نقاط بإحداها شاذة ⇒ لا خط (لا يكفي بعد الاستبعاد)');
});
