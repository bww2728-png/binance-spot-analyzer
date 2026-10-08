import test from 'node:test';
import assert from 'node:assert/strict';

const tracker = await import('../live-opportunities/tracker.mjs');
const scanner = await import('../live-opportunities/scanner.mjs');
const { advanceTracker, initTracker, canPublish, stageChain, dedupeSweepEvents } = tracker;
const { buildDecisionSnapshot } = scanner;

const zone = (over = {}) => ({
  symbol: 'TSTUSDT', timeframe: '1m', id: 'z1', kind: 'ssl',
  referenceLevel: 100, liquidityLevel: 99, atr: 1, ...over
});

/** سلسلة سعرية: مسلح → مسحوب → مستعاد */
function sweepReclaim({ reclaimAtMs, windowBars = 3 }) {
  const t0 = 1_700_000_000_000;
  let st = initTracker(zone(), t0, { freshnessBars: 6 });
  let r = advanceTracker(st, { zone: zone(), price: 102, atr: 1, now: t0, reclaimWindowBars: windowBars });
  st = r.next;
  assert.equal(st.phase, 'armed');
  r = advanceTracker(st, { zone: zone(), price: 98.5, atr: 1, now: t0 + 60_000, reclaimWindowBars: windowBars });
  st = r.next;
  assert.equal(st.phase, 'swept');
  assert.equal(st.sawSweep, true);
  r = advanceTracker(st, { zone: zone(), price: 100.5, atr: 1, now: t0 + 60_000 + reclaimAtMs, reclaimWindowBars: windowBars });
  return r;
}

test('استعادة ضمن النافذة (3 شموع): حدث reclaim بزمن مزدوج + نشر مسموح', () => {
  const { next, events } = sweepReclaim({ reclaimAtMs: 60_000, windowBars: 3 });
  assert.equal(next.phase, 'reclaimed');
  const ev = events.find(e => e.type === 'reclaim');
  assert.ok(ev, 'يجب حدث reclaim');
  assert.equal(ev.elapsedMs, 60_000);
  assert.equal(ev.elapsedBars, 1);
  assert.equal(ev.windowBars, 3);
  assert.equal(next.reclaimElapsedMs, 60_000);
  assert.equal(next.staleSweep, false);
  assert.equal(canPublish(next, 'k|1'), true);
});

test('استعادة متأخرة (بعد 5 دقائق > 3 شموع): late_reclaim + إبطال النشر', () => {
  const { next, events } = sweepReclaim({ reclaimAtMs: 300_000, windowBars: 3 });
  assert.equal(next.phase, 'reclaimed'); // الحقيقة الهندسية تبقى
  assert.ok(events.find(e => e.type === 'late_reclaim'), 'يجب حدث late_reclaim');
  assert.equal(next.staleSweep, true);
  assert.equal(canPublish(next, 'k|1'), false);
});

test('نشر بلا قصة مشاهَدة = ممنوع (بوابة التسلسل)', () => {
  const st = {
    key: 'k', symbol: 'T', timeframe: '1m', zoneId: 'z', phase: 'reclaimed',
    sweepObservedAt: 123, sawSweep: false, reclaimAt: null, staleSweep: false, publishedKey: null
  };
  assert.equal(canPublish(st, 'k|999'), false);
});

test('إزالة تكرار الحدث عبر الفريمات: الأساسي الأدق + شهود', () => {
  const t = 1_700_000_000_000;
  const cands = [
    { symbol: 'A', tfSec: 300, zone: { timeframe: '5m', liquidityLevel: 99 }, state: { sweepObservedAt: t, geometry: { toLiquidityAtr: 0.4 } } },
    { symbol: 'A', tfSec: 60, zone: { timeframe: '1m', liquidityLevel: 99.005 }, state: { sweepObservedAt: t + 30_000, geometry: { toLiquidityAtr: 0.4 } } },
    { symbol: 'B', tfSec: 60, zone: { timeframe: '1m', liquidityLevel: 50 }, state: { sweepObservedAt: t, geometry: { toLiquidityAtr: 0.2 } } }
  ];
  const out = dedupeSweepEvents(cands);
  assert.equal(out.length, 2);
  const a = out.find(o => o.symbol === 'A');
  assert.equal(a.zone.timeframe, '1m');
  assert.deepEqual(a.dupTfs, ['5m']);
});

test('سلسلة المراحل: خمس حلقات بأزمنة السويب/الاستعادة', () => {
  const chain = stageChain(
    { symbol: 'S', timeframe: '5m', zoneId: 'z', referenceLevel: 10, liquidityLevel: 9.8, sweepObservedAt: 111, sweepLow: 9.7, sawSweep: true, reclaimAt: 222, reclaimElapsedMs: 111000, reclaimBars: 1.85, staleSweep: false },
    { flow: { score: 70, tier: 'high' }, veto: 'flow_unconfirmed' }
  );
  assert.equal(chain.length, 5);
  assert.equal(chain[0].stage, 'ssl');
  assert.equal(chain[2].elapsedMs, 111000);
  assert.equal(chain[3].score, 70);
  assert.equal(chain[4].reason, 'flow_unconfirmed');
});

test('لقطة القرار: مجمدة وكاملة ولا تُعاد حسابا', () => {
  const snap = buildDecisionSnapshot({
    zone: zone(), state: { sweepObservedAt: 1, sweepLow: 98.5, sawSweep: true, reclaimAt: 2, reclaimElapsedMs: 60000, reclaimBars: 1 },
    flow: { score: 70, tier: 'high', components: { cvd: 20 }, reasons: ['r1'] },
    session: { tier: 'prime' }, location: { state: 'imbalance_up' },
    profile: { poc: 99, vah: 101, val: 98 },
    plan: { entry: 100.5, stop: 98.4, tp: 104.7, rr: 2, stopAtr: 2.1, targetLabel: 'R2' },
    segment: { key: '1m|high|b3', smoothedWinRate: 0.65, trades: 40, tier: 'qualified' },
    calibrationAt: 999, thresholds: { reclaimWindowBars: 3, minRR: 2 }
  });
  assert.ok(Object.isFrozen(snap));
  assert.equal(snap.sweep.sawSweep, true);
  assert.equal(snap.reclaim.windowBars, 3);
  assert.equal(snap.calibration.at, 999);
  assert.equal(snap.plan.rr, 2);
  assert.throws(() => { snap.plan.rr = 5; }, 'مجمدة — التعديل مرفوض');
});
