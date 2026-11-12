import assert from 'node:assert/strict';
import { test } from 'node:test';
import fc from 'fast-check';
import { normalizeHistoryKlines } from '../services/liquidityHistoryData.mjs';

const intervalMs = 60_000;
const startTime = 1_700_000_000_000;
const makeRow = (openTime, price) => [openTime, price, price + 2, price - 1, price + 1, 3, openTime + intervalMs - 1];

test('property: normalization preserves chronological candle identity and exactly accounts for internal gaps', () => {
  fc.assert(fc.property(
    fc.array(fc.integer({ min: 1, max: 8 }), { minLength: 1, maxLength: 100 }),
    (steps) => {
      let index = -1;
      const openTimes = steps.map((step) => {
        index += step;
        return startTime + index * intervalMs;
      });
      const rows = openTimes.map((openTime, rowIndex) => makeRow(openTime, 100 + rowIndex));
      const endTime = openTimes[openTimes.length - 1] + intervalMs;
      const result = normalizeHistoryKlines(rows, {
        timeframe: '1m',
        startTime,
        endTime,
        snapshotTime: endTime
      });
      const expectedMissingBars = steps.slice(1).reduce((total, step) => total + step - 1, 0);

      assert.deepEqual(result.candles.map((candle) => candle.time * 1000), openTimes);
      assert.equal(result.quality.acceptedBars, rows.length);
      assert.equal(result.quality.missingBars, expectedMissingBars);
      assert.equal(result.quality.gapCount, steps.slice(1).filter((step) => step > 1).length);
    }
  ), { numRuns: 150, seed: 20261110 });
});

test('property: snapshot cutoff never includes a candle that has not closed', () => {
  fc.assert(fc.property(
    fc.integer({ min: 2, max: 150 }),
    fc.integer({ min: 1, max: 150 }),
    (barCount, requestedClosedBars) => {
      const closedBars = Math.min(barCount, requestedClosedBars);
      const rows = Array.from({ length: barCount }, (_, index) => makeRow(startTime + index * intervalMs, 100 + index));
      const endTime = startTime + barCount * intervalMs;
      const snapshotTime = startTime + closedBars * intervalMs;
      const result = normalizeHistoryKlines(rows, {
        timeframe: '1m',
        startTime,
        endTime,
        snapshotTime
      });

      assert.equal(result.candles.length, closedBars);
      assert.ok(result.candles.every((candle) => candle.time * 1000 + intervalMs <= snapshotTime));
      assert.equal(result.quality.incompleteBars, barCount - closedBars);
    }
  ), { numRuns: 100, seed: 20261111 });
});

test('property: invalid high/low relationships are always rejected', () => {
  fc.assert(fc.property(
    fc.double({ min: 0.0001, max: 1_000_000, noNaN: true, noDefaultInfinity: true }),
    fc.double({ min: 0.0001, max: 1_000_000, noNaN: true, noDefaultInfinity: true }),
    (open, close) => {
      const impossibleHigh = Math.min(open, close) - 0.00001;
      const impossibleLow = Math.max(open, close) + 0.00001;
      const invalidRow = [startTime, open, impossibleHigh, impossibleLow, close, 0, startTime + intervalMs - 1];
      assert.throws(() => normalizeHistoryKlines([invalidRow], {
        timeframe: '1m',
        startTime,
        endTime: startTime + 2 * intervalMs,
        snapshotTime: startTime + 2 * intervalMs
      }), /OHLCV/);
    }
  ), { numRuns: 100, seed: 20261112 });
});
