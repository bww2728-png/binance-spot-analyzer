import { parentPort, workerData } from 'node:worker_threads';
import { detectLiquidityZones, adaptiveConfig } from '../liquidity-zones/engine.mjs';
import { detectLiquidityZonesV2 } from '../liquidity-zones/v2/index.mjs';
import { createHistorySerializer } from './liquidityHistorySerialize.mjs';

/**
 * خيط حساب منفصل للشارت التاريخي: يمنع حظر حلقة أحداث الخادم أثناء حساب
 * المحركين على ~130 ألف شمعة (v2 يحتاج دقائق). يستقبل الشموع كمصفوفة
 * Float64 متداخلة [time,open,high,low,close,volume] ويعيد المناطق مُسقطة
 * بحقول الرسم فقط.
 *
 * لا تعديل هنا على أي قاعدة كشف — استدعاء مباشر لمخرجات المحركين كما هي،
 * والتسلسل (بما فيه `availableAt`) في `liquidityHistorySerialize.mjs` المشروح والمُختبر.
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
const endIndex = candles.length - 1;

try {
  const t0 = Date.now();
  const zonesRaw = engineKey === 'v2'
    ? detectLiquidityZonesV2({ symbol, timeframe, candles, endIndex })
    : detectLiquidityZones({ symbol, timeframe, candles, endIndex });

  /**
   * `rightBars` هي نفس القيمة التي يستخدمها `findPivots` في هذه النافذة
   * (adaptiveConfig على آخر شمعة) — فزمن تأكيد أي بيفوت = الشمعة index + rightBars.
   */
  let rightBars = 3;
  try {
    rightBars = adaptiveConfig(candles, Math.max(0, endIndex)).rightBars;
  } catch { /* القيمة الافتراضية آمنة */ }

  const serializer = createHistorySerializer(candles);
  serializer.setRightBars(rightBars);

  const zones = zonesRaw.map(serializer.serializeZone);

  // أحداث البنية: تجميع مرة واحدة مع الحفاظ على ترتيبها الزمني
  const eventsByKey = new Map();
  for (const zone of zonesRaw) {
    const list = Array.isArray(zone.structureEvents) ? zone.structureEvents : [];
    for (const raw of list) {
      const ev = serializer.serializeEvent(raw);
      if (ev && !eventsByKey.has(ev.key)) eventsByKey.set(ev.key, ev);
    }
  }
  const structureEvents = [...eventsByKey.values()]
    .sort((a, b) => a.index - b.index || String(a.type).localeCompare(String(b.type)));

  parentPort.postMessage({
    ok: true,
    engine: versions[engineKey],
    computeMs: Date.now() - t0,
    totalZones: zonesRaw.length,
    rightBars,
    zones,
    structureEvents
  });
} catch (error) {
  parentPort.postMessage({ ok: false, error: String(error?.message ?? error) });
}
