import { Worker } from 'node:worker_threads';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TF_MS } from '../market/candleStore.mjs';
import { normalizeHistoryKlines } from './liquidityHistoryData.mjs';

const PAGE_LIMIT = 1000;
const MAX_HISTORY_BARS = 129_600;
const WARMUP_BARS = 0;
const CACHE_TTL_MS = 5 * 60_000;
const MAX_CACHE_ENTRIES = 4;
const MAX_QUEUED_JOBS = 5;
const MAX_FUTURE_END_MS = 86_400_000;
const SYMBOL_RE = /^[A-Z0-9]{3,20}$/;
const ENGINE_VERSION = 'liquidity-engine-v1';
const SERIALIZER_VERSION = 'history-serializer-v1';
const DATA_VERSION = 'binance-spot-rest-klines-v1';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKER_PATH = path.join(__dirname, 'liquidityHistorySnapshotCompute.worker.mjs');
const badRequest = (message) => Object.assign(new Error(message), { statusCode: 400 });

function parseTime(value, label) {
  const time = Number(value);
  if (!Number.isSafeInteger(time) || time < 0) throw badRequest(`${label} يجب أن يكون وقت UTC صالحاً بالمللي ثانية`);
  return time;
}

export function validateLegacySnapshotQuery(input, now = Date.now()) {
  const symbol = String(input?.symbol ?? '').trim().toUpperCase();
  const timeframe = String(input?.timeframe ?? '');
  if (!SYMBOL_RE.test(symbol)) throw badRequest('صيغة الرمز غير صالحة');
  if (!Object.hasOwn(TF_MS, timeframe)) throw badRequest('الفريم الزمني غير مدعوم');

  const intervalMs = TF_MS[timeframe];
  const startTime = parseTime(input?.startTime, 'تاريخ البداية');
  const endTime = parseTime(input?.endTime, 'تاريخ النهاية');
  const snapshotTime = parseTime(input?.snapshotTime ?? endTime, 'وقت اللقطة');
  if (endTime <= startTime) throw badRequest('يجب أن يأتي تاريخ النهاية بعد تاريخ البداية');
  if (snapshotTime <= startTime || snapshotTime > endTime || snapshotTime > now) throw badRequest('يجب أن تقع اللقطة بين البداية والنهاية وحتى الوقت الحالي');
  if (endTime > now + MAX_FUTURE_END_MS) throw badRequest('تاريخ النهاية يتجاوز الحد المسموح');

  const calculationStartTime = Math.max(0, startTime - WARMUP_BARS * intervalMs);
  const requestedBars = Math.ceil((snapshotTime - calculationStartTime) / intervalMs);
  if (requestedBars > MAX_HISTORY_BARS) {
    const maxDurationDays = Math.floor((MAX_HISTORY_BARS * intervalMs) / 86_400_000);
    throw badRequest(`الفترة تتجاوز الحد المقاس: ${MAX_HISTORY_BARS} شمعة (${maxDurationDays} يوماً تقريباً لهذا الفريم)`);
  }

  return {
    symbol,
    timeframe,
    startTime,
    endTime,
    snapshotTime,
    intervalMs,
    calculationStartTime,
    warmupBars: Math.max(0, Math.floor((startTime - calculationStartTime) / intervalMs))
  };
}

function cacheKeyFor(query) {
  return [
    query.symbol,
    query.timeframe,
    query.startTime,
    query.endTime,
    query.snapshotTime,
    query.calculationStartTime,
    DATA_VERSION,
    ENGINE_VERSION,
    SERIALIZER_VERSION
  ].join('|');
}

async function fetchKlineRows(klines, query) {
  const fetchEndTime = Math.min(query.endTime, query.snapshotTime);
  const rows = [];
  let pageStart = query.calculationStartTime;
  let pageCount = 0;
  while (pageStart < fetchEndTime && pageCount < Math.ceil(MAX_HISTORY_BARS / PAGE_LIMIT) + 1) {
    const page = await klines(query.symbol, query.timeframe, PAGE_LIMIT, pageStart, fetchEndTime - 1);
    if (!Array.isArray(page)) throw new Error('Binance أعاد استجابة شموع غير صالحة');
    if (page.length === 0) break;
    rows.push(...page);
    pageCount += 1;
    if (page.length < PAGE_LIMIT) break;

    const lastOpenTime = Number(page[page.length - 1]?.[0]);
    const nextPageStart = lastOpenTime + query.intervalMs;
    if (!Number.isSafeInteger(lastOpenTime) || nextPageStart <= pageStart) {
      throw new Error('تعذر التقدم في صفحات شموع Binance بسبب ترتيب أو وحدة وقت غير صالحة');
    }
    pageStart = nextPageStart;
  }
  if (pageCount >= Math.ceil(MAX_HISTORY_BARS / PAGE_LIMIT) + 1) {
    throw badRequest('تجاوز جلب الشموع العدد الأقصى المقاس');
  }
  return rows;
}

function runWorker({ symbol, timeframe, candles, timeoutMs }) {
  const packed = new Float64Array(candles.length * 6);
  candles.forEach((candle, index) => {
    const offset = index * 6;
    packed.set([candle.time, candle.open, candle.high, candle.low, candle.close, candle.volume], offset);
  });

  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_PATH, {
      workerData: { symbol, timeframe, bars: candles.length, buffer: packed.buffer },
      transferList: [packed.buffer],
      resourceLimits: { maxOldGenerationSizeMb: 512 }
    });
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => {
      void worker.terminate();
      finish(new Error('تجاوز حساب اللقطة التاريخية المهلة المحددة'));
    }, timeoutMs);

    worker.once('message', (message) => {
      if (message?.ok) finish(null, message);
      else finish(new Error(message?.error ?? 'فشل حساب المحرك القديم'));
      void worker.terminate();
    });
    worker.once('error', (error) => finish(error));
    worker.once('exit', (code) => {
      if (code !== 0) finish(new Error(`انتهى عامل اللقطة برمز ${code}`));
    });
  });
}

export function createLegacyHistorySnapshotService({
  klines,
  now = () => Date.now(),
  compute = runWorker,
  ttlMs = CACHE_TTL_MS,
  maxBars = MAX_HISTORY_BARS,
  warmupBars = WARMUP_BARS
} = {}) {
  if (typeof klines !== 'function') throw new Error('legacy-history-snapshot: klines is required');
  if (typeof compute !== 'function') throw new Error('legacy-history-snapshot: compute is required');

  const cache = new Map();
  const jobs = new Map();
  const failures = new Map();
  const queue = [];
  let running = false;

  const queryFor = (input) => {
    const query = validateLegacySnapshotQuery(input, now());
    const calculationStartTime = Math.max(0, query.startTime - warmupBars * query.intervalMs);
    const requestedBars = Math.ceil((query.snapshotTime - calculationStartTime) / query.intervalMs);
    if (requestedBars > maxBars) {
      const maxDurationDays = Math.floor((maxBars * query.intervalMs) / 86_400_000);
      throw badRequest(`الفترة تتجاوز الحد المقاس: ${maxBars} شمعة (${maxDurationDays} يوماً تقريباً لهذا الفريم)`);
    }
    return {
      ...query,
      calculationStartTime,
      warmupBars: Math.max(0, Math.floor((query.startTime - calculationStartTime) / query.intervalMs))
    };
  };

  async function calculate(query) {
    const rows = await fetchKlineRows(klines, query);
    const normalized = normalizeHistoryKlines(rows, {
      timeframe: query.timeframe,
      startTime: query.calculationStartTime,
      endTime: Math.min(query.endTime, query.snapshotTime),
      snapshotTime: query.snapshotTime
    });
    if (normalized.candles.length < 40) {
      throw Object.assign(new Error(`لا توجد شموع مكتملة كافية قبل اللقطة: ${normalized.candles.length}`), { statusCode: 422 });
    }

    const workerResult = await compute({
      symbol: query.symbol,
      timeframe: query.timeframe,
      candles: normalized.candles,
      timeoutMs: Math.max(60_000, Math.ceil(normalized.candles.length / 1000) * 1000)
    });
    if (!workerResult?.ok) throw new Error(workerResult?.error ?? 'فشل حساب المحرك القديم');

    const visibleCandles = normalized.candles.filter((candle) => candle.time * 1000 >= query.calculationStartTime);
    const value = {
      engineKey: 'legacy',
      engine: ENGINE_VERSION,
      symbol: query.symbol,
      timeframe: query.timeframe,
      startTime: query.startTime,
      endTime: query.endTime,
      snapshotTime: query.snapshotTime,
      warmupStartTime: query.calculationStartTime,
      warmupBars: query.warmupBars,
      source: DATA_VERSION,
      bars: visibleCandles.length,
      totalZones: workerResult.totalZones,
      rawZones: workerResult.rawZones,
      zones: workerResult.zones,
      quality: normalized.quality,
      meta: {
        rightBars: workerResult.rightBars,
        computeMs: workerResult.computeMs,
        computedAt: now()
      },
      candles: normalized.candles.map((candle) => [
        candle.time,
        candle.open,
        candle.high,
        candle.low,
        candle.close,
        candle.volume
      ]),
      cached: false
    };
    return value;
  }

  async function pump() {
    if (running) return;
    running = true;
    try {
      while (queue.length) {
        const job = queue.shift();
        try {
          const value = await calculate(job.query);
          cache.set(job.key, { value, expiresAt: now() + ttlMs });
          failures.delete(job.key);
          while (cache.size > MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value);
          job.resolve(value);
        } catch (error) {
          failures.set(job.key, {
            message: String(error?.message ?? error).slice(0, 240),
            statusCode: Number.isInteger(error?.statusCode) ? error.statusCode : 503,
            failedUntil: now() + 30_000
          });
          job.reject(error);
        } finally {
          jobs.delete(job.key);
        }
      }
    } finally {
      running = false;
    }
  }

  function request(input) {
    let query;
    try {
      query = queryFor(input);
    } catch (error) {
      return { kind: 'error', statusCode: error?.statusCode ?? 400, message: error.message };
    }

    const key = cacheKeyFor(query);
    const cached = cache.get(key);
    if (cached && cached.expiresAt > now()) return { kind: 'ready', value: { ...cached.value, cached: true } };

    const failure = failures.get(key);
    if (failure && failure.failedUntil > now()) {
      return { kind: 'error', statusCode: failure.statusCode, retryAfterSec: Math.ceil((failure.failedUntil - now()) / 1000), message: failure.message };
    }

    if (jobs.has(key)) return { kind: 'computing', startedAt: jobs.get(key).startedAt };
    if (queue.length >= MAX_QUEUED_JOBS) {
      return { kind: 'error', statusCode: 429, message: 'ازدحام حساب اللقطات التاريخية؛ حاول مجدداً بعد اكتمال المهام الحالية' };
    }

    const job = { key, query, startedAt: now() };
    const promise = new Promise((resolve, reject) => {
      job.resolve = resolve;
      job.reject = reject;
    });
    promise.catch(() => {});
    job.promise = promise;
    jobs.set(key, job);
    queue.push(job);
    void pump();
    return { kind: 'computing', startedAt: job.startedAt };
  }

  async function getSnapshot(input) {
    const state = request(input);
    if (state.kind === 'ready') return state.value;
    if (state.kind === 'error') throw Object.assign(new Error(state.message), { statusCode: state.statusCode });
    const query = queryFor(input);
    return jobs.get(cacheKeyFor(query)).promise;
  }

  return { request, getSnapshot, validate: (input) => queryFor(input) };
}
