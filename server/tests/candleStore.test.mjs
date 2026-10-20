import test from 'node:test';
import assert from 'node:assert/strict';
import { createCandleStore, TF_MS } from '../market/candleStore.mjs';
import { detectLiquidityZones, normalizeCandles } from '../liquidity-zones/engine.mjs';

/**
 * اختبارات مخزن الشموع الرقمي. المحاور المُختبَرة هي جوهر الصحة:
 *  - التجميع من الدقائق إلى الفريمات الأعلى (open/high/low/close/volume/taker).
 *  - اشتقاق حدود النوافذ من بيانات البذر لا من الحقبة (محاذاة 3d الخاصة).
 *  - الفجوات: لا شموع وهمية، وعدّاد فجوات.
 *  - تجاهل الأقدم، سقف السعة، دقة الجمع الصحيحة، شكل صفوف REST، المدخلات الفاسدة.
 */

/** صف REST على شكل بينانس: [openTime, o, h, l, c, v, closeTime, 0, 0, takerBuyBase] */
const row = (openTime, o, h, l, c, v, closeTime, taker) => [openTime, o, h, l, c, v, closeTime, 0, 0, taker];

/** شمعة دقيقة ككائن (كما تصل من البث) */
const min = (openTime, o, h, l, c, v, taker) => ({ openTime, open: o, high: h, low: l, close: c, volume: v, takerBuyBase: taker });

test('TF_MS: يغطي كل الفريمات المطلوبة بقيمها الصحيحة', () => {
  assert.equal(TF_MS['1m'], 60000);
  assert.equal(TF_MS['3m'], 180000);
  assert.equal(TF_MS['5m'], 300000);
  assert.equal(TF_MS['15m'], 900000);
  assert.equal(TF_MS['30m'], 1800000);
  assert.equal(TF_MS['1h'], 3600000);
  assert.equal(TF_MS['2h'], 7200000);
  assert.equal(TF_MS['4h'], 14400000);
  assert.equal(TF_MS['6h'], 21600000);
  assert.equal(TF_MS['8h'], 28800000);
  assert.equal(TF_MS['12h'], 43200000);
  assert.equal(TF_MS['1d'], 86400000);
  assert.equal(TF_MS['3d'], 259200000);
  assert.equal(TF_MS['1w'], 604800000);
});

test('1) تطابق التجميع: ثلاث دقائق متتالية تُنتج شمعة 3m مطابقة بالحرف', () => {
  const store = createCandleStore({ capacity: 10 });
  const t0 = 1_700_000_000_000;
  // بذر شمعة 3m واحدة تفتح النافذة عند t0 (الحدود مشتقة من البذر لا من الحقبة)
  store.seed('BTCUSDT', '3m', [row(t0, 100, 100, 100, 100, 0, t0 + 180000 - 1, 0)]);

  // الدقيقة الأولى: تفتح النافذة الجارية (open=100)
  store.apply1m('BTCUSDT', min(t0, 100, 105, 99, 104, 1, 0.4));
  // الدقيقة الثانية: تحديث تراكمي
  store.apply1m('BTCUSDT', min(t0 + 60000, 104, 110, 103, 108, 2, 0.9));
  // الدقيقة الثالثة: تحديث تراكمي
  store.apply1m('BTCUSDT', min(t0 + 120000, 108, 109, 95, 96, 3, 1.2));

  // الدقيقة الرابعة: تُغلق نافذة 3m وتفتح نافذة جديدة
  const closed = store.apply1m('BTCUSDT', min(t0 + 180000, 96, 97, 94, 95, 4, 1.5));
  assert.equal(closed.length, 1, 'نافذة 3m واحدة أُغلقت');
  assert.equal(closed[0].tf, '3m');

  const b = closed[0].bar;
  assert.equal(b.openTime, t0);
  assert.equal(b.open, 100, 'open = فتح الدقيقة الأولى');
  assert.equal(b.high, 110, 'high = الأكبر (110)');
  assert.equal(b.low, 95, 'low = الأصغر (95)');
  assert.equal(b.close, 96, 'close = إغلاق الدقيقة الأخيرة');
  assert.equal(b.volume, 6, 'volume = 1+2+3');
  assert.equal(b.takerBuyBase, 2.5, 'takerBuyBase = 0.4+0.9+1.2');
  assert.equal(b.closeTime, t0 + 180000 - 1, 'closeTime = openTime + TF_MS - 1');
});

test('2) إغلاق النافذة: تُعاد في الناتج والشمعة الجديدة تبدأ بقيم الواردة', () => {
  const store = createCandleStore({ capacity: 10 });
  const t0 = 1_700_000_000_000;
  store.seed('ETHUSDT', '5m', [row(t0, 10, 10, 10, 10, 0, t0 + 300000 - 1, 0)]);

  store.apply1m('ETHUSDT', min(t0, 10, 12, 9, 11, 1, 0.5));
  const closed = store.apply1m('ETHUSDT', min(t0 + 300000, 20, 22, 19, 21, 2, 0.8));

  assert.equal(closed.length, 1);
  assert.equal(closed[0].bar.open, 10, 'الشمعة المغلقة تحمل قيم النافذة القديمة');
  assert.equal(closed[0].bar.close, 11);

  // الشمعة الجارية الجديدة تبدأ بقيم الشمعة الواردة حرفياً
  const rows = store.getRows('ETHUSDT', '5m');
  const last = rows[rows.length - 1];
  assert.equal(last[0], t0 + 300000, 'openTime للنافذة الجديدة');
  assert.equal(last[1], 20, 'open = فتح الواردة');
  assert.equal(last[2], 22, 'high = أعلى الواردة');
  assert.equal(last[3], 19, 'low = أدنى الواردة');
  assert.equal(last[4], 21, 'close = إغلاق الواردة');
  assert.equal(last[5], 2, 'volume = حجم الواردة');
  assert.equal(last[9], 0.8, 'takerBuyBase = الواردة');
  assert.equal(last[6], t0 + 300000 + 300000 - 1, 'closeTime = openTime + TF_MS - 1');
});

test('3) محاذاة 3d: الحدود مشتقة من البذر لا من الحقبة', () => {
  const store = createCandleStore({ capacity: 10 });
  const t0 = 1_700_000_000_000; // ليس مضاعفاً لـ3d من الحقبة
  store.seed('BTCUSDT', '3d', [row(t0, 50, 50, 50, 50, 0, t0 + TF_MS['3d'] - 1, 0)]);

  // دقائق داخل نفس النافذة: يجب ألا تُغلق شيئاً
  assert.equal(store.apply1m('BTCUSDT', min(t0, 50, 55, 49, 54, 1, 0.1)).length, 0);
  assert.equal(store.apply1m('BTCUSDT', min(t0 + 60000, 54, 56, 53, 55, 1, 0.1)).length, 0);
  assert.equal(store.apply1m('BTCUSDT', min(t0 + 259200000 - 60000, 55, 57, 54, 56, 1, 0.1)).length, 0);

  // دقيقة عند openTime + 3d: تُغلق النافذة
  const closed = store.apply1m('BTCUSDT', min(t0 + TF_MS['3d'], 56, 58, 55, 57, 1, 0.1));
  assert.equal(closed.length, 1, 'نافذة 3d أُغلقت عند الحد المشتق من البذر');
  assert.equal(closed[0].tf, '3d');
  assert.equal(closed[0].bar.openTime, t0);
  assert.equal(closed[0].bar.open, 50);
  assert.equal(closed[0].bar.high, 57, 'high = الأكبر عبر الدقائق');
  assert.equal(closed[0].bar.low, 49, 'low = الأصغر عبر الدقائق');
  assert.equal(closed[0].bar.close, 56, 'close = آخر إغلاق داخل النافذة');
});

test('4) فجوة: لا شموع وهمية وعدّاد الفجوات يزيد', () => {
  const store = createCandleStore({ capacity: 10 });
  const t0 = 1_700_000_000_000;
  store.seed('BTCUSDT', '1m', [row(t0, 1, 1, 1, 1, 0, t0 + 60000 - 1, 0)]);

  store.apply1m('BTCUSDT', min(t0, 1, 2, 1, 2, 1, 0.1));
  const before = store.size('BTCUSDT', '1m');
  const gapsBefore = store.stats().gaps;

  // قفزة 3 فترات: تُغلق النافذة القديمة وتفتح نافذة جديدة بالشمعة الواردة فقط
  const closed = store.apply1m('BTCUSDT', min(t0 + 3 * 60000, 5, 6, 4, 5, 1, 0.1));
  assert.equal(closed.length, 1, 'الشمعة القديمة أُغلقت');
  assert.equal(closed[0].bar.openTime, t0);

  const after = store.size('BTCUSDT', '1m');
  assert.equal(after, before + 1, 'زادت شمعة واحدة فقط (لا ثلاث شموع وهمية)');
  assert.equal(store.stats().gaps, gapsBefore + 1, 'عدّاد الفجوات زاد');

  // النافذة الجديدة تفتح عند الحد المُشتق (t0 + 3*TF) لا عند زمن الشمعة الواردة
  const rows = store.getRows('BTCUSDT', '1m');
  assert.equal(rows[rows.length - 1][0], t0 + 3 * 60000);
});

test('5) تجاهل الأقدم: شمعة بزمن أقل من النافذة الحالية لا تُغيّر شيئاً', () => {
  const store = createCandleStore({ capacity: 10 });
  const t0 = 1_700_000_000_000;
  store.seed('BTCUSDT', '1m', [row(t0, 1, 1, 1, 1, 0, t0 + 60000 - 1, 0)]);
  store.apply1m('BTCUSDT', min(t0, 1, 5, 1, 4, 2, 0.5));

  const sizeBefore = store.size('BTCUSDT', '1m');
  const rowsBefore = JSON.stringify(store.getRows('BTCUSDT', '1m'));

  const closed = store.apply1m('BTCUSDT', min(t0 - 60000, 9, 9, 9, 9, 9, 9));
  assert.equal(closed.length, 0, 'لا إغلاق لشمعة أقدم');
  assert.equal(store.size('BTCUSDT', '1m'), sizeBefore, 'العدد لم يتغير');
  assert.equal(JSON.stringify(store.getRows('BTCUSDT', '1m')), rowsBefore, 'القيم لم تتغير');
});

test('6) سقف السعة: capacity=5 مع 10 شموع يُبقي الأحدث فقط', () => {
  const store = createCandleStore({ capacity: 5 });
  const t0 = 1_700_000_000_000;
  const rows = [];
  for (let i = 0; i < 10; i += 1) {
    rows.push(row(t0 + i * 60000, i, i, i, i, 0, t0 + i * 60000 + 60000 - 1, 0));
  }
  const stored = store.seed('BTCUSDT', '1m', rows);
  assert.equal(stored, 5, 'لا يتجاوز السقف أبداً');
  assert.equal(store.size('BTCUSDT', '1m'), 5);

  const out = store.getRows('BTCUSDT', '1m');
  assert.equal(out.length, 5);
  assert.equal(out[0][0], t0 + 5 * 60000, 'الأقدم (0..4) اختفت');
  assert.equal(out[4][0], t0 + 9 * 60000, 'الأحدث باقية');
  assert.equal(store.lastOpen('BTCUSDT', '1m'), t0 + 9 * 60000);
});

test('7) دقة الجمع: 1000 قيمة 1e-8 تُجمع بلا انزياح', () => {
  // فريم 1d (1440 دقيقة) ليجمع 1000 دقيقة داخل نافذة واحدة بلا إغلاق وسطي
  const store = createCandleStore({ capacity: 10 });
  const t0 = 1_700_000_000_000;
  store.seed('BTCUSDT', '1d', [row(t0, 1, 1, 1, 1, 0, t0 + TF_MS['1d'] - 1, 0)]);

  // 1000 دقيقة، كل واحدة تضيف 1e-8 للحجم و1e-8 للشراء الآجل
  for (let i = 0; i < 1000; i += 1) {
    store.apply1m('BTCUSDT', min(t0 + i * 60000, 1, 1, 1, 1, 1e-8, 1e-8));
  }
  const closed = store.apply1m('BTCUSDT', min(t0 + TF_MS['1d'], 1, 1, 1, 1, 0, 0));
  assert.equal(closed.length, 1);
  assert.equal(closed[0].bar.volume, 0.00001, 'المجموع = 1000 × 1e-8 = 1e-5 بلا انزياح');
  assert.equal(closed[0].bar.takerBuyBase, 0.00001, 'نفس الدقة للشراء الآجل');
});

test('8) شكل getRows: صف طوله 10 ومتوافق مع computeCvd', () => {
  const store = createCandleStore({ capacity: 10 });
  const t0 = 1_700_000_000_000;
  store.seed('BTCUSDT', '1m', [row(t0, 100, 110, 90, 105, 7, t0 + 60000 - 1, 3)]);
  const out = store.getRows('BTCUSDT', '1m');
  assert.equal(out.length, 1);
  assert.equal(out[0].length, 10, 'كل صف 10 عناصر');
  assert.equal(out[0][0], t0, '[0] = openTime');
  assert.equal(out[0][5], 7, '[5] = volume (يقرأه computeCvd)');
  assert.equal(out[0][6], t0 + 60000 - 1, '[6] = closeTime');
  assert.equal(out[0][9], 3, '[9] = takerBuyBase (يقرأه computeCvd)');
  assert.equal(out[0][7], 0);
  assert.equal(out[0][8], 0);
  // كل القيم أرقام لا نصوص
  for (const v of out[0]) assert.equal(typeof v, 'number');
});

test('9) غير مُبذور: getRows=[] وbuffer=null وstats أصفار', () => {
  const store = createCandleStore({ capacity: 10 });
  assert.deepEqual(store.getRows('NOPE', '1m'), []);
  assert.equal(store.buffer('NOPE', '1m'), null);
  assert.equal(store.has('NOPE', '1m'), false);
  assert.equal(store.size('NOPE', '1m'), 0);
  assert.equal(store.lastOpen('NOPE', '1m'), null);
  const s = store.stats();
  assert.equal(s.keys, 0);
  assert.equal(s.bars, 0);
  assert.equal(s.bytes, 0);
  assert.equal(s.capacity, 10);
  assert.equal(s.lastUpdateAt, null);
});

test('10) مدخلات فاسدة: seed وapply1m لا يرميان ولا يُفسدان الحالة', () => {
  const store = createCandleStore({ capacity: 10 });
  const t0 = 1_700_000_000_000;

  // صفوف فاسدة: null، NaN، قيم نصية، صفوف ناقصة — تُتجاهل بأمان
  const stored = store.seed('BTCUSDT', '1m', [
    null,
    [t0, 1, 2, 0.5, 1.5, 3, t0 + 60000 - 1, 0, 0, 1],
    [NaN, 1, 2, 0.5, 1.5, 3, t0 + 60000 - 1, 0, 0, 1],
    [t0 + 60000, 'x', 2, 0.5, 1.5, 3, t0 + 120000 - 1, 0, 0, 1],
    [t0 + 120000, 1, 2, 0.5, 1.5, 3, t0 + 180000 - 1, 0, 0, 1]
  ]);
  assert.equal(stored, 2, 'صفان صالحان فقط (الأول والرابع)');
  assert.equal(store.size('BTCUSDT', '1m'), 2);

  // شمعة ناقصة (بلا close) → لا رمي ولا تغيير
  const sizeBefore = store.size('BTCUSDT', '1m');
  const rowsBefore = JSON.stringify(store.getRows('BTCUSDT', '1m'));
  assert.deepEqual(store.apply1m('BTCUSDT', { openTime: t0 + 120000, open: 1, high: 2, low: 0.5 }), []);
  assert.deepEqual(store.apply1m('BTCUSDT', null), []);
  assert.deepEqual(store.apply1m('BTCUSDT', { openTime: NaN, open: 1, high: 2, low: 0.5, close: 1 }), []);
  assert.equal(store.size('BTCUSDT', '1m'), sizeBefore, 'العدد لم يتغير');
  assert.equal(JSON.stringify(store.getRows('BTCUSDT', '1m')), rowsBefore, 'القيم لم تتغير');

  // مدخلات غير صالحة على مستوى المفتاح
  assert.equal(store.seed(123, '1m', []), 0);
  assert.equal(store.seed('BTCUSDT', '7m', []), 0);
  assert.deepEqual(store.getRows('BTCUSDT', '7m'), []);
  assert.equal(store.buffer(null, '1m'), null);
  assert.equal(store.deleteSymbol(123), 0);
});

test('إضافي) deleteSymbol يحذف كل فريمات الرمز ويُبقي غيره', () => {
  const store = createCandleStore({ capacity: 10 });
  const t0 = 1_700_000_000_000;
  store.seed('BTCUSDT', '1m', [row(t0, 1, 1, 1, 1, 0, t0 + 60000 - 1, 0)]);
  store.seed('BTCUSDT', '5m', [row(t0, 1, 1, 1, 1, 0, t0 + 300000 - 1, 0)]);
  store.seed('ETHUSDT', '1m', [row(t0, 1, 1, 1, 1, 0, t0 + 60000 - 1, 0)]);

  assert.equal(store.deleteSymbol('BTCUSDT'), 2, 'فريمان محذوفان');
  assert.equal(store.has('BTCUSDT', '1m'), false);
  assert.equal(store.has('BTCUSDT', '5m'), false);
  assert.equal(store.has('ETHUSDT', '1m'), true, 'رمز آخر لم يُمسّ');
  assert.equal(store.stats().keys, 1);
});

test('إضافي) buffer عرض بلا نسخ على المخزن الداخلي', () => {
  const store = createCandleStore({ capacity: 4 });
  const t0 = 1_700_000_000_000;
  store.seed('BTCUSDT', '1m', [row(t0, 1, 2, 0.5, 1.5, 3, t0 + 60000 - 1, 1)]);
  const buf = store.buffer('BTCUSDT', '1m');
  assert.ok(buf.data instanceof Float64Array);
  assert.equal(buf.size, 1);
  assert.equal(buf.data.length, 4 * 8, 'الحلقة بحجم capacity × 8 قيم');
  assert.equal(buf.data[0], t0, 'أول قيمة = openTime');
  assert.equal(buf.data[5], 3, 'القيمة السادسة = volume');
  assert.equal(buf.data[7], t0 + 60000 - 1, 'القيمة الثامنة = closeTime');
});

test('إضافي) stats: bytes تقدير فعلي لأحجام Float64Array المحجوزة', () => {
  const store = createCandleStore({ capacity: 5 });
  const t0 = 1_700_000_000_000;
  store.seed('BTCUSDT', '1m', [row(t0, 1, 1, 1, 1, 0, t0 + 60000 - 1, 0)]);
  store.seed('ETHUSDT', '1m', [row(t0, 1, 1, 1, 1, 0, t0 + 60000 - 1, 0)]);
  const s = store.stats();
  assert.equal(s.keys, 2);
  assert.equal(s.bars, 2);
  assert.equal(s.bytes, 2 * 5 * 8 * 8, 'مفتاحان × capacity × 8 قيم × 8 بايت');
  assert.equal(s.capacity, 5);
  assert.ok(Number.isFinite(s.lastUpdateAt), 'lastUpdateAt زمن فعلي بعد البذر');
});

/**
 * فهرس الرموز: بلا هذا الفهرس تُمرّ apply1m على كل مفاتيح المخزن في كل شمعة دقيقة
 * (429 رمزاً × 6,006 مفتاحاً). الاختباران يثبتان أن الفهرس لا يُسرّب بين الرموز وأن
 * حذف رمز يُنظّف كل فريماته.
 */
test('apply1m لا يلمس رموزاً أخرى، وحذف رمز يُنظّف كل فريماته', () => {
  const store = createCandleStore({ capacity: 10, log: { warn() {}, error() {} } });
  const t0 = 1700000000000;
  // رمزان لهما الفريم نفسه: أي تسريب بينهما يظهر في القيم
  store.seed('AAAUSDT', '5m', [[t0, 100, 100, 100, 100, 1, t0 + 299999, 0, 0, 0.5]]);
  store.seed('AAAUSDT', '15m', [[t0, 100, 100, 100, 100, 1, t0 + 899999, 0, 0, 0.5]]);
  store.seed('BBBUSDT', '5m', [[t0, 200, 200, 200, 200, 2, t0 + 299999, 0, 0, 1.5]]);

  // دقيقة داخل نافذة AAAUSDT: يجب ألا تُغيّر BBBUSDT إطلاقاً
  store.apply1m('AAAUSDT', { openTime: t0 + 60000, open: 100, high: 111, low: 99, close: 110, volume: 3, takerBuyBase: 0.7 });
  const b = store.getRows('BBBUSDT', '5m');
  assert.equal(b.length, 1, 'BBBUSDT لم تكتسب شمعة');
  assert.deepEqual([b[0][2], b[0][3], b[0][4], b[0][5]], [200, 200, 200, 2], 'قيم BBBUSDT كما هي بلا أي مساس');

  const a = store.getRows('AAAUSDT', '5m');
  assert.equal(a.length, 1, 'شمعة AAAUSDT الحالية لم تُغلق بعد');
  assert.deepEqual([a[0][2], a[0][3], a[0][4], a[0][5]], [111, 99, 110, 4], 'التحديث التراكمي يخص AAAUSDT وحدها');

  assert.equal(store.deleteSymbol('AAAUSDT'), 2, 'حذف الرمز يمسّ فريماته المخزَّنة فقط');
  assert.equal(store.getRows('AAAUSDT', '5m').length, 0, 'لا بيانات بعد الحذف');
  assert.equal(store.apply1m('AAAUSDT', { openTime: t0 + 120000, open: 1, high: 1, low: 1, close: 1, volume: 1, takerBuyBase: 0 }).length, 0, 'لا أثر بعد الحذف');
  assert.equal(store.getRows('BBBUSDT', '5m').length, 1, 'الرمز الآخر محفوظ كما هو');
});

/**
 * `getCandles` وُجدت لحذف تخصيص وسيط: المسار القديم كان يبني مصفوفة 500×10 عناصر ثم
 * يحوّلها normalizeCandles إلى 500 كائن. الشرط الحاسم أنها تُعيد **القيم نفسها بالحرف**
 * — وإلا فالفورية اشتُريت بتغيير النتائج، وهو مرفوض.
 */
test('getCandles مطابقة حرفياً لمخرَج normalizeCandles من getRows', () => {
  const store = createCandleStore({ capacity: 20, log: { warn() {}, error() {} } });
  const t0 = 1700000000000;
  const rows = [];
  for (let i = 0; i < 12; i += 1) {
    const ot = t0 + i * 60000;
    rows.push([ot, 10 + i, 12.5 + i, 8.25 + i, 11 + i, 3.5 + i / 3, ot + 59999, 0, 0, 1.25 + i / 7]);
  }
  store.seed('CCCUSDT', '1m', rows);

  const viaNormalize = normalizeCandles(store.getRows('CCCUSDT', '1m'));
  const direct = store.getCandles('CCCUSDT', '1m');

  assert.equal(direct.length, viaNormalize.length, 'نفس عدد الشموع');
  assert.deepEqual(direct, viaNormalize, 'نفس الميادين ونفس القيم حرفياً (ومنها time بالثواني وindex)');
  // وعقدة الاستهلاك نفسها: الكشف يعطي نفس المناطق من الواجهتين
  const a = detectLiquidityZones({ symbol: 'CCCUSDT', timeframe: '1m', candles: viaNormalize, endIndex: viaNormalize.length - 1 });
  const b = detectLiquidityZones({ symbol: 'CCCUSDT', timeframe: '1m', candles: direct, endIndex: direct.length - 1 });
  assert.deepEqual(a.map(z => [z.kind, z.state, z.referenceLevel]), b.map(z => [z.kind, z.state, z.referenceLevel]), 'نفس المناطق');
});

test('getCandles على مفتاح غير موجود أو فريم مجهول تُعيد []', () => {
  const store = createCandleStore({ capacity: 5, log: { warn() {}, error() {} } });
  assert.deepEqual(store.getCandles('NOPE', '1m'), []);
  store.seed('X', '1m', [[1700000000000, 1, 1, 1, 1, 1, 1700000059999, 0, 0, 0]]);
  assert.deepEqual(store.getCandles('X', '7m'), [], 'فريم غير معروف لا يرمي');
});
