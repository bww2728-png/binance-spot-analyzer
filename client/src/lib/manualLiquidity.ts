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

import { TIMEFRAMES } from './types';

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: 'no-store', ...init });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.error ?? `HTTP ${response.status}`);
  return body as T;
}

function normalizeContext(symbol: string, timeframe: string) {
  const normalizedSymbol = symbol.trim().toUpperCase();
  if (!/^[A-Z0-9]{3,20}$/.test(normalizedSymbol) || !TIMEFRAMES.includes(timeframe as (typeof TIMEFRAMES)[number])) {
    throw new Error('الرمز أو الفريم غير صالحين لحفظ الرسومات');
  }
  return { symbol: normalizedSymbol, timeframe };
}

function validateDrawing(drawing: ManualDrawing) {
  if (!drawing || !/^[A-Za-z0-9_-]{1,80}$/.test(drawing.id) || !['line', 'circle', 'arrow', 'break', 'rectangle', 'text'].includes(drawing.type)) {
    throw new Error('بيانات الرسم غير صالحة');
  }
  const minimum = ['line', 'break', 'rectangle'].includes(drawing.type) ? 2 : 1;
  if (!Array.isArray(drawing.anchors) || drawing.anchors.length < minimum || drawing.anchors.length > 8 || drawing.anchors.some((point) => !Number.isSafeInteger(point.time) || point.time <= 0 || !Number.isFinite(point.price) || point.price <= 0 || point.price > 1e12)) {
    throw new Error('نقاط الرسم غير صالحة');
  }
  if (drawing.type === 'arrow' && !['BSL', 'SSL'].includes(drawing.liquidityType ?? '')) throw new Error('نوع سهم السيولة غير صالح');
  if (drawing.type === 'text' && !drawing.label && !drawing.note) throw new Error('أدخل نصاً للرسم');
  if (new TextEncoder().encode(JSON.stringify(drawing)).length > 16_384) throw new Error('حجم الرسم أكبر من المسموح');
}

export function fetchManualCandles(symbol: string, timeframe: string, signal?: AbortSignal, before?: number | null) {
  const query = new URLSearchParams({ symbol, timeframe });
  if (before != null) query.set('before', String(before));
  return request<ManualCandleResponse>(`/api/manual-liquidity/candles?${query}`, { signal });
}

const drawingQuery = (symbol: string, timeframe: string) => new URLSearchParams({ symbol, timeframe }).toString();

function validateDrawingsResponse(value: unknown, symbol: string, timeframe: string) {
  if (!value || typeof value !== 'object') throw new Error('استجابة الخادم للرسومات غير صالحة');
  const response = value as { symbol?: unknown; timeframe?: unknown; drawings?: unknown };
  if (response.symbol !== symbol || response.timeframe !== timeframe || !Array.isArray(response.drawings)) {
    throw new Error('سجل رسم غير مكتمل أو لا يطابق الرمز والفريم المطلوبين');
  }
  for (const drawing of response.drawings) validateDrawing(drawing as ManualDrawing);
  return response.drawings as ManualDrawing[];
}

export async function fetchManualDrawings(symbol: string, timeframe: string, signal?: AbortSignal) {
  const context = normalizeContext(symbol, timeframe);
  const response = await request<unknown>(`/api/manual-liquidity/drawings?${drawingQuery(context.symbol, context.timeframe)}`, { signal });
  return { ...context, drawings: validateDrawingsResponse(response, context.symbol, context.timeframe) };
}

export async function saveManualDrawing(symbol: string, timeframe: string, drawing: ManualDrawing) {
  const context = normalizeContext(symbol, timeframe);
  validateDrawing(drawing);
  const response = await request<{ saved?: unknown; drawing?: unknown }>('/api/manual-liquidity/drawings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...context, ...drawing, drawing_id: drawing.id })
  });
  if (response?.saved !== true) throw new Error('الخادم لم يؤكد حفظ الرسم');
  validateDrawing(response.drawing as ManualDrawing);
  return { saved: true, drawing: response.drawing as ManualDrawing };
}

export async function deleteManualDrawing(symbol: string, timeframe: string, drawingId: string) {
  const context = normalizeContext(symbol, timeframe);
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(drawingId)) throw new Error('معرّف الرسم غير صالح');
  const query = drawingQuery(context.symbol, context.timeframe);
  const response = await request<{ ok?: unknown }>(`/api/manual-liquidity/drawings/${encodeURIComponent(drawingId)}?${query}`, { method: 'DELETE' });
  if (response?.ok !== true) throw new Error('الخادم لم يؤكد حذف الرسم');
  return { ok: true, drawingId };
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
