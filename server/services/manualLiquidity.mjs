import { TF_MS } from '../market/candleStore.mjs';

const SYMBOL_RE = /^[A-Z0-9]{3,20}$/;
const DRAWING_TYPES = new Set(['line', 'circle', 'arrow', 'break', 'rectangle', 'text']);
const MAX_PAYLOAD_BYTES = 16_384;
const DAY_MS = 86_400_000;
const HISTORY_DAYS = 90;
const PAGE_LIMIT = 1000;
const CACHE_TTL_MS = 60_000;

const badRequest = (message) => Object.assign(new Error(message), { statusCode: 400 });
const normalizeSymbol = (value) => String(value ?? '').trim().toUpperCase();

function validateContext({ symbol, timeframe }) {
  const normalizedSymbol = normalizeSymbol(symbol);
  const normalizedTimeframe = String(timeframe ?? '');
  if (!SYMBOL_RE.test(normalizedSymbol)) throw badRequest('صيغة الرمز غير صالحة');
  if (!Object.hasOwn(TF_MS, normalizedTimeframe)) throw badRequest('الفريم الزمني غير مدعوم');
  return { symbol: normalizedSymbol, timeframe: normalizedTimeframe };
}

function validateDrawing(input, context, now) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw badRequest('بيانات الرسم غير صالحة');
  const drawingId = String(input.drawing_id ?? input.id ?? '');
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(drawingId)) throw badRequest('معرّف الرسم غير صالح');
  if (!DRAWING_TYPES.has(input.type)) throw badRequest('نوع الرسم غير مدعوم');
  const anchors = input.anchors;
  const minAnchors = ['line', 'break', 'rectangle'].includes(input.type) ? 2 : 1;
  if (!Array.isArray(anchors) || anchors.length < minAnchors || anchors.length > 8) throw badRequest('نقاط الرسم غير صالحة');
  for (const anchor of anchors) {
    const time = Number(anchor?.time);
    const price = Number(anchor?.price);
    if (!Number.isSafeInteger(time) || time <= 0 || time > Math.floor(now / 1000) + 604_800) throw badRequest('وقت نقطة الرسم غير صالح');
    if (!Number.isFinite(price) || price <= 0 || price > 1e12) throw badRequest('سعر نقطة الرسم غير صالح');
  }
  if (input.type === 'arrow' && !['BSL', 'SSL'].includes(input.liquidityType)) throw badRequest('نوع سهم السيولة يجب أن يكون BSL أو SSL');
  const payload = {
    id: drawingId,
    type: input.type,
    anchors: anchors.map(({ time, price }) => ({ time: Number(time), price: Number(price) })),
    color: typeof input.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(input.color) ? input.color : '#94a3b8',
    label: String(input.label ?? '').slice(0, 240),
    note: String(input.note ?? '').slice(0, 2000),
    liquidityType: input.type === 'arrow' ? input.liquidityType : null,
    breakType: input.type === 'break' && ['wick', 'close'].includes(input.breakType) ? input.breakType : null,
    radiusBars: Math.min(100, Math.max(1, Number(input.radiusBars) || 4)),
    radiusPrice: Math.min(1e9, Math.max(0, Number(input.radiusPrice) || 0)),
    fillOpacity: Math.min(0.8, Math.max(0.05, Number(input.fillOpacity) || 0.18)),
    atr: input.atr && typeof input.atr === 'object' ? {
      period: Math.min(100, Math.max(2, Math.floor(Number(input.atr.period) || 14))),
      value: Number.isFinite(Number(input.atr.value)) ? Number(input.atr.value) : null,
      multiplier: Math.min(20, Math.max(0.1, Number(input.atr.multiplier) || 2)),
      method: ['manual', 'swing', 'atr'].includes(input.atr.method) ? input.atr.method : 'manual'
    } : null
  };
  if (payload.type === 'text' && !payload.label && !payload.note) throw badRequest('أدخل نصاً للرسم');
  if (Buffer.byteLength(JSON.stringify(payload), 'utf8') > MAX_PAYLOAD_BYTES) throw badRequest('حجم الرسم أكبر من المسموح');
  return {
    drawing_id: drawingId,
    symbol: context.symbol,
    timeframe: context.timeframe,
    drawing_type: payload.type,
    payload,
    created_at: Number.isSafeInteger(Number(input.created_at)) ? Number(input.created_at) : now,
    updated_at: now
  };
}

function validCandle(row, timeframeMs, endMs) {
  if (!Array.isArray(row) || row.length < 6) return null;
  const openTime = Number(row[0]);
  const values = row.slice(1, 6).map(Number);
  if (!Number.isFinite(openTime) || openTime < 0 || openTime > endMs || values.some((value) => !Number.isFinite(value))) return null;
  const [open, high, low, close, volume] = values;
  if (open <= 0 || close <= 0 || low <= 0 || high < Math.max(open, close, low) || low > Math.min(open, close, high) || volume < 0) return null;
  return { time: Math.floor(openTime / 1000), open, high, low, close, volume, complete: openTime + timeframeMs <= endMs };
}

export function createManualLiquidityService({ klines, repository, now = () => Date.now() } = {}) {
  if (typeof klines !== 'function') throw new Error('manual liquidity: klines is required');
  if (!repository || typeof repository.listManualDrawings !== 'function' || typeof repository.upsertManualDrawing !== 'function' || typeof repository.deleteManualDrawing !== 'function') {
    throw new Error('manual liquidity: drawing repository is required');
  }
  const cache = new Map();

  async function candles(input) {
    const context = validateContext(input);
    const key = `${context.symbol}|${context.timeframe}`;
    const endMs = now();
    const intervalMs = TF_MS[context.timeframe];
    const rangeStart = endMs - HISTORY_DAYS * DAY_MS;
    const beforeMs = Number.isFinite(Number(input.before)) && Number(input.before) > 0 ? Number(input.before) * 1000 : null;
    const requestedEnd = beforeMs == null ? endMs : Math.min(endMs, beforeMs - 1);
    const requestedStart = Math.max(rangeStart, requestedEnd - intervalMs * (PAGE_LIMIT - 1));
    const cacheKey = `${key}|${Math.floor(requestedEnd / intervalMs)}`;
    const cached = cache.get(cacheKey);
    if (cached && cached.expiresAt > now()) return { ...cached.value, cached: true };

    const rows = await klines(context.symbol, context.timeframe, PAGE_LIMIT, requestedStart, requestedEnd);
    if (!Array.isArray(rows)) throw new Error('مصدر الشموع أعاد استجابة غير صالحة');
    const byTime = new Map();
    let invalidRows = 0;
    let duplicateRows = 0;
    for (const row of rows) {
      const candle = validCandle(row, intervalMs, endMs);
      if (!candle) { invalidRows += 1; continue; }
      if (candle.time * 1000 < rangeStart || candle.time * 1000 > requestedEnd) continue;
      if (byTime.has(candle.time)) { duplicateRows += 1; continue; }
      byTime.set(candle.time, candle);
    }
    const resultRows = [...byTime.values()].sort((a, b) => a.time - b.time);
    if (!resultRows.length) throw Object.assign(new Error('لا توجد شموع تاريخية لهذا الرمز والفريم'), { statusCode: 404 });
    let gaps = 0;
    for (let index = 1; index < resultRows.length; index += 1) {
      const delta = resultRows[index].time - resultRows[index - 1].time;
      if (delta > intervalMs / 1000) gaps += Math.max(1, Math.round(delta / (intervalMs / 1000)) - 1);
    }
    const firstMs = resultRows[0].time * 1000;
    const closedBars = resultRows.filter((candle) => candle.complete).length;
    const value = {
      symbol: context.symbol,
      timeframe: context.timeframe,
      days: HISTORY_DAYS,
      source: 'binance-spot',
      from: resultRows[0].time,
      to: resultRows[resultRows.length - 1].time,
      requestedFrom: Math.floor(requestedStart / 1000),
      requestedTo: Math.floor(requestedEnd / 1000),
      bars: resultRows.length,
      closedBars,
      incompleteBars: resultRows.length - closedBars,
      gaps,
      invalidRows,
      duplicateRows,
      pages: 1,
      hasOlder: firstMs > rangeStart,
      nextBefore: firstMs > rangeStart ? resultRows[0].time : null,
      candles: resultRows,
      cached: false
    };
    cache.set(cacheKey, { value, expiresAt: now() + CACHE_TTL_MS });
    while (cache.size > 12) cache.delete(cache.keys().next().value);
    return value;
  }

  async function listDrawings(input) {
    const context = validateContext(input);
    const rows = await repository.listManualDrawings(context);
    if (!Array.isArray(rows)) throw new Error('تعذر قراءة الرسومات المحفوظة');
    return rows.map((row) => row.payload);
  }

  async function saveDrawing(input) {
    const context = validateContext(input);
    const row = validateDrawing(input, context, now());
    const saved = await repository.upsertManualDrawing(row);
    if (!Array.isArray(saved) || !saved.length) throw new Error('لم يؤكد التخزين حفظ الرسم');
    return saved[0].payload;
  }

  async function deleteDrawing(input) {
    const context = validateContext(input);
    const drawingId = String(input?.drawingId ?? '');
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(drawingId)) throw badRequest('معرّف الرسم غير صالح');
    await repository.deleteManualDrawing({ ...context, drawingId });
    return { ok: true, drawingId };
  }

  return { candles, listDrawings, saveDrawing, deleteDrawing };
}
