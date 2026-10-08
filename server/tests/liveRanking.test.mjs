import test from 'node:test';
import assert from 'node:assert/strict';

const scanner = await import('../live-opportunities/scanner.mjs');
const { median, shrinkMedian, summarizeSegments, rankScore, rankBatch, buildDecisionSnapshot } = scanner;

test('median: وسيط حقيقي يقاوم الشواذ', () => {
  assert.equal(median([1, 2, 100]), 2);
  assert.equal(median([1, 2, 3, 100]), 2.5);
  assert.equal(median([]), null);
  assert.equal(median([5]), 5);
});

test('shrinkMedian: عينة كافية تحتفظ بوسيطها، والصغيرة تنكمش', () => {
  const full = shrinkMedian([10, 20, 30, 40, 50, 60, 70, 80], 1000, { minN: 8 });
  assert.equal(full.shrunk, false);
  assert.equal(full.value, 45);
  const small = shrinkMedian([100, 200], 1000, { minN: 8 });
  assert.equal(small.shrunk, true);
  // w=2/8=0.25 → 0.25*150 + 0.75*1000 = 787.5 → 788 (مقرب)
  assert.ok(Math.abs(small.value - 788) <= 1, `got ${small.value}`);
  const empty = shrinkMedian([], 1000, { minN: 8 });
  assert.equal(empty.value, 1000);
  assert.equal(empty.shrunk, true);
});

test('summarizeSegments: مدد مشروطة + انكماش + weak ظاهرة', () => {
  const trades = [];
  for (let i = 0; i < 10; i += 1) {
    trades.push({ timeframe: '5m', band: 'b3', minRR: 2, win: i < 7 ? 1 : 0, rr: 2, bars: 5 + i, ts: i, durationMs: 300_000 + i * 60_000 });
  }
  for (let i = 0; i < 3; i += 1) {
    trades.push({ timeframe: '5m', band: 'b1', minRR: 2, win: 0, rr: 2, bars: 4, ts: 100 + i, durationMs: 240_000 });
  }
  const rows = summarizeSegments(trades, { minTrades: 8 });
  const b3 = rows.find(r => r.key === '5m|all|b3');
  assert.ok(b3, 'شريحة b3 موجودة');
  assert.equal(b3.durationShrunk, false);
  assert.ok(b3.medianDurationMs > 0);
  const b1 = rows.find(r => r.key === '5m|all|b1');
  assert.ok(b1, 'الشريحة الضعيفة ظاهرة للبحث لا محذوفة');
  assert.equal(b1.tier, 'weak');
  assert.equal(b1.durationShrunk, true); // 3 < 8 → منكمشة نحو العامة
});

const snap = (over = {}) => buildDecisionSnapshot({
  zone: { id: 'z', symbol: 'S', timeframe: '5m', kind: 'ssl', referenceLevel: 100, liquidityLevel: 99, confidence: 0.8, touches: 3, atr: 1 },
  state: { sweepObservedAt: 1, sweepLow: 98.5, sawSweep: true, reclaimAt: 2, reclaimElapsedMs: 60000, reclaimBars: 1 },
  flow: { score: 70, tier: 'high', components: { cvd: 20 }, reasons: [] },
  session: { tier: 'prime' }, location: { state: 'imbalance_up' },
  profile: { poc: 99, vah: 101, val: 98 },
  plan: { entry: 100.5, stop: 98.4, tp: 104.7, rr: 2, stopAtr: 2.1, ...(over.planOver ?? {}) },
  segment: { key: 'k', smoothedWinRate: 0.65, trades: 40, tier: 'qualified', medianDurationMs: 600_000, ...(over.segOver ?? {}) },
  calibrationAt: over.calibrationAt ?? 999, thresholds: {},
  ...(over.rest ?? {})
});

test('rankScore: حدود [0,100] + حتمية + رتابة', () => {
  const s = { ...snap(), takenAt: 1000 };
  const a = rankScore(s, { refDurationMs: 600_000 });
  const b = rankScore(s, { refDurationMs: 600_000 });
  assert.deepEqual(a, b);
  assert.ok(a.score >= 0 && a.score <= 100);
  // تحسين أي عامل لا يُنقص الدرجة أبدا
  const better = { ...snap({ planOver: { rr: 4 } }), takenAt: 1000 };
  assert.ok(rankScore(better, { refDurationMs: 600_000 }).score >= a.score);
  const faster = { ...snap({ segOver: { medianDurationMs: 300_000 } }), takenAt: 1000 };
  assert.ok(rankScore(faster, { refDurationMs: 600_000 }).score >= a.score);
});

test('rankScore: تسريب مستقبلي = رمي فوري', () => {
  const bad = { ...snap({ calibrationAt: 1001 }), takenAt: 1000 };
  assert.throws(() => rankScore(bad, { refDurationMs: 600_000 }), /future leakage/);
  const ok = { ...snap({ calibrationAt: 999 }), takenAt: 1000 };
  assert.doesNotThrow(() => rankScore(ok, { refDurationMs: 600_000 }));
});

test('rankBatch: ترتيب + هوامش + استقرار top-1 عند ±20% للأوزان المهيمنة', () => {
  const mk = (id, p, rr) => ({
    id,
    snapshot: {
      ...snap({ planOver: { rr }, segOver: { smoothedWinRate: p } }),
      takenAt: 1000
    }
  });
  const items = [mk('w1', 0.9, 3), mk('w2', 0.6, 2), mk('w3', 0.55, 1.5)];
  const ranked = rankBatch(items);
  assert.equal(ranked[0].id, 'w1');
  assert.ok(ranked[0].marginToNext > 0);
  assert.equal(ranked[ranked.length - 1].marginToNext, null);
  // اضطراب ±20% للأوزان: top-1 المهيمن يبقى (هوامش واسعة موثقة لا مدّعاة)
  const pert = rankBatch(items, { weights: { p: 0.42, rr: 0.3, speed: 0.16, path: 0.16 } });
  assert.equal(pert[0].id, 'w1');
});
