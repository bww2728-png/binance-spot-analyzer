import { describe, expect, it } from 'vitest';
import {
  MIN_TOUCHES,
  aggregateCandles,
  buildLevels,
  buildTrends,
  makeScale,
  makeY
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
});
