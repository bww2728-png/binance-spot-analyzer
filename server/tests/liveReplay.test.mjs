import test from 'node:test';
import assert from 'node:assert/strict';
import { advanceTracker } from '../live-opportunities/tracker.mjs';

const { replayTimeline, phaseTrail, eventsOf } = await import('../live-opportunities/replay.mjs');
const { dedupeSweepEvents } = await import('../live-opportunities/tracker.mjs');

const T0 = 1_700_000_000_000;
const zone = (over = {}) => ({
  symbol: 'TSTUSDT', timeframe: '5m', id: 'z1', kind: 'ssl',
  referenceLevel: 100, liquidityLevel: 99, atr: 1, ...over
});
// 5m → الشمعة 300s: ticks كل 60s
const tick = (i, price) => ({ price, at: T0 + i * 60_000 });

test('التكافؤ: نفس السلسلة مرتين = نفس الخط الزمني حرفيا (Live=Replay)', () => {
  const ticks = [tick(0, 103), tick(1, 102), tick(2, 98.5), tick(3, 98.7), tick(4, 100.2), tick(5, 101)];
  const a = replayTimeline({ zone: zone(), atr: 1, ticks });
  const b = replayTimeline({ zone: zone(), atr: 1, ticks });
  assert.equal(phaseTrail(a), phaseTrail(b));
  assert.deepEqual(a.final, b.final);
});

test('سويب ناجح: swept ثم reclaim خلال 3 شموع (5m)', () => {
  const r = replayTimeline({ zone: zone(), atr: 1, ticks: [tick(0, 103), tick(1, 98.5), tick(2, 100.3)] });
  assert.ok(eventsOf(r, 'sweep').length === 1);
  const rec = eventsOf(r, 'reclaim');
  assert.ok(rec.length === 1);
  assert.equal(r.final.phase, 'reclaimed');
});

test('سويب فاشل: بلا استعادة → expired ثم invalidated', () => {
  const ticks = [tick(0, 103), tick(1, 98.5), tick(2, 98.6), tick(3, 98.4), tick(4, 98.3), tick(5, 98.2), tick(6, 98.1)];
  const r = replayTimeline({ zone: zone(), atr: 1, ticks });
  assert.ok(eventsOf(r, 'sweep').length === 1);
  assert.ok(eventsOf(r, 'reclaim').length === 0);
  assert.equal(r.final.phase, 'invalidated');
});

test('استعادة خلال النافذة مقبولة (شموع 1-3)؛ تجاوز 900s على 5m = متأخر', () => {
  for (const bars of [1, 2, 3]) {
    const ticks = [tick(0, 103), tick(1, 98.5)];
    for (let i = 0; i < bars - 1; i += 1) ticks.push(tick(2 + i, 98.8));
    ticks.push(tick(1 + bars, 100.3));
    const r = replayTimeline({ zone: zone(), atr: 1, ticks, reclaimWindowBars: 3 });
    assert.ok(eventsOf(r, 'reclaim').length === 1, `bar ${bars} يجب reclaim`);
  }
  // على 5m: النافذة = 3 شموع = 900s — المتأخر يحتاج تجاوزها بوضوح (tick17 ≈ 1020s بعد السويب)
  const lateTicks = [tick(0, 103), tick(1, 98.5)];
  for (let i = 2; i <= 16; i += 1) lateTicks.push(tick(i, 98.8));
  lateTicks.push(tick(17, 100.3));
  const rl = replayTimeline({ zone: zone(), atr: 1, ticks: lateTicks, reclaimWindowBars: 3 });
  assert.ok(eventsOf(rl, 'late_reclaim').length === 1, 'بعد 900s = متأخر');
});

test('تكرار الحدث نفسه لا يضاعف: tick مكرر + فجوة بيانات', () => {
  const same = { price: 98.5, at: T0 + 60_000 };
  const r = replayTimeline({ zone: zone(), atr: 1, ticks: [tick(0, 103), same, { ...same }, tick(3, 100.3)] });
  assert.equal(eventsOf(r, 'sweep').length, 1);
  // فجوة 30 دقيقة بلا ticks ثم عودة فوق المرجع = متأخر (انتهت النافذة أثناء الفجوة)
  const gap = replayTimeline({ zone: zone(), atr: 1, ticks: [tick(0, 103), tick(1, 98.5), { price: 100.3, at: T0 + 31 * 60_000 }] });
  assert.ok(eventsOf(gap, 'late_reclaim').length === 1);
});

test('إعادة التشغيل: تسلسل الحالة (JSON round-trip) يواصل identically', () => {
  const part1 = [tick(0, 103), tick(1, 98.5)];
  const cont = [tick(2, 98.7), tick(3, 100.3)];
  const full = replayTimeline({ zone: zone(), atr: 1, ticks: [...part1, ...cont] });
  const first = replayTimeline({ zone: zone(), atr: 1, ticks: part1 });
  const restored = JSON.parse(JSON.stringify(first.final)); // محاكاة إعادة التشغيل
  let st = restored;
  const trail = [];
  for (const t of cont) {
    const r = advanceTracker(st, { zone: zone(), price: t.price, atr: 1, now: t.at, reclaimWindowBars: 3 });
    trail.push(`${t.at}:${r.next.phase}`);
    st = r.next;
  }
  const expected = full.timeline.slice(2).map(t => `${t.at}:${t.phase}`).join('|');
  assert.equal(trail.join('|'), expected);
});

test('حدث واحد على فريمين = إزالة تكرار لمرشح واحد', () => {
  const mk = (tf, liq, at) => ({ symbol: 'X', tfSec: tf === '1m' ? 60 : 300, zone: { timeframe: tf, liquidityLevel: liq }, state: { sweepObservedAt: at, geometry: { toLiquidityAtr: 0.3 } } });
  const out = dedupeSweepEvents([mk('5m', 99, T0), mk('1m', 99.002, T0 + 20_000)]);
  assert.equal(out.length, 1);
  assert.equal(out[0].zone.timeframe, '1m');
});
