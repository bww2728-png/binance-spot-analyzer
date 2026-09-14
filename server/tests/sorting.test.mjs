import test from 'node:test';
import assert from 'node:assert/strict';

// اختبارات محرّك الترتيب — نفس ملف المنطق المستخدم في الواجهة
const { sortAnalyses, classify, isUptrend, isDowntrend, distancePct } = await import('../../client/src/lib/sorting.ts');
const type = (await import('../../client/src/lib/types.ts'));

const mk = (over = {}) => ({
  id: 1, symbol: 'BTCUSDT',
  trend_lower: null, tf_lower: null, trend_upper: null, tf_upper: null,
  ext_bsl_sweep: null, ext_supply_touch: null, int_bsl_sweep: null,
  sellers_induced: null, int_ssl_sweep: null,
  ssl_price: null, bsl_price: null,
  bsl_touched: 0, ssl_touched: 0, passed_bsl_after_ssl: 0, choch_up: null,
  notes: '', notify_enabled: 1, created_at: 0, updated_at: 0,
  ...over
});

test('الصاعدة: صاعدة في الفريم الأصغر أو الأكبر', () => {
  assert.equal(isUptrend(mk({ trend_lower: 'up', trend_upper: 'down' })), true);
  assert.equal(isUptrend(mk({ trend_lower: 'down', trend_upper: 'up' })), true);
  assert.equal(isUptrend(mk({ trend_lower: 'down', trend_upper: 'down' })), false);
  assert.equal(isDowntrend(mk({ trend_lower: 'down', trend_upper: 'down' })), true);
  assert.equal(isDowntrend(mk({ trend_lower: 'up', trend_upper: 'down' })), false);
});

test('التصنيف: صاعدة → up_to_ssl', () => {
  assert.equal(classify(mk({ trend_lower: 'up' })), 'up_to_ssl');
});

test('التصنيف: هابطة + لمست BSL ثم SSL', () => {
  assert.equal(classify(mk({ trend_lower: 'down', trend_upper: 'down', bsl_touched: 1, ssl_touched: 1 })), 'down_touched_bsl_then_ssl');
});

test('التصنيف: هابطة + لمست BSL فقط', () => {
  assert.equal(classify(mk({ trend_lower: 'down', trend_upper: 'down', bsl_touched: 1, ssl_touched: 0 })), 'down_touched_bsl_only');
});

test('التصنيف: هابطة + لم تلمس BSL', () => {
  assert.equal(classify(mk({ trend_lower: 'down', trend_upper: 'down' })), 'down_not_touched_bsl');
});

test('التصنيف: غير مكتملة', () => {
  assert.equal(classify(mk({})), 'incomplete');
});

test('المسافة النسبية', () => {
  assert.ok(Math.abs(distancePct(105, 100) - 5) < 1e-9);
  assert.equal(distancePct(null, 100), null);
  assert.equal(distancePct(100, null), null);
});

test('الترتيب: الصاعدة الأقرب إلى SSL أولاً ثم الهابطة بالمجموعات الفرعية', () => {
  const up1 = mk({ id: 1, symbol: 'AAAUSDT', trend_lower: 'up', ssl_price: 100 });
  const up2 = mk({ id: 2, symbol: 'BBBUSDT', trend_lower: 'up', trend_upper: 'up', ssl_price: 90 });
  const dTouchedBoth1 = mk({ id: 3, symbol: 'CCCUSDT', trend_lower: 'down', trend_upper: 'down', bsl_price: 120, ssl_price: 110, bsl_touched: 1, ssl_touched: 1 });
  const dTouchedBoth2 = mk({ id: 4, symbol: 'DDDUSDT', trend_lower: 'down', trend_upper: 'down', bsl_price: 100, ssl_price: 95, bsl_touched: 1, ssl_touched: 1 });
  const dTouchedBsl = mk({ id: 5, symbol: 'EEEUSDT', trend_lower: 'down', trend_upper: 'down', bsl_price: 100, ssl_price: 90, bsl_touched: 1 });
  const dNotTouched1 = mk({ id: 6, symbol: 'FFFUSDT', trend_lower: 'down', trend_upper: 'down', bsl_price: 50 });
  const dNotTouched2 = mk({ id: 7, symbol: 'GGGUSDT', trend_lower: 'down', trend_upper: 'down', bsl_price: 48 });
  const incomplete = mk({ id: 8, symbol: 'HHHUSDT' });

  const live = { AAAUSDT: 99, BBBUSDT: 89, CCCUSDT: 115, DDDUSDT: 90, EEEUSDT: 95, FFFUSDT: 49, GGGUSDT: 45, HHHUSDT: 10 };
  const rows = sortAnalyses([up2, incomplete, dTouchedBsl, dNotTouched1, up1, dNotTouched2, dTouchedBoth1, dTouchedBoth2].map(a => ({ analysis: a, livePrice: live[a.symbol] })));

  const ids = rows.map(r => r.analysis.id);
  // الصاعدة: الأقرب إلى SSL (AAA 1% قبل BBB 1.11%)؛ الهابطة لمست BSL+SSL: الأقرب إلى BSL (CCC 4.17% قبل DDD 10%)؛
  // لمست BSL فقط: الأقرب إلى SSL (EEE 5.56%)؛ لم تلمس BSL: الأقرب إلى BSL (FFF 2% قبل GGG 6.25%)؛ غير المكتملة أخيراً.
  assert.deepEqual(ids, [1, 2, 3, 4, 5, 6, 7, 8], `الترتيب الفعلي: ${JSON.stringify(rows.map(r => [r.analysis.id, r.group, r.distancePct]))}`);
});

test('الترتيب: من بلا منطقة يأتي آخراً داخل مجموعته', () => {
  const a = mk({ id: 1, symbol: 'AAAUSDT', trend_lower: 'up', ssl_price: 100 });
  const b = mk({ id: 2, symbol: 'BBBUSDT', trend_lower: 'up', ssl_price: null });
  const rows = sortAnalyses([{ analysis: b, livePrice: 50 }, { analysis: a, livePrice: 99 }]);
  assert.equal(rows[0].analysis.id, 1);
});

test('أنواع البيانات مشتقة من types.ts', () => {
  assert.ok(Array.isArray(type.TIMEFRAMES));
  assert.ok(type.TIMEFRAMES.includes('1m') && type.TIMEFRAMES.includes('1w'));
});
