/* اختبارات نواة سجل الاتجاهات — حتمية بلا شبكة
 *
 * تغطي: تحديد الاتجاه من 1m و8m · آلة المراحل (منطق المستخدم الحرفي) ·
 * تعدي bsl → ديسكاونت+ssl مقابل ديسكاونت فقط · التوافق والتعارض · موت المشوار ·
 * التحديث الخفيف بالأسعار · تصنيف التغييرات (انقلاب/مرحلة/موت).
 *
 * ملاحظات التصميم الحاسمة (محاذاة الدوال):
 *  - aggregateX8 يُجمّع بدلاء من أول شمعة: الدلو = 8 شموع دقيقة، وإغلاق الدلو
 *    هو إغلاق شمعته الأخيرة — لذا شمعة الكسر يجب أن تقع آخر دلوها.
 *  - findPivots صارم: المسطحات المتساوية لا تنتج بيفوتات.
 *  - تأكيد البيفوت يحتاج دلوَين كاملين على كل جانب (pivotWidth = 2).
 *  - الحد الأدنى للتحليل 120 شمعة دقيقة (15 دلو HTF).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeDirectionState, updateWithPrice, classifyChange
} from '../strategy2/directions.mjs';

const MS = 60_000;
let clock = 1_750_000_000;
const candle = (open, high, low, close) => ({
  time: (clock += 60), timeMs: clock * 1000,
  open, high, low, close, volume: 10
});
const flat = (price, n) => Array.from({ length: n }, () => candle(price, price + 0.05, price - 0.05, price));
const reset = () => { clock = 1_750_000_000; };

/**
 * انقلاب صاعد نظيف على 8m — كل دلو 8 شموع، شمعة الكسر آخر دلوها (index 95 ≡ 7 mod 8):
 *  b0-b2 مسطح 100 · b3 قاع خارجي 85 · b4-b5 · b6 قمة هيكل 130 (آخر دلوها) ·
 *  b7-b9 تراجع · b10-b11 · b11 يُغلق 135 فوق 130 → كسر صاعد حقيقي. المجموع 104 شمعة.
 */
function buildCleanUptrend() {
  reset();
  const cs = [];
  cs.push(...flat(100, 24));                        // 0-23   b0-b2
  cs.push(candle(100, 96.5, 85, 95));               // 24     b3: قاع خارجي 85
  cs.push(...flat(95, 7));                          // 25-31
  cs.push(...flat(95, 8));                          // 32-39  b4
  cs.push(...flat(95, 8));                          // 40-47  b5
  cs.push(candle(95, 130, 94.9, 128));              // 48     b6: قمة هيكل 130
  cs.push(...flat(120, 7));                         // 49-55
  cs.push(...flat(120, 8));                         // 56-63  b7
  cs.push(candle(120, 121, 106, 108));              // 64     b8: تراجع بلا كسر للقاع
  cs.push(...flat(108, 7));                         // 65-71
  cs.push(...flat(108, 8));                         // 72-79  b9
  cs.push(...flat(108, 7));                         // 80-86
  cs.push(candle(108, 136, 107, 135));              // 87     آخر b10: إغلاق 135 فوق 130
  cs.push(...flat(128, 32));                        // 88-119 b11-b14
  return cs;
}

test('computeDirectionState: كسر إغلاق فوق قمة الهيكل → اتجاه صاعد + مرحلة ديسكاونت', () => {
  const cs = buildCleanUptrend();
  const st = computeDirectionState(cs, { price: 128 });
  assert.equal(st.dir, 'up');
  assert.equal(st.dead, false, 'الرِجل حية — لا عرض خارجي أعلى');
  assert.ok(String(st.stage).includes('ديسكاونت'), `المرحلة: ${st.stage}`);
  assert.ok(st.discountLevel != null, 'مستوى الديسكاونت محدد');
  assert.ok(st.legHigh != null && st.legLow != null, 'نطاق الرِجل محدد');
});

test('المرحلة: بلا تعدي bsl → تحديد ديسكاونت فقط', () => {
  const cs = buildCleanUptrend();
  // السعر فوق الديسكاونت (بداية الرِجل) — بلا أي سويب bsl داخلي
  const st = computeDirectionState(cs, { price: 133 });
  assert.equal(st.dir, 'up');
  assert.equal(st.stageDetail?.bslRetest, false, 'لا سويب bsl داخلي');
  assert.ok(String(st.stage).includes('ديسكاونت فقط'), `المرحلة: ${st.stage}`);
});

test('المرحلة: بلوغ الديسكاونت بلا تعدي bsl → بانتظار تأكيد الدخول', () => {
  const cs = buildCleanUptrend();
  const st = computeDirectionState(cs, { price: 105 });
  assert.equal(st.dir, 'up');
  assert.equal(st.stageDetail?.bslRetest, false);
  assert.ok(String(st.stage).includes('بانتظار تأكيد الدخول'), `المرحلة: ${st.stage}`);
});

test('المرحلة: تعدي bsl → تحديد ديسكاونت + ssl', () => {
  const cs = buildCleanUptrend();
  // سويب bsl داخلي بعد الانقلاب: قمة داخلية 132 (بيفوت 1m) ثم ذيل فوقها وإغلاق تحتها
  cs.push(candle(128, 132, 127.6, 129));      // index 104: قمة داخلية 132
  cs.push(...flat(129, 4));
  cs.push(candle(129, 132.6, 127.9, 128.4));  // index 109: ذيل فوق 132 وإغلاق 128.4 → سويب
  const st = computeDirectionState(cs, { price: 128.4 });
  assert.equal(st.dir, 'up');
  assert.equal(st.stageDetail?.bslRetest, true, 'سويب bsl داخلي سُجل');
  assert.ok(String(st.stage).includes('ديسكاونت + ssl'), `المرحلة: ${st.stage}`);
});

/**
 * اتجاه هابط نظيف — كل دلو 8 شموع، شمعة الكسر آخر دلوها:
 *  b0-b2 مسطح 110 · b3 قمة خارجية 120.5 · b4 · b5 قاع خارجي 94 (بيفوت مؤكد بدلوين نظيفين بعده) ·
 *  b6-b7 · b8 يُغلق 92.5 تحت 94 → كسر هابط حقيقي · b9-b14 هبوط مستقر. المجموع 120 شمعة.
 */
function buildDowntrend() {
  reset();
  const cs = [];
  cs.push(...flat(110, 24));                        // b0-b2
  cs.push(candle(110, 120.5, 109, 112));            // b3: قمة خارجية 120.5
  cs.push(...flat(112, 7));
  cs.push(...flat(112, 8));                         // b4
  cs.push(candle(112, 113, 94, 111));               // b5 (index 40): قاع خارجي 94
  cs.push(...flat(111, 7));
  cs.push(...flat(111, 8));                         // b6
  cs.push(...flat(110, 8));                         // b7 — تأكيد بيفوت القاع 94
  cs.push(candle(110, 110.5, 92, 92.5));            // b8 (index 64): إغلاق 92.5 تحت 94 → كسر هابط
  cs.push(...flat(92.5, 7));
  cs.push(...flat(91.5, 48));                       // b9-b14: هبوط مستقر حتى 120 شمعة
  return cs;
}

test('المرحلة: اتجاه هابط → رصد نهاية الهبوط', () => {
  const cs = buildDowntrend();
  const st = computeDirectionState(cs, { price: 90 });
  assert.equal(st.dir, 'down', `آخر كسر حقيقي يحكم — dir: ${st.dir}`);
  assert.equal(st.dead, false, 'السعر 90 لم يبلغ العرض الخارجي 120.5');
  assert.ok(String(st.stage).includes('رصد نهاية الهبوط'), `المرحلة: ${st.stage}`);
  assert.ok(st.deathLevel === 120.5, `مستوى الموت = أقرب bsl خارجية: ${st.deathLevel}`);
});

test('التوافق: بدون شموع 5m → single، ومع توافق → confirmed', () => {
  const cs = buildCleanUptrend();
  const s1 = computeDirectionState(cs, { price: 128 });
  assert.equal(s1.agreement, 'single');
  assert.equal(s1.dir40m, null);

  // 5m صاعدة بنفس الشكل (كل دلو 8 شموع، الكسر آخر دلوها، 12 دلو على الأقل) → confirmed
  reset();
  const bull5m = [];
  bull5m.push(...flat(100, 16));              // 0-15   b0-b1
  bull5m.push(candle(100, 101, 96, 97));      // 16     b2: قمة 101 + قاع 96
  bull5m.push(...flat(97, 7));                // 17-23
  bull5m.push(...flat(97, 8));                // 24-31  b3
  bull5m.push(...flat(97, 8));                // 32-39  b4 — تأكيد البيفوتين
  bull5m.push(candle(97, 106, 96.5, 105));    // 40     آخر b5: إغلاق 105 فوق 101
  bull5m.push(...flat(105, 7));               // 41-47
  bull5m.push(...flat(105, 56));              // 48-103 b6-b12 (13 دلو على الأقل)
const s2 = computeDirectionState(cs, { price: 128, candles5m: bull5m });
  assert.equal(s2.agreement, 'confirmed', `dir40m: ${s2.dir40m}`);
});

test('موت المشوار: HTF هابط وبلوغ العرض الخارجي → dead + stage موت', () => {
  reset();
  const cs = [];
  cs.push(...flat(110, 24));                        // b0-b2
  cs.push(candle(110, 120.5, 109, 112));            // b3: قمة خارجية 120.5
  cs.push(...flat(112, 7));
  cs.push(...flat(112, 8));                         // b4
  cs.push(candle(112, 113, 94, 111));               // b5: قاع خارجي 94
  cs.push(...flat(111, 7));
  cs.push(...flat(111, 8));                         // b6
  cs.push(...flat(110, 8));                         // b7
  cs.push(candle(110, 110.5, 92, 92.5));            // b8: كسر هابط حقيقي
  cs.push(...flat(92.5, 7));
  cs.push(...flat(91.5, 24));                       // b9-b11
  cs.push(...flat(100, 8));                         // b12
  cs.push(...flat(110, 8));                         // b13
  cs.push(...flat(119, 16));                        // b14-b15: صعود حي حتى 119 (قرب 120.5)
  const st = computeDirectionState(cs, { price: 121 });
  assert.equal(st.dir, 'down', 'لا كسر صاعد — 119 < 120.5');
  assert.equal(st.dead, true, 'السعر 121 تجاوز العرض الخارجي 120.5');
  assert.ok(String(st.stage).includes('مات'), `المرحلة: ${st.stage}`);
});

test('updateWithPrice: تحديث خفيف يقلب dead بدون إعادة تحليل', () => {
  const cs = buildDowntrend();
  const st = computeDirectionState(cs, { price: 100 });
  assert.equal(st.dead, false, '100 < 120.5 — المشوار حي');
  assert.ok(st.deathLevel === 120.5);
  const updated = updateWithPrice(st, 121);
  assert.equal(updated.dead, true, 'التحديث الخفيف يكتشف الموت');
  assert.ok(String(updated.stage).includes('مات'));
  assert.equal(updateWithPrice(st, NaN), st, 'سعر غير صالح — لا تغيير');
});

test('classifyChange: انقلاب إلى صاعد مؤكد يُشعر، وغيره لا', () => {
  const down = { dir: 'down', agreement: 'confirmed', stage: 'رصد نهاية الهبوط', dead: false };
  const up = { dir: 'up', agreement: 'confirmed', stage: 'تحديد ديسكاونت فقط', dead: false };
  const flip = classifyChange(down, up);
  assert.equal(flip.kind, 'flip');
  assert.equal(flip.notify, true, 'الانقلاب الهيكلي إلى صاعد مؤكد يستحق إشعاراً مركزياً');
  // انقلاب متعارض (8m صاعد لكن 40m مخالف) — بلا إشعار
  const flipConflicted = classifyChange(down, { ...up, agreement: 'conflicted' });
  assert.equal(flipConflicted.notify, false);
  const stageChange = classifyChange(up, { ...up, stage: 'بانتظار تأكيد الدخول' });
  assert.equal(stageChange.kind, 'stage');
  assert.equal(stageChange.notify, false);
  const death = classifyChange(up, { ...up, dead: true });
  assert.equal(death.kind, 'dead');
  assert.equal(classifyChange(up, up), null);
  assert.equal(classifyChange(null, up).kind, 'init');
});
