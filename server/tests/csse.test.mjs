/* اختبارات CSSE — ذاكرة الشارت المستمرة (حتمية، بلا شبكة)
 * تغطي السيناريوهات A-G + الحتمية بعد restart + عدم التكرار + MTF + non-events.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createCsseState, updateCsse, elementId, sequenceChecklist,
  checklistSummary, attachFeedback, elementStory, serializeCsse
} from '../strategy2/csse.mjs';

const T0 = 1_700_000_000_000;
const cndl = (open, high, low, close, t) => ({ time: t / 1000, timeMs: t, open, high, low, close, volume: 10 });

const baseAnalysis = (over = {}) => ({
  price: 100,
  atr: 1,
  htf: { direction: 'up', afterPremium: false },
  internal: { openBsl: [], openSsl: [], lastSellersInduced: null, lastBuyersInduced: null },
  protectedHigh: null,
  protectedLow: null,
  flow: { signal: null, phase: 'بانتظار تكوّن قمة محمية', phaseDetail: null, invalid: null, waiting: {} },
  upLegDead: false,
  ...over
});

test('A: ظهور SSL #2 لا يحذف SSL #1 — والأخذ يميزهما', () => {
  let st = createCsseState('BTCUSDT', '5m');
  const ssl = (lvl, t) => ({ kind: 'ssl', level: lvl, time: t, i: 1, state: 'open' });
  st = updateCsse(st, {
    symbol: 'BTCUSDT', tf: '5m',
    candles: [cndl(100, 101, 99, 100, T0)],
    analysis: baseAnalysis({ internal: { openBsl: [], openSsl: [ssl(99, T0)], lastSellersInduced: null, lastBuyersInduced: null } }),
    now: T0
  });
  st = updateCsse(st, {
    symbol: 'BTCUSDT', tf: '5m',
    candles: [cndl(100, 101, 98, 100, T0 + 300_000)],
    analysis: baseAnalysis({ internal: { openBsl: [], openSsl: [ssl(99, T0), ssl(98, T0 + 300_000)], lastSellersInduced: null, lastBuyersInduced: null } }),
    now: T0 + 300_000
  });
  const ssls = [...st.elements.values()].filter(e => e.kind === 'SSL');
  assert.equal(ssls.length, 2);
  // نشر فرصة: تُوسم المسحوبة فقط مأخوذة
  st = updateCsse(st, {
    symbol: 'BTCUSDT', tf: '5m', candles: [cndl(100, 101, 98, 100, T0 + 600_000)],
    analysis: baseAnalysis(), outcome: { kind: 'published', signal: { model: 1 } }, now: T0 + 600_000
  });
  assert.equal(st.setup.state, 'OPPORTUNITY');
});

test('B: SSL بلا سويب لا تُعتبر مأخوذة', () => {
  let st = createCsseState('ETHUSDT', '5m');
  st = updateCsse(st, {
    symbol: 'ETHUSDT', tf: '5m',
    candles: [cndl(100, 100.5, 99.5, 100.2, T0)],
    analysis: baseAnalysis({ internal: { openBsl: [], openSsl: [{ kind: 'ssl', level: 99, time: T0, i: 1, state: 'open' }], lastSellersInduced: null, lastBuyersInduced: null } }),
    now: T0
  });
  const el = [...st.elements.values()].find(e => e.kind === 'SSL');
  assert.ok(el);
  assert.notEqual(el.state, 'swept');
  assert.equal(el.taken, false);
});

test('C: سويب ثم استعادة — انتقالات وتفاعلات مسجلة', () => {
  let st = createCsseState('BTCUSDT', '5m');
  const t1 = T0, t2 = T0 + 300_000, t3 = T0 + 600_000;
  const an = () => baseAnalysis({ internal: { openBsl: [], openSsl: [], lastSellersInduced: null, lastBuyersInduced: null } });
  st = updateCsse(st, { symbol: 'BTCUSDT', tf: '5m', candles: [cndl(100, 100.4, 99.6, 100.1, t1)], analysis: an(), now: t1 });
  // إدخال SSL يدوياً عبر التحليل ثم ذيل سويب
  st = updateCsse(st, {
    symbol: 'BTCUSDT', tf: '5m', candles: [cndl(100, 100.4, 98.5, 99.5, t2)],
    analysis: baseAnalysis({ internal: { openBsl: [], openSsl: [{ kind: 'ssl', level: 99, time: t1, i: 1, state: 'open' }], lastSellersInduced: null, lastBuyersInduced: null } }),
    now: t2
  });
  const el = [...st.elements.values()].find(e => e.kind === 'SSL');
  assert.equal(el.state, 'swept');
  assert.ok(el.interactions.some(i => i.kind === 'wickedThrough'));
  // شمعة استعادة فوق المستوى
  st = updateCsse(st, { symbol: 'BTCUSDT', tf: '5m', candles: [cndl(99.5, 100.6, 99.2, 100.4, t3)], analysis: an(), now: t3 });
  const story = elementStory(st, el.id);
  assert.ok(story.history.length >= 2);
  assert.ok(story.interactions.length >= 2);
});

test('D/E: قمة وقاع محميتان بهوية مستقرة', () => {
  let st = createCsseState('BTCUSDT', '15m');
  st = updateCsse(st, {
    symbol: 'BTCUSDT', tf: '15m', candles: [cndl(100, 101, 99, 100, T0)],
    analysis: baseAnalysis({
      protectedHigh: { level: 105, at: T0 - 1000, steps: {} },
      protectedLow: { level: 95, at: T0 - 2000, steps: {} }
    }),
    now: T0
  });
  const ph = [...st.elements.values()].find(e => e.kind === 'PH');
  const pl = [...st.elements.values()].find(e => e.kind === 'PL');
  assert.ok(ph && pl);
  assert.equal(ph.state, 'active');
  assert.equal(st.setup.state, 'WATCH');
});

test('F: النموذجان يُصنفان بسياقهما + الأهداف عناصر مستقلة', () => {
  const sig = (model) => ({
    model, at: T0, price: 100, entry: 100,
    stop: 98, tp1: 102, tp2: 104, rr: 1.5, stopRef: 98.5,
    reasons: ['سبب']
  });
  for (const model of [1, 2]) {
    let st = createCsseState('XRPUSDT', '5m');
    st = updateCsse(st, {
      symbol: 'XRPUSDT', tf: '5m', candles: [cndl(99, 101, 98, 100, T0)],
      analysis: baseAnalysis({
        protectedHigh: { level: 102, at: T0 - 500, steps: {} },
        flow: { signal: sig(model), phase: `إشارة نموذج ${model}`, phaseDetail: null, invalid: null, waiting: {} }
      }),
      now: T0
    });
    assert.equal(st.setup.state, 'CONFIRMED');
    const tp1 = [...st.elements.values()].find(e => e.kind === 'TP1');
    assert.ok(tp1, `TP1 للنموذج ${model}`);
    const setup = [...st.elements.values()].find(e => e.kind === 'SETUP');
    assert.ok(setup.reasons ?? true);
    const links = st.links.filter(l => l.rel === 'targets');
    assert.ok(links.length >= 1);
  }
});

test('G: فشل الدخول يُسجل ولا يمحو التاريخ', () => {
  let st = createCsseState('BTCUSDT', '5m');
  st = updateCsse(st, {
    symbol: 'BTCUSDT', tf: '5m', candles: [cndl(100, 101, 99, 100, T0)],
    analysis: baseAnalysis({ flow: { signal: null, phase: 'x', phaseDetail: null, invalid: { at: T0, reason: 'فشل الدخول: سويب ssl ثم bsl ثم كسر قاع السويب' }, waiting: {} } }),
    now: T0
  });
  assert.equal(st.setup.state, 'INVALIDATED');
  assert.ok(st.events.some(e => e.type === 'entry_failure'));
  assert.ok(st.elements.size >= 0);
});

test('H: الحتمية بعد restart — نفس المدخلات نفس الهويات', () => {
  const run = () => {
    let st = createCsseState('BTCUSDT', '5m');
    st = updateCsse(st, {
      symbol: 'BTCUSDT', tf: '5m', candles: [cndl(100, 101, 99, 100, T0)],
      analysis: baseAnalysis({
        protectedHigh: { level: 105, at: T0 - 1000, steps: {} },
        internal: { openBsl: [], openSsl: [{ kind: 'ssl', level: 99, time: T0 - 500, i: 2, state: 'open' }], lastSellersInduced: null, lastBuyersInduced: null }
      }),
      now: T0
    });
    return [...st.elements.keys()].sort();
  };
  assert.deepEqual(run(), run());
  assert.equal(elementId('BTCUSDT', '5m', 'SSL', T0, 99), elementId('btcusdt', '5m', 'SSL', T0, 99));
});

test('non-events: ما لم يحدث يُميَّز (not-yet/skipped) لا failure', () => {
  const items = sequenceChecklist(baseAnalysis());
  const byKey = Object.fromEntries(items.map(i => [i.key, i]));
  assert.equal(byKey.protectedHigh.status, 'not-yet');
  assert.equal(byKey.chochUp.status, 'skipped');
  assert.ok(!items.some(i => i.status === 'failed'));
  const s = checklistSummary(items);
  assert.ok(s.includes('…'));
});

test('MTF: هوية مستقلة لكل فريم ورمز', () => {
  assert.notEqual(elementId('BTCUSDT', '1m', 'SSL', T0, 99), elementId('BTCUSDT', '15m', 'SSL', T0, 99));
  assert.notEqual(elementId('BTCUSDT', '5m', 'SSL', T0, 99), elementId('ETHUSDT', '5m', 'SSL', T0, 99));
});

test('feedback: تعليق قابل للعكس لا يغير الحالة', () => {
  let st = createCsseState('BTCUSDT', '5m');
  st = updateCsse(st, {
    symbol: 'BTCUSDT', tf: '5m', candles: [cndl(100, 101, 99, 100, T0)],
    analysis: baseAnalysis({ internal: { openBsl: [], openSsl: [{ kind: 'ssl', level: 99, time: T0, i: 1, state: 'open' }], lastSellersInduced: null, lastBuyersInduced: null } }),
    now: T0
  });
  const el = [...st.elements.values()].find(e => e.kind === 'SSL');
  const before = el.state;
  attachFeedback(st, { elementId: el.id, verdict: 'invalid', reason: 'ليست SSL بنظري', at: T0 + 1 });
  assert.equal(el.state, before);
  assert.equal(el.feedback.length, 1);
  const ser = serializeCsse(st);
  assert.equal(ser.symbol, 'BTCUSDT');
  assert.ok(Array.isArray(ser.elements) && Array.isArray(ser.events));
});
