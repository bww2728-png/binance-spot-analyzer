import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeBarcode } from '../barcodeCore.mjs';

test('درجة الباركود حتمية وتستخدم العتبة 35', () => {
  const candles = Array.from({ length: 100 }, (_, i) => [
    i * 60_000, '100', '102', '98', i % 2 ? '100.1' : '99.9'
  ]);
  const first = analyzeBarcode(candles);
  const second = analyzeBarcode(candles);
  assert.deepEqual(first, second);
  assert.equal(first.threshold, 35);
  assert.equal(first.candles_count, 100);
});

test('الشموع الهادئة ليست باركوداً', () => {
  const candles = Array.from({ length: 100 }, (_, i) => [
    i * 60_000, '100', '100.2', '99.8', '100.1'
  ]);
  assert.equal(analyzeBarcode(candles).is_barcode, false);
});