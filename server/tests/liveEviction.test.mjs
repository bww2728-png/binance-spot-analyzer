import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLiveOpportunityEngine } from '../live-opportunities/loop.mjs';

/** محرك مصغّر: بلا مناطق جديدة (zoneSource فارغ) — الاستعادة تُغذّي المتابعة مباشرة،
 *  وrunCycle يشغّل trackOutcomes على الأسعار. هذا مسار تكامل حقيقي لا اختبار وحدة معزول.
 */
function makeEngine({ config = {} } = {}) {
  const persistCalls = [];
  let price = 100;
  let clock = 1_000_000;
  const engine = createLiveOpportunityEngine({
    now: () => clock,
    broadcast: () => {},
    persist: async (row) => { persistCalls.push(row); return { ok: true }; },
    zoneSource: () => [],
    resolveTargets: async () => ['BTCUSDT'],
    fetchPrices: async () => ({ BTCUSDT: price }),
    fetchBookSignals: async () => ({}),
    fetchRawKlines: async () => [],
    readCalibration: async () => null,
    log: { warn() {}, error() {}, log() {}, info() {} },
    config
  });
  return { engine, persistCalls, setPrice: (p) => { price = p; }, status: () => engine.getStatus(), advance: (ms) => { clock += ms; } };
}

const mkOp = (id, detectedAt) => ({
  id, symbol: 'BTCUSDT', timeframe: '5m', zoneId: `z-${id}`, kind: 'ssl',
  level: 98, referenceLevel: 100, stop: 96, tp: 105, entry: 99,
  composite: 0.9, rr: 2, confidence: 0.8, direction: 'up',
  detectedAt, outcome: null
});

const rehydrateOps = (engine, ids, extra = {}) => engine.rehydrate(
  ids.map((id, i) => ({ type: 'live_opportunity', symbol: 'BTCUSDT', ts: 900_000 + i, meta: JSON.stringify({ opportunity: mkOp(id, 800_000 + i * 1000) }) })),
  { lifecycle: { ok: true, count: 0 }, opportunities: { ok: true, count: ids.length }, ...extra }
);

test('P0 §7.2: تجاوز publishLimit لا يُنهي المتابعة ولا يُسجّل نتيجة اصطناعية', async () => {
  const { engine, persistCalls, status } = makeEngine({ config: { publishLimit: 2, trackOverflowLimit: 10 } });
  rehydrateOps(engine, ['o1', 'o2', 'o3', 'o4']);
  const st = status();
  // الأقدم (o1, o2) خرج من بطاقات العرض إلى المتابعة المؤجلة
  assert.equal(st.deferredTracking, 2, 'الفائض يُتابَع في المجموعة المؤجلة');
  assert.equal(st.evictedFromFeed, 2, 'الإخلاء من العرض معدود');
  assert.equal(st.evictedTracked, 0, 'لا إغلاق تشغيلي تحت السقف');
  // الدليل الحاسم: لا صف مغلق/منتهٍ أُنشئ بسبب الإخلاء
  const synthetic = persistCalls.filter(r => r.closed && r.exitReason?.startsWith('evicted'));
  assert.equal(synthetic.length, 0, 'لا نتيجة اصطناعية بسبب تجاوز حد العرض');
  // كل الأربعة ما زالت نشطة (بلا outcome) => ستُتابَع
  assert.equal(st.rehydrated.opportunities, 4);
});

test('P0 §7.2: الفرصة خارج العرض تُحسم بنتيجتها الحقيقية لا بـ expired', async () => {
  const { engine, persistCalls, setPrice, status, advance } = makeEngine({ config: { publishLimit: 2, trackOverflowLimit: 10 } });
  rehydrateOps(engine, ['o1', 'o2', 'o3', 'o4']);
  persistCalls.length = 0;
  setPrice(106); // يصيب الهدف لكل الفرص (tp=105)
  await engine.runCycle();
  const closed = persistCalls.filter(r => r.closed === true);
  assert.ok(closed.length >= 4, `كل الفرص الأربع تُحسم (حصلنا على ${closed.length})`);
  assert.ok(closed.every(r => r.outcome === 'target'), 'النتيجة الحقيقية target — لا expired اصطناعي');
  // فرقة العرض (3 دقائق): تُحفظ النتيجة فوراً ثم تُرحَّل من الخرائط بعد انقضائها
  advance(4 * 60_000);
  await engine.runCycle();
  const st = status();
  assert.equal(st.deferredTracking, 0, 'المتابعة المؤجلة تفرغ بعد الحسم والترحيل');
});

test('P0 §7.2: السعة التشغيلية الصلبة trackOverflowLimit لها سبب صريح وعداد', () => {
  const { engine, persistCalls, status } = makeEngine({ config: { publishLimit: 2, trackOverflowLimit: 3 } });
  // 6 فرص: 2 في العرض، 4 إلى المؤجلة، السقف 3 ⇒ الأقدم يُغلق تشغيلياً
  rehydrateOps(engine, ['o1', 'o2', 'o3', 'o4', 'o5', 'o6']);
  const st = status();
  assert.equal(st.deferredTracking, 3, 'المتابعة المؤجلة ملتزمة بسقفها');
  assert.equal(st.evictedTracked, 1, 'إغلاق تشغيلي واحد معدود');
  const evicted = persistCalls.filter(r => r.closed && r.exitReason === 'evicted-track-limit');
  assert.equal(evicted.length, 1, 'الإغلاق التشغيلي بسبب صريح موثّق');
  assert.equal(evicted[0].id, 'o1', 'الأقدم هو المُغلق');
  assert.equal(evicted[0].outcome, 'expired', 'انتهاء تشغيلي معلن — وليس TP/SL مختلق');
});

test('P0 §7.2: إعادة الاستعادة لا تُضاعف الفرص الموجودة في المتابعة المؤجلة', () => {
  const { engine, status } = makeEngine({ config: { publishLimit: 2, trackOverflowLimit: 10 } });
  rehydrateOps(engine, ['o1', 'o2', 'o3']);
  rehydrateOps(engine, ['o1', 'o2', 'o3']); // نفس الأحداث مرة أخرى (إعادة محاولة استعادة)
  const st = status();
  const total = st.rehydrated.opportunities + st.deferredTracking;
  assert.ok(total <= 3, `لا ازدواجية بعد إعادة الاستعادة (المجموع ${total})`);
});
