/* محرك «الفرص الحية — استراتيجيتي» — دورة حية كاملة + معايرة walk-forward + استمرارية
 *
 * المعمارية:
 *  1) طبقة بيانات مشتركة: WS (أسعار + شموع حية) عبر tenant مستقل + REST احتياطياً عبر المحدد الموحد.
 *  2) كل إغلاق شمعة دخول → analyzeCandles (نواة نقية) → إشارة أو مرحلة انتظار موثقة.
 *  3) البوابات: موت المشوار الصاعد (bsl/سبلاي خارجي على HTF هابط) + الطبقة الإحصائية + فشل الدخول.
 *  4) النشر: TP1 = قمة choch up الحقيقي · TP2 = bsl خارجي · الوقف تحت قاع السويب.
 *  5) الاستمرارية: أحداث events_log دائمة → استعادة عند الإقلاع + تسوية فجوة الشموع.
 *  6) المعايرة: إعادة تشغيل نفس النواة على التاريخ → شرائح (فريم × اتجاه HTF × نموذج) بتمليس بايزي + Wilson.
 */

import {
  analyzeCandles, isBullishPair
} from './structure.mjs';

const DEFAULT_CONFIG = {
  cycleMs: 20_000,             // دورة فحص احتياطية (المعالجة الأساسية حدث-مدفوعة بإغلاق الشموع)
  tickMs: 1_000,               // نبض تتبع النتائج من الأسعار الحية
  entryTfs: ['5m', '15m'],     // فريمات الدخول — الفريم الأكبر = ×8 تلقائياً (40m/2h)
  warmupBars: 220,             // أقل عدد شموع قبل بدء التحليل
  analysisWindow: 900,         // نافذة الشموع المعالجة (يشمل تجميع ×8)
  maxSymbols: 462,
  publishLimit: 100,
  historyLimit: 300,
  maxHoldBars: 96,             // أقصى عمر فرصة (شموع فريم الدخول) قبل «انتهت»
  bandPct: 0.0015,
  minRR: 1.0,
  discountPos: 0.5,
  maxTrackedPerSymbol: 1,      // فرصة نشطة واحدة لكل رمز/فريم
  promoteLiveTrades: 20,
  targetWinRate: 0.6,
  minSegmentTrades: 8,
  calibrationMs: 6 * 60 * 60 * 1000,
  calibration: { symbols: 96, bars: 3000, concurrency: 3, stridePatternOnly: true },
  maxFailuresKept: 300
};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** شرائح الاستراتيجية: (فريم × اتجاه HTF × نموذج) بتمليس بايزي + Wilson — نقية وقابلة للاختبار */
export function summarizeStrategySegments(trades, { targetWinRate = 0.6, minTrades = 8, priorWeight = 6 } = {}) {
  const wilsonLB = (w, n, z = 1.96) => {
    if (!n) return 0;
    const p = w / n;
    const denom = 1 + z * z / n;
    const centre = p + z * z / (2 * n);
    const margin = z * Math.sqrt((p * (1 - p) + z * z / (4 * n)) / n);
    return Math.max(0, (centre - margin) / denom);
  };
  let tw = 0, tt = 0;
  for (const t of trades ?? []) {
    if (t.win !== 0 && t.win !== 1) continue;
    tt += 1; if (t.win === 1) tw += 1;
  }
  const globalPrior = tt > 0 ? tw / tt : 0.5;
  const map = new Map();
  for (const t of trades ?? []) {
    if (t.win !== 0 && t.win !== 1) continue;
    const keys = [`${t.tf}|${t.htfDir}|m${t.model}`, `${t.tf}|${t.htfDir}|all`, `${t.tf}|all|all`];
    for (const key of keys) {
      const row = map.get(key) ?? { trades: 0, wins: 0, rrSum: 0, rrCount: 0 };
      row.trades += 1;
      if (t.win === 1) row.wins += 1;
      if (Number.isFinite(t.rr)) { row.rrSum += t.rr; row.rrCount += 1; }
      map.set(key, row);
    }
  }
  const out = [];
  for (const [key, r] of map) {
    const raw = r.trades ? r.wins / r.trades : null;
    const smoothed = (r.wins + globalPrior * priorWeight) / (r.trades + priorWeight);
    const lb = wilsonLB(r.wins, r.trades);
    const tier = (smoothed >= targetWinRate && lb >= 0.5 && r.trades >= minTrades)
      ? 'qualified'
      : (smoothed >= 0.5 ? 'probationary' : 'weak');
    out.push({
      key, trades: r.trades, wins: r.wins,
      winRate: raw == null ? null : Number(raw.toFixed(3)),
      smoothedWinRate: Number(smoothed.toFixed(3)),
      wilsonLB: Number(lb.toFixed(3)),
      avgRR: r.rrCount ? Number((r.rrSum / r.rrCount).toFixed(2)) : null,
      tier
    });
  }
  return out.sort((a, b) => b.trades - a.trades);
}

export function createStrategyEngine(deps) {
  const {
    resolveTargets,
    fetchRawKlines,
    fetchPrices,
    market = null,               // طبقة البيانات المشتركة (streams.mjs)
    broadcast = () => {},
    persist = async () => {},    // كتابة الأحداث الدائمة
    readCalibration = async () => null,
    readPublishedEvents = async () => [],
    now = () => Date.now(),
    log = console,
    config = {}
  } = deps;

  const cfg = { ...DEFAULT_CONFIG, ...config, calibration: { ...DEFAULT_CONFIG.calibration, ...(config.calibration ?? {}) } };
  const TF_MS = { m: 60_000, h: 3_600_000, d: 86_400_000 };
  const tfMs = (tf) => {
    const n = parseInt(tf, 10) || 1;
    const u = tf.replace(/[0-9]/g, '') || 'm';
    return n * (TF_MS[u] ?? TF_MS.m);
  };

  /* ---- الحالة ---- */
  const opportunities = new Map();   // id → فرصة منشورة
  const bySymbolTf = new Map();      // "SYM|tf" → فرصة نشطة (سقف 1)
  const lastProcessed = new Map();   // "SYM|tf" → openTime آخر شمعة معالجة
  const liveStats = new Map();       // شريحة → {trades, wins}
  const segments = new Map();        // مفتاح شريحة → إحصاء
  const failures = new Map();        // "SYM|tf|layer" → {count, last, message}
  const rejected = [];               // شفافية الرفض
  const history = [];
  const seeding = new Set();         // مفاتيح قيد البذر

  const status = {
    busy: false, cycle: 0, scope: 'halal_no_barcode', pairsTotal: 0,
    analyzing: 0, published: 0, resolved: 0, wins: 0, losses: 0,
    waitingPhases: {}, lastPublishAt: null, updatedAt: null, error: null,
    restored: 0, reconciled: 0
  };
  const calibration = { at: null, busy: false, trades: 0, progress: null, segments: [], error: null };

  let cycleTimer = null, tickTimer = null, calibTimer = null, unsubClose = null;
  let running = false;
  let lastPrices = {};
  let lastFastAt = 0;

  const bumpFailure = (key, message) => {
    const f = failures.get(key) ?? { count: 0, last: null, message: null };
    f.count += 1; f.last = now(); f.message = String(message ?? '').slice(0, 200);
    failures.set(key, f);
    if (failures.size > cfg.maxFailuresKept) {
      const oldest = [...failures.entries()].sort((a, b) => (a[1].last ?? 0) - (b[1].last ?? 0))[0];
      if (oldest) failures.delete(oldest[0]);
    }
  };
  const clearFailure = (key) => failures.delete(key);

  /* ---- جلب الشموع: بث حي أولاً ثم REST عبر المحدد ---- */
  async function getCandles(symbol, tf, limit = cfg.analysisWindow) {
    let raw = null;
    if (market) {
      const key = `${symbol}|${tf}`;
      if (!market.hasKline(key) && !seeding.has(key)) {
        seeding.add(key);
        try { await market.ensureKlineSeed(key); } catch (e) { bumpFailure(`${symbol}|${tf}|seed`, e.message); }
        finally { seeding.delete(key); }
      }
      raw = market.getKlines(symbol, tf);
    }
    if (!raw || raw.length < 60) {
      try {
        raw = await fetchRawKlines(symbol, tf, Math.min(limit, 1000));
        clearFailure(`${symbol}|${tf}|seed`);
      } catch (e) {
        bumpFailure(`${symbol}|${tf}|rest`, e.message);
        return null;
      }
    }
    if (!raw || !raw.length) return null;
    return raw.map(k => ({
      time: Math.floor(Number(k[0]) / 1000),
      timeMs: Number(k[0]),
      open: Number(k[1]), high: Number(k[2]), low: Number(k[3]), close: Number(k[4]),
      volume: Number(k[5])
    }));
  }

  /* ---- البوابات والنشر ---- */
  function segmentKeyOf(tf, htfDir, model) {
    return `${tf}|${htfDir}|m${model}`;
  }

  function findSegment(key) {
    const exact = segments.get(key);
    if (exact && exact.trades >= cfg.minSegmentTrades) return exact;
    // تراجع عام: شريحة الفريم فقط عبر كل الاتجاهات والنماذج
    const [tf] = key.split('|');
    const general = segments.get(`${tf}|all|all`);
    if (general && general.trades >= cfg.minSegmentTrades) return general;
    return null;
  }

  function effectiveTier(segment) {
    if (!segment) return null;
    if (segment.tier === 'probationary') {
      const live = liveStats.get(segment.key) ?? { trades: 0, wins: 0 };
      const wr = live.trades > 0 ? live.wins / live.trades : null;
      if (live.trades >= cfg.promoteLiveTrades && wr != null && wr >= cfg.targetWinRate) return 'qualified';
    }
    return segment.tier ?? null;
  }

  function publish(an, { symbol, tf, signal }) {
    const segKey = segmentKeyOf(tf, an.htf.direction, signal.model);
    const segment = findSegment(segKey);
    const tier = effectiveTier(segment);
    const segOk = tier === 'qualified' || tier === 'probationary';
    if (cfg.requireSegment ?? false) {
      if (!segOk) {
        rejected.push({
          at: now(), symbol, tf, model: signal.model, composite: null,
          reason: segment == null
            ? 'لا شريحة معايَرة — بانتظار المعايرة'
            : `الشريحة ${segment.key} ${tier === 'weak' ? 'ضعيفة' : tier === 'probationary' ? 'تحت التجربة' : 'غير مؤهلة'} (${((segment.smoothedWinRate ?? 0) * 100).toFixed(1)}% من ${segment.trades})`
        });
        return null;
      }
    }
    const id = `s2:${symbol}:${tf}:${signal.at}`;
    const opportunity = {
      id, symbol, tf,
      model: signal.model,
      htfDirection: an.htf.direction,
      afterPremium: an.htf.afterPremium,
      tier,
      segmentKey: segment?.key ?? segKey,
      calibratedWinRate: segment?.smoothedWinRate ?? null,
      wilsonLB: segment?.wilsonLB ?? null,
      detectedAt: now(), entryTimeMs: signal.at * 1000,
      price: signal.price,
      entry: signal.entry, stop: signal.stop, tp1: signal.tp1, tp2: signal.tp2,
      stopRef: signal.stopRef,
      rr: signal.rr,
      distancePct: Number((((signal.price - signal.tp1) / signal.tp1) * 100).toFixed(3)),
      reasons: signal.reasons,
      phase: 'published',
      outcome: null, outcomeAt: null, outcomePrice: null,
      mfeR: 0, maeR: 0
    };
    opportunities.set(id, opportunity);
    bySymbolTf.set(`${symbol}|${tf}`, opportunity);
    if (opportunities.size > cfg.publishLimit) {
      // إخلاء الأقدم مع وسم سبب — بلا حذف صامت
      const oldest = [...opportunities.values()].sort((a, b) => a.detectedAt - b.detectedAt)[0];
      if (oldest) {
        oldest.outcome = oldest.outcome ?? 'expired';
        oldest.expiredReason = 'إخلاء بسقف النشر';
        opportunities.delete(oldest.id);
        bySymbolTf.delete(`${oldest.symbol}|${oldest.tf}`);
        history.unshift(oldest);
        void persist({ ...oldest, closed: true }).catch(() => undefined);
      }
    }
    status.published += 1;
    status.lastPublishAt = opportunity.detectedAt;
    broadcast({ type: 'strategy2_new', opportunity });
    void persist(opportunity).catch(() => undefined);
    return opportunity;
  }

  /* ---- معالجة رمز/فريم واحد عند إغلاق شمعة ---- */
  async function processSymbolTf(symbol, tf, force = false) {
    try {
      const candles = await getCandles(symbol, tf);
      if (!candles || candles.length < cfg.warmupBars) return;
      const lastOpen = Number(candles[candles.length - 1].timeMs);
      const prev = lastProcessed.get(`${symbol}|${tf}`);
      if (!force && prev === lastOpen) return; // لا شمعة جديدة — لا معالجة
      lastProcessed.set(`${symbol}|${tf}`, lastOpen);

      // فرصة نشطة لنفس الرمز/الفريم → لا إشارة جديدة (سقف 1)
      if (bySymbolTf.has(`${symbol}|${tf}`)) return;

      const price = Number(market?.getPrice?.(symbol)) || Number(candles[candles.length - 1].close);
      const an = analyzeCandles(candles, {
        price, discountPos: cfg.discountPos, bandPct: cfg.bandPct, minRR: cfg.minRR
      });
      status.analyzing += 1;
      clearFailure(`${symbol}|${tf}|analysis`);

      // موت المشوار الصاعد: HTF هابط ووصل bsl خارجي → لا شراء
      if (an.upLegDead) {
        rejected.push({ at: now(), symbol, tf, reason: 'انتهى المشوار الصاعد — لمس bsl/سبلاي خارجي على HTF هابط' });
        return;
      }
      if (an.flow.signal) {
        publish(an, { symbol, tf, signal: an.flow.signal });
      } else {
        // شفافية المراحل: عدّاد المراحل فقط (لا نرّاكم سجلاً ضخماً)
        const ph = an.flow.phase;
        status.waitingPhases[ph] = (status.waitingPhases[ph] ?? 0) + 1;
      }
    } catch (e) {
      bumpFailure(`${symbol}|${tf}|analysis`, e.message);
    }
  }

  /* ---- دورة: فحص إغلاق الشموع عبر المخزن الحي + احتياطي REST ---- */
  async function runCycle() {
    if (status.busy) return { skipped: true };
    status.busy = true;
    const t0 = now();
    try {
      const targets = (await resolveTargets().catch(() => null)) ?? [];
      status.pairsTotal = Math.min(targets.length, cfg.maxSymbols);
      status.cycle += 1;
      const symbols = targets.slice(0, cfg.maxSymbols);

      if (market) {
        const kKeys = [];
        for (const s of symbols) for (const tf of cfg.entryTfs) kKeys.push(`${s}|${tf}`);
        market.setKlineSubscriptions(kKeys, 'strategy2');
      }

      // معالجة متوازية محدودة (تحليل في الذاكرة — البذر REST هو المكلف)
      const CONC = 6;
      let idx = 0;
      const workers = Array.from({ length: CONC }, async () => {
        while (idx < symbols.length) {
          const s = symbols[idx++];
          for (const tf of cfg.entryTfs) await processSymbolTf(s, tf);
        }
      });
      await Promise.all(workers);

      while (rejected.length > 120) rejected.shift();
      status.updatedAt = now();
      status.error = null;
      return { ok: true, cycle: status.cycle, ms: now() - t0 };
    } catch (e) {
      status.error = e.message;
      log.error?.('[strategy2] cycle failed:', e.message);
      return { ok: false, error: e.message };
    } finally {
      status.busy = false;
    }
  }

  /* ---- تتبع النتائج من الأسعار الحية ---- */
  function trackOutcomes() {
    const t = now();
    const pxOf = (symbol) => {
      const viaStream = market?.getPrice?.(symbol);
      if (Number.isFinite(Number(viaStream))) return Number(viaStream);
      return Number(lastPrices?.[symbol]);
    };
    let changed = false;
    for (const [id, op] of [...opportunities]) {
      if (op.outcome) continue;
      const px = pxOf(op.symbol);
      if (!Number.isFinite(px)) continue;
      const risk = Math.max(op.entry - op.stop, 1e-12);
      const exc = (px - op.entry) / risk;
      op.mfeR = Math.max(op.mfeR ?? 0, exc);
      op.maeR = Math.min(op.maeR ?? 0, exc);
      const ageBars = (t - op.entryTimeMs) / Math.max(tfMs(op.tf), 1);
      if (px <= op.stopRef) {
        op.outcome = 'invalidated'; // كسر قاع السويب قبل الهدف — فشل نقطة الدخول
      } else if (px <= op.stop) {
        op.outcome = 'stop';
      } else if (op.tp2 != null && px >= op.tp2) {
        op.outcome = 'target2';
      } else if (px >= op.tp1) {
        op.outcome = 'target';
      } else if (ageBars > cfg.maxHoldBars) {
        op.outcome = 'expired';
      }
      if (op.outcome) {
        op.outcomeAt = t; op.outcomePrice = px;
        op.durationMs = t - op.detectedAt;
        const win = op.outcome === 'target' || op.outcome === 'target2';
        if (win) status.wins += 1; else if (op.outcome === 'stop' || op.outcome === 'invalidated') status.losses += 1;
        status.resolved += 1;
        const sk = op.segmentKey;
        const st2 = liveStats.get(sk) ?? { trades: 0, wins: 0 };
        st2.trades += 1;
        if (win) st2.wins += 1;
        liveStats.set(sk, st2);
        broadcast({ type: 'strategy2_closed', opportunity: op });
        void persist({ ...op, closed: true }).catch(() => undefined);
        history.unshift(op);
        opportunities.delete(id);
        bySymbolTf.delete(`${op.symbol}|${op.tf}`);
        changed = true;
      }
    }
    while (history.length > cfg.historyLimit) history.pop();
    return changed;
  }

  /* ---- نبضة لحظية للواجهة ---- */
  function tickFeed() {
    if (running) trackOutcomes();
    const t = now();
    const rows = [];
    for (const op of opportunities.values()) {
      const px = Number(market?.getPrice?.(op.symbol)) || Number(lastPrices?.[op.symbol]);
      rows.push({
        id: op.id, symbol: op.symbol, tf: op.tf, price: Number.isFinite(px) ? px : null,
        plPct: Number.isFinite(px) ? Number((((px - op.entry) / op.entry) * 100).toFixed(3)) : null,
        toTp1Pct: Number.isFinite(px) ? Number((((op.tp1 - px) / px) * 100).toFixed(3)) : null,
        rNow: Number.isFinite(px) ? Number((((px - op.entry) / Math.max(op.entry - op.stop, 1e-12))).toFixed(3)) : null,
        mfeR: Number((op.mfeR ?? 0).toFixed(3)),
        ageSec: Math.round((t - op.detectedAt) / 1000)
      });
    }
    if (rows.length) broadcast({ type: 'strategy2_tick', at: t, opportunities: rows });
  }

  /* ---- معايرة walk-forward: نفس النواة على التاريخ ---- */
  async function runCalibration({ symbols = null } = {}) {
    if (calibration.busy) return { skipped: true };
    calibration.busy = true;
    calibration.error = null;
    try {
      const all = symbols ?? (await resolveTargets().catch(() => []) ?? []).slice(0, cfg.calibration.symbols);
      const tasks = [];
      for (const symbol of all) for (const tf of cfg.entryTfs) tasks.push({ symbol, tf });
      calibration.progress = { done: 0, total: tasks.length };
      let active = 0;
      const trades = [];
      const runTask = async ({ symbol, tf }) => {
        try {
          const raw = await fetchRawKlines(symbol, tf, cfg.calibration.bars).catch(() => null);
          if (raw && raw.length > 300) {
            const candles = raw.map(k => ({
              time: Math.floor(Number(k[0]) / 1000), timeMs: Number(k[0]),
              open: Number(k[1]), high: Number(k[2]), low: Number(k[3]), close: Number(k[4]), volume: Number(k[5])
            }));
            // إعادة تشغيل النواة: تقييم عند كل شمعة إغلاق مرشحة (نموذج شمعتين/صعود قوي)
            const warm = cfg.warmupBars;
            for (let i = warm; i < candles.length - 1; i += 1) {
              const last = candles[i], prev = candles[i - 1];
              const strongUp = Number(last.close) > Number(prev.high);
              if (!isBullishPair(prev, last) && !strongUp) continue;
              const win = candles.slice(Math.max(0, i - cfg.analysisWindow), i + 1);
              const an = analyzeCandles(win, {
                price: Number(last.close), discountPos: cfg.discountPos,
                bandPct: cfg.bandPct, minRR: cfg.minRR
              });
              if (!an.flow.signal) continue;
              // حسم تاريخي: مشي أمامي حتى الهدف/الوقف/الانتهاء
              const sig = an.flow.signal;
              let outcome = 'undecided', exitPx = null, bars = 0;
              for (let j = i + 1; j < Math.min(i + 1 + cfg.maxHoldBars, candles.length); j += 1) {
                const c = candles[j];
                bars = j - i;
                if (Number(c.low) <= sig.stopRef) { outcome = 'invalidated'; exitPx = sig.stopRef; break; }
                if (Number(c.low) <= sig.stop) { outcome = 'stop'; exitPx = sig.stop; break; }
                if (sig.tp2 != null && Number(c.high) >= sig.tp2) { outcome = 'target2'; exitPx = sig.tp2; break; }
                if (Number(c.high) >= sig.tp1) { outcome = 'target'; exitPx = sig.tp1; break; }
              }
              trades.push({
                tf, htfDir: an.htf.direction ?? 'all', model: sig.model,
                win: outcome === 'target' || outcome === 'target2' ? 1 : (outcome === 'undecided' ? null : 0),
                rr: sig.rr, bars, ts: sig.at * 1000
              });
            }
          }
        } catch { /* زوج فاشل لا يوقف المعايرة */ }
        calibration.progress.done += 1;
        if (calibration.progress.done % 5 === 0 || calibration.progress.done === calibration.progress.total) {
          broadcast({ type: 'strategy2_calibration_progress', ...calibration.progress });
        }
        await sleep(150);
      };
      const workers = Array.from({ length: cfg.calibration.concurrency }, async () => {
        while (tasks.length) {
          const t = tasks.shift();
          if (!t) break;
          await runTask(t);
        }
      });
      await Promise.all(workers);

      const rows = summarizeSegmentsForEngine(trades);
      segments.clear();
      for (const r of rows) segments.set(r.key, r);
      calibration.at = now();
      calibration.trades = trades.filter(x => x.win === 0 || x.win === 1).length;
      calibration.segments = rows;
      calibration.progress = null;
      calibration.samplePairs = all.length;
      broadcast({ type: 'strategy2_calibration_done', segments: rows.length, trades: calibration.trades });
      void persist({ type: 'strategy2_calibration', at: calibration.at, trades: calibration.trades, segments: rows }).catch(() => undefined);
      log.log?.(`[strategy2] calibration: ${rows.length} segments / ${calibration.trades} trades`);
      return { ok: true, segments: rows.length, trades: calibration.trades };
    } catch (e) {
      calibration.error = e.message;
      calibration.progress = null;
      log.error?.('[strategy2] calibration failed:', e.stack ?? e.message);
      return { ok: false, error: e.message };
    } finally {
      calibration.busy = false;
    }
  }

  /** شرائح الاستراتيجية — تفويض للدالة النقية المصدَّرة على مستوى الوحدة */
  function summarizeSegmentsForEngine(trades, opts = {}) {
    return summarizeStrategySegments(trades, {
      targetWinRate: cfg.targetWinRate,
      minTrades: cfg.minSegmentTrades,
      ...opts
    });
  }

  /* ---- الاستمرارية: استعادة + تسوية فجوة ---- */
  async function restoreFromEvents() {
    try {
      const events = await readPublishedEvents();
      if (!Array.isArray(events) || !events.length) return;
      const resolvedIds = new Set(events.filter(e => e.kind === 'resolved').map(e => e.id));
      const published = events.filter(e => e.kind === 'published' && e.id && !resolvedIds.has(e.id));
      for (const e of published) {
        if (opportunities.has(e.id)) continue;
        const op = {
          id: e.id, symbol: e.symbol, tf: e.timeframe ?? e.tf, model: e.model ?? null,
          htfDirection: e.htfDirection ?? null, afterPremium: e.afterPremium ?? null,
          tier: e.tier ?? null, segmentKey: e.segmentKey ?? null,
          detectedAt: e.detectedAt ?? e.ts, entryTimeMs: e.entryTimeMs ?? (e.detectedAt ?? e.ts),
          price: e.price ?? e.entry, entry: e.entry, stop: e.stop, tp1: e.tp1 ?? e.tp, tp2: e.tp2 ?? null,
          stopRef: e.stopRef ?? e.stop,
          rr: e.rr ?? null, reasons: e.reasons ?? [],
          restored: true, outcome: null, outcomeAt: null, outcomePrice: null, mfeR: 0, maeR: 0
        };
        if (!Number.isFinite(Number(op.entry)) || !Number.isFinite(Number(op.stop))) continue;
        opportunities.set(op.id, op);
        bySymbolTf.set(`${op.symbol}|${op.tf}`, op);
        status.restored += 1;
      }
      log.log?.(`[strategy2] restored ${status.restored} opportunities from events`);
    } catch (e) {
      log.warn?.(`[strategy2] restore failed: ${e.message}`);
    }
  }

  /** تسوية الفجوة: شموع فترة التوقف تحسم TP/SL أثناء الغياب */
  async function reconcileGap() {
    for (const op of [...opportunities.values()]) {
      if (op.outcome) continue;
      try {
        const raw = await fetchRawKlines(op.symbol, op.tf, 300, op.detectedAt - 60_000).catch(() => null);
        if (!raw || !raw.length) continue;
        const candles = raw.map(k => ({
          time: Math.floor(Number(k[0]) / 1000), timeMs: Number(k[0]),
          open: Number(k[1]), high: Number(k[2]), low: Number(k[3]), close: Number(k[4])
        }));
        let outcome = null, exitPx = null;
        for (const c of candles) {
          if (Number(c.timeMs) < op.detectedAt) continue;
          if (Number(c.low) <= op.stopRef) { outcome = 'invalidated'; exitPx = op.stopRef; break; }
          if (Number(c.low) <= op.stop) { outcome = 'stop'; exitPx = op.stop; break; }
          if (op.tp2 != null && Number(c.high) >= op.tp2) { outcome = 'target2'; exitPx = op.tp2; break; }
          if (Number(c.high) >= op.tp1) { outcome = 'target'; exitPx = op.tp1; break; }
        }
        if (outcome) {
          op.outcome = outcome; op.outcomeAt = now(); op.outcomePrice = exitPx;
          op.durationMs = now() - op.detectedAt;
          op.reconciled = true;
          const win = outcome === 'target' || outcome === 'target2';
          if (win) status.wins += 1; else if (outcome === 'stop' || outcome === 'invalidated') status.losses += 1;
          status.resolved += 1; status.reconciled += 1;
          broadcast({ type: 'strategy2_closed', opportunity: op });
          void persist({ ...op, closed: true }).catch(() => undefined);
          history.unshift(op);
          opportunities.delete(op.id);
          bySymbolTf.delete(`${op.symbol}|${op.tf}`);
        }
      } catch { /* فجوة فاشلة تُعاد لاحقاً */ }
    }
  }

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

  /* ---- القوائم للواجهة (فلترة خادمية قبل القص) ---- */
  function getFeed() {
    const ops = [...opportunities.values()].sort((a, b) =>
      (b.model ?? 0) - (a.model ?? 0) || b.detectedAt - a.detectedAt);
    const decided = status.wins + status.losses;
    return {
      busy: status.busy, cycle: status.cycle, scope: status.scope,
      pairsTotal: status.pairsTotal, analyzing: status.analyzing,
      waitingPhases: status.waitingPhases,
      updatedAt: status.updatedAt, error: status.error,
      opportunities: ops,
      total: ops.length,
      rejected: rejected.slice(-40).reverse(),
      failures: [...failures.entries()].slice(0, 50).map(([key, f]) => ({ key, ...f })),
      stats: {
        published: status.published, resolved: status.resolved,
        wins: status.wins, losses: status.losses,
        liveWinRate: decided ? Number((status.wins / decided).toFixed(3)) : null,
        restored: status.restored, reconciled: status.reconciled
      },
      calibration: {
        at: calibration.at, busy: calibration.busy, trades: calibration.trades,
        progress: calibration.progress, segments: calibration.segments,
        samplePairs: calibration.samplePairs, error: calibration.error,
        targetWinRate: cfg.targetWinRate
      }
    };
  }

  /** فلترة + ترتيب + قص على الخادم — قبل أي قص تُطبَّق الفلاتر على كامل المجموعة */
  function queryFeed({ symbol = '', tf = '', model = '', tier = '', htfDir = '', sort = 'recent', limit = 100, offset = 0 } = {}) {
    let rows = [...opportunities.values()];
    const sym = String(symbol).trim().toUpperCase();
    if (sym) rows = rows.filter(o => o.symbol.includes(sym));
    if (tf) rows = rows.filter(o => o.tf === tf);
    if (model) rows = rows.filter(o => String(o.model) === String(model));
    if (tier) rows = rows.filter(o => (o.tier ?? 'probationary') === tier);
    if (htfDir) rows = rows.filter(o => o.htfDirection === htfDir);
    if (sort === 'rr') rows.sort((a, b) => (b.rr ?? 0) - (a.rr ?? 0));
    else if (sort === 'distance') rows.sort((a, b) => Math.abs(a.distancePct ?? 0) - Math.abs(b.distancePct ?? 0));
    else rows.sort((a, b) => b.detectedAt - a.detectedAt);
    const total = rows.length;
    const offsetN = Math.max(0, Number(offset) || 0);
    return { rows: rows.slice(offsetN, offsetN + Math.min(Number(limit) || 100, 500)), total };
  }

  function getStatus() {
    return {
      busy: status.busy, cycle: status.cycle, scope: status.scope,
      pairsTotal: status.pairsTotal, analyzing: status.analyzing,
      waitingPhases: status.waitingPhases,
      updatedAt: status.updatedAt, error: status.error,
      entryTfs: cfg.entryTfs,
      market: market?.stats?.() ?? null,
      limiter: null,
      failures: [...failures.entries()].slice(0, 50).map(([key, f]) => ({ key, ...f })),
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
      samplePairs: calibration.samplePairs,
      targetWinRate: cfg.targetWinRate, minSegmentTrades: cfg.minSegmentTrades
    };
  }

  /* ---- إغلاق شمعة → معالجة فورية ---- */
  function onCandleClosed(symbol, tf) {
    if (!cfg.entryTfs.includes(tf)) return;
    const t = now();
    if (t - lastFastAt < 800) return;
    lastFastAt = t;
    if (!status.busy) void processSymbolTf(symbol, tf);
  }

  function start() {
    if (running) return;
    running = true;
    if (market?.onCandleClose) unsubClose = market.onCandleClose(onCandleClosed);
    void (async () => {
      await loadCalibration();
      await restoreFromEvents();
      await reconcileGap();
    })();
    cycleTimer = setInterval(() => { void runCycle(); }, cfg.cycleMs);
    tickTimer = setInterval(tickFeed, cfg.tickMs);
    calibTimer = setInterval(() => { void runCalibration(); }, cfg.calibrationMs);
    if (cycleTimer.unref) cycleTimer.unref();
    if (tickTimer.unref) tickTimer.unref();
    if (calibTimer.unref) calibTimer.unref();
    void runCycle();
  }

  function stop() {
    running = false;
    if (cycleTimer) clearInterval(cycleTimer);
    if (tickTimer) clearInterval(tickTimer);
    if (calibTimer) clearInterval(calibTimer);
    if (unsubClose) { unsubClose(); unsubClose = null; }
    cycleTimer = tickTimer = calibTimer = null;
  }

  return {
    start, stop, runCycle, runCalibration, restoreFromEvents, reconcileGap,
    getFeed, getStatus, getHistory, getCalibration, queryFeed,
    _internals: { opportunities, segments, liveStats, rejected, failures, status, calibration, cfg, lastProcessed }
  };
}
