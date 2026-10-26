import { parentPort, workerData } from 'node:worker_threads';
import { detectLiquidityZones } from '../liquidity-zones/engine.mjs';
import { detectLiquidityZonesV2 } from '../liquidity-zones/v2/index.mjs';

/**
 * خيط حساب منفصل للشارت التاريخي: يمنع حظر حلقة أحداث الخادم أثناء حساب
 * المحركين على ~130 ألف شمعة (v2 يحتاج دقائق). يستقبل الشموع كمصفوفة
 * Float64 متداخلة [time,open,high,low,close,volume] ويعيد المناطق مُسقطة
 * بحقول الرسم فقط.
 *
 * لا تعديل هنا على أي قاعدة كشف — استدعاء مباشر لمخرجات المحركين كما هي.
 */

const { engineKey, symbol, timeframe, bars, buf } = workerData;
const values = new Float64Array(buf);

const candles = Array.from({ length: bars }, (_, i) => {
  const o = i * 6;
  return {
    time: values[o],
    open: values[o + 1],
    high: values[o + 2],
    low: values[o + 3],
    close: values[o + 4],
    volume: values[o + 5]
  };
});

const versions = { legacy: 'liquidity-engine-v1', v2: 'liquidity-engine-v2' };

const serializeZone = (zone) => ({
  id: zone.id,
  kind: zone.kind,
  state: zone.state,
  direction: zone.direction,
  referenceLevel: zone.referenceLevel,
  liquidityLevel: zone.liquidityLevel,
  zoneBox: zone.zoneBox ?? null,
  createdAt: zone.createdAt ?? zone.confirmedAt ?? null,
  sweptAt: zone.sweptAt ?? null,
  confidence: zone.confidence,
  touches: zone.touches,
  timeframe: zone.timeframe
});

try {
  const t0 = Date.now();
  const zonesRaw = engineKey === 'v2'
    ? detectLiquidityZonesV2({ symbol, timeframe, candles, endIndex: candles.length - 1 })
    : detectLiquidityZones({ symbol, timeframe, candles, endIndex: candles.length - 1 });
  parentPort.postMessage({
    ok: true,
    engine: versions[engineKey],
    computeMs: Date.now() - t0,
    totalZones: zonesRaw.length,
    zones: zonesRaw.map(serializeZone)
  });
} catch (error) {
  parentPort.postMessage({ ok: false, error: String(error?.message ?? error) });
}
