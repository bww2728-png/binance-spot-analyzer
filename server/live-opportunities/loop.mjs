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
  pruneTrackers, publishKeyFor, tfRank, trackerKey, TF_ORDER
} from './tracker.mjs';
import {
  buildLongPlan, calibrateSweeps, compositeScore, confBand, flowScore, gates,
  longTargets, nextSslBelow, segmentLookupKeys, summarizeSegments
} from './scanner.mjs';

const DEFAULT_CONFIG = {
  cycleMs: 10_000,
  calibrationMs: 60 * 60 * 1000,
  maxVerifyPerCycle: 12,
  maxTrackAtr: 6,
  maxStopAtr: 3,
  freshnessBars: 6,
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
  historyLimit: 300,
  maxBars: 96,
  maxReclaimBars: 6,
  calibration: {
    symbols: 24, timeframes: null, bars: 1000, batch: 5, sleepMs: 600, maxPages: 2,
    minDepthAtr: 0.15, maxDepthAtr: 3, maxRangePos: 0.8, minBuyRatioPct: 48,
    requireSessionPrime: false,
    // شبكة أهداف R:R: النسبة تعتمد جوهرياً على بُعد الهدف، والشرائح تختار الأنسب
    rrGrid: [1.0, 1.2, 1.5, 2, 2.5],
    // نافذة الاستعادة أوسع (12 شمعة): 6 شموع ترفض معظم السويبات فيقلّ حجم العيّنة كثيراً
    maxReclaimBars: 12,
    // دخول إعادة الاختبار (فابيو): دخول أقرب للوقف بعد الاستعادة → نسبة نجاح أعلى لنفس الهدف
    retestTolAtr: 0.3,
    retestWindow: 12
  }
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
    broadcast = () => {},
    persist = async () => {},
    readCalibration = async () => null,
    now = () => Date.now(),
    log = console,
    config = {}
  } = deps;

  const cfg = { ...DEFAULT_CONFIG, ...config, calibration: { ...DEFAULT_CONFIG.calibration, ...(config.calibration ?? {}) } };

  const trackers = new Map();          // key → حالة
  const opportunities = new Map();     // publishKey → فرصة منشورة
  const history = [];                  // فرص محسومة/قديمة (محدودة)
  const segments = new Map();          // مفتاح شريحة → إحصاء
  const rejected = [];                 // مرشحون لم يجتازوا البوابات/الشريحة (شفافية)

  const status = {
    busy: false,
    cycle: 0,
    scope: 'halal_no_barcode',
    pairsTotal: 0,
    zonesTracked: 0,
    phases: {},
    published: 0,
    resolved: 0,
    wins: 0,
    losses: 0,
    deepScans: 0,
    bookCalls: 0,
    lastPublishAt: null,
    updatedAt: null,
    error: null
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
  let running = false;

  /** بحث الشريحة: الأدق أولاً ثم الأعمّ — تُقبل فقط إن بلغت عيّنتها الحد الأدنى */
  function findSegment(timeframe, tier, band) {
    for (const key of segmentLookupKeys({ timeframe, flowTier: tier, confBand: band })) {
      const row = segments.get(key);
      if (row && row.trades >= cfg.minSegmentTrades) return row;
    }
    return null;
  }

  /** نداء الشموع الخام مرة واحدة + الطبقات المشتقة (تُستدعى للمرشحين فقط) */
  async function enrich(symbol, timeframe) {
    const raw = await fetchRawKlines(symbol, timeframe, 500);
    const candles = normalizeCandles(raw);
    if (candles.length < 60) return null;
    const profile = computeVolumeProfile(candles);
    const location = classifyLocation(candles, profile);
    const cvd = computeCvd(raw, 50); // يحتاج الشموع الخام (يقرأ عمود Taker Buy)
    return { candles, profile, location, cvd };
  }

  /** تحقق شبكي كامل لمرشح + نشر إن اجتاز */
  async function evaluateCandidate({ symbol, zone, state, price }) {
    const enriched = await enrich(symbol, zone.timeframe);
    if (!enriched) return null;
    const { candles, profile, location, cvd } = enriched;

    // إعادة تقديم الحالة بالسعر الحي (لا بأدنى قاع — وإلا لن تُكتشف الاستعادة أبداً)،
    // مع ضبط قاع السويب من الشموع الحقيقية لا من سعر لحظي.
    const { next: st } = advanceTracker(state, {
      zone, price: Number(price), atr: zone.atr, now: now(),
      freshnessBars: cfg.freshnessBars, approachAtr: cfg.approachAtr, breakAtr: cfg.breakAtr
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

    status.bookCalls += 1;
    const book = await fetchBookSignals(symbol).catch(() => ({ bubbles: [], book: null, icebergs: [], spoofs: [] }));
    const flow = flowScore({
      cvd, bubbles: book.bubbles, book: book.book, icebergs: book.icebergs, spoofs: book.spoofs,
      sweepLow: st.sweepLow, price: Number(price), atr: zone.atr
    });

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
      rejected.push({ symbol, timeframe: zone.timeframe, zoneId: zone.id, at: now(), reason: plan.violations?.join(' · ') || 'لا خطة صالحة' });
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
    const segmentOk = segment != null && segment.smoothedWinRate >= cfg.targetWinRate;

    if (!gate.pass || !segmentOk) {
      const segReason = segment == null
        ? 'لا شريحة معايَرة مؤهَّلة بعد — شغّل المعايرة'
        : `الشريحة ${segment.key} دون الهدف (${(segment.smoothedWinRate * 100).toFixed(1)}% من ${segment.trades} صفقة)`;
      rejected.push({
        symbol, timeframe: zone.timeframe, zoneId: zone.id, at: now(),
        composite, flowScore: flow.score, rr: plan.rr,
        reason: !gate.pass ? gate.blockers.join(' · ') : segReason
      });
      return null;
    }

    const key = publishKeyFor(st);
    const opportunity = {
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
      segmentTrades: segment.trades,
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
      rotation: status.cycle
    };

    trackers.set(key, markPublished(st, key, now()));
    opportunities.set(key, opportunity);
    if (opportunities.size > cfg.publishLimit) {
      const oldest = [...opportunities.values()].sort((a, b) => a.detectedAt - b.detectedAt)[0];
      if (oldest) opportunities.delete(oldest.id);
    }
    status.published += 1;
    status.lastPublishAt = opportunity.detectedAt;
    broadcast({ type: 'live_opportunity_new', opportunity });
    void persist(opportunity).catch(() => undefined);
    return opportunity;
  }

  /** متابعة الفرص المنشورة: هدف / وقف من الأسعار الحية (بلا نداءات إضافية) */
  function trackOutcomes(prices) {
    for (const op of [...opportunities.values()]) {
      if (op.outcome) continue;
      const px = Number(prices?.[op.symbol]);
      if (!Number.isFinite(px)) continue;
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
    // ترحيل المحسوم إلى السجل
    for (const [key, op] of [...opportunities]) {
      if (!op.outcome) continue;
      const age = now() - (op.outcomeAt ?? op.detectedAt);
      if (age < 3 * 60_000) continue; // يبقى ظاهراً في البث قليلاً ثم يُرحَّل
      history.unshift(op);
      opportunities.delete(key);
      status.resolved += 1;
      if (op.outcome === 'target') status.wins += 1; else status.losses += 1;
      broadcast({ type: 'live_opportunity_closed', opportunity: op });
      void persist({ ...op, closed: true }).catch(() => undefined);
    }
    while (history.length > cfg.historyLimit) history.pop();
  }

  /** سباق مع مهلة: يحمي الدورة من أي نداء معلّق (شبكة/قاعدة بيانات) */
  const withTimeout = (promise, ms, fallback) => Promise.race([
    promise,
    new Promise(resolve => setTimeout(() => resolve(fallback), ms))
  ]);

  /** دورة واحدة كاملة */
  let lastTargets = null;
  async function runCycle() {
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
      const prices = await withTimeout(
        Promise.resolve(fetchPrices(targets)).catch(() => ({})),
        45_000,
        {}
      );

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
        if (!Number.isFinite(px)) continue;
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
            freshnessBars: cfg.freshnessBars, approachAtr: cfg.approachAtr, breakAtr: cfg.breakAtr
          });
          trackers.set(key, next);
          phaseCount[next.phase] = (phaseCount[next.phase] ?? 0) + 1;
          for (const e of events) {
            if (e.type === 'sweep') sweepEvents.push({ symbol, timeframe: zone.timeframe, zoneId: zone.id, at: e.at, price: e.price });
          }
          const close = next.geometry?.toLiquidityAtr;
          const veryClose = Number.isFinite(close) && close <= cfg.watchApproachAtr;
          if (canPublish(next, publishKeyFor(next)) || next.phase === 'reclaimed' || (next.phase === 'approaching' && veryClose)) {
            candidates.push({ symbol, zone, state: next, price: px });
          }
        }
      }
      status.zonesTracked = liveKeys.size;
      status.phases = phaseCount;
      // الحذف فقط للمناطق التي خرجت من المخزون تماماً — لا للمناطق البعيدة (تحفظ ذاكرتها)
      pruneTrackers(trackers, allZoneKeys, started);

      for (const ev of sweepEvents.slice(0, 30)) broadcast({ type: 'live_sweep_detected', ...ev });

      // 2) الترتيب: الفريم الأدق أولاً ثم الأقرب مسافةً (عرض أولاً بأول)
      candidates.sort((a, b) =>
        tfRank(a.zone.timeframe) - tfRank(b.zone.timeframe) ||
        (a.state.geometry?.toLiquidityAtr ?? 99) - (b.state.geometry?.toLiquidityAtr ?? 99));

      // 3) تحقق شبكي محدود للنشر
      let verified = 0;
      for (const c of candidates) {
        if (verified >= cfg.maxVerifyPerCycle) break;
        verified += 1;
        status.deepScans += 1;
        try {
          const published = await evaluateCandidate(c);
          if (published) broadcast({ type: 'live_opportunities' });
        } catch (e) {
          log.error?.(`[live-opp] evaluate failed ${c.symbol} ${c.zone.timeframe}:`, e.message);
        }
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
    if (calibration.busy) return { skipped: true, reason: 'المعايرة قيد التنفيذ' };
    calibration.busy = true;
    calibration.error = null;
    try {
      const targets = symbols ?? (await resolveTargets()).slice(0, cfg.calibration.symbols);
      const frames = timeframes ?? cfg.calibration.timeframes ?? TF_ORDER;
      calibration.progress = { done: 0, total: targets.length * frames.length };
      const all = [];
      const rejectedTotals = {};
      for (const symbol of targets) {
        for (const tf of frames) {
          try {
            const raw = await fetchRawKlines(symbol, tf, cfg.calibration.bars);
            const candles = normalizeCandles(raw);
            if (candles.length < 200) continue;
            const zones = scanHistory({
              symbol, timeframe: tf, candles,
              step: Math.max(1, Math.floor(candles.length / 120)),
              maxZones: 120
            });
            // نفس بوابات المحرك الحي: عمق السويب · الموقع · الجلسة · التدفق · R:R
            const { trades, rejected: rej } = calibrateSweeps({
              candles, zones, timeframe: tf, raw,
              bandPct: cfg.bandPct, maxBars: cfg.maxBars, minRR: cfg.minRR,
              maxReclaimBars: cfg.calibration.maxReclaimBars,
              rrGrid: cfg.calibration.rrGrid, maxStopAtr: cfg.maxStopAtr,
              maxDepthAtr: cfg.calibration.maxDepthAtr, minDepthAtr: cfg.calibration.minDepthAtr,
              maxRangePos: cfg.calibration.maxRangePos, minBuyRatioPct: cfg.calibration.minBuyRatioPct,
              sessionTierOf: (tsSec) => sessionFactor(Number(tsSec) * 1000).tier,
              requireSessionPrime: cfg.calibration.requireSessionPrime,
              entryMode: 'retest',
              retestTolAtr: cfg.calibration.retestTolAtr,
              retestWindow: cfg.calibration.retestWindow
            });
            all.push(...trades);
            for (const [k, n] of Object.entries(rej)) rejectedTotals[k] = (rejectedTotals[k] ?? 0) + n;
          } catch { /* زوج/فريم فاشل لا يوقف المعايرة */ }
          calibration.progress.done += 1;
          await sleep(cfg.calibration.sleepMs);
        }
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
      broadcast({ type: 'live_calibration_done', segments: rows.length, trades: calibration.trades });
      void persist({ type: 'live_calibration', at: calibration.at, trades: calibration.trades, segments: rows }).catch(() => undefined);
      log.log?.(`[live-opp] calibration: ${rows.length} segments / ${calibration.trades} trades`);
      return { ok: true, segments: rows.length, trades: calibration.trades };
    } catch (e) {
      calibration.error = e.message;
      calibration.progress = null;
      log.error?.('[live-opp] calibration failed:', e.message);
      return { ok: false, error: e.message };
    } finally {
      calibration.busy = false;
    }
  }

  /** استرجاع آخر معايرة محفوظة (عند الإقلاع) */
  async function loadCalibration() {
    try {
      const saved = await readCalibration();
      if (saved?.segments?.length) {
        segments.clear();
        for (const r of saved.segments) segments.set(r.key, r);
        calibration.at = saved.at ?? null;
        calibration.trades = saved.trades ?? 0;
        calibration.segments = saved.segments;
      }
    } catch { /* بلا معايرة محفوظة */ }
  }

  /** القائمة الحية للواجهة */
  function getFeed() {
    const ops = [...opportunities.values()].sort((a, b) => b.composite - a.composite || b.detectedAt - a.detectedAt);
    const watch = [];
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
      cycle: status.cycle,
      scope: status.scope,
      pairsTotal: status.pairsTotal,
      zonesTracked: status.zonesTracked,
      phases: status.phases,
      deepScans: status.deepScans,
      updatedAt: status.updatedAt,
      error: status.error,
      opportunities: ops.slice(0, cfg.publishLimit),
      total: ops.length,
      watching: watch.slice(0, cfg.watchLimit),
      watchingTotal: watch.length,
      rejected: rejected.slice(-30).reverse(),
      stats: {
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
      cycle: status.cycle,
      scope: status.scope,
      pairsTotal: status.pairsTotal,
      zonesTracked: status.zonesTracked,
      phases: status.phases,
      deepScans: status.deepScans,
      bookCalls: status.bookCalls,
      updatedAt: status.updatedAt,
      error: status.error,
      calibration: {
        at: calibration.at, busy: calibration.busy, trades: calibration.trades,
        progress: calibration.progress, segments: calibration.segments.length, error: calibration.error
      }
    };
  }

  function getHistory() {
    return { opportunities: history.slice(0, cfg.historyLimit), total: history.length };
  }

  function getCalibration() {
    return {
      at: calibration.at, busy: calibration.busy, trades: calibration.trades,
      progress: calibration.progress, segments: calibration.segments,
      targetWinRate: cfg.targetWinRate, minSegmentTrades: cfg.minSegmentTrades
    };
  }

  function findOpportunity(id) {
    return opportunities.get(id) ?? history.find(o => o.id === id) ?? null;
  }

  /** خريطة الحالات حول فرصة (للتشخيص والاختبار) */
  function getTracker(key) {
    return trackers.get(key) ?? null;
  }

  function start() {
    if (running) return;
    running = true;
    void loadCalibration().then(() => {
      void runCalibration().catch(() => undefined);
    });
    cycleTimer = setInterval(() => { void runCycle(); }, cfg.cycleMs);
    calibTimer = setInterval(() => { void runCalibration(); }, cfg.calibrationMs);
    if (cycleTimer.unref) cycleTimer.unref();
    if (calibTimer.unref) calibTimer.unref();
    void runCycle();
  }

  function stop() {
    running = false;
    if (cycleTimer) clearInterval(cycleTimer);
    if (calibTimer) clearInterval(calibTimer);
    cycleTimer = null;
    calibTimer = null;
  }

  return {
    start, stop, runCycle, runCalibration, loadCalibration,
    getFeed, getStatus, getHistory, getCalibration, findOpportunity, getTracker,
    _internals: { trackers, opportunities, history, segments, rejected, status, calibration, cfg }
  };
}
