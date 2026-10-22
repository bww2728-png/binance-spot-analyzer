/**
 * اختبار قياس التأخّر والتجمّد في الصحة — العيب كان **غياب** القياس لا وجوده.
 *
 * الدليل من الإنتاج (البناء السابق): `lagMs.p50` = 52–82ms (سليم) بينما
 * `lagMs.p99` = 3,093–3,681ms و`max` حتى 6,891ms، و`liquidity-zones` مع ذلك يحمل
 * `lastCycleMs: null` و`extra: undefined` — أي أن **أثقل حلقة كانت بلا أي قياس زمن**.
 * بلا هذا القياس يصبح أي إصلاح تخميناً. الاختبارات هنا تثبت أن الأقسام تُنتَج فعلاً
 * وبالأرقام، وأن توليد GC يُلتقط (لا أن القسم فارغ شكلاً).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import createHealth from '../health.mjs';

function makeHealth() {
  return createHealth({ name: 'test', startedAt: Date.now() });
}

test('قسم `gc` موجود وبالبنية المطلوبة (count/major/worst)', () => {
  const h = makeHealth();
  const g = h.snapshot().gc;
  assert.equal(typeof g.count, 'number');
  assert.equal(typeof g.totalMs, 'number');
  assert.equal(typeof g.maxMs, 'number');
  assert.equal(typeof g.major.count, 'number');
  assert.equal(Array.isArray(g.worst), true);
  assert.equal(g.enabled, true, 'مراقب GC مُفعَّل');
});

test('قسم `heap` يعطي مساحات V8 ونسبة الضغط', () => {
  const h = makeHealth();
  const hp = h.snapshot().heap;
  assert.equal(Array.isArray(hp.spaces), true, 'المساحات مصفوفة');
  assert.equal(hp.spaces.length > 0, true);
  for (const sp of hp.spaces) {
    assert.equal(typeof sp.space, 'string');
    assert.equal(typeof sp.usedMb, 'number');
    assert.equal(typeof sp.pct, 'number');
  }
  assert.equal(typeof hp.heapUsedMb, 'number');
  assert.equal(typeof hp.heapLimitMb, 'number');
  assert.equal(hp.heapLimitMb > 0, true);
  assert.equal(hp.pressurePct >= 0 && hp.pressurePct <= 100.01, true, `الضغط خارج النطاق: ${hp.pressurePct}`);
});

test('المساحات مرتَّبة تنازلياً بالاستهلاك (أكبر مستهلك أولاً)', () => {
  const spaces = makeHealth().snapshot().heap.spaces;
  for (let i = 1; i < spaces.length; i += 1) {
    assert.equal(spaces[i - 1].usedMb >= spaces[i].usedMb, true, 'الترتيب يجب أن يكون تنازلياً');
  }
});

test('توليد ضغط ذاكرة يُلتقط فعلاً في `gc` (لا قسم شكلي فارغ)', async () => {
  const h = makeHealth();
  const before = h.snapshot().gc.count;
  const hold = [];
  for (let i = 0; i < 30; i += 1) {
    hold.push(new Array(200_000).fill(i));   // ~1.6MB للمصفوفة ⇒ ضغط يفرض GC
    if (i % 10 === 9 && global.gc) global.gc();
  }
  await new Promise(r => setTimeout(r, 250));   // المراقب يعالج الأحداث في ميكروتاسك
  const after = h.snapshot().gc;
  assert.equal(after.count > before, true, `لم يُلتقط أي GC (قبل ${before} وبعد ${after.count})`);
  assert.equal(after.totalMs > 0, true, 'الزمن المتراكم يجب أن يكون موجباً');
  hold.length = 0;
});

test('`heapSpaces()` مستقل عن العيّنة ويُقرأ بلا أثر جانبي', () => {
  const h = makeHealth();
  const a = h.heapSpaces();
  const b = h.heapSpaces();
  assert.deepEqual(Object.keys(a), Object.keys(b), 'نفس الشكل في كل نداء');
  assert.equal(typeof a.pressurePct, 'number');
});

test('`resetLag` و`gcSnapshot` موجودان ومتوافقان خلفياً', () => {
  const h = makeHealth();
  assert.equal(typeof h.resetLag, 'function');
  assert.equal(typeof h.gcSnapshot, 'function');
  h.resetLag();
  assert.equal(typeof h.snapshot().lagMs.p99, 'number');
});

test('العيّنة تُحفظ بحمولة مضغوطة مع الأقسام الجديدة (gc/heap تُحفظ كأرقام)', async () => {
  const { compactSample } = await import('../health.mjs');
  const h = makeHealth();
  h.startSampler({
    db: { health: { append: async () => {} } },
    intervalMs: 600_000,
    log: { log() {}, error() {}, warn() {} }
  });
  const snap = h.snapshot();
  const compacted = compactSample(snap);
  assert.equal(typeof compacted.gc.count, 'number', 'عدّاد GC يبقى رقماً');
  /**
   * مساحات V8 مصفوفة كائنات، فالضغط يحفظ رأسها (أكبر المساحات بالترتيب) ويذكر
   * الطول الكامل — والمساحات المتبقية صفرية دائماً (شاهد القياس: 8 مساحات من 12
   * كلها 0.0MB)، فلا تُفقد معلومة.
   */
  assert.equal(compacted.heap.spaces.n, snap.heap.spaces.length, 'الطول الكامل محفوظ');
  assert.equal(Array.isArray(compacted.heap.spaces.head), true, 'أكبر المساحات محفوظة بتفاصيلها');
  assert.equal(compacted.heap.spaces.head[0].space, snap.heap.spaces[0].space, 'أكبر مستهلك يبقى أولاً');
  assert.equal(compacted.heap.spaces.head[0].usedMb, snap.heap.spaces[0].usedMb);
  assert.equal(typeof compacted.heap.pressurePct, 'number');
  assert.equal(compacted.heap.pressurePct, snap.heap.pressurePct, 'نسبة الضغط الحاسمة تُحفظ كما هي');
});
