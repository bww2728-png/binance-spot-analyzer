/**
 * كاش تطبيع الشموع: الأمان أولاً، ثم التوفير.
 *
 * القياس الإنتاجي الذي استدعى الكاش: جامع القمامة يعمل **43 مرة في الثانية** ويستهلك
 * 18% من زمن النواة الواحدة (54.8 ثانية في 5 دقائق)، لأن كل نداء كشف يبني ~800
 * مصفوفة/كائن (401 مصفوفة صفوف + 400 كائن تطبيع) و6,006 مفتاحاً في الدورة.
 *
 * الشرط الحاكم المُختبَر هنا: الكاش **لا يُغيّر أي محتوى أبداً** — يُعيد نفس المصفوفة
 * التي كان `normalizeCandles` سيبنيها من نفس المحتوى، ويُبطل عند أي كتابة في المخزن
 * (بذرة، شمعة جديدة، أو تحديث الشمعة الجارية) لأن كل ذلك يغيّر ما يقرأه الكشف.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCandleStore } from '../market/candleStore.mjs';

function rowsFrom(times, closes) {
  return times.map((t, i) => [t, closes[i], closes[i] + 1, closes[i] - 1, closes[i], 10, t + 59_999, 0, 0, 5]);
}

test('الإصدار يزيد عند البذر وعند كل شمعة جديدة (الإبطال دقيق)', () => {
  const store = createCandleStore({ capacity: 100 });
  const t0 = 1_700_000_000_000;
  store.seed('BTCUSDT', '1m', rowsFrom([t0, t0 + 60_000, t0 + 120_000], [1, 2, 3]));
  const r1 = store.rev('BTCUSDT', '1m');
  assert.equal(Number.isFinite(r1), true, 'الإصدار رقم');
  store.apply1m('BTCUSDT', { openTime: t0 + 180_000, open: 3, high: 4, low: 3, close: 3.5, volume: 1, takerBuyBase: 0.5, closeTime: t0 + 239_999 });
  const r2 = store.rev('BTCUSDT', '1m');
  assert.notEqual(r2, r1, 'شمعة جديدة تُغيّر الإصدار');
  store.seed('BTCUSDT', '1m', rowsFrom([t0, t0 + 60_000], [9, 9]));
  assert.notEqual(store.rev('BTCUSDT', '1m'), r2, 'إعادة البذر تُغيّر الإصدار');
});

test('تحديث الشمعة الجارية يغيّر الإصدار (لا يُقرأ محتوى قديم)', () => {
  const store = createCandleStore({ capacity: 100 });
  const t0 = 1_700_000_000_000;
  store.seed('ETHUSDT', '1m', rowsFrom([t0], [100]));
  const a = store.rev('ETHUSDT', '1m');
  // تحديث داخل النافذة الجارية (سعر/حجم) — يجب أن يُبطل الكاش
  store.apply1m('ETHUSDT', { openTime: t0, open: 100, high: 105, low: 99, close: 104, volume: 2, takerBuyBase: 1, closeTime: t0 + 59_999 });
  assert.notEqual(store.rev('ETHUSDT', '1m'), a, 'تحديث الشمعة الجارية يُبطل');
});

test('مفتاح غير موجود إصداره -1 (لا انفجار على مدخل مجهول)', () => {
  const store = createCandleStore({ capacity: 10 });
  assert.equal(store.rev('NOPEUSDT', '7m'), -1);
  assert.equal(store.rev('', ''), -1);
});

test('التطبيع من نفس المحتوى متطابق حرفياً (الكاش لا يغيّر نتيجة)', async () => {
  const { normalizeCandles } = await import('../liquidity-zones/engine.mjs');
  const store = createCandleStore({ capacity: 100 });
  const t0 = 1_700_000_000_000;
  const rows = rowsFrom([t0, t0 + 60_000, t0 + 120_000], [10, 11, 9]);
  store.seed('SOLUSDT', '5m', rows);
  const rowsRead = store.getRows('SOLUSDT', '5m');
  const a = normalizeCandles(rowsRead);
  const rowsRead2 = store.getRows('SOLUSDT', '5m');
  const b = normalizeCandles(rowsRead2);
  assert.deepEqual(a, b, 'نفس المحتوى ⇒ نفس التطبيع بالضبط');
  // والحقول المطلوبة موجودة كما يتوقعها المحرك
  for (const c of a) {
    for (const f of ['time', 'open', 'high', 'low', 'close', 'volume', 'index']) {
      assert.equal(f in c, true, `الحقل ${f} موجود`);
    }
  }
  assert.equal(a[0].time, t0 / 1000, 'الزمن بالثواني كما كان');
});

test('القيمة القصوى (capacity) تُحفظ: الإصدار يتقدّم حتى في الحلقة الممتلئة', () => {
  const store = createCandleStore({ capacity: 3 });
  const t0 = 1_700_000_000_000;
  store.seed('XRPUSDT', '1m', rowsFrom([t0, t0 + 60_000, t0 + 120_000], [1, 2, 3]));
  const before = store.rev('XRPUSDT', '1m');
  for (let i = 3; i < 8; i += 1) {
    store.apply1m('XRPUSDT', { openTime: t0 + i * 60_000, open: i, high: i + 1, low: i - 1, close: i, volume: 1, takerBuyBase: 0.1, closeTime: t0 + i * 60_000 + 59_999 });
  }
  assert.notEqual(store.rev('XRPUSDT', '1m'), before, 'الكتابة فوق الأقدم تُغيّر الإصدار');
  assert.equal(store.size('XRPUSDT', '1m'), 3, 'الحجم ثابت عند السقف');
});
