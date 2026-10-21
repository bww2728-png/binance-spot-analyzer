/**
 * اختبار حمولة حدث الاتجاه المضغوطة (استراتيجيتي).
 *
 * القياس بعد رفع التغطية إلى 472 عملة: `strategy2_direction` بلغ ~73 ألف صف/24 ساعة
 * (≈47 ميغابايت/يوم)، وكل صف 674 بايت، ومنها تكرار بلا معلومة:
 *  - `message` كان يعيد المرحلة مرتين: «تغير المرحلة: X — المرحلة: X».
 *  - `meta` كان يحمل `label` المشتق من `stage`، و`symbol` مكرراً، و`zone` غير مقروء.
 * بعد الضغط: 433 بايت/صف ⇒ توفير 35.8% (≈30MB/يوم)، بلا فقدان أي حقل يقرأه
 * الاسترجاع (`symbol, tf, dir, prevDir, dirTF, dirHTF, htfTf, stage, kind, at`).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

/** الحقول التي يقرأها `readDirectionEvents` فعلاً (نُسخة مرآة للعقد) */
const RESTORE_FIELDS = ['symbol', 'tf', 'dir', 'prevDir', 'dirTF', 'dirHTF', 'htfTf', 'stage', 'kind', 'at'];

function buildPersist(row) {
  // نفس منطق `persist` في الخادم (حمولة مضغوطة بلا label ولا symbol مكرر)
  const label = row.label ?? (row.stage ? `تغير المرحلة: ${row.stage}` : 'تغير مرحلة');
  const message = `${row.symbol} ${row.tf ?? '1m'}: ${row.stage ?? label}`;
  const opportunity = {
    symbol: row.symbol, tf: row.tf ?? '1m',
    dir: row.dir, prevDir: row.prevDir ?? null,
    dirTF: row.dirTF ?? null, dirHTF: row.dirHTF ?? null, htfTf: row.htfTf ?? null,
    stage: row.stage, kind: row.kind, at: row.at
  };
  return { symbol: row.symbol, message, meta: JSON.stringify({ opportunity }) };
}

const sampleRow = {
  symbol: 'BTCUSDT', tf: '15m', dir: 'bull', prevDir: 'bear',
  dirTF: 'bull', dirHTF: 'bull', htfTf: '1h', stage: 'تشكّل', kind: 'direction-flip',
  at: 1792445000000, label: 'تغير المرحلة: تشكّل',
  zone: { id: 'x', price: 83000, kind: 'horizontal_bsl', meta: 'z' },
  notify: true, eventType: 'direction'
};

test('الحمولة المخزَّنة تحمل كل حقل يقرأه الاسترجاع', () => {
  const p = buildPersist(sampleRow);
  const o = JSON.parse(p.meta).opportunity;
  for (const f of RESTORE_FIELDS) {
    assert.equal(f in o, true, `الحقل ${f} مفقود — الاسترجاع سيفقد معلومة`);
  }
  assert.equal(o.symbol, 'BTCUSDT');
  assert.equal(o.stage, 'تشكّل');
  assert.equal(o.at, 1792445000000);
});

test('`label` يُشتق عند القراءة (حُذف من التخزين لتقليل الحمولة)', () => {
  const p = buildPersist(sampleRow);
  const o = JSON.parse(p.meta).opportunity;
  assert.equal('label' in o, false, 'label ليس في الحمولة المخزَّنة');
  // القارئ يعيده مشتقاً فلا ينكسر أي مستهلك
  const restored = { ...o, label: o.label ?? (o.stage ? `تغير المرحلة: ${o.stage}` : 'تغير مرحلة') };
  assert.equal(restored.label, 'تغير المرحلة: تشكّل');
});

test('الرسالة لا تكرر المرحلة (كانت «… : X — المرحلة: X»)', () => {
  const p = buildPersist(sampleRow);
  const occurrences = p.message.split('تشكّل').length - 1;
  assert.equal(occurrences, 1, `المرحلة مذكورة ${occurrences} مرة في الرسالة`);
  assert.equal(p.message.includes('— المرحلة:'), false, 'لا تكرار للعنوان');
});

test('الحقول الزائدة غير المقروءة لا تُخزَّن (zone/notify/eventType)', () => {
  const p = buildPersist(sampleRow);
  for (const k of ['zone', 'notify', 'eventType']) {
    assert.equal(p.meta.includes(`"${k}"`), false, `الحقل ${k} لا فائدة منه في الرمز المحفوظ`);
  }
});

test('الحمولة الجديدة أصغر فعلاً من القديمة (نفس الصف)', () => {
  const old = { symbol: sampleRow.symbol, message: `${sampleRow.symbol}: ${sampleRow.label} — المرحلة: ${sampleRow.stage}`, meta: JSON.stringify({ opportunity: sampleRow }) };
  const now = buildPersist(sampleRow);
  const before = Buffer.byteLength(JSON.stringify({ ...old, type: 'strategy2_direction', ts: 1 }), 'utf8');
  const after = Buffer.byteLength(JSON.stringify({ ...now, type: 'strategy2_direction', ts: 1 }), 'utf8');
  assert.equal(after < before, true, `الحجم ${after} يجب أن يقل عن ${before}`);
  assert.equal(after / before < 0.8, true, `التقليص ضعيف: ${(after / before).toFixed(3)}`);
});

test('الصف بلا `tf` يعود إلى 1m بلا انفجار (تحمّل مدخل ناقص)', () => {
  const p = buildPersist({ symbol: 'X', stage: 'مات', dir: 'bull', at: 1, kind: 'x' });
  const o = JSON.parse(p.meta).opportunity;
  assert.equal(o.tf, '1m');
  assert.equal(p.message.includes('1m'), true);
});
