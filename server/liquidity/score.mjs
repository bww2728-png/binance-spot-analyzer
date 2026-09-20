/* محرك الدرجات: يحوّل مرشحات الهيكل + إشارات الطبقات → مناطق بدرجة 0-100 وأسباب
 * حتمي بالكامل — نفس المدخلات تعطي نفس المخرجات.
 */

import { isRoundNumber, referenceLevels } from './structure.mjs';
import { nearestLiqCluster } from './orderbook.mjs';

export const DEFAULT_WEIGHTS = {
  pivotBase: 35,
  clusterEach: 12,      // لكل قمة إضافية في عنقود EQH/EQL (بحد 24)
  clusterCap: 24,
  fvgBonus: 10,
  oiBonus: 10,
  fundingBonus: 8,
  longShortBonus: 5,
  cvdBonus: 10,
  liqMapBonus: 12,
  roundBonus: 5,
  refLevelBonus: 8,
  imbalanceBonus: 6,
  icebergBonus: 8,
  spoofBonus: 6,
  /* أوزان منطق المزاد (فابيو) — أين تستريح السيولة وأين يخترق السعر بلا احتكاك */
  profileEdgeWeight: 14,    // حافة منطقة القيمة (VAH/VAL) — بركة سيولة معلقة
  profileLvnWeight: 12,     // عقدة حجم منخفض — استمرار خلف الكسر
  prevDayWeight: 14,        // قمة/قاع اليوم السابق
  locationWeight: 10,       // توافق المنطقة مع حالة المزاد
  bubbleWeight: 12,         // فقاعة أوامر عدوانية باتجاه المنطقة
  sessionBonus: 6,          // جلسة ندرة حادة (تداخل لندن-نيويورك)
  sessionPenalty: 8         // فتكة سيولة موثوقة
};

const near = (price, level, pct) => Math.abs(price - level) / level <= pct;

/**
 * يبني مناطق نهائية من مرشحات الهيكل مع الإشارات.
 * candidates: ناتج candidateZones لفريم واحد.
 * signals: {oi, funding, longShort, cvd, book, icebergs, spoofs, liqClusters}
 */
export function scoreZones(candidates, signals, {
  weights = DEFAULT_WEIGHTS,
  minScore = 50,
  limit = 15,
  refLevels = null
} = {}) {
  const out = [];
  for (const c of candidates) {
    let score = weights.pivotBase;
    const reasons = [];

    // عنقود القمم/القيعان المتساوية
    if (c.clusterCount >= 2) {
      const bonus = Math.min(weights.clusterCap, weights.clusterEach * (c.clusterCount - 1));
      score += bonus;
      reasons.push(`${c.clusterCount === 2 ? 'قمتان/قاعان متساويان (EQH/EQL)' : `عنقود ${c.clusterCount} نقاط متساوية`}`);
    }

    /* ---- مناطق المزاد (فابيو): منطقة المزاد مشتقة من الملف الحجمي ومراسله ---- */
    if (c.meta === 'profile_edge') {
      score += weights.profileEdgeWeight;
      reasons.push(c.side === 'high' ? 'حافة منطقة القيمة عالية (VAH) — سيولة شرائية معلقة' : 'حافة منطقة القيمة منخفضة (VAL) — سيولة بيعية معلقة');
    } else if (c.meta === 'profile_edge_retest') {
      score += weights.profileEdgeWeight;
      reasons.push('إعادة اختبار حافة منطقة القيمة خلف الاختراق');
    } else if (c.meta === 'profile_lvn') {
      score += weights.profileLvnWeight;
      reasons.push('عقدة حجم منخفض — استمرار بلا احتكاك');
    } else if (c.meta === 'prev_day') {
      score += weights.prevDayWeight;
      reasons.push(c.side === 'high' ? 'قمة اليوم السابق' : 'قاع اليوم السابق');
    }

    // السحب معلوماتي فقط — لا يضخم الدرجة (التحديد الآلي للمناطق المعلقة، ليس السحب)

    // توافق فجوة قيمة عادلة
    if (c.fvgNear) {
      score += weights.fvgBonus;
      reasons.push('توافق FVG');
    }

    const s = signals ?? {};
    const pctAway = (lvl) => Math.abs(c.price - lvl) / lvl;

    // الفائدة المفتوحة ترتفع والمنطقة قريبة
    if (s.oi && s.oi.changePct >= 3 && refLevels && near(c.price, (refLevels.high + refLevels.low) / 2, 0.04)) {
      score += weights.oiBonus;
      reasons.push(`ارتفاع الفائدة المفتوحة ${s.oi.changePct.toFixed(1)}%`);
    }

    // تمويل متطرف
    if (s.funding && Math.abs(s.funding.last) > 0.0003) {
      score += weights.fundingBonus;
      reasons.push(`تمويل متطرف ${(s.funding.last * 100).toFixed(4)}%`);
    }

    // انحياز تجزئة حاد
    if (s.longShort && (s.longShort.last < 0.5 || s.longShort.last > 2)) {
      score += weights.longShortBonus;
      reasons.push(`انحياز تجزئة ${s.longShort.last.toFixed(2)}`);
    }

    // CVD مخالف للاتجاه قرب المنطقة
    if (s.cvd && s.cvd.recentSum !== 0 && refLevels) {
      const priceUp = c.price >= (refLevels.high + refLevels.low) / 2;
      if ((c.type === 'BSL' && s.cvd.recentSum < 0) || (c.type === 'SSL' && s.cvd.recentSum > 0)) {
        score += weights.cvdBonus;
        reasons.push('CVD مخالف (ضغط آجل معاكس)');
      }
      void priceUp;
    }

    // عنقود تصفيات تقديري قريب
    if (s.liqClusters?.length) {
      const liq = nearestLiqCluster(c.price, s.liqClusters);
      if (liq) {
        score += weights.liqMapBonus;
        reasons.push(`عنقود تصفيات تقديري ${liq.side === 'long' ? 'طويلين' : 'قصيرين'} ×${liq.lev}`);
      }
    }

    // رقم مستدير
    if (isRoundNumber(c.price)) {
      score += weights.roundBonus;
      reasons.push('رقم مستدير');
    }

    // قمة/قاع اليوم (النافذة)
    if (refLevels) {
      const refMatch = (c.type === 'BSL' && near(c.price, refLevels.high, 0.003)) ||
        (c.type === 'SSL' && near(c.price, refLevels.low, 0.003));
      if (refMatch) {
        score += weights.refLevelBonus;
        reasons.push('قمة/قاع النافذة الأخيرة');
      }
    }

    // دفتر الأوامر
    if (s.book && ((c.type === 'BSL' && s.book < 0.7) || (c.type === 'SSL' && s.book > 1.4))) {
      score += weights.imbalanceBonus;
      reasons.push('عدم توازن الدفتر');
    }
    if (s.icebergs?.some(i => near(i.price, c.price, 0.001))) {
      score += weights.icebergBonus;
      reasons.push('آيسبرغ (إعادة تعبئة مستوى)');
    }
    if (s.spoofs?.some(i => near(i.price, c.price, 0.001))) {
      score += weights.spoofBonus;
      reasons.push('أوامر وهمية (Spoof)');
    }

    /* ---- توافق المنطقة مع حالة المزاد (الخطوة 1: الموقع) ---- */
    if (s.location && weights.locationWeight > 0) {
      const st = s.location.state ?? 'balance';
      if (st === 'balance' && c.meta === undefined && c.clusterCount >= 2) {
        score += weights.locationWeight;
        reasons.push('توافق العنقود مع حالة التوازن (سيولة معلقة داخل النطاق)');
      }
      if ((st === 'imbalance_up' || st === 'imbalance_down') && c.meta === 'profile_lvn') {
        score += weights.locationWeight;
        reasons.push(`توافق عقدة الاستمرار مع عدم التوازن ${st === 'imbalance_up' ? 'صعوداً' : 'هبوطاً'}`);
      }
    }

    /* ---- فقاعة أوامر عدوانية باتجاه المنطقة (الخطوة 3: الزناد العدواني) ---- */
    if (weights.bubbleWeight > 0 && Array.isArray(s.bubbles) && s.bubbles.length) {
      const towardZone = s.bubbles.find(b =>
        (c.type === 'BSL' && b.type === 'aggressive_buy') ||
        (c.type === 'SSL' && b.type === 'aggressive_sell'));
      if (towardZone) {
        score += weights.bubbleWeight;
        const usd = towardZone.notional >= 1000
          ? `${Math.round(towardZone.notional / 1000)}k$`
          : `${Math.round(towardZone.notional)}$`;
        reasons.push(`فقاعة ${towardZone.type === 'aggressive_buy' ? 'شراء' : 'بيع'} عدوانية نحو المنطقة (${usd})`);
      }
    }

    /* ---- بعد الجلسة: مُعدِّل ندرة موثق وليس فلتر صارم ---- */
    if (s.session) {
      if (s.session.tier === 'prime' && weights.sessionBonus > 0) {
        score += weights.sessionBonus;
        reasons.push('جلسة ندرة حادة (تداخل لندن-نيويورك)');
      } else if (s.session.tier === 'lull' && weights.sessionPenalty > 0) {
        score = Math.max(0, score - weights.sessionPenalty);
        reasons.push('فتكة سيولة — انخفاض ندرة موثوق');
      }
    }

    score = Math.min(100, Math.max(0, Math.round(score)));
    if (score >= minScore) {
      out.push({
        type: c.type,
        price: c.price,
        score,
        reasons,
        clusterCount: c.clusterCount,
        swept: c.swept,
        sweptAt: c.sweptAt,
        anchorTime: c.anchorTime,
        bandPct: c.bandPct,
        meta: c.meta ?? 'structural',
        side: c.side ?? null
      });
    }
  }
  // الأعلى درجة أولاً ثم الأحدث مرساةً
  return out
    .sort((a, b) => b.score - a.score || b.anchorTime - a.anchorTime)
    .slice(0, limit);
}
