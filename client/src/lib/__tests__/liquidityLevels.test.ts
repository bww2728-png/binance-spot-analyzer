import { describe, expect, it } from 'vitest';
import {
  MIN_TOUCHES,
  aggregateCandles,
  buildLevels,
  buildTrends,
  clampViewBox,
  isFullView,
  levelDeviation,
  makeScale,
  makeY,
  mergeLevelsByGap,
  panViewBox,
  pickLevelNear,
  zoomViewBox
} from '../liquidityLevels';

const T0 = 1_700_000_000;
const HOUR = 3600;

const candle = (i: number, o: number, h: number, l: number, c: number): [number, number, number, number, number, number] =>
  [T0 + i * HOUR, o, h, l, c, 1];

const horizontal = (over: Record<string, unknown> = {}) => ({
  id: 'z1',
  kind: 'horizontal_bsl',
  state: 'candidate',
  referenceLevel: 100,
  liquidityLevel: 103,
  touches: 3,
  atr: 1.5,
  touchPoints: [
    { time: T0 + 10 * HOUR, price: 99.9 },
    { time: T0 + 20 * HOUR, price: 100.05 },
    { time: T0 + 30 * HOUR, price: 100.0 }
  ],
  ...over
});

describe('aggregateCandles', () => {
  it('returns empty for missing or empty input', () => {
    expect(aggregateCandles(undefined)).toEqual([]);
    expect(aggregateCandles([])).toEqual([]);
  });

  it('preserves the true high/low of each bucket and the last close', () => {
    const candles = [candle(0, 10, 12, 9, 11), candle(1, 11, 15, 10, 14), candle(2, 14, 16, 13, 13)];
    const bars = aggregateCandles(candles, 3);
    expect(bars).toHaveLength(3);
    expect(bars[0]).toMatchObject({ o: 10, h: 12, l: 9, c: 11 });
    expect(bars[1]).toMatchObject({ o: 11, h: 15, l: 10, c: 14 });
  });

  it('merges into at most the requested bucket count', () => {
    const candles = Array.from({ length: 100 }, (_, i) => candle(i, 100, 101, 99, 100));
    const bars = aggregateCandles(candles, 10);
    expect(bars.length).toBeLessThanOrEqual(10);
    expect(bars[0].h).toBe(101);
    expect(bars.at(-1)?.c).toBe(100);
  });
});

describe('makeScale / makeY', () => {
  const bars = [{ t: T0, o: 100, h: 110, l: 90, c: 105 }, { t: T0 + 50 * HOUR, o: 105, h: 120, l: 95, c: 100 }];
  const candles = [candle(0, 100, 110, 90, 105), candle(50, 105, 120, 95, 100)];
  const pad = { top: 10, right: 20, bottom: 10, left: 5 };

  it('returns null when there is nothing to scale', () => {
    expect(makeScale([], [], 100, 100, pad)).toBeNull();
    expect(makeScale(candles, [{ t: T0, o: 1, h: 1, l: 1, c: 1 }], 100, 100, pad)).toBeNull();
  });

  it('maps the time domain onto the padded plot area', () => {
    const scale = makeScale(candles, bars, 200, 100, pad)!;
    expect(scale).not.toBeNull();
    expect(scale.x(scale.t0)).toBeCloseTo(pad.left, 6);
    expect(scale.x(scale.t1)).toBeCloseTo(200 - pad.right, 6);
  });

  it('maps price top/bottom onto the padded plot area', () => {
    const scale = makeScale(candles, bars, 200, 100, pad)!;
    const y = makeY(scale, 100, pad);
    expect(y(scale.hi)).toBeCloseTo(pad.top, 6);
    expect(y(scale.lo)).toBeCloseTo(100 - pad.bottom, 6);
    expect(y((scale.hi + scale.lo) / 2)).toBeCloseTo(50, 6);
  });
});

describe('buildLevels', () => {
  const range = { t0: T0, t1: T0 + 100 * HOUR };

  it('keeps only horizontal zones with at least three touches in range', () => {
    const zones = [
      horizontal(),
      horizontal({ id: 'z2', touches: 2 }),
      horizontal({ id: 'z3', kind: 'trendline_bsl' }),
      horizontal({ id: 'z4', touchPoints: [{ time: T0 + 10 * HOUR, price: 100 }, { time: T0 + 20 * HOUR, price: 100 }] })
    ];
    const levels = buildLevels(zones, range);
    expect(MIN_TOUCHES).toBe(3);
    expect(levels).toHaveLength(1);
    expect(levels[0].id).toBe('z1');
  });

  it('spans from the first touch to the last touch, not the whole chart', () => {
    const levels = buildLevels([horizontal()], range);
    expect(levels[0].touchTimes[0]).toBe(T0 + 10 * HOUR);
    expect(levels[0].touchTimes.at(-1)).toBe(T0 + 30 * HOUR);
  });

  it('drops touches outside the chart range and re-counts them', () => {
    const zones = [horizontal({
      touchPoints: [
        { time: T0 - 5 * HOUR, price: 100 },
        { time: T0 + 10 * HOUR, price: 100 },
        { time: T0 + 20 * HOUR, price: 100 }
      ]
    })];
    expect(buildLevels(zones, { t0: T0, t1: T0 + 100 * HOUR })).toHaveLength(0);
    expect(buildLevels(zones, { t0: T0 - 10 * HOUR, t1: T0 + 100 * HOUR })[0].touchTimes).toHaveLength(3);
  });

  it('carries the stop level and ATR as the engine reported them', () => {
    const [level] = buildLevels([horizontal()], range);
    expect(level.stop).toBe(103);
    expect(level.atr).toBe(1.5);
    expect(level.touches).toBe(3);
    expect(level.side).toBe('bsl');
  });

  it('classifies ssl kinds and rejects unusable prices', () => {
    const zones = [
      horizontal({ id: 's1', kind: 'horizontal_ssl', referenceLevel: 50, liquidityLevel: 47 }),
      horizontal({ id: 'bad1', referenceLevel: null }),
      horizontal({ id: 'bad2', referenceLevel: 0 }),
      horizontal({ id: 'bad3', referenceLevel: Number.NaN }),
      horizontal({ id: 'bad4', liquidityLevel: null })
    ];
    const levels = buildLevels(zones, range);
    expect(levels.map((l) => l.id)).toEqual(['bad4', 's1']);
    expect(levels[1].side).toBe('ssl');
    expect(levels[0].stop).toBeNull();
  });

  it('sorts by reference level, highest first, and never emits duplicates', () => {
    const zones = [horizontal({ id: 'a', referenceLevel: 90 }), horizontal({ id: 'b', referenceLevel: 110 }), horizontal({ id: 'a' })];
    const levels = buildLevels(zones, range);
    expect(levels.map((l) => l.ref)).toEqual([110, 90]);
    expect(levels).toHaveLength(2);
  });

  it('keeps every numeric output finite', () => {
    const zones = [horizontal({ touchPoints: [
      { time: T0 + HOUR, price: Number.NaN },
      { time: T0 + 2 * HOUR, price: null },
      { time: T0 + 3 * HOUR, price: '100.5' }
    ] })];
    const [level] = buildLevels(zones, range);
    expect(level.touchPrices.every((p) => Number.isFinite(p) && p > 0)).toBe(true);
    expect(level.touchPrices).toEqual([100, 100, 100.5]);
    expect(Number.isFinite(level.ref)).toBe(true);
  });

  it('orders touches by time even when the engine returns them unsorted', () => {
    const zones = [horizontal({
      touchPoints: [
        { time: T0 + 30 * HOUR, price: 100.2 },
        { time: T0 + 10 * HOUR, price: 99.9 },
        { time: T0 + 20 * HOUR, price: 100.1 }
      ]
    })];
    const [level] = buildLevels(zones, range);
    expect(level.touchTimes).toEqual([T0 + 10 * HOUR, T0 + 20 * HOUR, T0 + 30 * HOUR]);
    expect(level.touchPrices).toEqual([99.9, 100.1, 100.2]);
  });

  it('merges copies of the same level within 0.02% and keeps the strongest as owner', () => {
    const zones = [
      horizontal({
        id: 'strong',
        touches: 5,
        confidence: 0.9,
        liquidityLevel: 103,
        touchPoints: [
          { time: T0 + 10 * HOUR, price: 100 },
          { time: T0 + 20 * HOUR, price: 100.001 },
          { time: T0 + 30 * HOUR, price: 100 }
        ]
      }),
      horizontal({
        id: 'weak',
        referenceLevel: 100.015,
        touches: 3,
        confidence: 0.4,
        liquidityLevel: 104.5,
        touchPoints: [
          { time: T0 + 40 * HOUR, price: 100.01 },
          { time: T0 + 50 * HOUR, price: 100.02 },
          { time: T0 + 60 * HOUR, price: 100.01 }
        ]
      })
    ];
    const levels = buildLevels(zones, range);
    expect(levels).toHaveLength(1);
    expect(levels[0].id).toBe('strong');
    expect(levels[0].ref).toBe(100);
    expect(levels[0].stop).toBe(103);
    expect(levels[0].mergedCount).toBe(2);
    expect(levels[0].touches).toBe(6);
    expect(levels[0].touchTimes[0]).toBe(T0 + 10 * HOUR);
    expect(levels[0].touchTimes.at(-1)).toBe(T0 + 60 * HOUR);
  });

  it('does not merge levels farther apart than the tolerance', () => {
    const zones = [
      horizontal({ id: 'a', referenceLevel: 100 }),
      horizontal({ id: 'b', referenceLevel: 100.05 }),
      horizontal({ id: 'c', referenceLevel: 100.019 })
    ];
    const levels = buildLevels(zones, range);
    expect(levels.map((l) => l.id).sort()).toEqual(['b', 'c']);
    expect(levels.find((l) => l.id === 'c')?.mergedCount).toBe(2);
  });

  it('is deterministic for the same input', () => {
    const zones = [
      horizontal({ id: 'x', referenceLevel: 100, touches: 4 }),
      horizontal({ id: 'y', referenceLevel: 100.005, touches: 4 }),
      horizontal({ id: 'z', referenceLevel: 200, touches: 3 })
    ];
    const first = buildLevels(zones, range).map((l) => `${l.id}:${l.ref}:${l.touches}`);
    const second = buildLevels(zones, range).map((l) => `${l.id}:${l.ref}:${l.touches}`);
    expect(first).toEqual(second);
  });
});

describe('buildTrends', () => {
  const range = { t0: T0, t1: T0 + 100 * HOUR };
  const trend = (points: Array<{ time: number; price: number }>) => ({
    id: 'tr1',
    kind: 'trendline_bsl',
    state: 'candidate',
    trendline: { points }
  });

  it('requires three points or more', () => {
    const two = trend([{ time: T0 + HOUR, price: 100 }, { time: T0 + 2 * HOUR, price: 101 }]);
    const three = trend([
      { time: T0 + 3 * HOUR, price: 102 },
      { time: T0 + HOUR, price: 100 },
      { time: T0 + 2 * HOUR, price: 101 }
    ]);
    expect(buildTrends([two], range)).toHaveLength(0);
    expect(MIN_TOUCHES).toBe(3);
    expect(buildTrends([three], range)).toHaveLength(1);
  });

  it('sorts points by time and drops points outside the range', () => {
    const zones = [trend([
      { time: T0 + 5 * HOUR, price: 104 },
      { time: T0 - HOUR, price: 99 },
      { time: T0 + HOUR, price: 100 },
      { time: T0 + 3 * HOUR, price: 102 }
    ])];
    const [line] = buildTrends(zones, range);
    expect(line.points.map((p) => p.t)).toEqual([T0 + HOUR, T0 + 3 * HOUR, T0 + 5 * HOUR]);
    expect(line.side).toBe('bsl');
  });

  it('ignores horizontal zones and malformed trendlines', () => {
    const zones = [
      { id: 'h', kind: 'horizontal_bsl', trendline: { points: [{ time: T0, price: 1 }, { time: T0 + 1, price: 2 }, { time: T0 + 2, price: 3 }] } },
      { id: 't', kind: 'trendline_ssl', trendline: null }
    ];
    expect(buildTrends(zones, range)).toHaveLength(0);
  });

  it('deduplicates copies of the same trendline id', () => {
    const pts = [
      { time: T0 + HOUR, price: 100 },
      { time: T0 + 2 * HOUR, price: 101 },
      { time: T0 + 3 * HOUR, price: 102 }
    ];
    const zones = [trend(pts), { ...trend(pts), state: 'confirmed' }];
    const lines = buildTrends(zones, range);
    expect(lines).toHaveLength(1);
    expect(lines[0].id).toBe('tr1');
    expect(new Set(lines.map((l) => l.id)).size).toBe(lines.length);
  });
});

describe('viewBox (pan/zoom)', () => {
  const bounds = { x: 14, y: 18, w: 1108, h: 472 };

  it('keeps the plot aspect ratio and clamps inside bounds', () => {
    const vb = clampViewBox({ x: -50, y: 900, w: 400, h: 10 }, bounds);
    expect(vb.x).toBe(bounds.x);
    expect(vb.y).toBe(bounds.y + bounds.h - vb.h);
    expect(vb.w).toBe(400);
    expect(vb.h / vb.w).toBeCloseTo(bounds.h / bounds.w, 12);
  });

  it('never zooms out past the bounds nor in past the minimum width', () => {
    const out = zoomViewBox({ ...bounds }, 10, { x: 500, y: 300 }, bounds);
    expect(out.w).toBe(bounds.w);
    const inn = zoomViewBox({ ...bounds }, 0.0001, { x: 500, y: 300 }, bounds);
    expect(inn.w).toBeGreaterThan(0);
    expect(inn.w).toBeLessThanOrEqual(bounds.w);
    expect(inn.h / inn.w).toBeCloseTo(bounds.h / bounds.w, 12);
  });

  it('keeps the anchor point under the cursor when zooming', () => {
    const vb = { x: 300, y: 200, w: 400, h: 400 * (bounds.h / bounds.w) };
    const anchor = { x: 520, y: 260 };
    const zoomed = zoomViewBox(vb, 0.5, anchor, bounds);
    const before = (anchor.x - vb.x) / vb.w;
    const after = (anchor.x - zoomed.x) / zoomed.w;
    expect(after).toBeCloseTo(before, 9);
  });

  it('pans by the requested amount and stops at the edges', () => {
    const vb = { x: 100, y: 100, w: 300, h: 300 * (bounds.h / bounds.w) };
    expect(panViewBox(vb, 10, 5, bounds).x).toBe(110);
    const far = panViewBox(vb, 1e6, 1e6, bounds);
    expect(far.x).toBe(bounds.x + bounds.w - far.w);
    expect(far.x).toBeLessThanOrEqual(bounds.x + bounds.w - far.w + 1e-9);
  });

  it('ignores non-finite input and reports the full view', () => {
    const same = zoomViewBox({ ...bounds }, Number.NaN, { x: Number.NaN, y: 0 }, bounds);
    expect(same).toEqual(bounds);
    expect(isFullView({ ...bounds }, bounds)).toBe(true);
    expect(isFullView({ ...bounds, w: 900 }, bounds)).toBe(false);
  });
});

describe('mergeLevelsByGap (display only)', () => {
  const mk = (id: string, ref: number, touches: number, mergedCount = 1) => ({
    id,
    kind: 'horizontal_bsl',
    side: 'bsl' as const,
    ref,
    stop: ref + 1,
    touchTimes: [T0 + HOUR, T0 + 2 * HOUR, T0 + 3 * HOUR],
    touchPrices: [ref, ref, ref],
    touches,
    state: 'candidate',
    atr: 1,
    confidence: 0.5,
    mergedCount
  });

  it('merges levels closer than the gap and keeps the strongest as owner', () => {
    const merged = mergeLevelsByGap([mk('a', 100, 3), mk('b', 100.4, 9), mk('c', 100.9, 5)], 0.45);
    expect(merged).toHaveLength(2);
    const byId = new Map(merged.map((l) => [l.id, l]));
    expect(byId.get('b')?.mergedCount).toBe(2);
    expect(byId.get('c')?.mergedCount).toBe(1);
    expect(byId.has('a')).toBe(false);
  });

  it('does not drift: a chain of near levels cannot merge past the anchor gap', () => {
    const chain = [mk('a', 100.0, 3), mk('b', 100.2, 3), mk('c', 100.4, 3), mk('d', 100.6, 3)];
    const merged = mergeLevelsByGap(chain, 0.25);
    expect(merged.length).toBeGreaterThan(1);
    for (const group of merged) {
      const members = chain.filter((l) => Math.abs(l.ref - group.ref) <= 0.25);
      expect(members.length).toBeGreaterThan(0);
    }
  });

  it('does not mutate the input levels', () => {
    const input = [mk('a', 100, 3), mk('b', 100.2, 4)];
    const copy = JSON.parse(JSON.stringify(input));
    const merged = mergeLevelsByGap(input, 1);
    expect(input).toEqual(copy);
    expect(merged).toHaveLength(1);
  });

  it('returns everything when the gap is zero or invalid', () => {
    const input = [mk('a', 100, 3), mk('b', 100.001, 3)];
    expect(mergeLevelsByGap(input, 0)).toHaveLength(2);
    expect(mergeLevelsByGap(input, Number.NaN)).toHaveLength(2);
    expect(mergeLevelsByGap([], 5)).toEqual([]);
  });
});

describe('pickLevelNear / levelDeviation', () => {
  const level = (ref: number) => ({
    id: `l${ref}`,
    kind: 'horizontal_ssl',
    side: 'ssl' as const,
    ref,
    stop: ref - 2,
    touchTimes: [T0 + HOUR, T0 + 2 * HOUR, T0 + 3 * HOUR],
    touchPrices: [ref, ref * 1.001, ref],
    touches: 3,
    state: 'swept',
    atr: 1,
    confidence: 0.6,
    mergedCount: 1
  });

  it('picks the closest level inside the tolerance', () => {
    const levels = [level(100), level(101)];
    expect(pickLevelNear(levels, 100.6, 0.7)?.ref).toBe(101);
    expect(pickLevelNear(levels, 100.6, 0.4)).toBeNull();
    expect(pickLevelNear(levels, Number.NaN, 1)).toBeNull();
  });

  it('reports the maximum touch deviation as a ratio', () => {
    expect(levelDeviation(level(100))).toBeCloseTo(0.001, 12);
    expect(levelDeviation({ ...level(100), touchPrices: [] })).toBe(0);
  });
});


