export type ManualDrawingType = 'line' | 'circle' | 'arrow' | 'break' | 'rectangle' | 'text';
export type ManualLiquidityKind = 'BSL' | 'SSL';
export type ManualPoint = { time: number; price: number };
export type ManualDrawing = {
  id: string;
  type: ManualDrawingType;
  anchors: ManualPoint[];
  color: string;
  label: string;
  note: string;
  liquidityType?: ManualLiquidityKind;
  breakType?: 'wick' | 'close';
  radiusBars?: number;
  radiusPrice?: number;
  fillOpacity?: number;
  atr?: { period: number; value: number | null; multiplier: number; method: 'manual' | 'swing' | 'atr' } | null;
  created_at?: number;
};
export type ManualCandle = ManualPoint & { open: number; high: number; low: number; close: number; volume: number; complete: boolean };
export type ManualCandleResponse = {
  symbol: string;
  timeframe: string;
  days: number;
  source: string;
  from: number;
  to: number;
  requestedFrom: number;
  requestedTo: number;
  bars: number;
  closedBars: number;
  incompleteBars: number;
  gaps: number;
  invalidRows: number;
  duplicateRows: number;
  pages: number;
  hasOlder: boolean;
  nextBefore: number | null;
  candles: ManualCandle[];
  cached: boolean;
};

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: 'no-store', ...init });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.error ?? `HTTP ${response.status}`);
  return body as T;
}

export function fetchManualCandles(symbol: string, timeframe: string, signal?: AbortSignal, before?: number | null) {
  const query = new URLSearchParams({ symbol, timeframe });
  if (before != null) query.set('before', String(before));
  return request<ManualCandleResponse>(`/api/manual-liquidity/candles?${query}`, { signal });
}

export function fetchManualDrawings(symbol: string, timeframe: string, signal?: AbortSignal) {
  const query = new URLSearchParams({ symbol, timeframe });
  return request<{ symbol: string; timeframe: string; drawings: ManualDrawing[] }>(`/api/manual-liquidity/drawings?${query}`, { signal });
}

export function saveManualDrawing(symbol: string, timeframe: string, drawing: ManualDrawing) {
  return request<{ saved: boolean; drawing: ManualDrawing }>('/api/manual-liquidity/drawings', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...drawing, symbol, timeframe })
  });
}

export function deleteManualDrawing(symbol: string, timeframe: string, drawingId: string) {
  const query = new URLSearchParams({ symbol, timeframe });
  return request<{ ok: boolean; drawingId: string }>(`/api/manual-liquidity/drawings/${encodeURIComponent(drawingId)}?${query}`, { method: 'DELETE' });
}

export function calculateAtr(candles: ManualCandle[], period = 14) {
  if (!Number.isInteger(period) || period < 2 || period > 100 || candles.length < period + 1) return null;
  const trueRanges = candles.slice(1).map((current, index) => {
    const previousClose = candles[index].close;
    return Math.max(current.high - current.low, Math.abs(current.high - previousClose), Math.abs(current.low - previousClose));
  });
  if (trueRanges.length < period || trueRanges.some((value) => !Number.isFinite(value))) return null;
  let value = trueRanges.slice(0, period).reduce((total, range) => total + range, 0) / period;
  for (const range of trueRanges.slice(period)) value = ((value * (period - 1)) + range) / period;
  return value;
}
