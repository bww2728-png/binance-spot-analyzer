/**
 * الشارت التاريخي (1m) لمحركي السيولة — طبقة العميل.
 * الحمولة شموع مدمجة [time,o,h,l,c,v] ومناطق بحقول المحرك كما هي (بلا اشتقاق مخفي)
 * + `availableAt` (أول لحظة يمكن فيها معرفة العنصر) + أحداث البنية مرة واحدة.
 */

export type LiquidityHistoryEngine = 'legacy' | 'v2';

export interface HistoryTouchPoint {
  index: number | null;
  time: number;
  price: number;
  /** زمن تأكيد البيفوت (بعد شموع rightBars) — لا يُعرض قبل وقوعه */
  availableAt: number | null;
}

export interface HistoryFvg {
  index: number | null;
  time: number | null;
  kind: string | null;
  top: number;
  bottom: number;
  availableAt: number | null;
  invalidatedAt: number | null;
}

export interface HistoryStructureEvent {
  key: string;
  type: string;
  index: number;
  time: number;
  price: number;
  brokenLevel: number | null;
  brokenPivotIndex: number | null;
  brokenPivotTime: number | null;
  brokenIndex: number | null;
  brokenTime: number | null;
  confirmBasis: string | null;
  external: boolean;
  priorBos: number | null;
  idmLevel: number | null;
  availableAt: number | null;
  confirmed: boolean;
  evidence: Record<string, unknown> | null;
}

export interface LiquidityHistoryZone {
  id: string;
  kind: string;
  state: string;
  direction: string | null;
  referenceLevel: number | null;
  referenceAlt: number | null;
  liquidityLevel: number | null;
  retailStop: number | null;
  zoneBox: { high: number; low: number } | null;
  bodyBox: { high: number; low: number } | null;
  /** زمن نشأة العنصر السعري (قد يسبق لحظة المعرفة) */
  createdAt: number | null;
  /** زمن تأكيد المحرك الفعلي — منفصل عن createdAt */
  confirmedAt: number | null;
  /** ساعة الخادم عند الحساب — لا يدخل في قرار العرض التاريخي */
  detectedAt: number | null;
  sweptAt: number | null;
  invalidatedAt: number | null;
  invalidation: Record<string, unknown> | null;
  /** أول لحظة يمكن فيها معرفة المنطقة (تأكيد آخر بيفوت / تكون FVG) */
  availableAt: number | null;
  availableAtBasis: 'created' | 'pivot_confirm' | 'fvg_formed' | string;
  confidence: number | null;
  touches: number | null;
  timeframe: string;
  engine?: string;
  touchPoints: HistoryTouchPoint[];
  trendline: {
    points: Array<{ index: number | null; time: number; price: number }>;
    projected: number | null;
    slope: number | null;
    errorAtr: number | null;
    maxDeviationAtr: number | null;
  } | null;
  staircase: { valid: boolean; breaks: Array<{ index: number; time: number; reactionPrice: number }>; missingAt: number } | null;
  finalBreak: { breakTime: number | null; reactionPrice: number } | null;
  breakSteps: Array<{ index?: number; time?: number | null; reactionPrice?: number }>;
  atr: number | null;
  distanceAtr: number | null;
  prominenceAtr: number | null;
  reasons: string[];
  premium: Record<string, unknown> | null;
  form: string | null;
  fvgs: HistoryFvg[];
  structureEventKeys: string[];
  source: string;
}

export interface LiquidityHistoryResponse {
  engineKey: LiquidityHistoryEngine;
  engine: string;
  symbol: string;
  timeframe: '1m';
  days: number;
  source: string;
  from: number;
  to: number;
  expectedBars: number;
  bars: number;
  gaps: number;
  totalZones: number;
  zonesCapped: boolean;
  zones: LiquidityHistoryZone[];
  structureEvents: HistoryStructureEvent[];
  meta: { rightBars: number | null; computedAt: number | null };
  candles: Array<[number, number, number, number, number, number]>;
  computeMs: number;
  totalMs?: number;
  cached: boolean;
  stale?: boolean;
}

export function fetchLiquidityHistory(opts: {
  symbol: string;
  engine: LiquidityHistoryEngine;
  days?: number;
  signal?: AbortSignal;
  /** مهلة الانتظار الكلية بالمللي ثانية (أول حساب لv2 على 90 يوماً يستغرق ~15 دقيقة على الخادم) */
  deadlineMs?: number;
}): Promise<LiquidityHistoryResponse> {
  const q = new URLSearchParams({ symbol: opts.symbol, engine: opts.engine });
  if (opts.days != null) q.set('days', String(opts.days));
  const url = `/api/liquidity-history?${q}`;
  const deadline = Date.now() + (opts.deadlineMs ?? (opts.engine === 'v2' ? 95 * 60_000 : 25 * 60_000));

  const once = async (): Promise<LiquidityHistoryResponse | 'computing'> => {
    const res = await fetch(url, { signal: opts.signal });
    if (res.status === 202) {
      await res.json().catch(() => null);
      return 'computing';
    }
    if (res.status === 503) {
      // فشل حساب سابق وتهدئة قصيرة — استمر بالاستطلاع حتى المهلة الكلية
      await res.json().catch(() => null);
      return 'computing';
    }
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try { const b = await res.json(); if (b?.error) msg = b.error; } catch { /* ignore */ }
      throw new Error(msg);
    }
    return res.json() as Promise<LiquidityHistoryResponse>;
  };

  const wait = (ms: number) => new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    opts.signal?.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('aborted', 'AbortError')); }, { once: true });
  });

  // الاستطلاع: الخادم قد يحتاج دقائق لأول حساب (v2 على عمق 90 يوماً)
  return (async function poll(): Promise<LiquidityHistoryResponse> {
    for (;;) {
      const result = await once();
      if (result !== 'computing') return result;
      if (Date.now() + 3_000 > deadline) {
        throw new Error('تجاوز تجهيز الشارت التاريخي المهلة — جرّب تحديثاً لاحقاً (النتيجة تُخزَّن على الخادم فتكون جاهزة أسرع في المرة القادمة)');
      }
      await wait(3_000);
    }
  })();
}
