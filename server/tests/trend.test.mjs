import test from 'node:test';
import assert from 'node:assert/strict';

// استيراد ديناميكي بنمط sorting.test.mjs (Node 22+ strip-types)
const { computeTrend } = await import('../../client/src/lib/trendCore.ts');

/** سلسلة صاعدة: climbs steadily then plateaus high */
function risingSeries(n = 100) {
  return Array.from({ length: n }, (_, i) => 100 + i * 0.8 + Math.sin(i / 3) * 0.4);
}

/** سلسلة هابطة: falls steadily then plateaus low */
function fallingSeries(n = 100) {
  return Array.from({ length: n }, (_, i) => 200 - i * 0.8 + Math.sin(i / 3) * 0.4);
}

test('سلسلة صاعدة → اقتراح "up" حتمي', () => {
  const r = computeTrend(risingSeries());
  assert.equal(r.trend, 'up');
  assert.ok(r.basis.includes('EMA20'));
  assert.ok(r.ema20 !== null && r.ema50 !== null && r.ema20 > r.ema50);
});

test('سلسلة هابطة → اقتراح "down" حتمي', () => {
  const r = computeTrend(fallingSeries());
  assert.equal(r.trend, 'down');
  assert.ok(r.ema20 !== null && r.ema50 !== null && r.ema20 < r.ema50);
});

test('بيانات غير كافية → null بدون رمي', () => {
  const r = computeTrend([1, 2, 3]);
  assert.equal(r.trend, null);
  assert.ok(r.basis.includes('غير كافية'));
});

test('الحتمية: نفس السلسلة → نفس النتيجة تماماً', () => {
  const a = computeTrend(risingSeries());
  const b = computeTrend(risingSeries());
  assert.equal(a.trend, b.trend);
  assert.equal(a.basis, b.basis);
  assert.deepEqual(a.ema20, b.ema20);
  assert.deepEqual(a.ema50, b.ema50);
});
