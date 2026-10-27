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
  touchPoints?: Array<{ index?: number; time?: number; price?: number }>;
  trendline?: { points?: Array<{ index?: number; time?: number; price?: number }> } | null;
  fvgs?: Array<{ index?: number; kind?: string; top?: number; bottom?: number }>;
  structureEvents?: Array<{ type?: string; index?: number; time?: number; price?: number; brokenLevel?: number }>;
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

export interface LiquidityWorkbenchPoint {
  point_id: string;
  engine: string;
  symbol: string;
  timeframe: string;
  zone_id: string;
  point_type: string;
  role: string;
  point_time: number | null;
  candle_index: number | null;
  price: number | null;
  price_low: number | null;
  price_high: number | null;
  zone_state: string | null;
  confirmed_at: number | null;
  last_reviewed_at: number;
  rules_version: string;
  payload: Record<string, unknown>;
  zone_links?: Array<{
    engine: string;
    symbol: string;
    timeframe: string;
    zone_id: string;
    relation_role: string;
    zone_kind: string;
    zone_state: string | null;
    last_seen_at: number;
  }>;
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

export interface LiquidityWorkbenchContext {
  available: boolean;
  reason?: string;
  contextOnly?: boolean;
  affectsOpportunityDecisions?: boolean;
  symbol: string;
  timeframe: string;
  recovery?: string;
  persistence?: string;
  latestScan?: number | null;
  currentPriceAt?: number | null;
  legacy?: LiquidityWorkbenchZone[];
  v2?: LiquidityWorkbenchZone[];
}

export async function fetchLiquidityWorkbenchContext(symbol: string, timeframe: string, signal?: AbortSignal): Promise<LiquidityWorkbenchContext> {
  const query = new URLSearchParams({ symbol, timeframe });
  const response = await fetch(`/api/liquidity-workbench/context?${query}`, { signal });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(String(body.error ?? `تعذر تحميل سياق مناطق السيولة (${response.status})`));
  }
  return response.json() as Promise<LiquidityWorkbenchContext>;
}

export async function fetchLiquidityWorkbenchPoints(timeframe: string, engine: string, zoneId: string, signal?: AbortSignal): Promise<LiquidityWorkbenchPoint[]> {
  const query = new URLSearchParams({ timeframe, engine, zoneId });
  const response = await fetch(`/api/liquidity-workbench/points?${query}`, { signal });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(String(body.error ?? `تعذر تحميل نقاط المنطقة (${response.status})`));
  }
  const body = await response.json() as { points?: LiquidityWorkbenchPoint[] };
  return Array.isArray(body.points) ? body.points : [];
}

export async function fetchLiquidityWorkbenchStatus(signal?: AbortSignal): Promise<LiquidityWorkbenchStatus> {
  const response = await fetch('/api/liquidity-workbench/status', { signal });
  if (!response.ok) throw new Error(`تعذر تحميل حالة منظومة السيولة (${response.status})`);
  return response.json() as Promise<LiquidityWorkbenchStatus>;
}
