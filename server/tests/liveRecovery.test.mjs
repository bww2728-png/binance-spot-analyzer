import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLiveOpportunityRecovery } from '../live-opportunities/recovery.mjs';

function makeEngine() {
  const events = [];
  let recovery = { state: 'pending', error: null };
  let calibrationReads = 0;
  let starts = 0;
  const engine = {
    async loadCalibration() { calibrationReads += 1; },
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
  return { engine, events, starts: () => starts, calibrationReads: () => calibrationReads };
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
  assert.equal(recovery.getState().retryScheduled, false);
});
