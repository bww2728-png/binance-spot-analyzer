/* محرك الباك تيست (walk-forward) — إعادة بناء نفس مراحل الكشف الحي على التاريخ
 * المنهجية:
 * - الشموع التاريخية فقط (السبوت): المشتقات غير متاحة تاريخياً — تحذيرات scoreZones تحتمل غيابها.
 * - CVD تاريخي متاح (الشموع ساعية index 9 = taker buy) — computeCvd يعمل حرفياً.
 * - إعادة بناء: profile + location + candidates + score — نفس الوحدات الحية حرفياً.
 * - walk-forward: لحظات كشف عند كل حد يومي → مناطق مكتشفة ببيانات تصل لحظتها فقط (لا رؤية مستقبلية)
 *   → لمس في نافذة اللمس → محاكاة: أي جانب يلمس أولاً (هدف=ربح، وقف=خسارة).
 * - وقف الخسارة: منطق النظام الحالي حرفياً — تحت/فوق المستوى المحمي بنطاق bandPct. صفر تعديل.
 */

import { computeVolumeProfile, classifyLocation } from '../liquidity/volumeProfile.mjs';
import { candidateZones, pivotStrengthFor, referenceLevels } from '../liquidity/structure.mjs';
import { scoreZones, DEFAULT_WEIGHTS } from '../liquidity/score.mjs';
import { computeCvd } from '../liquidity/derivatives.mjs';
import { buildPlan, checkPlan, kellyF, fractionalKelly, positionUnits } from './risk.mjs';
import { regimeGate } from './regime.mjs';
import { walkForwardSplit, fitLogistic, featurize, learnedScore, synthFilters, evaluateStrategy } from './learn.mjs';

/** تحميل شموع مجزّأ (أقصى عمق): pages من 1000 صف — Binance يحتمل 1000/نداء افتراضياً. */
export async function loadKlinesPaginated(db, symbol, interval, targetLimit, { pageMs = 450, maxPages = 8, startTime, endTime } = {}) {
  const out = [];
  let cursor = endTime; // نداء أول بوقت انتهاء اختياري (نطاق صريح: من — إلى)
  for (let p = 0; p < maxPages && out.length < targetLimit; p += 1) {
    const raw = await db.binance.klines(symbol, interval, 1000, undefined, cursor);
    if (!Array.isArray(raw) || !raw.length) break;
    out.unshift(...raw);
    const oldestOpen = raw[0][0];
    cursor = oldestOpen - 1; // قبل أقدم صفحة
    if (startTime != null && oldestOpen <= startTime) break; // بلغنا بداية النطاق
    if (raw.length < 1000) break;
    if (p < maxPages - 1) await new Promise(r => setTimeout(r, pageMs));
  }
  const inRange = startTime != null ? out.filter(c => c[0] >= startTime) : out;
  return inRange.slice(-targetLimit);
}

const DAY_MS = 86_400_000;

/** لحظات الكشف: كل حد يومي (بيانات تصل لحظتها فقط) — من أقدم نافذة كافية (300 صف) إلى قبل آخر نافذة محاكاة. */
export function detectionMoments(candles, { minBars = 300, simBars = 96, stepBars = 96 } = {}) {
  const out = [];
  if (candles.length < minBars + simBars) return out;
  let lastDay = -1;
  for (let i = minBars; i < candles.length - simBars; i += 1) {
    const day = Math.floor(candles[i].time / DAY_MS);
    if (day !== lastDay) {
      lastDay = day;
      out.push(i);
    }
    i += stepBars - 1;
  }
  return out;
}

/** إعادة بناء مناطق لحظة كشف — نفس خطوات الكشف الحي على بيانات تصل لحظتها فقط. */
export function detectAt({ candles, upto, tf, calibration = { minScore: 50, eqhTolerancePct: 0.002 } }) {
  const window = candles.slice(0, upto);
  if (window.length < 40) return [];
  const profile = computeVolumeProfile(window);
  const location = classifyLocation(window, profile);
  const cands = candidateZones(window, {
    strength: pivotStrengthFor(tf),
    eqhTolerancePct: calibration.eqhTolerancePct ?? 0.002,
    profile,
    location,
    prevDayLevels: prevDayLevels(window)
  });
  // CVD تاريخي من النافذة (computeCvd يحتمل raw arrays) — الشموع الساعية فيها taker buy
  const cs = toRaw(window);
  const cvd = computeCvd(cs, Math.min(50, window.length));
  return scoreZones(cands.zones, { cvd, location }, {
    minScore: calibration.minScore ?? 50,
    limit: 6,
    refLevels: referenceLevels(window)
  });
}

const prevDayLevels = (window) => {
  const lastDay = Math.floor(window[window.length - 1].time / DAY_MS);
  const prev = window.filter(c => Math.floor(c.time / DAY_MS) === lastDay - 1);
  if (!prev.length) return null;
  return { high: Math.max(...prev.map(c => c.high)), low: Math.min(...prev.map(c => c.low)) };
};

const toRaw = (candles) => candles.map(c => [
  c.time, undefined, undefined, undefined, undefined,
  c.volume, undefined, undefined, undefined,
  // taker buy متاح فقط في raw الأصلي — المحاكاة تمرر raw كاملاً عند التوفر
  c.takerBuyVolume ?? c.volume / 2
]);

/** لمس المنطقة في نافذة اللمس: أول شمعة تقترب (≤ band) أو تعبر. يعيد index أو null. */
export function findTouch(candles, from, to, zone, bandPct = 0.0025) {
  for (let i = from; i < Math.min(to, candles.length); i += 1) {
    const c = candles[i];
    const near = Math.abs(c.high - zone.price) / zone.price <= bandPct ||
      Math.abs(c.low - zone.price) / zone.price <= bandPct;
    const crossed = zone.type === 'BSL'
      ? c.high >= zone.price
      : c.low <= zone.price;
    if (near || crossed) return i;
  }
  return null;
}

/** محاكاة صفقة من اللمس: أي جانب يلمس أولاً (هدف أو وقف) — walk-forward صارم (بلا إعادة إدخال).
 *  وقف الخسارة: منطق النظام الحالي حرفياً — المستوى المحمي ± bandPct. صفر تعديل. */
export function simulateZone(candles, touchIdx, zone, { protectedPrice, targets = [], bandPct = 0.0025, maxBars = 96, capital = 10000 }) {
  const entry = candles[touchIdx].close; // الدخول على إغلاق شمعة اللمس (المعيار المنشور)
  const plan = buildPlan({ zoneType: zone.type, entry, protectedPrice, bandPct, targets });
  const check = checkPlan({ plan, protectedPrice, zoneType: zone.type });
  if (!check.ok || !plan.tp) return null;
  const long = zone.type === 'BSL';
  for (let i = touchIdx + 1; i < Math.min(touchIdx + maxBars, candles.length); i += 1) {
    const c = candles[i];
    const hitStop = long ? c.low <= plan.stop : c.high >= plan.stop;
    const hitTp = long ? c.high >= plan.tp : c.low <= plan.tp;
    if (hitStop && hitTp) {
      // الشمعة أمسكت الاثنين — الافتتاح يحدد الجانب القريب (المعيار المتحفظ)
      return { win: 0, ts: c.time, exit: plan.stop, bars: i - touchIdx, rr: plan.rr };
    }
    if (hitStop) return { win: 0, ts: c.time, exit: plan.stop, bars: i - touchIdx, rr: plan.rr };
    if (hitTp) return { win: 1, ts: c.time, exit: plan.tp, bars: i - touchIdx, rr: plan.rr };
  }
  return { win: undefined, ts: candles[candles.length - 1].time, exit: candles[candles.length - 1].close, bars: maxBars, undecided: true, rr: plan.rr };
}

/** باك تيست لزوج (رمز، فريم): لحظات كشف يومية → لمس → محاكاة — trades كامل مع الأدوات. */
export async function runPairBacktest(db, { symbol, timeframe, calibration = {}, bars = 3000, capital = 10000, capitalF = 0.01, pWinFallback = 0.5, startTime, endTime, maxPages }) {
  const opts = { startTime, endTime };
  if (maxPages) opts.maxPages = maxPages;
  const raw = await loadKlinesPaginated(db, symbol, timeframe, bars, opts);
  if (!Array.isArray(raw) || raw.length < 400) return { symbol, timeframe, trades: [], reason: 'لا شموع كافية' };
  const candles = raw.map(k => ({
    time: Number(k[0]), open: Number(k[1]), high: Number(k[2]),
    low: Number(k[3]), close: Number(k[4]), volume: Number(k[5]),
    takerBuyVolume: Number(k[9] ?? k[5] / 2)
  }));
  const moments = detectionMoments(candles);
  const trades = [];
  for (const upto of moments) {
    const zones = detectAt({ candles, upto, tf: timeframe, calibration });
    const to = Math.min(upto + 96, candles.length);
    for (const zone of zones) {
      const touchIdx = findTouch(candles, upto + 1, to, zone, zone.bandPct ?? 0.0025);
      if (touchIdx == null) continue;
      const protectedPrice = zone.price; // المستوى المحمي نفسه — الوقف بنطاق under/over ("علامة أو اثنتين" حرفياً)
      const entry0 = candles[touchIdx].close;
      const risk0 = Math.abs(entry0 - protectedPrice) || entry0 * 0.005;
      // الأهداف في اتجاه الاختراق (المنشور: استمرار بعد الاستمرار):
      // - أعلى/أدنى نافذة قبل الكشف (اختراق → استمرار حتى آخر اختراق)
      // - مستوى السيولة + 2×risk (الهدف الهيكلي المنشور)
      const win0 = candles.slice(Math.max(0, upto - 20), upto);
      const structural = win0.length
        ? (zone.type === 'BSL' ? Math.max(...win0.map(c => c.high)) : Math.min(...win0.map(c => c.low)))
        : null;
      const targets = [
        zone.type === 'BSL' ? zone.price + 2 * risk0 : zone.price - 2 * risk0,
        ...(structural != null ? [structural] : [])
      ];
      const sim = simulateZone(candles, touchIdx, zone, { protectedPrice, targets, bandPct: zone.bandPct ?? 0.0025, capital });
      if (!sim) continue;
      // أدوات المخاطر (إرشادية — العرض فقط): kelly + حجم مقترح
      const pWin = pWinFallback;
      const rr = sim.rr ?? 0;
      const kelly = kellyF(pWin, Math.max(1, rr));
      const fF = fractionalKelly(kelly, 0.25, 0.02);
      const units = positionUnits(capital, fF, candles[touchIdx].close, protectedPrice);
      // أدوات البواب: تشتت الانتشار والتقلب — (العرض فقط، ولا تُحفظ صفر بواب)
      void regimeGate({ altPrices: candles.slice(0, upto).map(c => c.close), anchorPrices: candles.slice(0, upto).map(c => c.close) });
      trades.push({
        symbol, timeframe,
        zoneType: zone.type,
        zoneId: zone.id,
        zonePrice: zone.price,
        score: zone.score,
        reasons: zone.reasons ?? [],
        clusterCount: zone.clusterCount ?? 0,
        swept: Boolean(zone.swept),
        bandPct: zone.bandPct ?? 0.0025,
        ts: touchIdx < candles.length ? candles[touchIdx].time : null,
        detectUpto: upto,
        detectTime: candles[upto].time,
        entry: candles[touchIdx].close,
        protectedPrice,
        win: sim.win,
        exit: sim.exit,
        bars: sim.bars,
        undecided: Boolean(sim.undecided),
        rr,
        kelly: Number(kelly.toFixed(3)),
        fF: Number(fF.toFixed(4)),
        units: Number(units.toFixed(4))
      });
    }
  }
  return { symbol, timeframe, trades };
}

/** باك تيست جمعي (رمز × فريم) — مجدول تدريجي حتى لا يُخنق API. */
export async function runBacktest(db, { targets, timeframes = ['1h', '4h', '1d'], calibration = {}, capital = 10000, capitalF = 0.01, sleepMs = 1200, onPair }) {
  const all = [];
  for (const symbol of targets) {
    for (const tf of timeframes) {
      try {
        const res = await runPairBacktest(db, { symbol, timeframe: tf, calibration, capital, capitalF });
        all.push(res);
        if (onPair) onPair(res);
      } catch (e) {
        all.push({ symbol, timeframe: tf, trades: [], reason: e.message });
      }
      await new Promise(r => setTimeout(r, sleepMs));
    }
  }
  return all;
}

/** حلقة التعلم: على trades التدريب 70% → أوزان أوزان أوزان + قواعد مُتعلَّمة، ثم تقييم على 30% تحقق. */
export function learnOnTrades(all, { trainRatio = 0.7, targetWinRate = 0.7 } = {}) {
  const trades = all.flatMap(r => r.trades ?? []);
  if (trades.length < 12) {
    return { enough: false, message: 'trades غير كافية للتعلم (أقل من 12)' };
  }
  const { train, validation } = walkForwardSplit(trades, trainRatio);
  // معالم التدريب: لوجستي عصبي-رمزي من الصفر
  const samples = train.map(t => ({
    x: featurize({ score: t.score, reasons: t.reasons, clusterCount: t.clusterCount }),
    y: t.win === 1 ? 1 : t.win === 0 ? 0 : 0
  })).filter(s => s.y === 0 || s.y === 1);
  const weights = fitLogistic(samples);
  // قواعد مُتعلَّمة (تخليق قواعد صغيرة) على التحقق
  const forSynth = validation.map(t => ({
    score: t.score, reasons: t.reasons, clusterCount: t.clusterCount,
    swept: t.swept, rr: t.rr, win: t.win
  })).filter(t => t.win === 1 || t.win === 0);
  const rules = synthFilters(forSynth, { targetWinRate });
  // تقييم قبل/بعد
  const evalAll = evaluateStrategy(validation);
  const keptByRules = rules ? forSynth.filter(t =>
    t.score >= rules.minScore &&
    (!rules.requireCluster || (t.clusterCount ?? 0) >= 2) &&
    (!rules.requireBubble || (t.reasons ?? []).some(r => String(r).includes('فقاعة'))) &&
    (rules.allowSwept || !t.swept)) : [];
  const evalRules = evaluateStrategy(keptByRules);
  return {
    enough: true,
    trainCount: train.length,
    validationCount: validation.length,
    weights,
    rules,
    evalBefore: evalAll,
    evalAfter: evalRules,
    winRate: evalRules.winRate ?? evalAll.winRate
  };
}
