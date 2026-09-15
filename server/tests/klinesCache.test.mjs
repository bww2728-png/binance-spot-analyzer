import test from 'node:test';
import assert from 'node:assert/strict';

const { mergeCandles } = await import('../../client/src/lib/binance.ts');

test('mergeCandles يدمج ويحافظ على الترتيب ويزيل التكرار', () => {
  const a = [
    { time: 1, open: 1, high: 2, low: 0.5, close: 1.5 },
    { time: 2, open: 1, high: 2, low: 0.5, close: 1.5 },
    { time: 3, open: 1, high: 2, low: 0.5, close: 1.5 }
  ];
  const b = [
    { time: 2, open: 10, high: 11, low: 9, close: 10 },
    { time: 4, open: 5, high: 6, low: 4, close: 5.5 }
  ];
  const m = mergeCandles(a, b);
  assert.equal(m.length, 4);
  assert.equal(m[0].time, 1);
  assert.equal(m[3].time, 4);
  assert.equal(m[1].close, 10);
});
