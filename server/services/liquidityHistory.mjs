import { detectLiquidityZones } from '../liquidity-zones/engine.mjs';
import { detectLiquidityZonesV2 } from '../liquidity-zones/v2/index.mjs';

/**
 * شارت تاريخي (1m) لمحركي السيولة — حساب عند الطلب فوق شموع تاريخية عميقة.
 *
 * يجلب شموع الدقيقة من Binance بتقسيم دفعات (1000 شمعة لكل نداء، تزامن محدود)،
 * ثم يشغّل المحرك المطلوب **كما هو** بلا أي تعديل على قواعد الكشف، على العمق
 * الكامل (endIndex = آخر شمعة). الكاش بالذاكرة بمفتاح (رمز، محرك، عمق) مع قفل
 * يمنع حسابين متوازيين لنفس المفتاح — لأن الحساب على ~130 ألف شمعة ثقيل.
 *
 * لا يحفظ شيئاً في قاعدة البيانات ولا يُغذّي أي قرار: قراءة السوق + عرض.
 */

const MINUTE_MS = 60_000;
const BATCH = 1000;            // سقف Binance لكل نداء klines
const FETCH_CONCURRENCY = 4;   // نداءات متوازية محدودة — المحدد الداخلي يبقى مرجعاً
const TTL_MS = 15 * 60_000;    // صلاحية الكاش: نتائج ثابتة تاريخياً في الأغلب
const MIN_DAYS = 7;
const MAX_DAYS = 120;
const DEFAULT_DAYS = 90;
const MAX_ZONES = 400;         // سقف عرض معلن — لا يقطع الحساب
const MAX_CACHE_ENTRIES = 4;   // محركان × عمقان تقريباً
const SYMBOL_RE = /^[A-Z0-9]{1,20}$/;

const ENGINE_VERSIONS = {
  legacy: 'liquidity-engine-v1',
  v2: 'liquidity-engine-v2'
};

const badRequest = (message) => Object.assign(new Error(message), { statusCode: 400 });

/** حقول الرسم فقط — تُسقط الحقول الثقيلة (visual، structureEvents…) من المخرجات */
function serializeZone(zone, engineKey) {
  return {
    id: zone.id,
    kind: zone.kind,
    state: zone.state,
    direction: zone.direction,
    referenceLevel: zone.referenceLevel,
    liquidityLevel: zone.liquidityLevel,
    zoneBox: zone.zoneBox ?? null,
    createdAt: zone.createdAt ?? zone.confirmedAt ?? null,
    sweptAt: zone.sweptAt ?? null,
    confidence: zone.confidence,
    touches: zone.touches,
    timeframe: zone.timeframe,
    engine: ENGINE_VERSIONS[engineKey]
  };
}

export function createLiquidityHistoryService({ klines, now = () => Date.now(), ttlMs = TTL_MS } = {}) {
  if (typeof klines !== 'function') throw new Error('liquidity-history: klines is required');
  const cache = new Map();   // key → { expiresAt, value }
  const inflight = new Map(); // key → Promise

  /** جلب شموع 1m بعمق `days` يوماً — دفعات ثابتة البداية بتزامن محدود */
  async function fetchCandles(symbol, days) {
    const end = now();
    const start = Math.floor((end - days * 86_400_000) / MINUTE_MS) * MINUTE_MS;
    const expected = Math.floor((end - start) / MINUTE_MS) + 1; // شموع الفترة مغلقة على الطرفين
    const starts = [];
    for (let t = start; t < end; t += BATCH * MINUTE_MS) starts.push(t);
    const batches = new Array(starts.length);
    let failure = null;
    let cursor = 0;
    const worker = async () => {
      while (failure == null) {
        const i = cursor;
        cursor += 1;
        if (i >= starts.length) return;
        try {
          batches[i] = await klines(symbol, '1m', BATCH, starts[i]);
        } catch (error) {
          failure = failure ?? error;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(FETCH_CONCURRENCY, starts.length) }, worker));
    if (failure) throw failure;

    const candles = [];
    let lastTime = -Infinity;
    for (const batch of batches) {
      for (const row of batch ?? []) {
        const openTime = Number(row[0]);
        if (!Number.isFinite(openTime) || openTime > end || openTime <= lastTime) continue;
        lastTime = openTime;
        candles.push({
          time: openTime / 1000,
          open: Number(row[1]),
          high: Number(row[2]),
          low: Number(row[3]),
          close: Number(row[4]),
          volume: Number(row[5] ?? 0)
        });
      }
    }
    return { candles, expected };
  }

  async function compute(key, { symbol, engine, days }) {
    const t0 = now();
    const { candles, expected } = await fetchCandles(symbol, days);
    if (candles.length < 40) {
      throw new Error(`شموع تاريخية غير كافية للرمز ${symbol}: ${candles.length}`);
    }
    const endIndex = candles.length - 1;
    const zonesRaw = engine === 'v2'
      ? detectLiquidityZonesV2({ symbol, timeframe: '1m', candles, endIndex })
      : detectLiquidityZones({ symbol, timeframe: '1m', candles, endIndex });
    const computeMs = now() - t0;
    return {
      engineKey: engine,
      engine: ENGINE_VERSIONS[engine],
      symbol,
      timeframe: '1m',
      days,
      source: 'binance-spot',
      from: candles[0].time,
      to: candles[endIndex].time,
      expectedBars: expected,
      bars: candles.length,
      gaps: Math.max(0, expected - candles.length),
      totalZones: zonesRaw.length,
      zonesCapped: zonesRaw.length > MAX_ZONES,
      zones: zonesRaw.slice(0, MAX_ZONES).map((zone) => serializeZone(zone, engine)),
      candles: candles.map((c) => [c.time, c.open, c.high, c.low, c.close, c.volume]),
      computeMs
    };
  }

  const evict = () => {
    while (cache.size > MAX_CACHE_ENTRIES) {
      const oldest = cache.keys().next().value;
      cache.delete(oldest);
    }
  };

  async function getHistory({ symbol, engine = 'legacy', days } = {}) {
    const key = `${symbol}|${engine}|${days}`;
    const cached = cache.get(key);
    if (cached && cached.expiresAt > now()) return { ...cached.value, cached: true };
    const pending = inflight.get(key);
    if (pending) return pending;

    const task = (async () => {
      const value = await compute(key, { symbol, engine, days });
      cache.set(key, { expiresAt: now() + ttlMs, value });
      evict();
      return { ...value, cached: false };
    })().finally(() => inflight.delete(key));
    inflight.set(key, task);
    return task;
  }

  /** تحقق المدخلات مفصول عن الكاش: خطأ 400 لا يُخزَّن ولا يُحسب */
  function validate({ symbol, engine, days }) {
    const s = String(symbol ?? '').toUpperCase();
    if (!SYMBOL_RE.test(s)) throw badRequest('صيغة الرمز غير صالحة');
    const e = String(engine ?? 'legacy');
    if (!(e in ENGINE_VERSIONS)) throw badRequest('محرك غير مدعوم — القيم: legacy أو v2');
    const d = days == null ? DEFAULT_DAYS : Number(days);
    if (!Number.isFinite(d) || d < MIN_DAYS || d > MAX_DAYS) {
      throw badRequest(`العمق بالأيام يجب أن يكون بين ${MIN_DAYS} و${MAX_DAYS}`);
    }
    return { symbol: s, engine: e, days: d };
  }

  return { getHistory, validate };
}
