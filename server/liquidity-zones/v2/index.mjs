/**
 * الواجهة الموحدة لمحرك السيولة v2.
 *
 * نقطة الدخول واحدة بنفس توقيع المحرك الأول:
 *   `detectLiquidityZonesV2({ symbol, timeframe, candles, endIndex, opts })`
 * فيصبح الاستبدال لاحقاً (بعد إثبات الظل) تبديلاً لمصدر واحد بلا إعادة كتابة مستهلكين.
 *
 * المخرجات: مناطق بأربعة أنواع من المحرك الأول (`horizontal_bsl/ssl`, `trendline_bsl/ssl`)
 * **زائد** نوعين جديدين بطلب صاحب النظام (`supply`, `demand`)، ومعها أحداث البنية
 * (IDM/BOS/CHoCH) والفجوات — وهي ما يغذّي التحديد البصري في الواجهة.
 */

import { normalizeCandles, findPivots, atrAt } from '../engine.mjs';
import { detectStructureEvents, classifyExternalPivots } from './structure.mjs';
import { detectFvgs, detectSupplyDemand } from './imbalance.mjs';
import {
  ZONE_DEFAULTS,
  clusterByAtr,
  fitTrendline,
  buildHorizontalZone,
  buildTrendlineZone
} from './zones.mjs';

export const LIQUIDITY_KINDS_V2 = [
  'horizontal_bsl', 'horizontal_ssl', 'trendline_bsl', 'trendline_ssl', 'supply', 'demand'
];

/** تحويل منطقة عرض/طلب من وحدة الفجوات إلى شكل منطقة موحّد للعرض والقياس */
function supplyDemandToZone(sd, { symbol, timeframe, candles, endIndex, opts, structureEvents }) {
  const related = (structureEvents ?? []).filter(e => e.index >= sd.originCandleIndex && e.index <= endIndex);
  const kind = sd.kind; // 'supply' | 'demand'
  const direction = kind === 'demand' ? 'up' : 'down';
  const atr = atrAt(candles ?? [], endIndex, opts.atrPeriod);
  const confidence = 0.3 + (sd.confirmed ? 0.25 : 0) + (sd.form === 'A' ? 0.1 : 0.05)
    + Math.min((sd.fvgs?.length ?? 1) * 0.05, 0.15);
  const mid = (Number(sd.zoneHigh) + Number(sd.zoneLow)) / 2;
  return {
    id: `${symbol}-${timeframe}-${kind}-${sd.form}-${sd.originCandleIndex}`,
    symbol,
    timeframe,
    kind,
    referenceLevel: Number(mid),
    referenceAlt: null,
    liquidityLevel: Number(direction === 'up' ? sd.zoneHigh : sd.zoneLow),
    retailStop: Number(direction === 'up' ? sd.zoneLow - atr * opts.stopAtrMult : sd.zoneHigh + atr * opts.stopAtrMult),
    state: sd.confirmed ? 'confirmed' : 'candidate',
    createdAt: sd.time ?? null,
    confirmedAt: sd.confirmed ? (candles?.[sd.bosIndex]?.time ?? null) : null,
    sweptAt: null,
    confidence: Number(Math.min(confidence, 0.99).toFixed(4)),
    touches: 1,
    touchPoints: [{ index: sd.originCandleIndex, time: sd.time ?? null, price: Number(mid) }],
    staircase: { valid: false, breaks: [], missingAt: -1 },
    finalBreak: null,
    breakSteps: [],
    prominenceAtr: Number(((Number(sd.zoneHigh) - Number(sd.zoneLow)) / Math.max(atr, 1e-12)).toFixed(3)),
    atr: Number(atr.toPrecision(8)),
    distanceAtr: 0,
    reasons: [
      `منطقة ${kind === 'supply' ? 'عرض' : 'طلب'} بالشكل ${sd.form}`,
      `فجوات قيمة عادلة: ${(sd.fvgs ?? []).length}`,
      sd.confirmed ? 'مؤكدة بكسر بنيوي (BOS)' : 'بانتظار كسر بنيوي — غير معتمدة',
      ...(sd.provisional ? ['منطقة مبدئية للعرض فقط'] : [])
    ],
    premium: null,
    trendline: null,
    zoneBox: { high: Number(sd.zoneHigh), low: Number(sd.zoneLow) },
    bodyBox: { high: Number(sd.bodyHigh), low: Number(sd.bodyLow) },
    fvgs: (sd.fvgs ?? []).map(f => ({ index: f.index, kind: f.kind, top: f.top, bottom: f.bottom })),
    form: sd.form,
    invalidation: null,
    structureEvents: related,
    idm: null,
    lastPrice: Number.isFinite(candles?.[endIndex]?.close) ? Number(candles[endIndex].close) : null,
    detectedAt: opts.nowMs ?? 0,
    source: 'liquidity-engine-v2'
  };
}

/**
 * كشف كل مناطق السيولة على (رمز، فريم) عند `endIndex`.
 * @param {Object} params { symbol, timeframe, candles, endIndex, opts }
 * @param {Array} params.candles شموع مُطبَّعة أو صفوف REST (يُقبل الاثنان)
 */
export function detectLiquidityZonesV2({ symbol, timeframe, candles: input, endIndex, opts = {} } = {}) {
  const cfg = { ...ZONE_DEFAULTS, ...opts };
  const raw = Array.isArray(input) ? input : [];
  const candles = raw.length && Array.isArray(raw[0]) ? normalizeCandles(raw) : raw;
  const end = Math.min(Number.isInteger(endIndex) ? endIndex : candles.length - 1, candles.length - 1);
  if (candles.length < 40 || end < 20) return [];

  const pivots = findPivots(candles, { endIndex: end });
  const classified = classifyExternalPivots(pivots, candles, end, cfg);
  const structureEvents = detectStructureEvents(candles, classified, end, cfg);
  const fvgs = detectFvgs(candles, end, structureEvents, cfg);
  const sdZones = detectSupplyDemand(candles, fvgs, structureEvents, end, cfg);

  const zones = [];

  // ---- المناطق الأفقية: تجميع بتسامح ATR + حد لمسات ۲
  const pooled = classifyExternalPivots(pivots, candles, end, { ...cfg, externalMinAtr: -Infinity });
  for (const kind of ['high', 'low']) {
    const points = pooled.filter(p => p.kind === kind && p.index <= end);
    for (const cluster of clusterByAtr(points, cfg.toleranceAtr, cfg)) {
      if (cluster.touches < cfg.minTouches) continue;
      const direction = kind === 'high' ? 'down' : 'up';
      // القمة/القاع الفرعي التالي مباشرة = خط الدفاع الثاني للريتيل
      const nextOfKind = pooled
        .filter(p => p.kind === kind && p.index > cluster.lastIndex && p.index <= end)
        .sort((a, b) => a.index - b.index)[0];
      const zone = buildHorizontalZone({
        symbol, timeframe, cluster, candles, endIndex: end,
        opts: {
          ...cfg,
          structureEvents: structureEvents.filter(e => e.index <= end),
          referenceAltFor: () => (nextOfKind ? Number(nextOfKind.price) : null)
        }
      });
      zone.direction = direction;
      zones.push(zone);
    }
  }

  // ---- خطوط الاتجاه: تركيب أقل مربعات على نقاط كافية البروز
  const tlPoints = (kind) => classified
    .filter(p => p.kind === kind && p.index <= end && (Number(p.prominenceAtr) || 0) >= cfg.minPointProminenceAtr)
    .sort((a, b) => a.index - b.index);
  for (const [pivotKind, zoneKind] of [['high', 'trendline_bsl'], ['low', 'trendline_ssl']]) {
    const points = tlPoints(pivotKind);
    if (points.length < cfg.trendMinPoints) continue;
    const fitted = fitTrendline(points, candles, end, cfg);
    if (!fitted) continue;
    const direction = zoneKind === 'trendline_bsl' ? 'down' : 'up';
    const zone = buildTrendlineZone({ symbol, timeframe, fitted, candles, endIndex: end, kind: zoneKind, opts: { ...cfg, structureEvents } });
    zone.direction = direction;
    zones.push(zone);
  }

  // ---- مناطق العرض والطلب (أنواع مستقلة بطلب صاحب النظام)
  for (const sd of sdZones) {
    zones.push(supplyDemandToZone(sd, { symbol, timeframe, candles, endIndex: end, opts: cfg, structureEvents }));
  }

  return zones.sort((a, b) => b.confidence - a.confidence || (b.createdAt ?? 0) - (a.createdAt ?? 0));
}

/** ملخّص أحداث البنية لمنطقة زمنية — يُستخدم في القياس والصحة والعرض */
export function structureSummary({ candles, endIndex, opts = {} } = {}) {
  const cfg = { ...ZONE_DEFAULTS, ...opts };
  const list = Array.isArray(candles) ? candles : [];
  const end = Math.min(Number.isInteger(endIndex) ? endIndex : list.length - 1, list.length - 1);
  if (list.length < 40 || end < 20) return { idm: 0, bosUp: 0, bosDown: 0, chochUp: 0, chochDown: 0 };
  const pivots = findPivots(list, { endIndex: end });
  const events = detectStructureEvents(list, pivots, end, cfg);
  return {
    idm: events.filter(e => e.type === 'idm').length,
    bosUp: events.filter(e => e.type === 'bos_up').length,
    bosDown: events.filter(e => e.type === 'bos_down').length,
    chochUp: events.filter(e => e.type === 'choch_up').length,
    chochDown: events.filter(e => e.type === 'choch_down').length,
    total: events.length
  };
}
