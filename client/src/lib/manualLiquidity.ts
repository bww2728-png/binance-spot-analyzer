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

type PublicSupabaseConfig = { url: string; anonKey: string };
type DrawingRow = { drawing_id: string; symbol: string; timeframe: string; drawing_type: ManualDrawingType; payload: ManualDrawing; created_at: number; updated_at: number };
let publicConfigRequest: Promise<PublicSupabaseConfig> | null = null;

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: 'no-store', ...init });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.error ?? `HTTP ${response.status}`);
  return body as T;
}

async function getPublicSupabaseConfig() {
  if (!publicConfigRequest) {
    publicConfigRequest = request<PublicSupabaseConfig>('/api/manual-liquidity/config').then((config) => {
      if (!config || typeof config.url !== 'string' || !/^https?:\/\//.test(config.url) || typeof config.anonKey !== 'string' || !config.anonKey) {
        throw new Error('إعداد Supabase العام غير صالح');
      }
      return config;
    }).catch((error) => {
      publicConfigRequest = null;
      throw error;
    });
  }
  return publicConfigRequest;
}

async function requestPublicDrawings<T>(path: string, init: RequestInit = {}): Promise<T> {
  const { url, anonKey } = await getPublicSupabaseConfig();
  const headers: Record<string, string> = { apikey: anonKey, 'content-type': 'application/json' };
  if (!anonKey.startsWith('sb_publishable_')) headers.Authorization = `Bearer ${anonKey}`;
  if (init.headers instanceof Headers) init.headers.forEach((value, name) => { headers[name] = value; });
  else if (Array.isArray(init.headers)) {
    for (const [name, value] of init.headers) headers[name] = value;
  } else if (init.headers) Object.assign(headers, init.headers);
  const response = await fetch(`${url.replace(/\/+$/, '')}/rest/v1/liquidity_manual_drawings${path}`, {
    cache: 'no-store',
    ...init,
    headers
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(body?.message ?? body?.error ?? `Supabase HTTP ${response.status}`);
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

function rowsForChart(symbol: string, timeframe: string) {
  const query = new URLSearchParams({ select: 'drawing_id,symbol,timeframe,drawing_type,payload,created_at,updated_at', symbol: `eq.${symbol}`, timeframe: `eq.${timeframe}`, order: 'updated_at.asc,drawing_id.asc', limit: '5000' });
  return `?${query}`;
}

function drawingFromRow(row: DrawingRow, symbol: string, timeframe: string) {
  if (!row || row.symbol !== symbol || row.timeframe !== timeframe || row.payload?.id !== row.drawing_id || row.payload?.type !== row.drawing_type || !Array.isArray(row.payload?.anchors)) {
    throw new Error('سجل رسم غير مكتمل أو لا يطابق الرمز والفريم المطلوبين');
  }
  return row.payload;
}

export function fetchManualCandles(symbol: string, timeframe: string, signal?: AbortSignal, before?: number | null) {
  const query = new URLSearchParams({ symbol, timeframe });
  if (before != null) query.set('before', String(before));
  return request<ManualCandleResponse>(`/api/manual-liquidity/candles?${query}`, { signal });
}

export async function fetchManualDrawings(symbol: string, timeframe: string, signal?: AbortSignal) {
  const context = normalizeContext(symbol, timeframe);
  const rows = await requestPublicDrawings<DrawingRow[]>(rowsForChart(context.symbol, timeframe), { signal });
  if (!Array.isArray(rows)) throw new Error('استجابة Supabase للرسومات غير صالحة');
  return { ...context, drawings: rows.map((row) => drawingFromRow(row, context.symbol, timeframe)) };
}

export async function saveManualDrawing(symbol: string, timeframe: string, drawing: ManualDrawing) {
  const context = normalizeContext(symbol, timeframe);
  validateDrawing(drawing);
  const query = new URLSearchParams({ on_conflict: 'symbol,timeframe,drawing_id', select: 'drawing_id,symbol,timeframe,drawing_type,payload,created_at,updated_at' });
  const row: DrawingRow = {
    drawing_id: drawing.id,
    ...context,
    drawing_type: drawing.type,
    payload: drawing,
    created_at: Number.isSafeInteger(drawing.created_at) ? drawing.created_at! : Date.now(),
    updated_at: Date.now()
  };
  const saved = await requestPublicDrawings<DrawingRow[]>(`?${query}`, {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify(row)
  });
  if (!Array.isArray(saved) || saved.length !== 1) throw new Error('Supabase لم يؤكد حفظ الرسم');
  return { saved: true, drawing: drawingFromRow(saved[0], context.symbol, timeframe) };
}

export async function deleteManualDrawing(symbol: string, timeframe: string, drawingId: string) {
  const context = normalizeContext(symbol, timeframe);
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(drawingId)) throw new Error('معرّف الرسم غير صالح');
  const query = new URLSearchParams({ drawing_id: `eq.${drawingId}`, symbol: `eq.${context.symbol}`, timeframe: `eq.${timeframe}` });
  await requestPublicDrawings<null>(`?${query}`, { method: 'DELETE' });
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
