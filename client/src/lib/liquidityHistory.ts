/**
 * الشارت التاريخي (1m) لمحركي السيولة — طبقة العميل.
 * الحمولة شموع مدمجة [time,o,h,l,c,v] ومناطق مُسقطة بحقول الرسم فقط.
 */

export type LiquidityHistoryEngine = 'legacy' | 'v2';

export interface LiquidityHistoryZone {
  id: string;
  kind: string;
  state: string;
  direction: string;
  referenceLevel: number;
  referenceAlt: number | null;
  liquidityLevel: number;
  zoneBox: { high: number; low: number } | null;
  bodyBox: { high: number; low: number } | null;
  createdAt: number | null;
  sweptAt: number | null;
  confidence: number;
  touches: number;
  timeframe: string;
  engine?: string;
  touchPoints: Array<{ time: number; price: number }>;
  trendline: { points: Array<{ time: number; price: number }>; projected: number } | null;
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
  candles: Array<[number, number, number, number, number, number]>;
  computeMs: number;
  cached: boolean;
}

export function fetchLiquidityHistory(opts: {
  symbol: string;
  engine: LiquidityHistoryEngine;
  days?: number;
  signal?: AbortSignal;
  /** مهلة الانتظار الكلية بالمللي ثانية (الحساب الأول لv2 على 90 يوماً يستغرق دقائق) */
  deadlineMs?: number;
}): Promise<LiquidityHistoryResponse> {
  const q = new URLSearchParams({ symbol: opts.symbol, engine: opts.engine });
  if (opts.days != null) q.set('days', String(opts.days));
  const url = `/api/liquidity-history?${q}`;
  const deadline = Date.now() + (opts.deadlineMs ?? 8 * 60_000);

  const once = async (): Promise<LiquidityHistoryResponse | 'computing'> => {
    const res = await fetch(url, { signal: opts.signal });
    if (res.status === 202) {
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
