/**
 * اختبار وضع الظل (★) — الضمانة الملزمة:
 *  1) الإصلاحات ★ لا تؤثر على أي قرار منشور (القياس فقط).
 *  2) الفروق تُرصد وتُجمَّع بحدود ذاكرة آمنة.
 *  3) تعطيل القياس بالمتغير SHADOW_MODE=0 يوقف كل شيء.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createShadow, SHADOW_FIXES } from '../services/shadow.mjs';

test('كل الإصلاحات ★ معروفة ولها وصف عربي واضح', () => {
  const keys = Object.keys(SHADOW_FIXES);
  /**
   * السبعة: الستة الأصلية + `zone-id-candidate` (قياس المعرّف المرشَّح من محتوى
   * المنطقة لعدة شبكات). إضافة مفتاح جديد مقصودة ولا يغيّر سلوكاً: كل مفتاح هنا
   * قياس-فقط، وشرط التفعيل يبقى موافقتك الصريحة بعد عرض الدليل.
   */
  assert.equal(keys.length, 7, 'سبعة إصلاحات ★: الستة الأصلية + قياس المعرّف المرشَّح');
  for (const [k, v] of Object.entries(SHADOW_FIXES)) {
    assert.ok(k && typeof k === 'string');
    assert.ok(v && v.length > 5, `وصف ${k} موجود`);
  }
});

test('الإصلاحات ★ غير مُفعَّلة افتراضياً (قياس فقط)', () => {
  const shadow = createShadow();
  const sum = shadow.summary();
  assert.equal(sum.enabled, true, 'القياس مُفعَّل افتراضياً');
  assert.equal(sum.records.length, 0, 'لا سجلات قبل أي قياس');
  // التقرير يذكر صراحةً أن شيئاً لم يُفعَّل
  assert.match(sum.note, /لم يُفعَّل/, 'تنبيه صريح بعدم التفعيل');
  // لا يوجد في الواجهة أي دالة تُعيد قراراً للاستخدام
  assert.equal(typeof shadow.compare, 'function');
  assert.equal(shadow.decide, undefined, 'لا واجهة «قرار» — الظل للقياس فقط');
});

test('تقرير الظل يبقى عبر إعادة التشغيل (مخزن الحالة الدائم)', async () => {
  const store = new Map();
  const fakeDb = {
    engineState: {
      put: async (k, v) => { store.set(k, JSON.parse(JSON.stringify(v))); },
      get: async (k) => store.get(k) ?? null
    }
  };
  const first = createShadow();
  // المقارنة: (المفتاح، القرار المنشور، قرار الظل) — تطابق JSON = اتفاق
  first.compare('s2-closed-bars-only', { d: 'a' }, { d: 'a' });
  first.compare('s2-closed-bars-only', { d: 'b' }, { d: 'b' });
  first.compare('s2-closed-bars-only', { d: 'c' }, { d: 'd' });
  assert.equal(await first.persistDb(fakeDb), true, 'حُفظ في القاعدة');
  assert.ok(store.has('shadow_report'), 'مفتاح التقرير موجود');

  // عملية جديدة (كما بعد إعادة النشر): تبدأ من صفر ثم تستعيد
  const second = createShadow();
  assert.equal(second.summary().records.length, 0, 'قبل الاستعادة: لا سجلات (صفر تراكم)');
  const loaded = await second.loadDb(fakeDb);
  assert.ok(loaded, 'قُرئ التقرير المحفوظ');
  const rec = second.summary().records.find(r => r.key === 's2-closed-bars-only');
  assert.equal(rec.samples, 3, 'العيّنات الثلاث عادت بعد إعادة التشغيل');
  assert.equal(rec.agree, 2);
  assert.equal(rec.diff, 1);
});

test('لا يُحفظ شيء إن كان المخزن الدائم غير متاح (لا فشل صامت أو انهيار)', async () => {
  const shadow = createShadow();
  assert.equal(await shadow.persistDb(null), false);
  assert.equal(await shadow.persistDb({}), false);
  assert.equal(await shadow.loadDb({ engineState: { get: async () => { throw new Error('شبكة'); } } }), null, 'خطأ الشبكة لا يُسقط شيئاً');
});

test('المقارنة ترصد الاتفاق والاختلاف بدقة', () => {
  const shadow = createShadow();
  shadow.compare('s2-closed-bars-only', { decision: 'up' }, { decision: 'up' }, (a, b) => a.decision === b.decision);
  shadow.compare('s2-closed-bars-only', { decision: 'up' }, { decision: 'down' }, (a, b) => a.decision === b.decision);
  shadow.compare('s2-closed-bars-only', { decision: null }, { decision: 'down' }, (a, b) => a.decision === b.decision);
  const rec = shadow.summary().records.find(r => r.key === 's2-closed-bars-only');
  assert.equal(rec.samples, 3);
  assert.equal(rec.agree, 1);
  assert.equal(rec.diff, 2);
  assert.equal(rec.diffRate, Number((2 / 3).toFixed(4)));
  assert.equal(rec.examples.length, 2, 'أمثلة الفروق محفوظة');
});

test('المقارنة بلا دالة تساوٍ تستخدم التطابق الحرفي', () => {
  const shadow = createShadow();
  shadow.compare('k', { a: 1 }, { a: 1 });
  shadow.compare('k', { a: 1 }, { a: 2 });
  const rec = shadow.summary().records.find(r => r.key === 'k');
  assert.equal(rec.agree, 1);
  assert.equal(rec.diff, 1);
});

test('عدد الأمثلة محدود (منع تضخّم الذاكرة)', () => {
  const shadow = createShadow();
  for (let i = 0; i < 500; i += 1) shadow.compare('k', { v: i }, { v: i + 1 });
  const rec = shadow.summary().records.find(r => r.key === 'k');
  assert.equal(rec.samples, 500);
  assert.equal(rec.diff, 500);
  assert.ok(rec.examples.length <= 25, `الأمثلة محدودة (${rec.examples.length})`);
});

test('SHADOW_MODE=0 يوقف القياس تماماً', () => {
  const prev = process.env.SHADOW_MODE;
  process.env.SHADOW_MODE = '0';
  try {
    const shadow = createShadow();
    assert.equal(shadow.enabled, false, 'القياس معطّل بالمتغير');
  } finally {
    if (prev === undefined) delete process.env.SHADOW_MODE;
    else process.env.SHADOW_MODE = prev;
  }
});

test('التقرير قابل للحفظ والقراءة (يتراكم عبر إعادات التشغيل)', async () => {
  const { mkdtempSync, readFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const dir = mkdtempSync(path.join(tmpdir(), 'shadow-'));
  const a = createShadow({ dir });
  a.compare('k', { v: 1 }, { v: 2 });
  a.persist();
  const raw = JSON.parse(readFileSync(path.join(dir, 'shadow-report.json'), 'utf8'));
  assert.equal(raw.records[0].samples, 1);
  // نسخة جديدة تقرأ التراكم السابق
  const b = createShadow({ dir });
  b.load();
  b.compare('k', { v: 1 }, { v: 1 });
  const rec = b.summary().records.find(r => r.key === 'k');
  assert.equal(rec.samples, 2, 'التراكم محفوظ عبر إعادة التشغيل');
  assert.equal(rec.diff, 1);
});
