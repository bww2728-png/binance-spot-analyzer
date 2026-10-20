import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSegmentShadowReport, countDecidedOnce } from '../services/segmentShadow.mjs';

/**
 * ★3: العدّ المنشور لشريحة الفرصة يزيد في كل نداء متابعة لكل فرصة لم تُحسم، فيتضخّم
 * بحسب مدة الانتظار لا بحسب النتائج — فتصبح ترقية الشرائح بلا معنى. القياس هنا يحسب
 * العدّ الصحيح (مرة واحدة عند الحسم) بجانب المنشور لعرض الفرق. لا يقرأه أي قرار.
 */

test('التسجيل الظلّي: مرة واحدة لكل فرصة عند حسمها فقط', () => {
  const counted = new Set();
  const segments = new Map();
  // فرصة مفتوحة: 20 نداء متابعة بلا حسم
  for (let i = 0; i < 20; i += 1) {
    assert.equal(countDecidedOnce(counted, segments, 'OP1', null, 'segA'), false, 'لا تسجيل قبل الحسم');
  }
  assert.equal(segments.size, 0, 'الفرصة المفتوحة لا تُسجَّل إطلاقاً');
  // عند الحسم: تسجيل واحد
  assert.equal(countDecidedOnce(counted, segments, 'OP1', 'target', 'segA'), true);
  assert.equal(segments.get('segA').trades, 1);
  assert.equal(segments.get('segA').wins, 1);
  // ومحاولات لاحقة لنفس الفرصة لا تُضاعف
  for (let i = 0; i < 5; i += 1) countDecidedOnce(counted, segments, 'OP1', 'target', 'segA');
  assert.equal(segments.get('segA').trades, 1, 'لا عدّ مزدوج لنفس الفرصة');
});

test('فرصة خاسرة تُسجَّل مرة: trades يزيد و wins لا', () => {
  const counted = new Set();
  const segments = new Map();
  countDecidedOnce(counted, segments, 'OP2', 'stop', 'segB');
  assert.deepEqual(segments.get('segB'), { trades: 1, wins: 0 });
});

test('مدخلات ناقصة لا تُنتج عدّاً وهمياً', () => {
  const counted = new Set();
  const segments = new Map();
  assert.equal(countDecidedOnce(counted, segments, 'OP3', 'target', null), false, 'بلا شريحة لا تسجيل');
  assert.equal(countDecidedOnce(counted, segments, null, 'target', 'segC'), false, 'بلا معرّف لا تسجيل');
  assert.equal(segments.size, 0);
});

test('التقرير: يعرض تضخّم العدّ المنشور وفرق الشرائح المؤهّلة', () => {
  // المنشور: فرصة واحدة نظرنا إليها 300 مرة → 300 «صفقة» وهمية في الشريحة
  const published = new Map([['segA', { trades: 300, wins: 45 }]]);
  const decided = new Map([['segA', { trades: 1, wins: 1 }]]);
  const r = buildSegmentShadowReport(published, decided, 30);
  assert.equal(r.publishedTotal, 300);
  assert.equal(r.decidedTotal, 1);
  assert.equal(r.inflation, 300, 'التضخّم 300 ضعف');
  assert.equal(r.qualifiedPublished, 1, 'بالقاعدة المنشورة تُعدّ الشريحة مؤهّلة زوراً');
  assert.equal(r.qualifiedDecided, 0, 'بالقاعدة الصحيحة لا');
  assert.equal(r.qualifiedDiff, 1, 'الفرق = 1 شريحة تغيّر حكمها');
});

test('التقرير: خرائط فارغة لا تُنتج قيماً مبهمة', () => {
  const r = buildSegmentShadowReport(new Map(), new Map(), 30);
  assert.equal(r.keys, 0);
  assert.equal(r.publishedTotal, 0);
  assert.equal(r.inflation, null, 'لا تضخّم بلا عدّ');
  assert.equal(r.qualifiedDiff, 0);
});

test('التقرير: خرائط مفقودة (null) لا تُسقط شيئاً', () => {
  const r = buildSegmentShadowReport(null, undefined, 30);
  assert.equal(r.keys, 0);
  assert.equal(r.decidedTotal, 0);
});
