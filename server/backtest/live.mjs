/* محرك الفرص الحية (مستقل) — كشف المناطق الحالية بنفس الوحدات الحية حرفياً
 * المنهجية:
 * - 500 شمعة لكل زوج (نمط الكشف الحي المعمول به — نداء واحد) — يلف بالتوازي مع المحركات الأخرى.
 * - المناطق الحالية (النافذة الكاملة، لا لحظات تاريخية): المكتشفة الآن ولم تُسحب = فرصة حية.
 * - الخطة: نفس خطوات الباك تيست حرفياً — دخول على الإغلاق، وقف تحت/فوق المستوى المحمي بنطاق
 *   (صفر تعديل على منطق الوقف)، أهداف في اتجاه الاختراق، rr/كلي/كلي مجزأ/حجم — العرض فقط.
 * - المسافة الحالية من المنطقة + قرار الاستدلال النشط (طاقة حرة متوقعة): دخول / انتظار / تخطي.
 * - تطبيق قواعد المتعلم (الدوري يتعلم، محرك الفرص يطبّق).
 */

import { buildPlan, checkPlan, kellyF, fractionalKelly, positionUnits } from './risk.mjs';
import { activeDecision } from './learn.mjs';
import { detectAt } from './engine.mjs';

/** تطبيق قواعد المتعلم على فرق — حتمي بلا شبكة. */
export function applyLearnedRules(list, rules) {
  if (!rules || typeof rules.minScore !== 'number') return list;
  return list.filter(x =>
    x.score >= rules.minScore &&
    (!rules.requireCluster || (x.clusterCount ?? 0) >= 2) &&
    (!rules.requireBubble || (x.reasons ?? []).some(r => String(r).includes('فقاعة'))) &&
    (rules.allowSwept || !x.swept));
}

/** لفة فرز لزوج: 500 شمعة → مناطق حالية → فرق حية بخطة كاملة. */
export async function discoverLiveOpportunities(db, { symbol, timeframe, calibration = {}, bars = 500, learnedRules = null, price = null, capital = 10000, pWinFallback = 0.5 }) {
  const raw = await db.binance.klines(symbol, timeframe, bars);
  if (!Array.isArray(raw) || raw.length < 60) return { symbol, timeframe, opportunities: [], reason: 'شموع غير كافية' };
  const candles = raw.map(k => ({
    time: Number(k[0]), open: Number(k[1]), high: Number(k[2]),
    low: Number(k[3]), close: Number(k[4]), volume: Number(k[5]),
    takerBuyVolume: Number(k[9] ?? k[5] / 2)
  }));
  const upto = candles.length;
  const zones = detectAt({ candles, upto, tf: timeframe, calibration });
  const last = candles[candles.length - 1];
  const px = price != null ? Number(price) : last.close;
  const opportunities = [];
  for (const zone of zones) {
    if (zone.swept) continue; // المُسحبة ليست حية
    const dist = Math.abs(px - zone.price) / zone.price;
    // الأهداف في اتجاه الاختراق (نفس خطوات الباك تيست حرفياً):
    const risk0 = Math.abs(last.close - zone.price) || last.close * 0.005;
    const win0 = candles.slice(Math.max(0, upto - 20), upto);
    const structural = win0.length
      ? (zone.type === 'BSL' ? Math.max(...win0.map(c => c.high)) : Math.min(...win0.map(c => c.low)))
      : null;
    const targets = [
      zone.type === 'BSL' ? zone.price + 2 * risk0 : zone.price - 2 * risk0,
      ...(structural != null ? [structural] : [])
    ];
    const protectedPrice = zone.price; // المستوى المحمي نفسه — الوقف بنطاق under/over ("علامة أو اثنتين" حرفياً)
    const entry = last.close; // الدخول على الإغلاق (المعيار المنشور)
    const plan = buildPlan({ zoneType: zone.type, entry, protectedPrice, bandPct: zone.bandPct ?? 0.0025, targets });
    const check = checkPlan({ plan, protectedPrice, zoneType: zone.type });
    if (!check.ok || !plan.tp) continue;
    // payoff: مسافة الهدف / مسافة الوقف — دلالات الاستراتيجية النهائية نفسها
    const risk = Math.abs(entry - plan.stop) || entry * 0.005;
    const reward = Math.abs(plan.tp - entry);
    const payoff = reward / risk;
    const decision = activeDecision({ pWin: pWinFallback, payoff });
    const kelly = kellyF(pWinFallback, Math.max(1, payoff));
    const fF = fractionalKelly(kelly, 0.25, 0.02);
    const units = positionUnits(capital, fF, entry, protectedPrice);
    opportunities.push({
      symbol, timeframe,
      zoneType: zone.type,
      zoneId: zone.id,
      zonePrice: zone.price,
      score: zone.score,
      reasons: zone.reasons ?? [],
      clusterCount: zone.clusterCount ?? 0,
      swept: Boolean(zone.swept),
      bandPct: zone.bandPct ?? 0.0025,
      ts: last.time,
      price: px,
      entry,
      stop: plan.stop,
      tp: plan.tp,
      protectedPrice,
      distPct: Number((dist * 100).toFixed(3)),
      rr: Number(payoff.toFixed(3)),
      kelly: Number(kelly.toFixed(3)),
      fF: Number(fF.toFixed(4)),
      units: Number(units.toFixed(4)),
      targets,
      decision
    });
  }
  return { symbol, timeframe, opportunities: applyLearnedRules(opportunities, learnedRules) };
}
