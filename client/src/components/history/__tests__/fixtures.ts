import { buildElements } from '../../../../../shared/historyModel.mjs';
import type { HistoryElement, HistoryMeta } from '../../../../../shared/historyModel.mjs';
import type { LiquidityHistoryResponse, LiquidityHistoryZone } from '../../../lib/liquidityHistory';

/**
 * عيّنات اختبار مبنية على **نفس** خط أنابيب الإنتاج (`buildElements`)،
 * لا كائنات مخترعة بيد — حتى لا يمرّ الاختبار على شكل بيانات لا ينتجه المحرك.
 * الأزمنة ثوانٍ UNIX صغيرة مقصودة لتُقرأ بسهولة في التوقعات.
 */

/** منطقة legacy مكتملة الأزمنة: نشأة 1000 · معرفة 1060 · تأكيد 1200 · سويب 2000 */
export const legacyZone: LiquidityHistoryZone = {
  id: 'Z1',
  kind: 'horizontal_bsl',
  state: 'swept',
  direction: 'bearish',
  referenceLevel: 100,
  referenceAlt: null,
  liquidityLevel: 101,
  retailStop: 98,
  zoneBox: { high: 101, low: 99 },
  bodyBox: { high: 100.5, low: 99.5 },
  createdAt: 1000,
  confirmedAt: 1200,
  detectedAt: 1_700_000_000,
  sweptAt: 2000,
  invalidatedAt: null,
  invalidation: null,
  availableAt: 1060,
  availableAtBasis: 'pivot_confirm',
  confidence: 0.5,
  touches: 3,
  timeframe: '1m',
  touchPoints: [{ index: 1, time: 1000, price: 99.5, availableAt: 1060 }],
  trendline: null,
  staircase: null,
  finalBreak: null,
  breakSteps: [],
  atr: 5,
  distanceAtr: 0.4,
  prominenceAtr: null,
  reasons: ['سبب من المحرك'],
  premium: null,
  form: 'pivots',
  fvgs: [],
  structureEventKeys: [],
  source: 'engine'
};

/** منطقة v2 بلا أزمنة تأكيد/سويب — تُختبر حدود العرض عند نقص البيانات */
export const v2UntimedZone: LiquidityHistoryZone = {
  ...legacyZone,
  id: 'Z2',
  kind: 'demand',
  state: 'confirmed',
  createdAt: 5000,
  confirmedAt: null,
  detectedAt: null,
  sweptAt: null,
  invalidatedAt: null,
  availableAt: 5300,
  availableAtBasis: 'fvg_formed',
  referenceAlt: 95,
  bodyBox: null,
  touchPoints: [],
  reasons: [],
  fvgs: []
};

export const buildLegacy = () => buildElements({ engine: 'legacy', zones: [legacyZone] });
export const buildV2 = () =>
  buildElements({ engine: 'v2', zones: [v2UntimedZone], structureEvents: [] });

/** استجابة وهمية بالشكل الذي يُنتجه الخادم — لأجل لوحة التفاصيل فقط */
export const responseOf = (
  engineType: 'legacy' | 'v2',
  zones: LiquidityHistoryZone[],
  structureEvents: LiquidityHistoryResponse['structureEvents'] = []
): LiquidityHistoryResponse => ({
  engineKey: engineType,
  engine: engineType,
  symbol: 'BTCUSDT',
  timeframe: '1m',
  days: 7,
  source: 'binance',
  from: 1000,
  to: 8000,
  expectedBars: 101,
  bars: 101,
  gaps: 0,
  totalZones: zones.length,
  zonesCapped: false,
  zones,
  structureEvents,
  meta: { rightBars: 3, computedAt: 1_700_000_000 },
  candles: [],
  computeMs: 1,
  cached: true
});

export const elementOf = (
  input: { elements: HistoryElement[]; meta: HistoryMeta },
  idPrefix: string
): HistoryElement => {
  const el = input.elements.find((e) => e.id.startsWith(idPrefix));
  if (!el) throw new Error(`fixture element not found: ${idPrefix}`);
  return el;
};
