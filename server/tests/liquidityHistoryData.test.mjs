import assert from 'node:assert/strict';
import { test } from 'node:test';
import { detectHistoryGaps, normalizeHistoryKlines } from '../services/liquidityHistoryData.mjs';

const minute = 60_000;
const startTime = 1_700_000_000_000;
const endTime = startTime + 6 * minute;
const snapshotTime = startTime + 4 * minute;

const row = (openTime, { open = 100, high = 102, low = 99, close = 101, volume = 4 } = {}) => [
  openTime,
  open,
  high,
  low,
  close,
  volume,
  openTime + minute - 1,
  0,
  0,
  0
];

const normalize = (rows, options = {}) => normalizeHistoryKlines(rows, {
  timeframe: '1m',
  startTime,
  endTime,
  snapshotTime,
  ...options
});

test('REST klines normalize to UTC seconds and exclude bars outside range', () => {
  const result = normalize([
    row(startTime - minute),
    row(startTime),
    row(startTime + minute),
    row(startTime + 2 * minute),
    row(startTime + 3 * minute),
    row(startTime + 4 * minute)
  ]);

  assert.deepEqual(result.candles.map((candle) => candle.time), [startTime / 1000, startTime / 1000 + 60, startTime / 1000 + 120, startTime / 1000 + 180]);
  assert.equal(result.quality.sourceUnit, 'milliseconds');
  assert.equal(result.quality.receivedRows, 6);
  assert.equal(result.quality.acceptedBars, 4);
  assert.equal(result.quality.incompleteBars, 1);
});

test('a candle closing after the snapshot is excluded as incomplete', () => {
  const result = normalize([
    row(startTime),
    row(startTime + minute),
    row(startTime + 2 * minute)
  ], { snapshotTime: startTime + 2 * minute - 1 });

  assert.deepEqual(result.candles.map((candle) => candle.time), [startTime / 1000]);
  assert.equal(result.quality.incompleteBars, 2);
});

test('gap metadata identifies exact missing intervals without synthesizing candles', () => {
  const result = normalize([
    row(startTime),
    row(startTime + 3 * minute)
  ]);

  assert.equal(result.candles.length, 2);
  assert.equal(result.quality.gapCount, 1);
  assert.equal(result.quality.missingBars, 2);
  assert.deepEqual(result.quality.gaps, [{
    after: startTime / 1000,
    before: startTime / 1000 + 180,
    missingBars: 2
  }]);
});

test('duplicate and out-of-order rows fail closed', () => {
  assert.throws(() => normalize([row(startTime), row(startTime)]), /مكررة/);
  assert.throws(() => normalize([row(startTime + minute), row(startTime)]), /غير مرتبة/);
});

test('malformed OHLCV and invalid close-time boundaries are rejected', () => {
  assert.throws(() => normalize([row(startTime, { low: 103 })]), /OHLCV/);
  assert.throws(() => normalize([row(startTime, { volume: -1 })]), /OHLCV/);
  assert.throws(() => normalize([[...row(startTime).slice(0, 6), startTime + minute + 1]]), /وقت إغلاق/);
  assert.throws(() => normalize([[startTime * 1000, 100, 102, 99, 101, 4]]), /وحدة أو حد وقت/);
});

test('invalid request bounds and unsupported timeframes fail explicitly', () => {
  assert.throws(() => normalize([], { endTime: startTime }), /حدود الفترة/);
  assert.throws(() => normalize([], { snapshotTime: endTime + 1 }), /وقت اللقطة/);
  assert.throws(() => normalize([], { timeframe: '7m' }), /غير مدعوم/);
});

test('gap detection respects interval duration and returns no gaps for adjacent bars', () => {
  assert.deepEqual(detectHistoryGaps([
    { time: startTime / 1000 },
    { time: startTime / 1000 + 300 }
  ], 300_000), []);
  assert.deepEqual(detectHistoryGaps([
    { time: startTime / 1000 },
    { time: startTime / 1000 + 900 }
  ], 300_000), [{ after: startTime / 1000, before: startTime / 1000 + 900, missingBars: 2 }]);
});
