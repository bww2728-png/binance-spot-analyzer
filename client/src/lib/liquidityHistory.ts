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
  liquidityLevel: number;
  zoneBox: { high: number; low: number } | null;
  createdAt: number | null;
  sweptAt: number | null;
  confidence: number;
  touches: number;
  timeframe: string;
  engine: string;
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
}): Promise<LiquidityHistoryResponse> {
  const q = new URLSearchParams({ symbol: opts.symbol, engine: opts.engine });
  if (opts.days != null) q.set('days', String(opts.days));
  return fetch(`/api/liquidity-history?${q}`, { signal: opts.signal }).then(async (res) => {
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try { const b = await res.json(); if (b?.error) msg = b.error; } catch { /* ignore */ }
      throw new Error(msg);
    }
    return res.json() as Promise<LiquidityHistoryResponse>;
  });
}
