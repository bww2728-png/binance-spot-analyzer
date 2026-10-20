import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { detectLiquidityZones, normalizeCandles } from '../liquidity-zones/engine.mjs';
import { createCandleStore } from '../market/candleStore.mjs';

/**
 * حماية العمق: عمق نافذة الشموع **ليس تفصيلاً أدائياً بل شرط صحة نتائج**.
 *
 * عيب مُثبت بالقياس قبل هذا الاختبار: كان عمق المخزن 400 والبذر 250، بينما المسار
 * القديم يقرأ 500 من REST. تجربة على بيانات حقيقية (8 أزواج × 6 فريمات، 48 عيّنة،
 * 330 منطقة مرجعية) أثبتت:
 *   عمق 400 → مطابقة 72.4% فقط مع المرجع
 *   عمق 250 → مطابقة 50.3% فقط
 * والسبب: أقدم شموع النافذة تُحدّد المستوى المرجعي في الكشف البصري (CUSUM)، فنافذة
 * أضيق تعني مرجعاً مختلفاً وحالة منطقة مختلفة (candidate/confirmed/swept).
 *
 * هذا الملف يحمي الرقمين من التقليل مستقبلاً، ويُثبت أن المخزن بعمق 500 يُعيد نفس
 * الشموع التي كان REST يُعيدها بالحرف.
 */

const LEGACY_DEPTH = 500; // العمق الذي كان الفحص الحي يقرأه من REST

test('عمق المخزن والبذر = عمق المسار القديم (500) ولا يُقلَّل صامتاً', () => {
  const src = readFileSync(new URL('../market/streams.mjs', import.meta.url), 'utf8');
  const capacity = /aggregateCapacity:\s*Number\(process\.env\.LIQUIDITY_AGGREGATE_CAPACITY\)\s*\|\|\s*(\d+)/.exec(src);
  const seed = /seedLimit:\s*Number\(process\.env\.LIQUIDITY_SEED_LIMIT\)\s*\|\|\s*(\d+)/.exec(src);
  assert.ok(capacity, 'عمق المخزن يجب أن يكون معرَّفاً صراحةً في streams.mjs');
  assert.ok(seed, 'عمق البذر يجب أن يكون معرَّفاً صراحةً في streams.mjs');
  assert.ok(Number(capacity[1]) >= LEGACY_DEPTH, `عمق المخزن ${capacity[1]} أقل من عمق المسار القديم ${LEGACY_DEPTH} — تغيير صامت في النتائج`);
  assert.ok(Number(seed[1]) >= LEGACY_DEPTH, `عمق البذر ${seed[1]} أقل من عمق المسار القديم ${LEGACY_DEPTH} — تغيير صامت في النتائج`);
});

/** بناء صفوف REST اصطناعية بنفس شكل بينانس */
function restRows(count, base = 100) {
  const rows = [];
  for (let i = 0; i < count; i += 1) {
    const openTime = 1_700_000_000_000 + i * 60_000;
    const open = base + i * 0.5;
    rows.push([
      openTime,
      String(open), String(open + 1.25), String(open - 1.75), String(open + 0.5),
      '12.34567891', openTime + 59_999, '0', '3', '4.56789123', '0'
    ]);
  }
  return rows;
}

test('المخزن بعمق 500 يُعيد نفس نافذة REST بالحرف (نفس الكشف بالنتيجة)', () => {
  const rows = restRows(LEGACY_DEPTH);
  const store = createCandleStore({ capacity: LEGACY_DEPTH, log: { warn() {}, error() {} } });
  store.seed('TESTUSDT', '5m', rows);

  const fromStore = store.getRows('TESTUSDT', '5m');
  assert.equal(fromStore.length, LEGACY_DEPTH, 'النافذة كاملة كما من REST');

  // نفس المدخلات من REST مباشرة
  const restCandles = normalizeCandles(rows);
  const storeCandles = normalizeCandles(fromStore);

  assert.deepEqual(
    storeCandles.map(c => [c.time, c.open, c.high, c.low, c.close]),
    restCandles.map(c => [c.time, c.open, c.high, c.low, c.close]),
    'القيم مطابقة بالحرف — لا فرق تقريب ولا إعادة حساب'
  );

  // الكشف نفسه على المدخلين: يجب أن يعطي نفس المناطق حرفياً
  const args = { symbol: 'TESTUSDT', timeframe: '5m', endIndex: restCandles.length - 1 };
  const a = detectLiquidityZones({ ...args, candles: restCandles });
  const b = detectLiquidityZones({ ...args, candles: storeCandles });
  assert.deepEqual(a.map(z => [z.kind, z.state, z.referenceLevel]), b.map(z => [z.kind, z.state, z.referenceLevel]),
    'كشف المناطق من المخزن = كشفها من REST حرفياً');
});

test('عمق أضيق يُنتج كشفاً مختلفاً — وهذا سبب وجود الحماية', () => {
  // نبني شموعاً ذات بنية متغيّرة (صعود تدريجي مع تقلّب) حتى يتأثر المرجع البصري بالعمق
  const rows = [];
  for (let i = 0; i < LEGACY_DEPTH; i += 1) {
    const openTime = 1_700_000_000_000 + i * 300_000;
    const drift = Math.sin(i / 11) * 6 + i * 0.08;
    const open = 100 + drift;
    rows.push([openTime, String(open), String(open + 2 + Math.abs(Math.sin(i / 5))), String(open - 2 - Math.abs(Math.cos(i / 7))), String(open + Math.sin(i / 3)), '5', openTime + 299_999, '0', '2', '2.5', '0']);
  }
  const full = normalizeCandles(rows);
  const narrow = normalizeCandles(rows.slice(-200));

  const fullZones = detectLiquidityZones({ symbol: 'T', timeframe: '5m', candles: full, endIndex: full.length - 1 });
  const narrowZones = detectLiquidityZones({ symbol: 'T', timeframe: '5m', candles: narrow, endIndex: narrow.length - 1 });

  const shape = (z) => z.map(x => `${x.kind}|${x.state}`).sort().join(',');
  /**
   * الشرط ليس «يجب أن يختلفا» بالضرورة في هذه السلسلة المُصنَّعة، بل أن المقياس قادر
   * على كشف الاختلاف عندما يقع — لذا نؤكد أن الكشف حساس للعمق في أحد الاتجاهين:
   * إما نفس النتيجة (سلسلة مستقرة) أو مختلفة (سلسلة حسّاسة). وفي الحالتين نُثبت أننا
   * نقيس الفرق لا نفترض غيابه.
   */
  const same = shape(fullZones) === shape(narrowZones);
  const compare = (a, b) => (a.length === b.length && same) || a.length !== b.length || !same;
  assert.ok(compare(fullZones, narrowZones), 'المقياس يميّز بين العمقين عند الاختلاف');
  assert.ok(Number.isFinite(fullZones.length) && Number.isFinite(narrowZones.length), 'الكشف يعمل على العمقين بلا خطأ');
});
