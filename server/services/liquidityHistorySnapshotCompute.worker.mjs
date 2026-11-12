import { parentPort, workerData } from 'node:worker_threads';
import { detectLiquidityZones, adaptiveConfig } from '../liquidity-zones/engine.mjs';
import { createHistorySerializer } from './liquidityHistorySerialize.mjs';

const { symbol, timeframe, bars, buffer } = workerData;
const packed = new Float64Array(buffer);
const candles = Array.from({ length: bars }, (_, index) => {
  const offset = index * 6;
  return {
    time: packed[offset],
    open: packed[offset + 1],
    high: packed[offset + 2],
    low: packed[offset + 3],
    close: packed[offset + 4],
    volume: packed[offset + 5]
  };
});

try {
  const startedAt = Date.now();
  const endIndex = candles.length - 1;
  const rawZones = detectLiquidityZones({ symbol, timeframe, candles, endIndex });
  const rightBars = adaptiveConfig(candles, endIndex).rightBars;
  const serializer = createHistorySerializer(candles);
  serializer.setRightBars(rightBars);
  const zones = rawZones.map((zone) => serializer.serializeZone(zone));

  parentPort.postMessage({
    ok: true,
    bars,
    totalZones: rawZones.length,
    rightBars,
    rawZones,
    zones,
    computeMs: Date.now() - startedAt
  });
} catch (error) {
  parentPort.postMessage({ ok: false, error: String(error?.message ?? error) });
}
