/**
 * تكافؤ كاش الائتلاف البصري — الشرط الحاكم: **صفر فرق في أي حقل يدخل قراراً**.
 *
 * القياس الذي استدعى الكاش: `detectVisualZones` = 9.71ms من 10.2ms لكل مفتاح على 400
 * شمعة (95% من كلفة الكشف)، ودورة كاملة (6,006 مفتاحاً) = ~61 ثانية معالج على نواة
 * واحدة. القياس بعد الكاش: 3,179ms ⇒ 602ms لدورة 300 مفتاح (**81% أقل**) بنسبة إصابة
 * 100%، وهذا مباشرة أهم مؤشر على تأخّر الحلقة (p99).
 *
 * والاختبارات هنا تثبت أن التوفير لا يأتي من تغيير حساب: نفس المصفوفة مع الكاش ونسخة
 * منفصلة (تُخفق الكاش) تعطيان نفس كل حقل محسوب. الحقول الزمنية الجدارية
 * (`detectedAt`/`confirmedAt`/`sweptAt`) مستثناة لأنها تتغيّر بمرور الزمن في **كل**
 * نداء — بالكاش وبلا كاش — ولا تدخل أي قرار.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeCandles, detectLiquidityZones, visualCacheStats, resetVisualCacheStats
} from '../liquidity-zones/engine.mjs';

const WALL_CLOCK_FIELDS = ['detectedAt', 'updatedAt', 'createdAt', 'confirmedAt', 'sweptAt'];
const strip = (z) => {
  const o = { ...z };
  for (const k of WALL_CLOCK_FIELDS) delete o[k];
  return o;
};

function makeCandles(n = 400, seed = 7) {
  let s = seed;
  const rnd = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
  const out = [];
  let px = 100;
  const t0 = 1_700_000_000_000;
  for (let i = 0; i < n; i += 1) {
    const o = px;
    const c = Math.max(0.0001, px * (1 + (rnd() - 0.5) * 0.012));
    out.push([t0 + i * 60_000, o, Math.max(o, c) * 1.002, Math.min(o, c) * 0.998, c, 100, t0 + i * 60_000 + 59_999, 0, 0, 50]);
    px = c;
  }
  return normalizeCandles(out);
}

test('الكاش يعطي نفس كل حقل محسوب (بلا أي فرق في القرار)', () => {
  const candles = makeCandles();
  const first = detectLiquidityZones({ symbol: 'X', timeframe: '5m', candles, tolerancePct: 0.002 }).map(strip);
  const second = detectLiquidityZones({ symbol: 'X', timeframe: '5m', candles, tolerancePct: 0.002 }).map(strip);
  assert.deepEqual(second, first, 'نداء ثانٍ بنفس المصفوفة (إصابة الكاش) مطابق حرفياً');
});

test('الكاش يُخفق على نسخة منفصلة ويعطي النتيجة نفسها (لا اعتماد على الهوية)', () => {
  const candles = makeCandles();
  const cached = detectLiquidityZones({ symbol: 'X', timeframe: '5m', candles, tolerancePct: 0.002 }).map(strip);
  resetVisualCacheStats();
  const copy = candles.map(c => ({ ...c }));
  const fresh = detectLiquidityZones({ symbol: 'X', timeframe: '5m', candles: copy, tolerancePct: 0.002 }).map(strip);
  assert.equal(visualCacheStats().hits, 0, 'المصفوفة الجديدة أخطأت الكاش فعلاً');
  assert.deepEqual(fresh, cached, 'المحسوب بلا كاش = المحسوب بالكاش');
});

test('تغيّر `biasPerKind` يُبطل الكاش (لا يُعاد استخدام نتيجة وسائط قديمة)', () => {
  const candles = makeCandles();
  resetVisualCacheStats();
  const a = detectLiquidityZones({ symbol: 'X', timeframe: '5m', candles, tolerancePct: 0.002, biasPerKind: { horizontal_bsl: 0 } });
  const b = detectLiquidityZones({ symbol: 'X', timeframe: '5m', candles, tolerancePct: 0.002, biasPerKind: { horizontal_bsl: 0.5 } });
  assert.equal(a.some(z => z.visual) || b.some(z => z.visual), true, 'الوسائط البصرية مؤثرة');
  // المفتاح يشمل البصمة ⇒ لا إصابة بين وسائط مختلفة
  const st = visualCacheStats();
  assert.equal(st.misses >= 2, true, `توقّع إخفاقين على الأقل لوسائط مختلفة، والمقيس ${st.misses}`);
});

test('تغيّر نافذة `end` لا يُخلط النتائج (مفتاح مستقل لكل نافذة)', () => {
  const candles = makeCandles(300);
  const full = detectLiquidityZones({ symbol: 'X', timeframe: '5m', candles, endIndex: 299, tolerancePct: 0.002 }).map(strip);
  const trimmed = detectLiquidityZones({ symbol: 'X', timeframe: '5m', candles, endIndex: 199, tolerancePct: 0.002 }).map(strip);
  const fullAgain = detectLiquidityZones({ symbol: 'X', timeframe: '5m', candles, endIndex: 299, tolerancePct: 0.002 }).map(strip);
  assert.notDeepEqual(trimmed, full, 'نافذتان مختلفتان تعطيان مناطق مختلفة');
  assert.deepEqual(fullAgain, full, 'ونافذة النهاية تعود بنفس النتيجة بعد ملء كاش النافذة الأخرى');
});

test('حتمية الكاش: 20 نداء متتالياً بنفس المدخل ⇒ نتيجة واحدة', () => {
  const candles = makeCandles(120);
  const base = JSON.stringify(detectLiquidityZones({ symbol: 'X', timeframe: '1m', candles, tolerancePct: 0.002 }).map(strip));
  for (let i = 0; i < 20; i += 1) {
    assert.equal(JSON.stringify(detectLiquidityZones({ symbol: 'X', timeframe: '1m', candles, tolerancePct: 0.002 }).map(strip)), base);
  }
});

test('الشموع القصيرة لا تُخزَّن في الكاش بلا داعٍ (تُعاد مبكراً)', () => {
  const short = makeCandles(30);
  resetVisualCacheStats();
  const r = detectLiquidityZones({ symbol: 'X', timeframe: '1m', candles: short, tolerancePct: 0.002 });
  assert.deepEqual(r, [], 'أقل من 40 شمعة ⇒ لا مناطق');
  assert.equal(visualCacheStats().misses, 0, 'لا حساب بصري على مدخل غير صالح');
});

test('الإحصاء يعطي نسبة إصابة منطقية (دليل التوفير)', () => {
  const candles = makeCandles(120);
  resetVisualCacheStats();
  for (let i = 0; i < 10; i += 1) detectLiquidityZones({ symbol: 'X', timeframe: '1m', candles, tolerancePct: 0.002 });
  const st = visualCacheStats();
  assert.equal(st.misses, 1, 'حساب واحد فقط ثم إصابات');
  assert.equal(st.hits, 9);
  assert.equal(st.hitRate, 90, 'نسبة الإصابة 90%');
});

test('الكاش لا يغيّر شكل المنطقة المفكوكة إلى JSON (نفس الحقول والأنواع)', () => {
  const candles = makeCandles(200);
  const a = detectLiquidityZones({ symbol: 'X', timeframe: '5m', candles, tolerancePct: 0.002 });
  const b = detectLiquidityZones({ symbol: 'X', timeframe: '5m', candles, tolerancePct: 0.002 });
  assert.deepEqual(Object.keys(b[0]).sort(), Object.keys(a[0]).sort(), 'نفس المفاتيح');
  for (const k of Object.keys(a[0])) {
    assert.equal(typeof b[0][k], typeof a[0][k], `نوع الحقل ${k} ثابت`);
  }
  assert.equal(JSON.stringify(a.map(strip)), JSON.stringify(b.map(strip)));
});
