import assert from 'node:assert/strict';
import { test } from 'node:test';
import { adaptiveConfig, detectLiquidityZones } from '../liquidity-zones/engine.mjs';
import { createHistorySerializer } from '../services/liquidityHistorySerialize.mjs';

const createFixture = (count = 400) => Array.from({ length: count }, (_, index) => {
  const trend = index * 0.05;
  const wave = 100 + trend + Math.sin(index / 7) * 3 + Math.sin(index / 23) * 1.5;
  return {
    time: 1_700_000_000 + index * 60,
    open: wave,
    high: wave + 1 + (index % 13 === 0 ? 0.6 : 0),
    low: wave - 1 - (index % 17 === 0 ? 0.6 : 0),
    close: wave + (index % 3 === 0 ? 0.5 : -0.5),
    volume: 10
  };
});

function computeSerializedZones(candles) {
  const rawZones = detectLiquidityZones({
    symbol: 'TESTUSDT',
    timeframe: '1m',
    candles,
    endIndex: candles.length - 1
  });
  const serializer = createHistorySerializer(candles);
  return rawZones.map((zone) => {
    const serialized = serializer.serializeZone(zone);
    return {
      id: serialized.id,
      kind: serialized.kind,
      availableAt: serialized.availableAt,
      liquidityLevel: serialized.liquidityLevel
    };
  });
}

const signature = (zone) => `${zone.id}|${zone.kind}|${zone.availableAt}|${zone.liquidityLevel}`;

test('full-range filtering does not reproduce legacy engine results computed on historical prefixes', () => {
  const candles = createFixture();
  const fullRangeZones = computeSerializedZones(candles);
  const results = [];

  for (const endIndex of [99, 199, 299, 399]) {
    const prefix = candles.slice(0, endIndex + 1);
    const prefixZones = computeSerializedZones(prefix);
    const snapshotTime = prefix.at(-1).time;
    const filteredFullRangeZones = fullRangeZones.filter((zone) => zone.availableAt <= snapshotTime);
    const filteredSet = new Set(filteredFullRangeZones.map(signature));
    const exactMatches = prefixZones.filter((zone) => filteredSet.has(signature(zone))).length;

    results.push({
      bars: prefix.length,
      rightBars: adaptiveConfig(prefix, prefix.length - 1).rightBars,
      prefixZones: prefixZones.length,
      filteredFullRangeZones: filteredFullRangeZones.length,
      exactMatches
    });
  }

  assert.deepEqual(results, [
    { bars: 100, rightBars: 12, prefixZones: 0, filteredFullRangeZones: 0, exactMatches: 0 },
    { bars: 200, rightBars: 12, prefixZones: 2, filteredFullRangeZones: 1, exactMatches: 1 },
    { bars: 300, rightBars: 12, prefixZones: 2, filteredFullRangeZones: 1, exactMatches: 1 },
    { bars: 400, rightBars: 12, prefixZones: 2, filteredFullRangeZones: 2, exactMatches: 2 }
  ]);
});
