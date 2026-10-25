import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLiveOpportunityRecovery } from '../live-opportunities/recovery.mjs';
import { createLiveOpportunityEngine } from '../live-opportunities/loop.mjs';

function makeEngine() {
  const events = [];
  let recovery = { state: 'pending', error: null };
  let calibrationReads = 0;
  let starts = 0;
  let pause = { paused: false, pauseUpdatedAt: null };
  const engine = {
    async loadCalibration() { calibrationReads += 1; },
    setPaused(paused, pauseUpdatedAt) {
      pause = { paused, pauseUpdatedAt };
      events.push(`paused:${paused}`);
    },
    setRecoveryState(state, details = {}) {
      recovery = { state, error: details.error ?? null, metadata: details.metadata ?? null };
      events.push(`state:${state}`);
    },
    rehydrate(rows, metadata) {
      events.push(`rehydrate:${rows.length}`);
      recovery = { state: 'ready', error: null, metadata };
      return { inputRows: rows.length };
    },
    getStatus() { return { recovery }; },
    start() { starts += 1; events.push('start'); }
  };
  return { engine, events, starts: () => starts, calibrationReads: () => calibrationReads, pause: () => pause };
}

function fakeTimers() {
  const tasks = [];
  return {
    tasks,
    setTimeoutFn(fn, delay) {
      const task = { fn, delay, cleared: false, unref() {} };
      tasks.push(task);
      return task;
    },
    clearTimeoutFn(task) { task.cleared = true; }
  };
}

const emptyPage = async () => ({ rows: [], pages: 0, truncated: false });

test('live recovery: keeps the engine paused after a read error and retries into a valid empty history', async () => {
  const h = makeEngine();
  const timers = fakeTimers();
  let reads = 0;
  const recovery = createLiveOpportunityRecovery({
    engine: h.engine,
    readLifecycle: async () => {
      reads += 1;
      if (reads === 1) throw new Error('db unavailable');
      return emptyPage();
    },
    readOpportunities: emptyPage,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    log: { log() {}, error() {} }
  });
  const failed = await recovery.runNow();
  assert.equal(failed.ok, false);
  assert.equal(h.engine.getStatus().recovery.state, 'failed');
  assert.equal(h.starts(), 0);
  assert.equal(recovery.getState().retryScheduled, true);
  assert.equal(timers.tasks[0].delay, 30_000);
  timers.tasks[0].fn();
  for (let attempt = 0; attempt < 10 && h.starts() === 0; attempt += 1) await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.engine.getStatus().recovery.state, 'ready');
  assert.equal(h.starts(), 1);
  assert.equal(h.calibrationReads(), 2);
  assert.ok(h.events.includes('rehydrate:0'));
  assert.equal(recovery.getState().attempt, 0);
});

test('live recovery: restores the persisted emergency pause before starting the engine', async () => {
  const h = makeEngine();
  const recovery = createLiveOpportunityRecovery({
    engine: h.engine,
    readLifecycle: emptyPage,
    readOpportunities: emptyPage,
    readPauseState: async () => ({ paused: true, pauseUpdatedAt: 1_700_000_000_000 }),
    log: { log() {}, error() {} }
  });

  const result = await recovery.runNow();

  assert.equal(result.ok, true);
  assert.deepEqual(h.pause(), { paused: true, pauseUpdatedAt: 1_700_000_000_000 });
  assert.ok(h.events.indexOf('paused:true') < h.events.indexOf('start'));
  assert.equal(h.starts(), 1);
});

test('live recovery: a failed emergency-state read prevents startup and schedules retry', async () => {
  const h = makeEngine();
  const timers = fakeTimers();
  const recovery = createLiveOpportunityRecovery({
    engine: h.engine,
    readLifecycle: emptyPage,
    readOpportunities: emptyPage,
    readPauseState: async () => { throw new Error('control state unavailable'); },
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    log: { log() {}, error() {} }
  });

  const result = await recovery.runNow();

  assert.equal(result.ok, false);
  assert.equal(h.starts(), 0);
  assert.equal(h.engine.getStatus().recovery.state, 'failed');
  assert.equal(recovery.getState().retryScheduled, true);
});

test('live recovery: a truncated read never reaches rehydrate or start', async () => {
  const h = makeEngine();
  const timers = fakeTimers();
  const recovery = createLiveOpportunityRecovery({
    engine: h.engine,
    readLifecycle: async () => ({ rows: [{ id: 1 }], pages: 1, truncated: true }),
    readOpportunities: emptyPage,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    log: { log() {}, error() {} }
  });
  const result = await recovery.runNow();
  assert.equal(result.ok, false);
  assert.equal(h.events.some(event => event.startsWith('rehydrate:')), false);
  assert.equal(h.starts(), 0);
  assert.equal(h.engine.getStatus().recovery.state, 'failed');
});

test('live recovery: stop ثم start أثناء قراءة معلقة لا يطلق استعادة مزدوجة', async () => {
  const h = makeEngine();
  const timers = fakeTimers();
  let reads = 0;
  let resolveFirstRead;
  const firstRead = new Promise(resolve => { resolveFirstRead = resolve; });
  const recovery = createLiveOpportunityRecovery({
    engine: h.engine,
    readLifecycle: async () => {
      reads += 1;
      return reads === 1 ? firstRead : emptyPage();
    },
    readOpportunities: emptyPage,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    log: { log() {}, error() {} }
  });
  recovery.start();
  timers.tasks[0].fn();
  for (let attempt = 0; attempt < 10 && reads === 0; attempt += 1) await new Promise(resolve => setImmediate(resolve));
  assert.equal(reads, 1);
  recovery.stop();
  recovery.start();
  timers.tasks[1].fn();
  assert.equal(h.starts(), 0);
  resolveFirstRead(emptyPage());
  for (let attempt = 0; attempt < 10 && h.starts() === 0; attempt += 1) await new Promise(resolve => setImmediate(resolve));
  assert.equal(reads, 2);
  assert.equal(h.starts(), 1);
  assert.equal(h.engine.getStatus().recovery.state, 'ready');
  recovery.stop();
});

test('live recovery: stop cancels retry scheduling', async () => {
  const h = makeEngine();
  const timers = fakeTimers();
  const recovery = createLiveOpportunityRecovery({
    engine: h.engine,
    readLifecycle: async () => { throw new Error('db unavailable'); },
    readOpportunities: emptyPage,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    log: { log() {}, error() {} }
  });
  await recovery.runNow();
  const retry = timers.tasks[0];
  recovery.stop();
  assert.equal(retry.cleared, true);
  recovery.stop();
});

test('محاكاة إعادة تشغيل المحرك: يستعيد النشطة ولا يعيد فتح المحسومة أو يكررها', async () => {
  const now = 1_700_000_000_000;
  const active = {
    id: 'BTCUSDT|5m|active-zone|1700000000', symbol: 'BTCUSDT', timeframe: '5m', zoneId: 'active-zone',
    entry: 100, stop: 96, tp: 108, detectedAt: now - 60_000, outcome: null
  };
  const closed = {
    id: 'ETHUSDT|5m|closed-zone|1700000000', symbol: 'ETHUSDT', timeframe: '5m', zoneId: 'closed-zone',
    entry: 100, stop: 96, tp: 108, detectedAt: now - 60_000, outcome: 'target', outcomeAt: now - 10_000
  };
  const lifecycleRows = [{
    id: 1, type: 'live_lifecycle', symbol: 'BTCUSDT', ts: now - 30_000,
    meta: JSON.stringify({
      kind: 'sweep', timeframe: '5m', zoneId: active.zoneId, key: 'BTCUSDT|5m|active-zone',
      payload: { referenceLevel: 101, liquidityLevel: 100, sweepLow: 99 }
    })
  }];
  const opportunityRows = [
    { id: 2, type: 'live_opportunity', symbol: active.symbol, ts: now - 20_000, meta: JSON.stringify({ opportunity: active }) },
    { id: 3, type: 'live_opportunity', symbol: closed.symbol, ts: now - 20_000, meta: JSON.stringify({ opportunity: { ...closed, outcome: null } }) },
    { id: 4, type: 'live_opportunity_closed', symbol: closed.symbol, ts: now - 10_000, meta: JSON.stringify({ opportunity: closed }) }
  ];
  const makeRuntime = () => {
    let candleClose = null;
    let listeners = 0;
    const market = {
      onCandleClose(handler) { candleClose = handler; listeners += 1; return () => { candleClose = null; listeners -= 1; }; },
      connected: () => true,
      getPrices: () => ({ BTCUSDT: 101 }),
      getPrice: () => 101,
      setKlineSubscriptions() {},
      setAggTradeSubscriptions() {},
      stats: () => ({ connected: true })
    };
    const engine = createLiveOpportunityEngine({
      now: () => now,
      market,
      zoneSource: () => [],
      resolveTargets: async () => ['BTCUSDT'],
      fetchPrices: async () => ({ BTCUSDT: 101 }),
      fetchBookSignals: async () => ({}),
      fetchRawKlines: async () => [],
      readCalibration: async () => null,
      log: { log() {}, warn() {}, error() {} },
      config: { recoveryRequired: true, cycleMs: 60_000, tickMs: 60_000, calibrationMs: 60_000 }
    });
    const recovery = createLiveOpportunityRecovery({
      engine,
      readLifecycle: async () => ({ rows: lifecycleRows, pages: 1, truncated: false }),
      readOpportunities: async () => ({ rows: opportunityRows, pages: 1, truncated: false }),
      log: { log() {}, error() {} }
    });
    return { engine, recovery, listenerCount: () => listeners, closeCandle: () => candleClose?.('BTCUSDT', '5m', 101) };
  };

  const first = makeRuntime();
  const firstRecovery = await first.recovery.runNow();
  assert.equal(firstRecovery.ok, true);
  assert.equal(first.engine.getStatus().recovery.state, 'ready');
  assert.equal(first.listenerCount(), 1, 'بدأ المحرك بعد الاستعادة وربط مستمع شموع واحداً');
  assert.deepEqual(first.engine.getFeed().opportunities.map(row => row.id), [active.id]);
  assert.equal(first.engine.getTracker('BTCUSDT|5m|active-zone')?.phase, 'published');
  assert.equal(first.engine.getTracker('BTCUSDT|5m|active-zone')?.publishedKey, active.id);
  first.closeCandle();
  first.engine.stop();
  first.recovery.stop();
  assert.equal(first.listenerCount(), 0, 'الإيقاف أزال مستمع الشموع');

  const restarted = makeRuntime();
  const restartRecovery = await restarted.recovery.runNow();
  assert.equal(restartRecovery.ok, true);
  assert.equal(restarted.engine.getStatus().recovery.state, 'ready');
  assert.deepEqual(restarted.engine.getFeed().opportunities.map(row => row.id), [active.id]);
  assert.equal(restarted.engine.getFeed().total, 1, 'لا تكرار بعد إعادة تشغيل محرك جديد');
  assert.equal(restarted.engine.getTracker('BTCUSDT|5m|active-zone')?.phase, 'published');
  assert.equal(restarted.listenerCount(), 1, 'المحرك الجديد شغّل حلقة متابعة واحدة فقط');
  restarted.engine.stop();
  restarted.recovery.stop();
  assert.equal(restarted.listenerCount(), 0);
});
