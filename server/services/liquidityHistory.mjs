import { Worker } from 'node:worker_threads';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * شارت تاريخي (1m) لمحركي السيولة — تنسيق الجلب والحساب والتخزين المؤقت.
 *
 * القياس على 129,600 شمعة اصطناعية: legacy ≈ 5 ثوانٍ، v2 ≈ 5 دقائق — لذلك:
 * 1) الحساب في worker thread منفصل حتى لا يجمّد حساب v2 حلقة أحداث الخادم.
 * 2) طلب الواجهة نمطه «ابدأ ثم استطلع»: `request()` يعيد النتيجة فوراً إن
 *    كانت جاهزة، وإلا يبدأ الحساب ويعيد `computing` فيستطلع العميل كل ثوانٍ.
 * 3) تسخين خلفي عند الإقلاع بالعمق الافتراضي ليكون الشارت جاهزاً عند أول استخدام.
 * 4) الكاش بالذاكرة مع stale-while-revalidate: عند انتهاء الصلاحية تُقدَّم
 *    القيمة القديمة فوراً ويُعاد الحساب في الخلفية.
 *
 * جلب الشموع من Binance في الخيط الرئيسي (I/O غير حاجب، تزامن محدود). لا
 * كتابة في قاعدة البيانات ولا تعديل على قواعد المحركين.
 */

const MINUTE_MS = 60_000;
const BATCH = 1000;            // سقف Binance لكل نداء klines
const FETCH_CONCURRENCY = 6;   // نداءات متوازية محدودة
const TTL_MS = 30 * 60_000;    // صلاحية الكاش الافتراضية (legacy)
const MIN_DAYS = 7;
const MAX_DAYS_LEGACY = 120;
// v2: ذروة ذاكرة مقاسة محلياً — 14d: 190MB، 30d: 240MB، 90d: 435MB. الـ502 الحية
// وقعت حين ركض تسخين legacy90 وv2 بالتوازي فجمعت الذاكرة فوق حد الحاوية. لذا:
// سقف v2 = 14 يوماً، تسخين متسلسل، ووسم كومة عامل v2 حتى يموت وحده لا التطبيق.
const MAX_DAYS_V2 = 14;
const DEFAULT_DAYS = 90;
const MAX_CACHE_ENTRIES = 4;
const SYMBOL_RE = /^[A-Z0-9]{1,20}$/;
// مهلة الحساب تتناسب مع حجم المهمة: القياس على الإنتاج ≈ 11× المحلي،
// فv2 على 90 يوماً يحتاج نحو ساعة. التاريخ الثابت لا يبرر حرق إعادة حساب متكرر:
// نتائج v2 تُخزَّن يوماً كاملاً (وstale-while-revalidate يخدم القديم أثناء التحديث).
const jobTimeoutMs = (engine, days) => (engine === 'v2' ? Math.max(120, days) * 60_000 : 25 * 60_000);
const FAILURE_COOLDOWN_MS = 30 * 60_000; // بعد فشل حقيقي: خطأ ظاهر وتهدئة بدل حلقة إعادة إدراج تستهلك المعالج
/**
 * الانقطاع الشبكي ليس حكماً على العمق: خطأ اتصال واحد (UND_ERR_CONNECT_TIMEOUT)
 * كان يقفل الشاشة 30 دقيقة برسالة «جرّب عمقاً أصغر» وهي مضلّلة — العمق بريء.
 * لذلك: إعادة محاولة قصيرة للدفعة، ثم تهدئة قصيرة تُعيد المحاولة تلقائياً.
 */
const TRANSIENT_COOLDOWN_MS = 90_000;
const FETCH_ATTEMPTS = 2;
const RETRY_DELAY_MS = 800;

/** أخطاء الشبكة/المهلة فقط — لا تُصنَّف أخطاء المحرك أو الذاكرة هنا */
const TRANSIENT_CODES = new Set([
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET',
  'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND', 'EPIPE', 'EHOSTUNREACH', 'ENETUNREACH'
]);

export function isTransientNetworkError(error) {
  if (!error) return false;
  const name = String(error.name ?? '');
  if (name === 'TimeoutError' || name === 'AbortError') return true;
  const codes = [error.code, error.cause?.code, error.cause?.cause?.code].filter(Boolean).map(String);
  if (codes.some((code) => TRANSIENT_CODES.has(code))) return true;
  return /fetch failed|socket hang up|network error/i.test(String(error.message ?? ''));
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKER_PATH = path.join(__dirname, 'liquidityHistoryCompute.worker.mjs');

const ENGINE_VERSIONS = { legacy: 'liquidity-engine-v1', v2: 'liquidity-engine-v2' };

const badRequest = (message) => Object.assign(new Error(message), { statusCode: 400 });

export function createLiquidityHistoryService({
  klines,
  now = () => Date.now(),
  ttlMs: ttlOverride,
  warmup = true,
  fetchAttempts = FETCH_ATTEMPTS,
  retryDelayMs = RETRY_DELAY_MS,
  transientCooldownMs = TRANSIENT_COOLDOWN_MS
} = {}) {
  if (typeof klines !== 'function') throw new Error('liquidity-history: klines is required');
  const attempts = Math.max(1, Number(fetchAttempts) || 1);
  const delayMs = Math.max(0, Number(retryDelayMs) || 0);
  const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
  const ttlFor = (engine) => (engine === 'v2' ? 24 * 60 * 60_000 : (ttlOverride ?? TTL_MS));

  const cache = new Map();      // key → { value, expiresAt }
  const jobs = new Map();       // key → { startedAt, promise }
  const cooldown = new Map();   // key → failedUntil (منع حلقة فشل↔إعادة إدراج)
  const lastFailure = new Map(); // key → { message, transient, at } — لتفسير التهدئة للمستخدم
  const lightQueue = [];        // مهام العمق ≤30 يوماً — عامل مستقل
  const heavyQueue = [];        // مهام العمق >30 يوماً — عامل مستقل
  let lightRunning = false;
  let heavyRunning = false;

  /** جلب شموع 1m بعمق `days` يوماً — دفعات ثابتة البداية بتزامن محدود */
  async function fetchCandles(symbol, days) {
    const end = now();
    const start = Math.floor((end - days * 86_400_000) / MINUTE_MS) * MINUTE_MS;
    const expected = Math.floor((end - start) / MINUTE_MS) + 1;
    const starts = [];
    for (let t = start; t < end; t += BATCH * MINUTE_MS) starts.push(t);
    const batches = new Array(starts.length);
    let failure = null;
    let cursor = 0;
    /** دفعة واحدة مع إعادة محاولة للأخطاء الشبكية العابرة فقط (لا أخطاء المحرك) */
    const fetchBatch = async (startTime) => {
      let lastError;
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
          return await klines(symbol, '1m', BATCH, startTime);
        } catch (error) {
          lastError = error;
          const canRetry = attempt < attempts && isTransientNetworkError(error);
          if (!canRetry) break;
          if (delayMs > 0) await wait(delayMs);
        }
      }
      throw lastError;
    };
    const worker = async () => {
      while (failure == null) {
        const i = cursor;
        cursor += 1;
        if (i >= starts.length) return;
        try {
          batches[i] = await fetchBatch(starts[i]);
        } catch (error) {
          failure = failure ?? error;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(FETCH_CONCURRENCY, starts.length) }, worker));
    if (failure) throw failure;

    const rows = [];
    let lastTime = -Infinity;
    for (const batch of batches) {
      for (const row of batch ?? []) {
        const openTime = Number(row[0]);
        if (!Number.isFinite(openTime) || openTime > end || openTime <= lastTime) continue;
        lastTime = openTime;
        rows.push([
          openTime / 1000,
          Number(row[1]),
          Number(row[2]),
          Number(row[3]),
          Number(row[4]),
          Number(row[5] ?? 0)
        ]);
      }
    }
    return { rows, expected, start, end };
  }

  /** حساب المحرك في worker — الوعد يُحسم عند انتهاء الخيط (نجاح أو فشل) */
  function computeInWorker(engineKey, symbol, timeframe, rows, timeoutMs) {
    const bars = rows.length;
    const flat = new Float64Array(bars * 6);
    for (let i = 0; i < bars; i += 1) {
      flat.set(rows[i], i * 6);
    }
    return new Promise((resolve, reject) => {
      const worker = new Worker(WORKER_PATH, {
        workerData: { engineKey, symbol, timeframe, bars, buf: flat.buffer },
        // وسم كومة حاد: تجاوز العامل حدّه يُنهيه وحده بخطأ نظيف (تهدئة) بدل
        // أن تتجاوز ذاكرة العملية المشتركة حد الحاوية فيُسقط التطبيق كله.
        // v2: القياس الحقيقي 14d ≈ 190MB، وكان السقف 128MB فيموت العامل بـOOM
        // ويُقفل الشارت 30 دقيقة بلا سبب مفهوم. 256MB فوق القياس بهامش آمن.
        resourceLimits: { maxOldGenerationSizeMb: engineKey === 'v2' ? 256 : 512 }
      });
      const timer = setTimeout(() => {
        worker.terminate();
        reject(new Error(`تجاوز حساب المحرك ${engineKey} المهلة (${Math.round(timeoutMs / 60000)} دقائق)`));
      }, timeoutMs);
      worker.on('message', (msg) => {
        clearTimeout(timer);
        worker.terminate();
        if (msg?.ok) resolve(msg);
        else reject(new Error(msg?.error ?? 'فشل حساب المحرك'));
      });
      worker.on('error', (error) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      });
      worker.on('exit', (code) => {
        if (code !== 0) {
          clearTimeout(timer);
          reject(new Error(`انتهى خيط الحساب برمز ${code}`));
        }
      });
    });
  }

  async function runJob(key, { symbol, engine, days }) {
    const t0 = now();
    const { rows, expected } = await fetchCandles(symbol, days);
    if (rows.length < 40) {
      throw new Error(`شموع تاريخية غير كافية للرمز ${symbol}: ${rows.length}`);
    }
    const result = await computeInWorker(engine, symbol, '1m', rows, jobTimeoutMs(engine, days));
    const value = {
      engineKey: engine,
      engine: result.engine,
      symbol,
      timeframe: '1m',
      days,
      source: 'binance-spot',
      from: rows[0][0],
      to: rows[rows.length - 1][0],
      expectedBars: expected,
      bars: rows.length,
      gaps: Math.max(0, expected - rows.length),
      totalZones: result.totalZones,
      zonesCapped: false,
      zones: result.zones.map((zone) => ({ ...zone, engine: result.engine })),
      // أحداث البنية مرة واحدة (v2 فقط تنتجها؛ legacy تعيد مصفوفة فارغة) — لا نسخة لكل منطقة
      structureEvents: result.structureEvents ?? [],
      meta: {
        rightBars: result.rightBars ?? null,
        // توقيت الحساب على ساعة الخادم — للعرض التشخيصي فقط، ولا يدخل في قرار الظهور التاريخي
        computedAt: now()
      },
      candles: rows,
      computeMs: result.computeMs,   // زمن حساب المحرك داخل الخيط المنفصل
      totalMs: now() - t0,           // الجلب + الحساب + التحويل
      cached: false,
      stale: false
    };
    cache.set(key, { value, expiresAt: now() + ttlFor(engine) });
    while (cache.size > MAX_CACHE_ENTRIES) {
      const oldest = cache.keys().next().value;
      cache.delete(oldest);
    }
    return value;
  }

  /** عاملان متوازيان (خفيف/ثقيل): طلب العمق الصغير لا ينتظر خلف حساب ساعة كاملة */
  async function pump(kind) {
    const isHeavy = kind === 'heavy';
    if (isHeavy ? heavyRunning : lightRunning) return;
    if (isHeavy) heavyRunning = true; else lightRunning = true;
    const queue = isHeavy ? heavyQueue : lightQueue;
    try {
      while (queue.length) {
        queue.sort((a, b) => a.enqueuedAt - b.enqueuedAt);
        const job = queue.shift();
        const { key, params, resolve, reject } = job;
        try {
          const value = await runJob(key, params);
          cooldown.delete(key);
          lastFailure.delete(key);
          resolve(value);
        } catch (error) {
          const transient = isTransientNetworkError(error);
          cooldown.set(key, now() + (transient ? transientCooldownMs : FAILURE_COOLDOWN_MS));
          lastFailure.set(key, { message: String(error?.message ?? error).slice(0, 200), transient, at: now() });
          reject(error);
        }
      }
    } finally {
      if (isHeavy) heavyRunning = false; else lightRunning = false;
    }
  }

  function enqueue(key, params) {
    const pending = jobs.get(key);
    if (pending) return pending;
    const entry = {
      key,
      params,
      enqueuedAt: now(),
      startedAt: now()
    };
    entry.promise = new Promise((resolve, reject) => {
      entry.resolve = resolve;
      entry.reject = reject;
    }).finally(() => jobs.delete(key));
    // طلب fire-and-forget (المسار عبر request) لا ينتظر الوعد: بلا هذا الالتقاط
    // يصعد فشل العامل كـunhandledRejection يُسجَّل [fatal] في السجل.
    entry.promise.catch(() => {});
    jobs.set(key, entry);
    (params.days <= 30 ? lightQueue : heavyQueue).push(entry);
    void pump(params.days <= 30 ? 'light' : 'heavy');
    return entry;
  }

  /**
   * نقطة الواجهة: جاهز → القيمة فوراً (cached). قيد الحساب → computing.
   * خامل → يبدأ الحساب ويعيد computing. منتهي الصلاحية → القيمة فوراً مع
   * stale:true وإعادة حساب خلفية.
   */
  function request({ symbol, engine, days }) {
    const key = `${symbol}|${engine}|${days}`;
    const failedUntil = cooldown.get(key);
    if (failedUntil && failedUntil > now()) {
      const failure = lastFailure.get(key);
      const retryAfterSec = Math.max(1, Math.ceil((failedUntil - now()) / 1000));
      return {
        kind: 'error',
        transient: Boolean(failure?.transient),
        retryAfterSec,
        message: failure?.transient
          ? `تعذّر جلب الشموع من Binance (انقطاع اتصال مؤقت) — تُعاد المحاولة تلقائياً بعد ${retryAfterSec} ثانية`
          : `تعذر إكمال الحساب لهذا العمق — يعاد المحاولة تلقائياً بعد دقائق، أو جرّب عمقاً أصغر`
      };
    }
    const cached = cache.get(key);
    if (cached) {
      if (cached.expiresAt > now()) return { kind: 'ready', value: { ...cached.value, cached: true } };
      // stale-while-revalidate: قدّم القديم فوراً وحدّث في الخلفية
      enqueue(key, { symbol, engine, days });
      return { kind: 'ready', value: { ...cached.value, cached: true, stale: true } };
    }
    const job = enqueue(key, { symbol, engine, days });
    return { kind: 'computing', startedAt: job.startedAt };
  }

  /** نسخة تنتظر الاكتمال — للتسخين الخلفي والاختبارات */
  async function getHistory(params) {
    const state = request(params);
    if (state.kind === 'ready') return state.value;
    if (state.kind === 'error') return Promise.reject(new Error(state.message));
    const key = `${params.symbol}|${params.engine}|${params.days}`;
    const job = jobs.get(key);
    return job ? job.promise : Promise.reject(new Error('أُلغيت مهمة الحساب'));
  }

  function validate({ symbol, engine, days }) {
    const s = String(symbol ?? '').toUpperCase();
    if (!SYMBOL_RE.test(s)) throw badRequest('صيغة الرمز غير صالحة');
    const e = String(engine ?? 'legacy');
    if (!(e in ENGINE_VERSIONS)) throw badRequest('محرك غير مدعوم — القيم: legacy أو v2');
    const maxDays = e === 'v2' ? MAX_DAYS_V2 : MAX_DAYS_LEGACY;
    const d = days == null ? Math.min(DEFAULT_DAYS, maxDays) : Number(days);
    if (!Number.isFinite(d) || d < MIN_DAYS || d > maxDays) {
      throw badRequest(e === 'v2'
        ? `عمق v2 الأقصى ${MAX_DAYS_V2} يوماً بحدود ذاكرة منصة النشر (الحساب على 90 يوماً يقاس بـ435MB) — استخدم legacy للعمق الأعمق`
        : `العمق بالأيام يجب أن يكون بين ${MIN_DAYS} و${maxDays}`);
    }
    return { symbol: s, engine: e, days: d };
  }

  /** تسخين متسلسل عند الإقلاع: لا حسابان ثقيلان متوازيان أبداً (درس 502 الحية) */
  async function warmUpDefaults(symbol = 'BTCUSDT') {
    if (!warmup) return;
    setTimeout(async () => {
      try { await getHistory({ symbol, engine: 'legacy', days: DEFAULT_DAYS }); } catch { /* cooldown يكفي */ }
      try { await getHistory({ symbol, engine: 'v2', days: MAX_DAYS_V2 }); } catch { /* cooldown يكفي */ }
    }, 3_000);
  }

  return { request, getHistory, validate, warmUpDefaults };
}
