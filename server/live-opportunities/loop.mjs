/* محرك الفرص الحية — تتبع مستمر بلا انقطاع + معايرة walk-forward + تتبع النتائج
 *
 * المعمارية:
 *  1) المخزون الحي لمحرك مناطق السيولة (يُحدَّث تلقائياً) هو مصدر المناطق — صفر نداءات إضافية للكشف.
 *  2) كل دورة: نداء أسعار واحد لكل الأزواج → تحديث آلة الحالة لكل منطقة SSL (بلا شبكة).
 *  3) المرشحون فقط (استعادة مكتملة أو اقتراب حاد) → تحقق شبكي محدود: شموع الفريم + أدوات الأوردر فلو.
 *  4) البوابات + شريحة المعايرة (≥ 60%) → نشر فوري عبر البث.
 *  5) الفرص المنشورة تُتابع من الأسعار الحية (هدف/وقف) → إحصاء فعلي + إعادة معايرة دورية.
 *
 * الترتيب: الفريمات من الأدق إلى الأكبر (1m أولاً) ثم الأقرب مسافةً — عرض أولاً بأول.
 */

import { normalizeCandles, scanHistory } from '../liquidity-zones/engine.mjs';
import { computeCvd } from '../liquidity/derivatives.mjs';
import { computeVolumeProfile, classifyLocation } from '../liquidity/volumeProfile.mjs';
import { sessionFactor } from '../liquidity/session.mjs';
import {
  advanceTracker, canPublish, initTracker, markPublished, pickWatchlist,
  pruneTrackers, publishKeyFor, tfRank, tfSeconds, trackerKey, TF_ORDER,
  stageChain, dedupeSweepEvents
} from './tracker.mjs';
import {
  buildLongPlan, calibrateSweeps, compositeScore, confBand, flowScore, gates,
  longTargets, nextSslBelow, segmentLookupKeys, summarizeSegments, buildDecisionSnapshot,
  rankBatch, sweepModeParity
} from './scanner.mjs';
import { toLifecycleRow, rehydrateState } from './lifecycle.mjs';
import { buildSegmentShadowReport, countDecidedOnce } from '../services/segmentShadow.mjs';

const DEFAULT_CONFIG = {
  cycleMs: 5_000,
  tickMs: 1_000,              // تحديث دوري لحظي للصفقات المنشورة وقيد المراقبة
  fastCycleThrottleMs: 1_500, // أقصى تكرار لدورات «إغلاق الشمعة» السريعة
  verifyConcurrency: 6,       // تحقق شبكي متوازٍ للمرشحين
  maxKlineSubs: 900,          // سقف اشتراكات الشموع عبر البث (حد بينانس 1024/اتصال)
  maxFlowSubs: 80,            // سقف اشتراكات aggTrade (تدفق حي)
  calibrationMs: 6 * 60 * 60 * 1000,
  maxVerifyPerCycle: 12,
  promoteLiveTrades: 20,      // عتبة الترقية الحية: نتائج فعلية قبل ترقية شريحة تجريبية
  maxTrackAtr: 6,
  maxStopAtr: 3,
  freshnessBars: 6,
  // نافذة الاستعادة فرضية تجريبية (عقيدة Fabio §3): 3 = المرشح الأساسي، 4/6 = حساسية.
  // الاختيار النهائي على OOS حصرا — ممنوع الاختيار على نفس بيانات الضبط (قاعدة ملزمة).
  reclaimWindowBars: 3,
  reclaimExperiment: [3, 4, 6],
  // تأكيد التدفق قبل الدخول (التسلسل الحرفي): أدنى درجة فلو تُقبل للنشر
  flowMinScore: 45,
  approachAtr: 1.5,
  breakAtr: 0.6,
  watchApproachAtr: 0.5,
  minRR: 2,
  minComposite: 55,
  targetWinRate: 0.6,
  minSegmentTrades: 8,
  bandPct: 0.0025,
  watchLimit: 40,
  publishLimit: 150,
  /**
   * السعة التشغيلية الصلبة لمتابعة الفرص التي خرجت من بطاقات العرض (P0 عقيدة §7.2):
   * تجاوز publishLimit لا يُنهي متابعة فرصة نشطة ولا يُسجّل لها نتيجة اصطناعية —
   * تُنقل إلى مجموعة المتابعة المؤجلة حتى حسمها الحقيقي. هذا السقف فقط يُنهي
   * المتابعة عند بلوغه، وبسبب تشغيلي مُعلَن ومُعدّاد، لا بسبب عرض.
   */
  trackOverflowLimit: 300,
  historyLimit: 300,
  maxBars: 96,
  maxReclaimBars: 6,
  calibration: {
    symbols: 96, timeframes: null, bars: 2000, batch: 5, sleepMs: 200, maxPages: 3,
    concurrency: 4,
    minDepthAtr: 0.15, maxDepthAtr: 3, maxRangePos: 0.8, minBuyRatioPct: 48,
    requireSessionPrime: false,
    /**
     * تكاليف التداول للبحث الصادق (عقيدة §15 + القرار المعتمد في خطة الإصلاح):
     * 0.1% رسوم في كل اتجاه (0.2% للصفقة) + 0.05% انزلاق سعري.
     * تُخصم من **النتيجة الصافية** (`netRr`) في المعايرة والباك تيست فقط، ولا تمس
     * أي شرط دخول أو خروج أو هدف أو وقف: الفرصة المنشورة وشروطها تبقى كما هي حرفياً.
     * كانت 0 افتراضياً، فكانت نسب النجاح المعروضة بلا أي تكلفة تنفيذ — وهو ما يجعل
     * الرقم غير قابل للتحقق على الحساب الحقيقي. قابلة للتجاوز للبحث خارج العيّنة.
     */
    feePct: Number(process.env.TRADE_FEE_PCT ?? 0.001),
    slippagePct: Number(process.env.TRADE_SLIPPAGE_PCT ?? 0.0005),
    // شبكة أهداف R:R: النسبة تعتمد جوهرياً على بُعد الهدف، والشرائح تختار الأنسب
    rrGrid: [1.0, 1.2, 1.5, 2, 2.5],
    // نافذة الاستعادة أوسع (12 شمعة): 6 شموع ترفض معظم السويبات فيقلّ حجم العيّنة كثيراً
    maxReclaimBars: 12,
    // دخول إعادة الاختبار (فابيو): دخول أقرب للوقف بعد الاستعادة → نسبة نجاح أعلى لنفس الهدف
    retestTolAtr: 0.3,
    retestWindow: 12
  },
  /** نافذة منع تكرار حفظ الرفض لنفس السبب (ساعة افتراضياً) — إصلاح إغراق السجل */
  rejectionDedupeMs: Number(process.env.REJECTION_DEDUPE_MS) || 60 * 60 * 1000,
  /**
   * تكرار أحداث دورة الحياة: القياس الإنتاجي أعطى 143,433 صفاً/24س = 78 ميغابايت/يوم،
   * ومتوسط تكرار 1.8 لنفس المفتاح في 5.4 دقيقة فقط. المعلومة الفعلية هي **انتقال
   * الحالة** (سويب/استعادة) لكل مفتاح، وتكرارها بعد ذلك بلا معلومة جديدة، والاستعادة
   * تقرأ أحدث صف لكل مفتاح فلا تفقد شيئاً. تخفيض التقليم هنا يقصّ أكبر كاتب في القاعدة
   * إلى أقل من عُشر حجمه بلا فقدان دليل.
   */
  lifecycleDedupeMs: Number(process.env.LIFECYCLE_DEDUPE_MS) || 15 * 60 * 1000,
  recoveryRequired: false
};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * إنشاء المحرك. كل الاعتماديات تُمرَّر — المحرك بلا معرفة بمسار الخادم.
 * deps: { fetchPrices, fetchCandles, fetchBookSignals, fetchRawKlines, zoneSource, resolveTargets,
 *         broadcast, persist?, readCalibration?, now?, log?, config? }
 */
export function createLiveOpportunityEngine(deps) {
  const {
    fetchPrices, fetchBookSignals, fetchRawKlines,
    zoneSource, resolveTargets,
    market = null, // طبقة بيانات WebSocket الحية (streams.mjs) — اختيارية مع احتياطي REST كامل
    broadcast = () => {},
    persist = async () => {},
    readCalibration = async () => null,
    now = () => Date.now(),
    log = console,
    config = {},
    notePersist = null,
    /**
     * مُجمّع عمال لتنفيذ فحص السيولة خارج حلقة الأحداث.
     * بدونه يبقى scanHistory متزامناً ويُجمّد البث (العيب المقيس: 59% من زمن CPU).
     * النتيجة مطابقة حرفياً في الحالتين — الفرق في أين يُحسب لا فيما يُحسب.
     */
    workers = null,
    /**
     * مجمّع الظل (قياس ★ فقط): يُغذّى بمقارنات لا تؤثر على أي قرار منشور.
     * بلا هذا تبقى إصلاحات ★ بلا دليل رقمي، والقرار فيها بلا أساس.
     */
    shadow = null
  } = deps;

  /**
   * مساعد موثوق لإعلام الصحة بنتيجة الحفظ بغض النظر عن ما إذا كانت `persist` وعودة
   * أم غير متزامنة. هذا هو التوصيل المفقود الذي جعل `persistWrites` صفراً دائماً.
   */
  const persistWithResult = async (key, op) => {
    try {
      const result = await Promise.resolve(op());
      if (result === false || result?.ok === false) throw new Error(result?.error ?? 'persist rejected without a confirmed write');
      status.persist.lastOk = { key, at: now() };
      status.persist.writes += 1;
      if (typeof notePersist === 'function') {
        try { notePersist({ ok: true, key, at: now() }); } catch {}
      }
      return { ok: true, result, key };
    } catch (err) {
      status.persist.lastError = err?.message || String(err);
      status.persist.lastErrorAt = now();
      status.persist.failures += 1;
      if (typeof notePersist === 'function') {
        try { notePersist({ ok: false, key, error: err?.message || String(err), at: now() }); } catch {}
      }
      return { ok: false, error: err, key };
    }
  };

  const cfg = { ...DEFAULT_CONFIG, ...config, calibration: { ...DEFAULT_CONFIG.calibration, ...(config.calibration ?? {}) } };

  const trackers = new Map();          // key → حالة
  const opportunities = new Map();     // publishKey → فرصة منشورة (مجموعة العرض: بطاقات البث)
  /**
   * مجموعة المتابعة المؤجلة (P0 عقيدة §7.2): فرص خرجت من بطاقات العرض بسبب
   * publishLimit لكنها **نشطة** وتُتابَع حتى حسمها الحقيقي. الإخلاء من العرض
   * ليس نتيجة تداول، ولا يُسجَّل لها `expired` إلا عند بلوغ trackOverflowLimit.
   */
  const deferredTracking = new Map();  // id → فرصة نشطة خارج العرض
  const liveStats = new Map();         // مفتاح شريحة → {trades, wins} من النتائج الحية (ترقية champion-challenger)
  /**
   * ★3 قياس فقط: العدّ الحالي لشريحة الفرصة يزيد في **كل نداء متابعة** (~كل 5 ثوان)
   * لكل فرصة لم تُحسم بعد، أي أن «الصفقات» تُحتسب مئات المرات لنفس الفرصة، ومنطق
   * الترقية إلى شرائح مؤهّلة يصبح بلا معنى. هذا الخريطة تُحصي بالقاعدة الصحيحة
   * (مرة واحدة عند حسم الفرصة) للمقارنة، ولا تؤثر على `liveStats` إطلاقاً.
   */
  const shadowDecided = new Map();     // مفتاح شريحة → {trades, wins} بقاعدة «عند الحسم فقط»
  const shadowCountedOps = new Set();  // مفاتيح الفرص المحسوبة في النسخة الظلّية
  /**
   * ★5 قياس فقط: حالة الحكم المعلَّق لكل فرصة منشورة (مفتاح → {bars, hi, lo}).
   * منفصلة عن `opportunities` عمداً: لا تُحفظ ولا تُصدَّر ولا يقرأها أي قرار.
   */
  const outcomeShadowState = new Map();
  const history = [];                  // فرص محسومة/قديمة (محدودة)
  const segments = new Map();          // مفتاح شريحة → إحصاء
  const rejected = [];                 // مرشحون لم يجتازوا البوابات/الشريحة (شفافية)

  const status = {
    busy: false,
    paused: false,
    pauseUpdatedAt: null,
    market: null,
    priceAgeMs: null,
    cycle: 0,
    scope: 'halal_no_barcode',
    pairsTotal: 0,
    zonesTracked: 0,
    phases: {},
    // قمع التغطية بالأسباب (عقيدة §13): كل مرحلة بعدّاد — لا نسبة عمياء
    funnel: {
      eligible: 0, noData: 0, swept: 0, noReclaim: 0, lateReclaim: 0,
      flowFail: 0, planFail: 0, gateFail: 0, calibFail: 0, published: 0
    },
    published: 0,
    resolved: 0,
    wins: 0,
    losses: 0,
    deepScans: 0,
    bookCalls: 0,
    lastPublishAt: null,
    updatedAt: null,
    error: null,
    recovery: { state: cfg.recoveryRequired ? 'pending' : 'ready', error: null, attemptedAt: null, readyAt: null, metadata: null },
    /** نتائج الحفظ الأخيرة: آخر نجاح، آخر فشل، عدد المحاولات، وعدد الفشل */
    persist: { lastOk: null, lastError: null, lastErrorAt: null, writes: 0, failures: 0 },
    /** مراقبة الإخلاء التشغيلي (عقيدة §7.2): خروج من العرض ≠ نهاية متابعة */
    evictedFromFeed: 0,
    evictedTracked: 0
  };

  const setRecoveryState = (state, { error = null, metadata = status.recovery.metadata } = {}) => {
    status.recovery = {
      ...status.recovery,
      state,
      error: error ? String(error).slice(0, 240) : null,
      attemptedAt: now(),
      readyAt: state === 'ready' ? now() : null,
      metadata
    };
    status.error = status.recovery.error;
    return { ...status.recovery };
  };

  const calibration = {
    at: null,
    busy: false,
    trades: 0,
    samplePairs: 0,
    progress: null,
    segments: [],
    error: null
  };

  let cycleTimer = null;
  let calibTimer = null;
  let tickTimer = null;
  let unsubCandleClose = null;
  let running = false;
  let pauseGeneration = 0;
  let lastPrices = {};
  let lastPricesAt = 0;
  let lastFastCycleAt = 0;
  const verifying = new Set();  // مرشحون قيد التحقق الآن (منع التكرار بين الدورات المتقاربة)

  /** محدد توازٍ — ينفّذ مهام متعددة بحد أقصى n متزامن (بلا مكتبات خارجية) */
  /**
   * حفظ الرفض مرة واحدة لكل (رمز، فريم، منطقة، سبب) خلال نافذة زمنية.
   * إصلاح A10: كان كل رفض يُحفظ في **كل دورة** (كل 5 ثوان لكل فرصة مرشحة)، فسجل
   * الأحداث ينمو بلا معنى: 121,507 حدثاً قديماً غالبه تكرار لنفس الرفض، ويهدّد سعة
   * القاعدة (500MB مجاناً / 2GB للمدفوع). الآن يُسجَّل الرفض مرة، وتُهمَل التكرارات.
   * ملاحظة: لا يمس هذا أي قرار نشر — الرفض نفسه وسببه كما هما، والفرق فقط ألا
   * نكتب السطر نفسه 720 مرة في الساعة.
   */
  const rejectionSeen = new Map();
  function persistRejectionOnce(row) {
    const key = `${row.symbol}|${row.timeframe}|${row.zoneId ?? '-'}|${row.reason}`;
    const t = now();
    const prev = rejectionSeen.get(key);
    if (prev != null && t - prev < cfg.rejectionDedupeMs) return;
    rejectionSeen.set(key, t);
    if (rejectionSeen.size > 4000) {
      // تقليم الأقدم: كل ما تجاوز النافذة لم يعد مفيداً
      for (const [k, at] of rejectionSeen) {
        if (t - at > cfg.rejectionDedupeMs) rejectionSeen.delete(k);
        if (rejectionSeen.size <= 3000) break;
      }
    }
    void persistWithResult('live_rejected', () => persist({ type: 'live_rejected', ...row }));
  }

  /**
   * حفظ حدث دورة الحياة **مرة واحدة لكل انتقال** في نافذة التقليم.
   * المفتاح يشمل النوع والفريم والمنطقة والطور، فلا يُدمج حدثان مختلفان أبداً؛
   * ويُحدَّث الطابع الزمني عند كل ظهور حتى لا يُعيد التكرار بعد انقضاء النافذة.
   */
  const lifecycleSeen = new Map();
  function persistLifecycleOnce(row) {
    const key = `${row.symbol}|${row.timeframe ?? '-'}|${row.zoneId ?? row.key ?? '-'}|${row.kind}`;
    const t = now();
    const prev = lifecycleSeen.get(key);
    if (prev != null && t - prev < cfg.lifecycleDedupeMs) return;
    lifecycleSeen.set(key, t);
    if (lifecycleSeen.size > 8000) {
      // تقليم الأقدم: ما خرج من النافذة لم يعد يفيد المنع
      for (const [k, at] of lifecycleSeen) {
        if (t - at > cfg.lifecycleDedupeMs) lifecycleSeen.delete(k);
        if (lifecycleSeen.size <= 6000) break;
      }
    }
    void persistWithResult('live_lifecycle', () => persist(row));
  }

  function createLimiter(n) {
    let active = 0;
    const queue = [];
    const next = () => {
      if (active >= n || queue.length === 0) return;
      active += 1;
      const job = queue.shift();
      Promise.resolve().then(job.fn)
        .then(v => { active -= 1; job.resolve(v); next(); })
        .catch(e => { active -= 1; job.reject(e); next(); });
    };
    return (fn) => new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      next();
    });
  }

  /** بحث الشريحة: الأدق أولاً ثم الأعمّ — تُقبل فقط إن بلغت عيّنتها الحد الأدنى */
  function findSegment(timeframe, tier, band) {
    for (const key of segmentLookupKeys({ timeframe, flowTier: tier, confBand: band })) {
      const row = segments.get(key);
      if (row && row.trades >= cfg.minSegmentTrades) return row;
    }
    return null;
  }

  /** نداء الشموع (بث حي إن توفر، وإلا REST) + الطبقات المشتقة (تُستدعى للمرشحين فقط) */
  async function enrich(symbol, timeframe) {
    let raw = null;
    if (market) {
      const key = `${symbol}|${timeframe}`;
      if (!market.hasKline(key)) await market.ensureKlineSeed(key);
      raw = market.getKlines(symbol, timeframe);
    }
    if (!raw || raw.length < 60) raw = await fetchRawKlines(symbol, timeframe, 500);
    const candles = normalizeCandles(raw);
    if (candles.length < 60) return null;
    const latestCandleTime = Number(candles.at(-1)?.time);
    const latestCandleAt = latestCandleTime > 1e12 ? latestCandleTime : latestCandleTime * 1000;
    const candleAgeLimit = tfSeconds(timeframe) * 2000 + 5000;
    if (!Number.isFinite(latestCandleAt) || latestCandleAt > now() + 5000 || now() - latestCandleAt > candleAgeLimit) {
      status.funnel.noData += 1;
      return null;
    }
    const profile = computeVolumeProfile(candles);
    const location = classifyLocation(candles, profile);
    const cvd = computeCvd(raw, 50); // يحتاج الشموع الخام (يقرأ عمود Taker Buy)
    return { candles, profile, location, cvd };
  }

  /** تحقق شبكي كامل لمرشح + نشر إن اجتاز */
  async function evaluateCandidate({ symbol, zone, state, price }) {
    if (status.paused) return null;
    const enriched = await enrich(symbol, zone.timeframe);
    if (!enriched || status.paused) return null;
    const { candles, profile, location, cvd } = enriched;

    // إعادة تقديم الحالة بالسعر الحي (لا بأدنى قاع — وإلا لن تُكتشف الاستعادة أبداً)،
    // مع ضبط قاع السويب من الشموع الحقيقية لا من سعر لحظي.
    const { next: st } = advanceTracker(state, {
      zone, price: Number(price), atr: zone.atr, now: now(),
      freshnessBars: cfg.freshnessBars, approachAtr: cfg.approachAtr, breakAtr: cfg.breakAtr,
      reclaimWindowBars: cfg.reclaimWindowBars
    });
    // قاع السويب الحقيقي من الشموع: أدنى قاع خلال نافذة السويب، بلا تجاوز مستوى السيولة إلا لأسفل
    const lookback = Math.min(candles.length, Math.max(3, cfg.freshnessBars));
    const win = candles.slice(-lookback);
    const realLow = Math.min(...win.map(c => Number(c.low)));
    const liqLevel = Number(zone.liquidityLevel);
    if (Number.isFinite(realLow) && st.phase !== 'invalidated') {
      const insideZone = Number.isFinite(liqLevel) && realLow > liqLevel;
      st.sweepLow = insideZone
        ? Math.min(Number(st.sweepLow ?? realLow), realLow)
        : realLow;
    }
    trackers.set(st.key, st);
    if (!canPublish(st, publishKeyFor(st))) return null;
    // بوابة التسلسل الحرفي (عقيدة §2): نشر بلا قصة مشاهَدة كاملة = خلل حرج
    if (!st.sawSweep || !st.reclaimAt) {
      log.error?.(`[live-opp] SEQUENCE VIOLATION ${symbol} ${zone.timeframe} zone=${zone.id} phase=${st.phase} sawSweep=${st.sawSweep} reclaimAt=${st.reclaimAt}`);
      return null;
    }

    status.bookCalls += 1;
    const book = await fetchBookSignals(symbol).catch(() => ({ bubbles: [], book: null, icebergs: [], spoofs: [] }));
    // التدفق الحي من aggTrade (بث لحظي) — يُفضَّل عند توفره ويُدمج مع إشارات الدفتر
    const liveFlow = market?.flowSnapshot?.(symbol) ?? null;
    const flow = flowScore({
      cvd: liveFlow?.cvd ?? cvd,
      bubbles: liveFlow?.bubbles?.length ? liveFlow.bubbles : book.bubbles,
      book: book.book,
      icebergs: liveFlow?.icebergs?.length ? liveFlow.icebergs : book.icebergs,
      spoofs: book.spoofs,
      sweepLow: st.sweepLow, price: Number(price), atr: zone.atr
    });
    // تأكيد التدفق قبل الدخول (التسلسل الحرفي — veto خارج الدرجة): فلو ضعيف = رفض مسجل بالسلسلة
    if (!(Number(flow?.score) >= cfg.flowMinScore)) {
      status.funnel.flowFail += 1;
      const row = {
        symbol, timeframe: zone.timeframe, zoneId: zone.id, at: now(),
        flowScore: flow?.score ?? null, flowTier: flow?.tier ?? null,
        reason: `فلو غير مؤكد (${flow?.score ?? '?'} < ${cfg.flowMinScore})`,
        chain: stageChain(st, { flow, veto: 'flow_unconfirmed' })
      };
      rejected.push(row);
      // ما بعد السويب يُحفظ للبحث (لماذا لم تتحول إلى فرصة؟) — ذهب البحث لاحقا
      if (st.sawSweep) persistRejectionOnce(row);
      return null;
    }

    const last = candles[candles.length - 1];
    const entry = Number(last.close);
    const session = sessionFactor(now());
    const sweepDepthAtr = Number.isFinite(Number(st.sweepLow)) && Number(zone.atr) > 0
      ? Math.abs(Number(st.liquidityLevel) - Number(st.sweepLow)) / Number(zone.atr)
      : 0;

    // الأهداف: أقرب سيولة شرائية فوق + VAH/POC + قمة اليوم السابق + عقد الحجم المنخفض
    const bslAbove = (zoneSource() ?? [])
      .filter(z => z.symbol === symbol && z.timeframe === zone.timeframe && String(z.kind ?? '').includes('bsl'))
      .map(z => Number(z.referenceLevel))
      .filter(v => Number.isFinite(v) && v > entry);
    const priorWindow = candles.slice(-96);
    const prevDayHigh = priorWindow.length ? Math.max(...priorWindow.map(c => Number(c.high))) : null;
    const lvnAbove = (profile?.lvnZones ?? []).map(l => Number(l.price)).filter(p => Number.isFinite(p) && p > entry);
    const targets = longTargets({
      entry, atr: zone.atr, referenceLevel: Number(zone.referenceLevel),
      bslAbove, profile, prevDayHigh, lvnAbove
    });
    // الشريحة أولاً: هي التي تحدّد أنسب R:R لهذا (فريم × تدفق × ثقة) بناءً على المعايرة
    const band = confBand(zone.confidence);
    const segment = findSegment(zone.timeframe, flow.tier, band);
    const planMinRR = segment?.minRR ?? cfg.minRR;

    // الوقف: قاع السويب افتراضياً، وإذا كان السويب عميقاً (> maxStopAtr) نعتمد أقرب قاع
    // لحركة الاستعادة (فابيو: «علامة أو اثنتين» تحت نقطة الدخول) لأن السوق أثبت قوة الاستعادة.
    // الحد الأدنى 0.5×ATR يمنع وقفاً ضيقاً يُضرب بالضجيج.
    const reclaimLow = Math.min(...candles.slice(-3).map(c => Number(c.low)));
    const deepSweep = (entry - Number(st.sweepLow)) / Math.max(Number(zone.atr), 1e-12) > cfg.maxStopAtr;
    const protectedLow = deepSweep
      ? Math.min(Math.max(reclaimLow, Number(st.sweepLow)), entry - 0.5 * Number(zone.atr))
      : Number(st.sweepLow);
    const plan = buildLongPlan({ entry, sweepLow: protectedLow, atr: zone.atr, bandPct: cfg.bandPct, targets, minRR: planMinRR });
    if (!plan.valid || !plan.tp) {
      status.funnel.planFail += 1;
      const row = {
        symbol, timeframe: zone.timeframe, zoneId: zone.id, at: now(),
        reason: plan.violations?.join(' · ') || 'لا خطة صالحة',
        chain: stageChain(st, { flow, veto: 'no_valid_plan' })
      };
      rejected.push(row);
      if (st.sawSweep) persistRejectionOnce(row);
      return null;
    }

    const composite = compositeScore({
      zoneConfidence: zone.confidence, flow: flow.score, rr: plan.rr,
      sessionTier: session.tier, locationState: location.state, sweepDepthAtr
    });
    const gate = gates({
      rr: plan.rr, sessionTier: session.tier, locationState: location.state,
      composite, minRR: planMinRR, minComposite: cfg.minComposite
    });
    // البوابة الإحصائية بطبقتين: شريحة مثبتة (qualified) أو تحت التجربة (probationary) تنشر؛
    // weak أو غائبة تُرفض بسبب صريح. النتائج الحية للشريحة تدعم الترقية (champion-challenger).
    const live = liveStats.get(segment?.key ?? '') ?? { trades: 0, wins: 0 };
    const liveN = live.trades;
    const liveWr = liveN > 0 ? live.wins / liveN : null;
    const effectiveTier = segment?.tier === 'probationary'
      && liveN >= cfg.promoteLiveTrades && liveWr != null && liveWr >= cfg.targetWinRate
      ? 'qualified' // ترقية حية: الشريحة التجريبية أثبتت نفسها في التداول الفعلي
      : segment?.tier ?? null;
    const segmentOk = effectiveTier === 'qualified' || effectiveTier === 'probationary';

    if (!gate.pass || !segmentOk) {
      const segReason = segment == null
        ? 'لا شريحة معايَرة — بانتظار اكتمال المعايرة'
        : effectiveTier == null
          ? `الشريحة ${segment.key} ضعيفة إحصائياً (${(segment.smoothedWinRate * 100).toFixed(1)}% منكمشة من ${segment.trades} صفقة — دون 50%)`
          : `الشريحة ${segment.key} ${effectiveTier === 'probationary' ? 'تحت التجربة' : 'غير مؤهلة'} (${(segment.smoothedWinRate * 100).toFixed(1)}% · حد Wilson ${(segment.wilsonLB * 100).toFixed(0)}% من ${segment.trades} صفقة)`;
      const vetoKind = !gate.pass ? 'gate_block' : 'calibration_tier';
      if (!gate.pass) status.funnel.gateFail += 1; else status.funnel.calibFail += 1;
      const row = {
        symbol, timeframe: zone.timeframe, zoneId: zone.id, at: now(),
        composite, flowScore: flow.score, rr: plan.rr,
        reason: !gate.pass ? gate.blockers.join(' · ') : segReason,
        chain: stageChain(st, { flow, veto: vetoKind })
      };
      rejected.push(row);
      if (st.sawSweep) persistRejectionOnce(row);
      return null;
    }

    if (status.paused) return null;
    const detectedAt = now();
    // القاعدة 1 (لا تسريب مستقبلي): المعايرة المستخدمة يجب أن تسبق لحظة القرار
    if (calibration.at != null && Number(calibration.at) > detectedAt) {
      log.error?.(`[live-opp] FUTURE LEAKAGE ${symbol} ${zone.timeframe}: calibration.at=${calibration.at} > detectedAt=${detectedAt} — publish blocked`);
      return null;
    }
    // القاعدة 2 (لا Ranking بلا Snapshot): اللقطة تُبنى أولا وتُحفظ مع الفرصة — لا إعادة حساب لاحقا
    const snapshot = {
      ...buildDecisionSnapshot({
        zone, state: st, flow, session, location, profile, plan, segment,
        calibrationAt: calibration.at ?? null,
        thresholds: {
          reclaimWindowBars: cfg.reclaimWindowBars, minRR: planMinRR,
          minComposite: cfg.minComposite, flowMinScore: cfg.flowMinScore,
          maxStopAtr: cfg.maxStopAtr, bandPct: cfg.bandPct
        }
      }),
      takenAt: detectedAt
    };

    const key = publishKeyFor(st);    const opportunity = {
      id: key,
      symbol,
      timeframe: zone.timeframe,
      kind: zone.kind,
      zoneId: zone.id,
      referenceLevel: Number(zone.referenceLevel),
      liquidityLevel: Number(zone.liquidityLevel),
      sweepLow: Number(st.sweepLow),
      sweepAt: st.sweepObservedAt,
      detectedAt: now(),
      price: Number(price),
      entry: plan.entry,
      stop: plan.stop,
      tp: plan.tp,
      rr: plan.rr,
      stopAtr: plan.stopAtr,
      targetLabel: plan.targetLabel ?? null,
      targets: plan.targets?.map(t => t.price) ?? [],
      composite,
      flowScore: flow.score,
      flowTier: flow.tier,
      flowReasons: flow.reasons,
      zoneConfidence: zone.confidence,
      zoneTouches: zone.touches,
      session: session.tier,
      location: location.state,
      profile: profile ? { poc: profile.poc, vah: profile.vah, val: profile.val } : null,
      segmentKey: segment.key,
      calibratedWinRate: segment.smoothedWinRate,
      wilsonLB: segment.wilsonLB,
      segmentTrades: segment.trades,
      tier: effectiveTier,
      planMinRR,
      distancePct: Number((((Number(price) - Number(zone.referenceLevel)) / Number(zone.referenceLevel)) * 100).toFixed(3)),
      reasons: [
        `${zone.touches ?? 0} لمسات على المنطقة`,
        `سويب بمقدار ${sweepDepthAtr.toFixed(2)} ATR تحت مستوى السيولة`,
        ...flow.reasons,
        session.tier === 'prime' ? 'جلسة ندرة (تداخل لندن-نيويورك)' : `جلسة ${session.tier}`,
        `الموقع: ${location.state}`
      ],
      outcome: null,
      outcomeAt: null,
      outcomePrice: null,
      bars: null,
      rotation: status.cycle,
      snapshot
    };

    trackers.set(key, markPublished(st, key, now()));
    opportunities.set(key, opportunity);
    /**
     * ★5 قياس فقط: الحكم المعلَّق يُحدَّد من **أعلى وأدنى سعر في الشموع المكتملة منذ
     * النشر**، لا من سعر لحظي يُقرأ كل عدة ثوانٍ. المتابعة الحالية تفوّت الظلال السريعة
     * التي تلمس الهدف أو الوقف بين قراءتين. تُحفظ الحالة خارج كائن الفرصة كي لا تدخل
     * التخزين ولا تُغيّر أي صف محفوظ.
     */
    if (shadow) {
      outcomeShadowState.set(key, {
        symbol: opportunity.symbol, timeframe: opportunity.timeframe,
        stop: Number(opportunity.stop), tp: Number(opportunity.tp),
        bars: 0, hi: -Infinity, lo: Infinity, published: null, compared: false
      });
      /**
       * سقف صلب: الحالة لا تخرج عن الفرص المنشورة أخيراً، فلا تنمو بلا حد لو لم تُقارن.
       * الأقدم يُسقَط أولاً لأنه الأقل احتمالاً لبلوغ حكم نهائي.
       */
      while (outcomeShadowState.size > Math.max(cfg.publishLimit * 3, 60)) {
        const firstKey = outcomeShadowState.keys().next().value;
        outcomeShadowState.delete(firstKey);
      }
    }
    if (opportunities.size > cfg.publishLimit) {
      enforceFeedBounds();
    }
    status.published += 1;
    status.funnel.published += 1;
    status.lastPublishAt = opportunity.detectedAt;
    broadcast({ type: 'live_opportunity_new', opportunity });
    void persistWithResult('live_opportunity', () => persist(opportunity));
    return opportunity;
  }

  /**
   * حدود المجموعتين (P0 عقيدة §7.2):
   * - العرض (opportunities) سقفه publishLimit: الزائد يُنقل إلى المتابعة المؤجلة
   *   **بلا نتيجة اصطناعية** — يظل متابَطاً حتى هدف/وقف حقيقي.
   * - المتابعة المؤجلة (deferredTracking) سقفها التشغيلي trackOverflowLimit:
   *   بلوغه يعني ضغط سعة فعلي، فيُغلق الأقدم بسبب تشغيلي صريح `evicted-track-limit`
   *   ويُحفظ، مع عدّاد مراقب. هذا سياسة تشغيلية معلنة لا قاعدة تداول.
   */
  function enforceFeedBounds() {
    while (opportunities.size > cfg.publishLimit) {
      const oldest = [...opportunities.values()].sort((a, b) => a.detectedAt - b.detectedAt)[0];
      if (!oldest) break;
      opportunities.delete(oldest.id);
      deferredTracking.set(oldest.id, oldest);
      status.evictedFromFeed += 1;
    }
    while (deferredTracking.size > cfg.trackOverflowLimit) {
      const oldest = [...deferredTracking.values()].sort((a, b) => a.detectedAt - b.detectedAt)[0];
      if (!oldest) break;
      deferredTracking.delete(oldest.id);
      const closed = {
        ...oldest, closed: true, outcome: oldest.outcome ?? 'expired',
        exitReason: oldest.exitReason ?? 'evicted-track-limit',
        closedAt: now()
      };
      status.evictedTracked += 1;
      void persistWithResult('live_opportunity', () => persist(closed));
    }
  }

  /** متابعة الفرص المنشورة: هدف / وقف من الأسعار الحية (بلا نداءات إضافية) */
  function trackOutcomes(prices) {
    for (const op of [...opportunities.values(), ...deferredTracking.values()]) {
      /**
       * `wasOpen` يحدد هل هذه الدورة هي لحظة الحسم. كتل الإحصاء والظل تعمل مرة
       * واحدة عند الحسم فقط (كما كانت)، لكن فرع حفظ النتيجة يبقى متاحاً كل دورة
       * حتى ينجح الحفظ — هذا هو مسار إعادة المحاولة (§7.5) بعد فشل الكتابة.
       */
      const wasOpen = !op.outcome;
      if (!wasOpen) {
        // محسومة سابقاً: لا فحص سعر ولا إحصاء — فقط إعادة محاولة الحفظ أدناه إن فشلت
      } else {
        const px = Number(prices?.[op.symbol]);
        if (Number.isFinite(px)) {
          // أفضل/أسوأ إزاحة منذ النشر (R multiples) — مقياس جودة الدخول
          const excursionR = (px - op.entry) / Math.max(op.entry - op.stop, 1e-12);
          op.mfeR = Math.max(Number(op.mfeR ?? 0), excursionR);
          op.maeR = Math.min(Number(op.maeR ?? 0), excursionR);
          if (px <= op.stop) {
            op.outcome = 'stop';
            op.outcomeAt = now();
            op.outcomePrice = px;
          } else if (px >= op.tp) {
            op.outcome = 'target';
            op.outcomeAt = now();
            op.outcomePrice = px;
          }
        }
      }
      /**
       * ★3 قياس فقط: تسجيل الفرصة مرة واحدة عند لحظة حسمها (القاعدة الصحيحة).
       * لا يُقرأ هذا العدّ في أي قرار — يُقارَن فقط بالعدّ المنشور في التقرير.
       */
      if (wasOpen && op.outcome && op.segmentKey) {
        countDecidedOnce(shadowCountedOps, shadowDecided, op.id, op.outcome, op.segmentKey);
      }
      /**
       * حفظ النتيجة فور حسمها — لا ينبغي أن يعتمد حفظ النتيجة الدائم على مؤقت
       * العرض الباقي (3 دقائق). هذا يمنع ضياع النتيجة إذا توقف الخادم قبل الترحيل.
       * عند الفشل: يُعاد فتح الحفظ لتحاوله الدورة التالية (§7.5) — الفشل لا يُخفى
       * ولا يُسوّى بصمت، والعدادات في status.persist تُظهره. علم `outcomeSaving`
       * يمنع حفظاً متزامناً مزدوجاً قبل حلول وعد المحاولة الجارية.
       */
      if (op.outcome && !op.outcomeSaved && !op.outcomeSaving) {
        op.outcomeSaving = true;
        void persistWithResult('live_opportunity', () => persist({ ...op, closed: true }))
          .then(saved => {
            if (saved.ok) op.outcomeSaved = true;
            else op.outcomeSaving = false;
          });
      }
      /**
       * ★5 قياس: نُسجّل الحكم المنشور (من السعر اللحظي) لنقارنه لاحقاً بالحكم المعلَّق
       * من أعلى/أدنى الشموع. لا يُقرأ هذا في أي قرار.
       */
      if (wasOpen && op.outcome && shadow) {
        const st = outcomeShadowState.get(op.id);
        if (st && !st.published) st.published = op.outcome;
      }
      // تغذية راجعة حية لشريحة الفرصة (champion-challenger) — تُستخدم في الترقية التلقائية
      if (wasOpen && op.segmentKey) {
        const st2 = liveStats.get(op.segmentKey) ?? { trades: 0, wins: 0 };
        st2.trades += 1;
        if (op.outcome === 'target') st2.wins += 1;
        liveStats.set(op.segmentKey, st2);
      }
    }
    // ترحيل المحسوم إلى السجل (من العرض ومن المتابعة المؤجلة على حد سواء)
    for (const [key, op] of [...opportunities, ...deferredTracking]) {
      if (!op.outcome) continue;
      const age = now() - (op.outcomeAt ?? op.detectedAt);
      if (age < 3 * 60_000) continue; // يبقى ظاهراً في البث قليلاً ثم يُرحَّل
      history.unshift(op);
      opportunities.delete(key);
      deferredTracking.delete(key);
      status.resolved += 1;
      if (op.outcome === 'target') status.wins += 1; else status.losses += 1;
      broadcast({ type: 'live_opportunity_closed', opportunity: op });
      // النتيجة تُحفظ فور حسمها أعلاه؛ هنا لا حاجة لمحاولة إضافية تُخفي الفشل.
    }
    for (const op of history) {
      if (!op.outcome || op.outcomeSaved || op.outcomeSaving) continue;
      op.outcomeSaving = true;
      void persistWithResult('live_opportunity', () => persist({ ...op, closed: true }))
        .then(saved => {
          if (saved.ok) op.outcomeSaved = true;
          else op.outcomeSaving = false;
        });
    }
    while (history.length > cfg.historyLimit) {
      const removable = history.findIndex(op => op.outcomeSaved === true);
      if (removable < 0) break;
      history.splice(removable, 1);
    }
  }

  /** سباق مع مهلة: يحمي الدورة من أي نداء معلّق (شبكة/قاعدة بيانات) */
  const withTimeout = (promise, ms, fallback) => {
    let timer;
    const timeout = new Promise(resolve => {
      timer = setTimeout(() => resolve(fallback), ms);
    });
    return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(timer));
  };

  /** تحديث دوري لحظي (كل ثانية) للصفقات المنشورة والمناطق قيد المراقبة — بث deltas للواجهة */
  function tickPublished() {
    if (cfg.recoveryRequired && status.recovery.state !== 'ready') return;
    const t = now();
    const src = market?.connected?.() ? null : lastPrices;
    const pxOf = (symbol) => {
      const viaStream = market?.getPrice?.(symbol);
      if (Number.isFinite(Number(viaStream))) return Number(viaStream);
      return Number(src?.[symbol]);
    };
    const oppRows = [];
    for (const op of opportunities.values()) {
      if (op.outcome) continue;
      const px = pxOf(op.symbol);
      if (!Number.isFinite(px)) continue;
      // تحديث الإزاحات حتى بلا دورة كاملة — دقة ثانية واحدة
      const excursionR = (px - op.entry) / Math.max(op.entry - op.stop, 1e-12);
      op.mfeR = Math.max(Number(op.mfeR ?? 0), excursionR);
      op.maeR = Math.min(Number(op.maeR ?? 0), excursionR);
      oppRows.push({
        id: op.id,
        symbol: op.symbol,
        timeframe: op.timeframe,
        price: px,
        plPct: Number((((px - op.entry) / op.entry) * 100).toFixed(3)),
        toTpPct: Number((((op.tp - px) / px) * 100).toFixed(3)),
        toStopPct: Number((((px - op.stop) / px) * 100).toFixed(3)),
        rNow: Number(excursionR.toFixed(3)),
        mfeR: Number((op.mfeR ?? 0).toFixed(3)),
        maeR: Number((op.maeR ?? 0).toFixed(3)),
        ageSec: Math.round((t - op.detectedAt) / 1000),
        earlyExit: Boolean(op.earlyExit)
      });
      if (oppRows.length >= 60) break;
    }
    const watchRows = [];
    for (const st of trackers.values()) {
      if (st.phase === 'published') continue;
      const close = st.geometry?.toLiquidityAtr;
      if (!Number.isFinite(close) || close > cfg.watchApproachAtr * 2) continue;
      watchRows.push({
        key: st.key,
        symbol: st.symbol,
        timeframe: st.timeframe,
        phase: st.phase,
        toLiquidityAtr: Number(close.toFixed(3))
      });
      if (watchRows.length >= 40) break;
    }
    if (oppRows.length || watchRows.length) {
      broadcast({ type: 'live_opportunities_tick', at: t, opportunities: oppRows, watching: watchRows });
    }
  }

  /** كشف حدث-مدفوع: إغلاق شمعة متتبعة → دورة فورية (كل شيء في الذاكرة — بلا شبكة) */
  function onCandleClosed(symbol, tf, closePrice) {
    if (cfg.recoveryRequired && status.recovery.state !== 'ready') return;
    // إبطال مبكر: شمعة أُغلقت تحت قاع السويب المحمي لفرصة منشورة (علامة خروج)
    for (const op of opportunities.values()) {
      if (op.outcome || op.earlyExit) continue;
      if (op.symbol !== symbol || op.timeframe !== tf) continue;
      if (Number.isFinite(Number(closePrice)) && Number(closePrice) < Number(op.sweepLow ?? op.stop)) {
        op.earlyExit = true; // تظهر في tick الثانية التالية (اللقطات كاملة دوماً)
      }
    }
    advanceOutcomeShadow(symbol, tf);
    // دورة سريعة مُخفَّفة — المحرك كله في الذاكرة الآن فلا تكلفة تقريباً
    const t = now();
    if (t - lastFastCycleAt < cfg.fastCycleThrottleMs) return;
    lastFastCycleAt = t;
    if (!status.busy) void runCycle();
  }

  /**
   * ★5 قياس فقط — الحكم المعلَّق من الشموع المكتملة.
   *
   * الفرضية المُقاسة: المتابعة المنشورة تقرأ سعراً لحظياً كل عدة ثوانٍ، فقد يلمس السعر
   * الوقف أو الهدف بين قراءتين ويضيع الحسم؛ ولا تنتهي صلاحية الفرصة أبداً بينما تنتهي
   * في المعايرة بعد `maxBars` شمعة (96). الدليل هو عدد الفرص التي يختلف حكمها.
   *
   * الطريقة: مع كل شمعة مكتملة لرمز الفرصة وفريمها نُراكم أعلى وأدنى سعر، ثم:
   *  - الوقف يُلمس إن نزل الأدنى إلى الوقف، والهدف إن صعد الأعلى إلى الهدف (الوقف أولاً
   *    هو الأسوأ حال اللمس المزدوج — لا نفترض الأفضل).
   *  - عند بلوغ `maxBars` شمعة يصبح الحكم «منتهية» كما في المعايرة.
   *  - تُقارن مرة واحدة فقط لكل فرصة، وحينها يكون الطرفان نهائيين.
   * لا يُكتب أي شيء من هذا في الفرصة ولا في أي صف محفوظ.
   */
  function advanceOutcomeShadow(symbol, tf) {
    if (!shadow || outcomeShadowState.size === 0) return;
    const bars = market?.getKlines?.(symbol, tf) ?? [];
    const last = bars[bars.length - 1];
    const high = Number(last?.high);
    const low = Number(last?.low);
    if (!Number.isFinite(high) || !Number.isFinite(low)) return;
    for (const [id, st] of outcomeShadowState) {
      if (st.compared || st.symbol !== symbol || st.timeframe !== tf) continue;
      st.bars += 1;
      st.hi = Math.max(st.hi, high);
      st.lo = Math.min(st.lo, low);
      const hitStop = Number.isFinite(st.stop) && st.lo <= st.stop;
      const hitTarget = Number.isFinite(st.tp) && st.hi >= st.tp;
      const pending = hitStop ? 'stop' : hitTarget ? 'target' : st.bars >= cfg.maxBars ? 'expired' : null;
      /**
       * المقارنة تحتاج طرفين نهائيين: الحكم المعلَّق إما حُسم بالسعر اللحظي، وإما انقضت
       * مدة التعليق فصار نهائياً. قبل ذلك لا معنى للمقارنة.
       */
      const publishedFinal = st.published ?? (st.bars >= cfg.maxBars ? 'open' : null);
      if (!pending || !publishedFinal) continue;
      st.compared = true;
      shadow.compare(
        'fabio-expiry-and-hilo',
        { outcome: publishedFinal, source: st.published ? 'tick' : 'no-resolution' },
        { outcome: pending, source: 'candle-hilo' },
        (a, b) => a?.outcome === b?.outcome,
        {
          symbol, timeframe: tf, bars: st.bars, id,
          lo: Number(st.lo.toPrecision(10)), hi: Number(st.hi.toPrecision(10)),
          stop: st.stop, tp: st.tp
        }
      );
      outcomeShadowState.delete(id);
    }
  }

  /**
   * ★5 — جامع قياس فرق المعايرة عن الحي: قياس فقط، لا يُكتب في أي فرصة ولا صف محفوظ
   * ولا يُغيّر أي نشر. الغرض إظهار «نسب النجاح المعروضة تقيس غير ما يُنشر» بالأرقام.
   * العدّاد يحمل اختلافاً واحداً لكل (رمز، فريم) في كل تشغيل معايرة، وبمعدّل ثابت
   * لا عشوائي.
   */
  const parityCollector = { pairs: [], compared: 0, diffs: 0, runs: 0, frames: 0 };

  /** دورة واحدة كاملة */
  let lastTargets = null;
  async function runCycle() {
    if (cfg.recoveryRequired && status.recovery.state !== 'ready') return { skipped: true, recovery: status.recovery.state };
    if (status.busy) return { skipped: true, reason: 'دورة قيد التنفيذ' };
    status.busy = true;
    const started = now();
    try {
      // حماية من التعليق: الأهداف من الذاكرة عند بطء الاستعلام، والأسعار تُهمل إن تأخرت
      const targets = await withTimeout(
        resolveTargets().catch(() => null),
        30_000,
        null
      ) ?? lastTargets ?? [];
      if (targets.length) lastTargets = targets;
      status.pairsTotal = targets.length;
      status.cycle += 1;
      // الأسعار الحديثة فقط — يُهمل المخزون القديم ثم يُستخدم REST عند الحاجة
      let prices = {};
      if (typeof market?.getFreshPrice === 'function') {
        for (const symbol of targets) {
          const price = market.getFreshPrice(symbol);
          if (Number.isFinite(price)) prices[symbol] = price;
        }
      } else if (market?.connected?.()) {
        prices = market.getPrices(targets);
      }
      const missing = targets.filter(s => !Number.isFinite(prices[s]));
      if (missing.length) {
        const rest = await withTimeout(Promise.resolve(fetchPrices(missing)).catch(() => ({})), 45_000, {});
        prices = { ...rest, ...prices };
      }
      lastPrices = prices;
      lastPricesAt = now();
      status.market = market?.stats?.() ?? null;
      status.priceAgeMs = status.market?.priceAgeMs ?? null;

      const allowed = new Set(targets);
      const bySymbol = new Map();
      const allZoneKeys = new Set();
      for (const zone of zoneSource() ?? []) {
        if (!allowed.has(zone.symbol)) continue;
        if (!String(zone.kind ?? '').includes('ssl')) continue;
        allZoneKeys.add(trackerKey(zone.symbol, zone.timeframe, zone.id));
        if (!bySymbol.has(zone.symbol)) bySymbol.set(zone.symbol, []);
        bySymbol.get(zone.symbol).push(zone);
      }

      // 1) تحديث كل الحالات بلا شبكة — تتبع مستمر بلا انقطاع
      //    فلترة أداء: آلة الحالة تعمل فقط على المناطق القريبة (≤ maxTrackAtr)،
      //    والبعيدة تُلتقط تلقائياً في الدورة التي تقترب فيها (المسافة تُقاس من السعر الحي).
      const liveKeys = new Set();
      const candidates = [];
      const sweepEvents = [];
      const phaseCount = {};
      for (const [symbol, list] of bySymbol) {
        const px = Number(prices[symbol]);
        if (!Number.isFinite(px)) { status.funnel.noData += 1; continue; }
        status.funnel.eligible += list.length;
        for (const zone of list) {
          const atr = Number(zone.atr) > 0 ? Number(zone.atr) : Math.abs(Number(zone.referenceLevel)) * 0.005 || 1;
          const liq = Number(zone.liquidityLevel ?? zone.referenceLevel);
          if (!Number.isFinite(liq)) continue;
          const toLiquidityAtr = (px - liq) / atr;
          const key = trackerKey(symbol, zone.timeframe, zone.id);
          const prev = trackers.get(key);
          // منطقة بعيدة ولم تُتتبَّع سابقاً: تخطَّ (لا تستهلك ذاكرة ولا معالجة)
          if (!prev && toLiquidityAtr > cfg.maxTrackAtr) continue;
          liveKeys.add(key);
          const { next, events } = advanceTracker(prev ?? initTracker(zone, started, { freshnessBars: cfg.freshnessBars }), {
            zone, price: px, atr, now: started,
            freshnessBars: cfg.freshnessBars, approachAtr: cfg.approachAtr, breakAtr: cfg.breakAtr,
            reclaimWindowBars: cfg.reclaimWindowBars
          });
          trackers.set(key, next);
          phaseCount[next.phase] = (phaseCount[next.phase] ?? 0) + 1;
          for (const e of events) {
            if (e.type === 'sweep') {
              status.funnel.swept += 1;
              sweepEvents.push({
                symbol, timeframe: zone.timeframe, zoneId: zone.id, key,
                at: e.at, price: e.price, kind: zone.kind,
                referenceLevel: Number(zone.referenceLevel),
                liquidityLevel: Number(zone.liquidityLevel),
                sweepLow: Number(next.sweepLow)
              });
            }
            else if (e.type === 'expired') status.funnel.noReclaim += 1;
            else if (e.type === 'late_reclaim') status.funnel.lateReclaim += 1;
            else if (e.type === 'reclaim') {
              sweepEvents.push({
                symbol, timeframe: zone.timeframe, zoneId: zone.id, key,
                at: e.at, price: e.price, kind: zone.kind, reclaim: true,
                elapsedMs: e.elapsedMs ?? null, elapsedBars: e.elapsedBars ?? null,
                referenceLevel: Number(zone.referenceLevel),
                liquidityLevel: Number(zone.liquidityLevel)
              });
            }
          }
          const close = next.geometry?.toLiquidityAtr;
          const veryClose = Number.isFinite(close) && close <= cfg.watchApproachAtr;
          if (!status.paused && (canPublish(next, publishKeyFor(next)) || next.phase === 'reclaimed' || (next.phase === 'approaching' && veryClose))) {
            candidates.push({ symbol, zone, state: next, price: px });
          }
        }
      }
      status.zonesTracked = liveKeys.size;
      status.phases = phaseCount;
      // الحذف فقط للمناطق التي خرجت من المخزون تماماً — لا للمناطق البعيدة (تحفظ ذاكرتها)
      pruneTrackers(trackers, allZoneKeys, started);

      // مزامنة اشتراكات البث: شموع الأكوان المتتبعة + تدفق صفقات لأطوار السويب/الاستعادة/المنشورة
      if (market) {
        const kKeys = new Set();
        const flowSyms = new Set();
        for (const st of trackers.values()) {
          if (st.symbol && st.timeframe) kKeys.add(`${st.symbol}|${st.timeframe}`);
          if (st.symbol && (st.phase === 'swept' || st.phase === 'reclaimed' || st.phase === 'published')) flowSyms.add(st.symbol);
        }
        for (const op of opportunities.values()) if (op.symbol) flowSyms.add(op.symbol);
        market.setKlineSubscriptions([...kKeys].slice(0, cfg.maxKlineSubs));
        market.setAggTradeSubscriptions([...flowSyms].slice(0, cfg.maxFlowSubs));
      }

      for (const ev of sweepEvents.slice(0, 30)) broadcast({ type: 'live_sweep_detected', ...ev });
      // تسجيل دورة الحياة الدائم (أخذ عينات: swept/reclaimed فقط — بلا ضجيج)
      for (const ev of sweepEvents.slice(0, 30)) {
        persistLifecycleOnce(toLifecycleRow(ev.reclaim ? 'reclaim' : 'sweep', {
          symbol: ev.symbol, timeframe: ev.timeframe, zoneId: ev.zoneId, key: ev.key,
          at: ev.at,
          payload: ev.reclaim
            ? { elapsedMs: ev.elapsedMs, elapsedBars: ev.elapsedBars, referenceLevel: ev.referenceLevel, liquidityLevel: ev.liquidityLevel }
            : { kind: ev.kind, referenceLevel: ev.referenceLevel, liquidityLevel: ev.liquidityLevel, sweepLow: ev.sweepLow }
        }));
      }

      // 2) الترتيب + إزالة تكرار الحدث الواحد عبر الفريمات (عقيدة §11):
      //    نفس السويب على عدة فريمات = حدث واحد أساسه الأدق فريماً والبقية شهود (dupTfs)
      for (const c of candidates) c.tfSec = tfSeconds(c?.zone?.timeframe);
      const deduped = dedupeSweepEvents(candidates);
      candidates.length = 0;
      candidates.push(...deduped);

      // 3) تحقق شبكي متوازٍ محدود للنشر (محدد توازٍ + منع تكرار المرشح قيد التحقق)
      const limit = createLimiter(cfg.verifyConcurrency);
      const batch = candidates
        .filter(c => {
          const pk = publishKeyFor(c.state);
          if (verifying.has(pk)) return false;
          verifying.add(pk);
          return true;
        })
        .slice(0, cfg.maxVerifyPerCycle);
      let verified = 0;
      if (batch.length) {
        await withTimeout(
          Promise.all(batch.map(c => limit(async () => {
            verified += 1;
            status.deepScans += 1;
            try {
              const published = await evaluateCandidate(c);
              if (published) broadcast({ type: 'live_opportunities' });
            } catch (e) {
              log.error?.(`[live-opp] evaluate failed ${c.symbol} ${c.zone.timeframe}:`, e.message);
            } finally {
              verifying.delete(publishKeyFor(c.state));
            }
          }))),
          45_000,
          null
        );
      }

      // 4) متابعة نتائج الفرص المنشورة
      trackOutcomes(prices);

      while (rejected.length > 120) rejected.shift();
      status.updatedAt = now();
      status.error = null;
      return { ok: true, cycle: status.cycle, tracked: liveKeys.size, candidates: candidates.length, verified };
    } catch (e) {
      status.error = e.message;
      log.error?.('[live-opp] cycle failed:', e.message);
      return { ok: false, error: e.message };
    } finally {
      status.busy = false;
    }
  }

  /** معايرة walk-forward: مناطق SSL التاريخية المسحوبة → محاكاة → شرائح (فريم × فئة الثقة) */
  async function runCalibration({ symbols = null, timeframes = null } = {}) {
    if (status.paused) return { skipped: true, reason: 'المحرك متوقف مؤقتًا' };
    if (cfg.recoveryRequired && status.recovery.state !== 'ready') {
      return { skipped: true, recovery: status.recovery.state };
    }
    if (calibration.busy) return { skipped: true, reason: 'المعايرة قيد التنفيذ' };
    calibration.busy = true;
    calibration.error = null;
    const runGeneration = pauseGeneration;
    try {
      const targets = symbols ?? (await resolveTargets()).slice(0, cfg.calibration.symbols);
      const frames = timeframes ?? cfg.calibration.timeframes ?? TF_ORDER;
      // مهام (رمز × فريم) عبر محدد توازٍ — بترتيب ثابت وباحترام وزن نداءات بينانس
      const tasks = [];
      for (const symbol of targets) for (const tf of frames) tasks.push({ symbol, tf });
      calibration.progress = { done: 0, total: tasks.length };
      const limit = createLimiter(cfg.calibration.concurrency ?? 4);
      const all = [];
      const rejectedTotals = {};
      const runTask = async ({ symbol, tf }) => {
        if (status.paused || runGeneration !== pauseGeneration) return;
        try {
          const raw = await fetchRawKlines(symbol, tf, cfg.calibration.bars);
          if (status.paused || runGeneration !== pauseGeneration) return;
          const candles = normalizeCandles(raw);
          if (candles.length >= 200) {
            const scanArgs = {
              symbol, timeframe: tf, candles,
              step: Math.max(1, Math.floor(candles.length / 120)),
              maxZones: 120
            };
            // خارج حلقة الأحداث إن توفّر المُجمّع؛ وإلا نفس الدالة كما كانت
            const zones = workers
              ? await workers.run('scanHistory', scanArgs, { timeoutMs: cfg.scanTimeoutMs ?? 120_000 })
              : scanHistory(scanArgs);
            if (status.paused || runGeneration !== pauseGeneration) return;
            // نفس بوابات المحرك الحي: عمق السويب · الموقع · الجلسة · التدفق · R:R
      const { trades, rejected: rej } = calibrateSweeps({
        candles, zones, timeframe: tf, raw,
        bandPct: cfg.bandPct, maxBars: cfg.maxBars, minRR: cfg.minRR,
        maxReclaimBars: cfg.calibration.maxReclaimBars,
        rrGrid: cfg.calibration.rrGrid, maxStopAtr: cfg.maxStopAtr,
        maxDepthAtr: cfg.calibration.maxDepthAtr, minDepthAtr: cfg.calibration.minDepthAtr,
        maxRangePos: cfg.calibration.maxRangePos, minBuyRatioPct: cfg.calibration.minBuyRatioPct,
        feePct: cfg.calibration.feePct, slippagePct: cfg.calibration.slippagePct,
        sessionTierOf: (tsSec) => sessionFactor(Number(tsSec) * 1000).tier,
              requireSessionPrime: cfg.calibration.requireSessionPrime,
              entryMode: 'retest',
              retestTolAtr: cfg.calibration.retestTolAtr,
              retestWindow: cfg.calibration.retestWindow
            });
            all.push(...trades);
            for (const [k, n] of Object.entries(rej)) rejectedTotals[k] = (rejectedTotals[k] ?? 0) + n;

            /**
             * ★5 — قياس فرق المعايرة عن الحي على نفس السويبات (قياس فقط).
             *
             * يُقيَّد بمعدّل ثابت (كل مهمة `parityStride`، افتراضياً 12) لا عشوائي:
             * التكلفة إعادة محاكاة سويبات SSL لنفس البيانات، وهي محسوبة أصلاً في
             * الذاكرة. النتيجة تذهب إلى `shadow` وحده: لا فرصة، ولا صف محفوظ، ولا
             * شريحة معايرة، ولا قرار منشور يتغيّر بها.
             */
            calibration.parityIndex = (calibration.parityIndex ?? 0) + 1;
            if (calibration.parityIndex % (cfg.calibration.parityStride ?? 12) === 0) {
              try {
                const parity = sweepModeParity({
                  candles, zones, timeframe: tf, raw,
                  bandPct: cfg.bandPct, maxBars: cfg.maxBars, minRR: cfg.minRR,
                  maxStopAtr: cfg.maxStopAtr, minDepthAtr: cfg.calibration.minDepthAtr,
                  maxDepthAtr: cfg.calibration.maxDepthAtr, maxRangePos: cfg.calibration.maxRangePos,
                  minBuyRatioPct: cfg.calibration.minBuyRatioPct,
                  sessionTierOf: (tsSec) => sessionFactor(Number(tsSec) * 1000).tier,
                  requireSessionPrime: cfg.calibration.requireSessionPrime,
                  published: {
                    entryMode: 'retest',
                    retestTolAtr: cfg.calibration.retestTolAtr,
                    retestWindow: cfg.calibration.retestWindow,
                    maxReclaimBars: cfg.calibration.maxReclaimBars
                  },
                  /**
                   * الطرف الحي: نافذة الاستعادة الفعلية من إعدادات المحرك الحي
                   * (`reclaimWindowBars`، افتراضياً 3) ودخول على الاستعادة — أي
                   * المعاملات التي تُنتج الفرص المنشورة فعلاً.
                   */
                  live: {
                    entryMode: 'close',
                    retestTolAtr: cfg.calibration.retestTolAtr,
                    retestWindow: cfg.reclaimWindowBars,
                    maxReclaimBars: cfg.maxReclaimBars
                  },
                  limit: cfg.calibration.parityLimit ?? 40
                });
                parityCollector.runs += 1;
                parityCollector.frames += 1;
                parityCollector.compared += parity.compared;
                parityCollector.diffs += parity.diffs;
                parityCollector.pairs.push(...parity.pairs.slice(0, 6));
                if (parityCollector.pairs.length > 60) parityCollector.pairs.splice(0, parityCollector.pairs.length - 60);
                for (const row of parity.pairs.slice(0, 4)) {
                  shadow?.compare(
                    'calibration-live-parity',
                    { outcome: row.published.outcome, win: row.published.win, netRr: row.published.netRr },
                    { outcome: row.live.outcome, win: row.live.win, netRr: row.live.netRr },
                    (a, b) => a?.outcome === b?.outcome && a?.win === b?.win,
                    { symbol, timeframe: tf, sweepAt: row.sweepAt, publishedWindow: cfg.calibration.retestWindow, liveWindow: cfg.reclaimWindowBars }
                  );
                }
              } catch { /* القياس لا يُسقط المعايرة أبداً */ }
            }
          }
        } catch { /* زوج/فريم فاشل لا يوقف المعايرة */ }
        calibration.progress.done += 1;
        // بث التقدم لحظياً + نبضة مهلة بين المهام (احترام حدود بينانس)
        if (calibration.progress.done % 5 === 0 || calibration.progress.done === calibration.progress.total) {
          broadcast({ type: 'live_calibration_progress', ...calibration.progress });
        }
        await sleep(cfg.calibration.sleepMs);
      };
      await Promise.all(tasks.map(t => limit(() => runTask(t))));
      if (status.paused || runGeneration !== pauseGeneration) {
        calibration.progress = null;
        return { skipped: true, reason: 'تم إيقاف المعايرة مؤقتًا' };
      }
      const rows = summarizeSegments(all, {
        targetWinRate: cfg.targetWinRate, minTrades: cfg.minSegmentTrades
      });
      segments.clear();
      for (const r of rows) segments.set(r.key, r);
      calibration.rejected = rejectedTotals;
      calibration.at = now();
      calibration.trades = all.filter(t => t.win === 0 || t.win === 1).length;
      calibration.samplePairs = targets.length;
      calibration.segments = rows;
      calibration.progress = null;
      const saved = await persistWithResult('live_calibration', () => persist({ type: 'live_calibration', at: calibration.at, trades: calibration.trades, segments: rows }));
      if (!saved.ok) calibration.error = 'لم يؤكد التخزين الدائم نجاح المعايرة';
      broadcast({ type: 'live_calibration_done', at: calibration.at, segments: rows.length, trades: calibration.trades, persisted: saved.ok });
      log.log?.(`[live-opp] calibration: ${rows.length} segments / ${calibration.trades} trades`);
      return { ok: true, segments: rows.length, trades: calibration.trades, persisted: saved.ok };
    } catch (e) {
      calibration.error = e.message;
      calibration.progress = null;
      log.error?.('[live-opp] calibration failed:', e.stack ?? e.message);
      return { ok: false, error: e.message };
    } finally {
      calibration.busy = false;
    }
  }

  /** استرجاع آخر معايرة محفوظة (عند الإقلاع) */
  async function loadCalibration() {
    const saved = await readCalibration();
    if (saved?.segments?.length) {
      segments.clear();
      for (const r of saved.segments) segments.set(r.key, r);
      calibration.at = saved.at ?? null;
      calibration.trades = saved.trades ?? 0;
      calibration.segments = saved.segments;
    }
  }

  /** القائمة الحية للواجهة */
  function getFeed() {
    const ops = [...opportunities.values()].sort((a, b) => b.composite - a.composite || b.detectedAt - a.detectedAt);
    // الترتيب الجديد دفعي نسبي (عقيدة §10): القاعدة 2 — بلا لقطة محفوظة لا درجة
    // (الفرز المعروض يبقى composite حتى OOS؛ rank للشفافية والبحث)
    const rankable = ops.filter(o => o?.snapshot);
    const ranked = new Map(rankBatch(rankable.map(o => ({ id: o.id, snapshot: o.snapshot }))).map(r => [r.id, r]));
    for (const o of ops) {
      const r = ranked.get(o.id);
      o.rank = r ? r.score : null;
      o.rankParts = r ? r.parts : null;
      o.rankMargin = r ? r.marginToNext : null;
      o.rankRefDurationMs = r && r.parts ? r.parts.refDurationMs : null;
    }    const watch = [];
    for (const st of trackers.values()) {
      if (st.phase === 'published') continue;
      const close = st.geometry?.toLiquidityAtr;
      if (!Number.isFinite(close) || close > cfg.watchApproachAtr * 2) continue;
      watch.push({
        symbol: st.symbol,
        timeframe: st.timeframe,
        zoneId: st.zoneId,
        kind: st.kind,
        phase: st.phase,
        referenceLevel: st.referenceLevel,
        liquidityLevel: st.liquidityLevel,
        toLiquidityAtr: Number(close.toFixed(3)),
        attempts: st.attempts,
        staleSweep: st.staleSweep,
        reason: st.lastReason
      });
    }
    watch.sort((a, b) => {
      // المناطق النشطة أولاً، ثم المُبطَلة (شفافية فشل السويب)، ثم الفريم الأدق، ثم الأقرب
      const rank = (p) => (p === 'invalidated' ? 1 : 0);
      return rank(a.phase) - rank(b.phase) ||
        tfRank(a.timeframe) - tfRank(b.timeframe) ||
        Math.abs(a.toLiquidityAtr) - Math.abs(b.toLiquidityAtr);
    });
    const decided = status.wins + status.losses;
    return {
      busy: status.busy,
      paused: status.paused,
      pauseUpdatedAt: status.pauseUpdatedAt,
      cycle: status.cycle,
      priceAgeMs: status.priceAgeMs,
      lastPricesAt,
      schedule: { cycleMs: cfg.cycleMs, calibrationMs: cfg.calibrationMs },
      market: status.market,
      recovery: { ...status.recovery },
      scope: status.scope,
      pairsTotal: status.pairsTotal,
      zonesTracked: status.zonesTracked,
      phases: status.phases,
      funnel: { ...status.funnel },
      deepScans: status.deepScans,
      updatedAt: status.updatedAt,
      error: status.error,
      opportunities: ops.slice(0, cfg.publishLimit),
      total: ops.length,
      deferredTracking: deferredTracking.size,
      watching: watch.slice(0, cfg.watchLimit),
      watchingTotal: watch.length,
      rejected: rejected.slice(-30).reverse(),
      stats: {
        /** نطاق العدادات: جلسة التشغيل الحالية — التاريخي يُشتق من events_log عبر /history?days=N */
        scope: 'session',
        published: status.published,
        resolved: status.resolved,
        wins: status.wins,
        losses: status.losses,
        liveWinRate: decided ? Number((status.wins / decided).toFixed(3)) : null
      },
      calibration: {
        at: calibration.at,
        busy: calibration.busy,
        trades: calibration.trades,
        samplePairs: calibration.samplePairs,
        progress: calibration.progress,
        segments: calibration.segments,
        error: calibration.error,
        targetWinRate: cfg.targetWinRate
      }
    };
  }

  function getStatus() {
    return {
      busy: status.busy,
      paused: status.paused,
      pauseUpdatedAt: status.pauseUpdatedAt,
      cycle: status.cycle,
      priceAgeMs: status.priceAgeMs,
      lastPricesAt,
      market: market?.stats?.() ?? status.market,
      schedule: { cycleMs: cfg.cycleMs, calibrationMs: cfg.calibrationMs },
      scope: status.scope,
      rehydrated: status.rehydrated ?? null,
      rehydratedAt: status.rehydratedAt ?? null,
      recovery: { ...status.recovery },
      rehydrateMeta: status.rehydrateMeta ?? null,
      pairsTotal: status.pairsTotal,
      deferredTracking: deferredTracking.size,
      evictedFromFeed: status.evictedFromFeed,
      evictedTracked: status.evictedTracked,
      zonesTracked: status.zonesTracked,
      phases: status.phases,
      deepScans: status.deepScans,
      bookCalls: status.bookCalls,
      updatedAt: status.updatedAt,
      error: status.error,
      persist: status.persist,
      market: market?.stats?.() ?? null,
      calibration: {
        at: calibration.at, busy: calibration.busy, trades: calibration.trades,
        progress: calibration.progress, segments: calibration.segments.length, error: calibration.error
      },
      /** ★3: مقارنة العدّ المنشور بالعدّ الصحيح (عند الحسم فقط) — قياس بلا أثر */
      segmentsShadow: segmentShadowReport(),
      /** ★5: عدد الفرص التي ما زال حكمها المعلَّق (من الشموع) بانتظار طرف نهائي للمقارنة */
      outcomeShadowPending: outcomeShadowState.size
    };
  }

  /**
   * ★3 — تقرير فرق العدّ (يُبنى بوحدة نقية مُختبَرة). لكل شريحة عدّان:
   *  - المنشور: يزيد في كل نداء متابعة (~5 ثوان) لكل فرصة لم تُحسم، فيتضخّم بحسب عدد
   *    المرات التي نظرنا فيها لا بحسب النتائج، فتصبح الترقية إلى «شرائح مؤهّلة» بلا معنى.
   *  - الظلّي: يزيد مرة واحدة عند حسم الفرصة — وهذا ما تعنيه «صفقة» فعلاً.
   * يُعرض للمقارنة فقط ولا يُقرأ في أي قرار. الفرق هنا هو دليل قرارك على ★3.
   */
  function segmentShadowReport() {
    try {
      return buildSegmentShadowReport(liveStats, shadowDecided, calibration.minSegmentTrades ?? cfg.calibration?.minSegmentTrades ?? 30);
    } catch { return null; }
  }

  function getHistory() {
    return { opportunities: history.slice(0, cfg.historyLimit), total: history.length };
  }

  function getCalibration() {
    return {
      at: calibration.at, busy: calibration.busy, trades: calibration.trades,
      progress: calibration.progress, segments: calibration.segments,
      targetWinRate: cfg.targetWinRate, minSegmentTrades: cfg.minSegmentTrades,
      /**
       * ★5: الفرق المقيس بين معاملات المعايرة ومعاملات المحرك الحي على نفس السويبات.
       * عرض وقياس فقط — لا يُقرأ في أي قرار، ولا يغيّر أي شريحة أو نشر.
       */
      parity: {
        compared: parityCollector.compared,
        diffs: parityCollector.diffs,
        diffRate: parityCollector.compared ? Number((parityCollector.diffs / parityCollector.compared).toFixed(4)) : null,
        frames: parityCollector.frames,
        runs: parityCollector.runs,
        publishedWindow: cfg.calibration.retestWindow,
        liveWindow: cfg.reclaimWindowBars,
        samples: parityCollector.pairs.slice(-6)
      }
    };
  }

  function findOpportunity(id) {
    return opportunities.get(id) ?? history.find(o => o.id === id) ?? null;
  }

  /** خريطة الحالات حول فرصة (للتشخيص والاختبار) */
  function getTracker(key) {
    return trackers.get(key) ?? null;
  }

  /**
   * استعادة الحالات النشطة بعد إعادة التشغيل (عقيدة §12):
   * rows = أحداث live_lifecycle + فرص live_opportunity/live_opportunity_closed المحفوظة.
   * تُسقط السويبات الميتة زمنيا — لا إحياء للموتى.
   *
   * meta: { lifecycle: { ok, count?, error? }, opportunities: { ok, count?, error? } }
   *       تُمرَّر من المستدعي لتمييز: سجل فارغ حقيقي / فشل قراءة / استعادة جزئية.
   */
  function rehydrate(rows, meta = {}) {
    if (cfg.recoveryRequired) {
      const complete = Array.isArray(rows)
        && meta.lifecycle?.ok === true && meta.opportunities?.ok === true
        && !meta.lifecycle?.truncated && !meta.opportunities?.truncated;
      if (!complete) {
        status.rehydrateMeta = meta;
        const error = 'استعادة الفرص الحية غير مكتملة أو تجاوزت حد الصفوف';
        setRecoveryState('failed', { error, metadata: meta });
        return { trackers: 0, opportunities: 0, inputRows: 0, skipped: true };
      }
      setRecoveryState('loading', { metadata: meta });
    }
    status.rehydrateMeta = meta;
    const live = [];
    let invalidRows = 0;
    for (const r of rows ?? []) {
      let parsedMeta = null;
      let parseFailed = false;
      try { parsedMeta = typeof r.meta === 'string' ? JSON.parse(r.meta) : (r.meta ?? null); } catch { parseFailed = true; }
      if (parseFailed && (r.type === 'live_lifecycle' || r.type === 'live_opportunity' || r.type === 'live_opportunity_closed')) {
        invalidRows += 1;
        continue;
      }
      if (r.type === 'live_lifecycle') {
        live.push({
          kind: parsedMeta?.kind ?? r.kind, symbol: r.symbol, timeframe: parsedMeta?.timeframe ?? null,
          zoneId: parsedMeta?.zoneId ?? null, key: parsedMeta?.key ?? null, at: Number(r.ts),
          phase: null, payload: parsedMeta?.payload ?? parsedMeta ?? null
        });
      } else if (r.type === 'live_opportunity' || r.type === 'live_opportunity_closed') {
        const op = parsedMeta?.opportunity ?? null;
        if (!op) {
          invalidRows += 1;
          continue;
        }
        live.push({
          kind: r.type === 'live_opportunity_closed' ? 'closed' : 'published',
          symbol: op.symbol, timeframe: op.timeframe, zoneId: op.zoneId,
          key: trackerKey(op.symbol, op.timeframe, op.zoneId),
          at: Number(r.ts), payload: { opportunity: op }
        });
      }
    }
    if (cfg.recoveryRequired && invalidRows > 0) {
      const metadata = { ...meta, invalidRows };
      status.rehydrateMeta = metadata;
      const error = `تعذر تفسير ${invalidRows} من أحداث الفرص المحفوظة`;
      setRecoveryState('failed', { error, metadata });
      return { trackers: 0, opportunities: 0, inputRows: rows?.length ?? 0, invalidRows, skipped: true };
    }
    const { trackers: ts, opportunities: ops } = rehydrateState(live, {
      nowMs: now(), freshnessBars: cfg.freshnessBars, tfSecondsOf: (tf) => tfSeconds(tf)
    });
    let restoredTrackers = 0, restoredOpps = 0;
    for (const st of ts) {
      if (!trackers.has(st.key)) { trackers.set(st.key, st); restoredTrackers += 1; }
    }
    for (const op of ops) {
      if (!op.outcome && !opportunities.has(op.id) && !deferredTracking.has(op.id)) {
        opportunities.set(op.id, op);
        restoredOpps += 1;
      }
    }
    // الاستعادة قد تُعيد أكثر من سعة العرض: الفائض يذهب إلى المتابعة المؤجلة
    // (بلا نتيجة اصطناعية) — نفس سياسة publish() الحية.
    enforceFeedBounds();
    status.rehydratedAt = now();
    status.rehydrated = { trackers: restoredTrackers, opportunities: restoredOpps, inputRows: rows?.length ?? 0 };
    if (cfg.recoveryRequired) setRecoveryState('ready', { metadata: meta });
    log.log?.(`[live-opp] rehydrated ${restoredTrackers} trackers / ${restoredOpps} opportunities (rows=${rows?.length ?? 0})`);
    return status.rehydrated;
  }

  function start() {
    if (running) return;
    if (cfg.recoveryRequired && status.recovery.state !== 'ready') {
      return { skipped: true, recovery: status.recovery.state };
    }
    running = true;
    // كشف حدث-مدفوع: إغلاق شمعة متتبعة → دورة فورية + إبطال مبكر للفرص المنشورة
    if (market?.onCandleClose) unsubCandleClose = market.onCandleClose(onCandleClosed);
    if (!cfg.recoveryRequired) {
      void loadCalibration().then(() => runCalibration().catch(() => undefined)).catch(error => {
        status.error = `فشل تحميل المعايرة: ${error?.message ?? error}`;
        log.error?.('[live-opp] calibration restore failed:', status.error);
      });
    } else {
      // الإنتاج أيضاً: تُحمَّل المعايرة المحفوظة عند البدء، وإن لم توجد محفوظة تُشغَّل
      // أول معايرة تلقائياً بدل انتظار أول مجدول (6 ساعات) — المحرك ذاتي بلا أزرار.
      void loadCalibration().then(() => {
        if (!calibration.at) return runCalibration().catch(() => undefined);
        return undefined;
      }).catch(error => {
        status.error = `فشل تحميل المعايرة: ${error?.message ?? error}`;
        log.error?.('[live-opp] calibration restore failed:', status.error);
      });
    }
    cycleTimer = setInterval(() => { void runCycle(); }, cfg.cycleMs);
    tickTimer = setInterval(tickPublished, cfg.tickMs);
    calibTimer = setInterval(() => { void runCalibration(); }, cfg.calibrationMs);
    if (cycleTimer.unref) cycleTimer.unref();
    if (tickTimer.unref) tickTimer.unref();
    if (calibTimer.unref) calibTimer.unref();
    void runCycle();
  }

  function setPaused(paused, pauseUpdatedAt = now()) {
    const nextPaused = Boolean(paused);
    if (status.paused !== nextPaused) pauseGeneration += 1;
    status.paused = nextPaused;
    status.pauseUpdatedAt = status.paused ? Number(pauseUpdatedAt) || now() : null;
    status.updatedAt = now();
    return { paused: status.paused, pauseUpdatedAt: status.pauseUpdatedAt };
  }

  function stop() {
    running = false;
    if (cycleTimer) clearInterval(cycleTimer);
    if (tickTimer) clearInterval(tickTimer);
    if (calibTimer) clearInterval(calibTimer);
    if (unsubCandleClose) { unsubCandleClose(); unsubCandleClose = null; }
    cycleTimer = null;
    tickTimer = null;
    calibTimer = null;
  }

  return {
    start, stop, setPaused, runCycle, runCalibration, loadCalibration, rehydrate, setRecoveryState,
    getFeed, getStatus, getHistory, getCalibration, findOpportunity, getTracker,
    _internals: { trackers, opportunities, history, segments, rejected, status, calibration, cfg }
  };
}
