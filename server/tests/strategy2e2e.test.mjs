/* اختبار End-to-End لمحرك استراتيجيتي + CSSE — بلا شبكة
 * السيناريو الكامل: بيانات سوق اصطناعية → حالة → بنية → سيولة → سويب →
 * choch → إعداد → تأكيد → فرصة → تسلسل موثق → حسم (هدف) → نتيجة →
 * استمرارية بعد restart → شرح الفراغ → بوابة المعايرة.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStrategyEngine } from '../strategy2/loop.mjs';

const MS = 60_000;
let clock = 1_700_000_000;
const candle = (open, high, low, close) => {
  clock += MS / 1000;
  return { time: clock, timeMs: clock * 1000, open, high, low, close, volume: 10 };
};
const flat = (price, n) => Array.from({ length: n }, () => candle(price, price + 0.05, price - 0.05, price));
const toRaw = (cs) => cs.map(c => [c.timeMs, c.open, c.high, c.low, c.close, c.volume]);

/* نفس سيناريو نموذج 1 المثبت في strategy2.test.mjs (إشارة حتمية) */
function buildSignalSeries() {
  clock = 1_700_000_000;
  const cs = [];
  cs.push(...flat(98, 230)); // سياق تاريخي كافٍ لأي warmup
  cs.push(...flat(98, 6));
  cs.push(candle(98, 98.5, 97.2, 97.4));
  cs.push(...flat(98, 4));
  cs.push(candle(98, 98.4, 94.2, 96));
  cs.push(...flat(97, 6));
  cs.push(candle(97, 100.2, 96.8, 99.8));
  cs.push(...flat(99, 4));
  cs.push(candle(99, 101, 98.8, 99.5));
  cs.push(candle(99.5, 99.6, 97.5, 97.6));
  cs.push(candle(97.6, 97.7, 96.4, 96.5));
  cs.push(candle(96.5, 96.6, 93.8, 95));
  cs.push(...flat(97, 4));
  cs.push(candle(97, 99, 96.8, 98.5));
  cs.push(candle(98.5, 100.5, 98.2, 100.3));
  cs.push(candle(100.3, 100.9, 99.8, 100.1));
  cs.push(candle(100.1, 100.4, 98.9, 99.2));
  cs.push(...flat(99, 3));
  cs.push(candle(99, 101.6, 98.9, 101.3));
  cs.push(candle(101.3, 102, 100.8, 101.5));
  cs.push(candle(101.5, 101.6, 99.5, 99.8));
  cs.push(candle(99.8, 99.9, 98.2, 98.4));
  cs.push(candle(98.4, 98.5, 96.9, 98.2));
  cs.push(candle(98.2, 99.4, 98, 99.2));
  cs.push(candle(99.2, 99.5, 98.6, 98.8));
  cs.push(candle(98.8, 98.9, 98.2, 98.4));
  cs.push(candle(98.4, 99.8, 98.3, 99.6));
  cs.push(...flat(99.6, 2));
  return cs;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function makeHarness(series, { priceOverride = null } = {}) {
  const raw = toRaw(series);
  const broadcasts = [];
  const persisted = [];
  let price = priceOverride;
  const engine = createStrategyEngine({
    resolveTargets: async () => ['E2EUSDT'],
    fetchRawKlines: async () => raw,
    fetchPrices: async () => ({ E2EUSDT: price ?? series[series.length - 1].close }),
    market: null,
    broadcast: (m) => broadcasts.push(m),
    persist: async (row) => { persisted.push(row); },
    readCalibration: async () => null,
    readPublishedEvents: async () => [],
    readDirectionEvents: null,
    now: () => Date.now(),
    log: { log: () => {}, warn: () => {}, error: () => {} },
    config: {
      warmupBars: 30, analysisWindow: 400, maxSymbols: 5,
      entryTfs: ['5m'], minRR: 0.4, cycleMs: 60_000, tickMs: 150,
      calibrationMs: 3_600_000
    }
  });
  return {
    engine, broadcasts, persisted,
    setPrice: (p) => { price = p; },
    lastClose: series[series.length - 1].close
  };
}

test('E2E: إشارة → فرصة بتسلسل موثق → CSSE → حسم بالهدف', async () => {
  const h = makeHarness(buildSignalSeries());
  try {
    // دورة حتمية أولاً (start تُطلق دورة خلفية قد تتسابق — لا نعتمد عليها هنا)
    await h.engine.runCycle();
    h.engine.start();
    const feed = h.engine.getFeed();
    assert.equal(feed.total, 1, `متوقع فرصة واحدة — phases: ${JSON.stringify(feed.waitingPhases)} rejected: ${JSON.stringify(feed.rejected.slice(0, 3))}`);
    const op = feed.opportunities[0];
    assert.equal(op.model, 1);
    assert.ok(Array.isArray(op.sequence) && op.sequence.length >= 4, 'التسلسل موثق على الفرصة');
    assert.equal(op.setupState, 'OPPORTUNITY');
    assert.ok(h.broadcasts.some(b => b.type === 'strategy2_new'), 'بُثت strategy2_new');
    // CSSE يتذكر العناصر والأحداث
    const csse = h.engine.getCsse('E2EUSDT', '5m');
    assert.ok(csse && csse.elements.length > 0, 'عناصر مسجلة بهويات');
    assert.ok(csse.events.length > 0, 'أحداث مسجلة');
    assert.equal(csse.setup.state, 'OPPORTUNITY');
    // ادفع السعر للهدف الأول → تحديث الأسعار الاحتياطية → نبضة تحسم target
    h.setPrice(op.tp1 + 0.01);
    await h.engine.runCycle();
    await sleep(600);
    const feed2 = h.engine.getFeed();
    assert.equal(feed2.total, 0, 'حُسمت الفرصة');
    assert.equal(h.engine.getFeed().stats.wins, 1);
    assert.ok(h.broadcasts.some(b => b.type === 'strategy2_closed'), 'بُثت strategy2_closed');
    const csse2 = h.engine.getCsse('E2EUSDT', '5m');
    assert.equal(csse2.setup.state, 'RESOLVED');
  } finally {
    h.engine.stop();
  }
});

test('E2E: دورتان متزامنتان — لا ازدواج (سقف 1 لكل رمز/فريم)', async () => {
  const h = makeHarness(buildSignalSeries());
  try {
    await h.engine.runCycle();
    h.engine.start();
    await Promise.all([h.engine.runCycle(), h.engine.runCycle()]);
    assert.ok(h.engine.getFeed().total <= 1, 'فرصة واحدة كحد أقصى');
  } finally {
    h.engine.stop();
  }
});

test('E2E-H: restart يستعيد الفرصة غير المحسومة', async () => {
  const h = makeHarness(buildSignalSeries());
  let published = [];
  try {
    await h.engine.runCycle();
    h.engine.start();
    assert.equal(h.engine.getFeed().total, 1);
    published = h.persisted.filter(p => !p.closed);
    assert.ok(published.length >= 1);
  } finally {
    h.engine.stop();
  }
  // محرك جديد يقرأ نفس الأحداث الدائمة
  const h2 = makeHarness(buildSignalSeries());
  const eng2 = createStrategyEngine({
    resolveTargets: async () => ['E2EUSDT'],
    fetchRawKlines: async () => toRaw(buildSignalSeries()),
    fetchPrices: async () => ({ E2EUSDT: 99.6 }),
    market: null,
    broadcast: () => {},
    persist: async () => {},
    readCalibration: async () => null,
    readPublishedEvents: async () => published.map(o => ({ kind: 'published', ...o })),
    readDirectionEvents: null,
    now: () => Date.now(),
    log: { log: () => {}, warn: () => {}, error: () => {} },
    config: { warmupBars: 30, analysisWindow: 400, maxSymbols: 5, entryTfs: ['5m'], minRR: 0.4, cycleMs: 60_000, tickMs: 150, calibrationMs: 3_600_000 }
  });
  await eng2.restoreFromEvents();
  assert.equal(eng2.getFeed().total, 1, 'استُعيدت الفرصة');
  assert.equal(eng2.getFeed().opportunities[0].restored, true);
  eng2.stop();
  void h2;
});

test('E2E-J/K: بلا إشارة — شرح لا صمت، وبلا معايرة — لا إحصاء مضلل', async () => {
  clock = 1_700_000_000;
  const h = makeHarness(flat(100, 300));
  try {
    await h.engine.runCycle();
    h.engine.start();
    const feed = h.engine.getFeed();
    assert.equal(feed.total, 0);
    assert.ok(Object.keys(feed.waitingPhases).length > 0, 'مراحل الانتظار موثقة كسبب');
    assert.equal(feed.stats.liveWinRate, null, 'لا نسبة نجاح قبل أي حسم');
    const cal = h.engine.getCalibration();
    assert.equal(cal.at, null);
    assert.deepEqual(cal.segments, []);
  } finally {
    h.engine.stop();
  }
});

test('معايرة Strategy2 لا تُعلن الحفظ عند فشل الكتابة وتربط الإشعار بزمن التشغيل', async () => {
  const broadcasts = [];
  const engine = createStrategyEngine({
    resolveTargets: async () => [],
    fetchRawKlines: async () => [],
    persist: async () => ({ ok: false, error: new Error('db down') }),
    broadcast: message => broadcasts.push(message),
    now: () => 1_700_000_123_456,
    log: { log: () => {}, warn: () => {}, error: () => {} }
  });
  const result = await engine.runCalibration({ symbols: [] });
  const done = broadcasts.filter(message => message.type === 'strategy2_calibration_done');
  assert.equal(result.persisted, false);
  assert.equal(engine.getStatus().calibration.error, 'لم يؤكد التخزين الدائم نجاح المعايرة');
  assert.equal(done.length, 1);
  assert.equal(done[0].at, 1_700_000_123_456);
  assert.equal(done[0].persisted, false);
  engine.stop();
});

test('recoveryRequired: يمنع دورة المسح والمعايرة حتى قبل بدء المحرك', async () => {
  let targetReads = 0;
  const engine = createStrategyEngine({
    resolveTargets: async () => { targetReads += 1; return ['PENDINGUSDT']; },
    fetchRawKlines: async () => [],
    readCalibration: async () => null,
    readPublishedEvents: async () => [],
    config: { recoveryRequired: true },
    log: { log: () => {}, warn: () => {}, error: () => {} }
  });
  assert.equal(engine.getFeed().recovery.state, 'pending');
  assert.deepEqual(await engine.runCycle(), { skipped: true, recovery: 'pending' });
  assert.deepEqual(await engine.runCalibration(), { skipped: true, recovery: 'pending' });
  assert.equal(targetReads, 0);
  engine.stop();
});

test('إخفاق قراءة الاستعادة يوقف المسح والمعايرة حتى الإيقاف', async () => {
  let targetReads = 0;
  let eventReads = 0;
  const engine = createStrategyEngine({
    resolveTargets: async () => { targetReads += 1; return ['E2EUSDT']; },
    fetchRawKlines: async () => [],
    fetchPrices: async () => ({}),
    readCalibration: async () => null,
    readPublishedEvents: async () => { eventReads += 1; throw new Error('temporary database failure'); },
    log: { log: () => {}, warn: () => {}, error: () => {} },
    config: { cycleMs: 60_000, tickMs: 60_000, calibrationMs: 60_000 }
  });
  engine.start();
  try {
    for (let attempt = 0; attempt < 20 && engine.getStatus().recovery.state !== 'failed'; attempt += 1) await sleep(0);
    assert.equal(engine.getStatus().recovery.state, 'failed');
    assert.match(engine.getStatus().recovery.error, /temporary database failure/);
    assert.deepEqual(await engine.runCycle(), { skipped: true, recovery: 'failed' });
    assert.deepEqual(await engine.runCalibration(), { skipped: true, recovery: 'failed' });
    assert.equal(targetReads, 0);
  } finally {
    engine.stop();
  }
  await sleep(10);
  assert.equal(eventReads, 1, 'الإيقاف يمنع إعادة محاولة الاستعادة');
});

test('تجاوز حد استعادة أحداث Strategy2 لا يُعامل كاستعادة كاملة', async () => {
  const events = Array.from({ length: 50_000 }, () => ({ kind: 'resolved', id: 'resolved-only' }));
  const engine = createStrategyEngine({
    resolveTargets: async () => [],
    fetchRawKlines: async () => [],
    readPublishedEvents: async () => events,
    log: { log: () => {}, warn: () => {}, error: () => {} }
  });
  await assert.rejects(engine.restoreFromEvents(), /تجاوزت استعادة أحداث الاستراتيجية حد 50000 صف/);
  assert.equal(engine.getStatus().recovery.truncated, true);
  engine.stop();
});

test('اكتمال استعادة صفحات Strategy2 يميّز 50000 صف كاملة عن الاقتطاع', async () => {
  const events = Array.from({ length: 50_000 }, (_, index) => ({ kind: 'resolved', id: `resolved-${index}` }));
  const engine = createStrategyEngine({
    resolveTargets: async () => [],
    fetchRawKlines: async () => [],
    readPublishedEvents: async () => ({ rows: events, truncated: false, pages: 50 }),
    log: { log: () => {}, warn: () => {}, error: () => {} }
  });
  await engine.restoreFromEvents();
  assert.equal(engine.getStatus().recovery.eventsRead, 50_000);
  assert.equal(engine.getStatus().recovery.truncated, false);
  engine.stop();
});

test('سجل فرصة منشورة ناقص يوقف الاستعادة دون استرجاع جزئي', async () => {
  const engine = createStrategyEngine({
    resolveTargets: async () => [],
    fetchRawKlines: async () => [],
    readPublishedEvents: async () => [
      { kind: 'published', id: 'good', symbol: 'GOODUSDT', tf: '5m', detectedAt: 1_700_000_000_000, entry: 100, stop: 98, tp1: 104 },
      { kind: 'published', id: 'bad', symbol: 'BADUSDT', tf: '5m', detectedAt: 1_700_000_000_000, entry: 100, stop: 98 }
    ],
    log: { log: () => {}, warn: () => {}, error: () => {} }
  });
  await assert.rejects(engine.restoreFromEvents(), /فرصة Strategy2 غير مكتملة/);
  assert.equal(engine.getFeed().total, 0);
  engine.stop();
});

test('إعادة تشغيل Strategy2 أثناء قراءة معلقة لا تكرر أو تخلط الاستعادة', async () => {
  let eventReads = 0;
  let resolveFirstRead;
  const firstRead = new Promise(resolve => { resolveFirstRead = resolve; });
  const engine = createStrategyEngine({
    resolveTargets: async () => [],
    fetchRawKlines: async () => [],
    readCalibration: async () => null,
    readPublishedEvents: async () => {
      eventReads += 1;
      return eventReads === 1 ? firstRead : [];
    },
    log: { log: () => {}, warn: () => {}, error: () => {} },
    config: { cycleMs: 60_000, tickMs: 60_000, calibrationMs: 60_000 }
  });
  try {
    engine.start();
    for (let attempt = 0; attempt < 20 && eventReads === 0; attempt += 1) await sleep(0);
    assert.equal(eventReads, 1);
    engine.stop();
    engine.start();
    resolveFirstRead([]);
    for (let attempt = 0; attempt < 20 && engine.getStatus().recovery.state !== 'ready'; attempt += 1) await sleep(0);
    assert.equal(eventReads, 2);
    assert.equal(engine.getStatus().recovery.state, 'ready');
  } finally {
    engine.stop();
  }
});
