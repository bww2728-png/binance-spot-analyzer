export interface LiquidityWorkbenchZone {
  id: string;
  symbol: string;
  timeframe: string;
  kind: string;
  direction?: string | null;
  state?: string | null;
  referenceLevel?: number | null;
  liquidityLevel?: number | null;
  confidence?: number | null;
  touches?: number | null;
  createdAt?: number | null;
  confirmedAt?: number | null;
  sweptAt?: number | null;
  zoneBox?: { high?: number; low?: number } | null;
  reasons?: string[];
  engine: string;
  observation: {
    distance: number | null;
    distancePct: number | null;
    priceAt: number | null;
    priceAgeMs: number | null;
    basis: string;
  };
}

export interface LiquidityWorkbenchStatus {
  enabled: boolean;
  recovery: 'pending' | 'loading' | 'ready' | 'degraded' | 'failed' | 'idle' | string;
  error: string | null;
  symbol: string;
  timeframes: string[];
  seeded: number;
  expected: number;
  latestCloseAt: number | null;
  latestScanAt: number | null;
  storedCandles: number;
  lastPrunedAt: number | null;
  tickSize: number | null;
  samples: number;
  persistence?: 'supabase' | 'memory-fallback' | string;
}

export interface LiquidityWorkbenchSnapshot {
  status: LiquidityWorkbenchStatus;
  symbol: string;
  timeframe: string;
  currentPrice: number | null;
  currentPriceAt: number | null;
  currentPriceAgeMs: number | null;
  candles: Array<{ time: number; open: number; high: number; low: number; close: number; volume: number }>;
  latestScan: number | null;
  legacy: LiquidityWorkbenchZone[];
  v2: LiquidityWorkbenchZone[];
  matches: Array<{
    legacyId: string;
    v2Id: string;
    symbol: string;
    timeframe: string;
    direction: string;
    legacyReference: number;
    v2Reference: number;
    priceDelta: number;
    timeDeltaMs: number;
    classification: 'candidate';
  }>;
  recentEvents: Array<{
    idempotency_key: string;
    engine: string;
    symbol: string;
    timeframe: string;
    zone_id: string;
    event_type: string;
    event_at: number;
    payload: { previousState?: string | null; zone?: LiquidityWorkbenchZone };
  }>;
  dataSource: string;
}

export async function fetchLiquidityWorkbench(timeframe: string, signal?: AbortSignal): Promise<LiquidityWorkbenchSnapshot> {
  const response = await fetch(`/api/liquidity-workbench?timeframe=${encodeURIComponent(timeframe)}`, { signal });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(String(body.error ?? `تعذر تحميل مقارنة السيولة (${response.status})`));
  }
  return response.json() as Promise<LiquidityWorkbenchSnapshot>;
}

export async function fetchLiquidityWorkbenchStatus(signal?: AbortSignal): Promise<LiquidityWorkbenchStatus> {
  const response = await fetch('/api/liquidity-workbench/status', { signal });
  if (!response.ok) throw new Error(`تعذر تحميل حالة منظومة السيولة (${response.status})`);
  return response.json() as Promise<LiquidityWorkbenchStatus>;
}
