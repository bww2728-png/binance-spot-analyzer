/* طبقات التعلم (حتمية بالكامل — كل طبقة دالة حتمية تُختبر بدون شبكة)
 * 1. العصبي-الرمزي: انحدار لوجستي من الصفر على معالم الأسباب → مضاعف تعلُّم يُمزج مع الدرجة الرمزية.
 * 2. السببي-الرصد: رفع لكل سبب مقابل النتيجة، مقسّم بالمتغيرات (tier/trend) — يغذّي أوزان الخصائص.
 * 3. الاستدلال النشط (الطاقة الحرة المتوقعة): قرار دخول/انتظار/تخطي بتقليل الطاقة الحرة المتوقعة
 *    (utility متوقعة + كسب معرفي) — طبقة قرار مدمجة قابلة للشرح.
 * 4. تخليق القواعد (قواعد صغيرة): بحث حتمي في قواعد صغيرة لتعظيم النجاح على مجموعة التحقق.
 * التدريب: 70% الأول من النافذة الزمنية، التحقق: 30% الأخير — بلا رؤية مستقبلية.
 */

/** معالم المنطقة: خصائص عددية مستخرجة من مناطق الأسباب (خصائص ثابتة). */
export function featurize(zone) {
  const reasons = zone.reasons ?? [];
  const has = (frag) => reasons.some(r => String(r).includes(frag)) ? 1 : 0;
  return {
    intercept: 1,
    eqh: has('متساويان') || has('عنقود'),
    profile_edge: has('حافة منطقة القيمة') || has('إعادة اختبار حافة'),
    profile_lvn: has('عقدة حجم منخفض'),
    prev_day: has('اليوم السابق'),
    cvd: has('CVD'),
    bubble: has('فقاعة'),
    session_prime: has('جلسة ندرة'),
    session_lull: has('فتكة سيولة'),
    imbalance: has('عدم توازن الدفتر'),
    iceberg: has('آيسبرغ'),
    spoof: has('أوامر وهمية'),
    round: has('رقم مستدير'),
    ref_level: has('النافذة الأخيرة') || has('اليوم السابق'),
    location: has('توافق'),
    clusterCount: Math.min(6, Math.max(0, Number(zone.clusterCount) || 0)) / 6,
    scoreNorm: Math.min(1, Math.max(0, (Number(zone.score) || 0) / 100))
  };
}

const SIGMOID = (z) => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));

/** انحدار لوجستي من الصفر (نزول تدرّج دفعات كاملة) — نرى {weights}. */
export function fitLogistic(samples, { iterations = 300, lr = 0.15, l2 = 0.002 } = {}) {
  const keys = samples.length ? Object.keys(samples[0].x) : [];
  const w = Object.fromEntries(keys.map(k => [k, 0]));
  if (!samples.length) return w;
  const n = samples.length;
  for (let it = 0; it < iterations; it += 1) {
    const grad = Object.fromEntries(keys.map(k => [k, 0]));
    for (const s of samples) {
      const z = keys.reduce((a, k) => a + (w[k] ?? 0) * (s.x[k] ?? 0), 0);
      const p = SIGMOID(z);
      const err = p - s.y; // y=1 رابحة، y=0 خاسرة
      for (const k of keys) grad[k] += err * (s.x[k] ?? 0);
    }
    for (const k of keys) {
      const reg = l2 * (w[k] ?? 0);
      w[k] = (w[k] ?? 0) - lr * (grad[k] / n + reg);
    }
  }
  return w;
}

/** درجة تعلُّم مُبسَّطة: مضاعف حول 1.0 من أوزان اللوجستي — يُمزج مع الدرجة الرمزية. */
export function learnedScore(baseScore, feats, weights, { blend = 0.35 } = {}) {
  const keys = Object.keys(weights).filter(k => k !== 'intercept');
  const z = keys.reduce((a, k) => a + (weights[k] ?? 0) * (feats[k] ?? 0), 0);
  const conf = SIGMOID(z); // احتمال الربح المُتعلَّم
  // 0.5 → محايد (مضاعف 1)؛ صعوداً/هبوطاً ±70% حد
  const multiplier = Math.max(0.3, Math.min(1.7, 0.5 + (conf - 0.5) * 2.4));
  return Math.round(Math.min(100, Math.max(0, (1 - blend) * baseScore + blend * baseScore * multiplier)));
}

/** السببي-الرصد: رفع الربح لكل سبب مقابل مجموعة بدون السبب، مقسّم بطبقة المتغير (confounder).
 *  lift = P(ربح | السبب، طبقة) / P(ربح | بدون السبب، طبقة) — يغذّي عتبات الخصائص. */
export function stratifiedLift(trades, { has, groupOf }) {
  const out = {};
  const frag = has;
  const key = frag;
  const byGroup = {};
  for (const t of trades) {
    const g = groupOf(t) ?? 'all';
    (byGroup[g] ??= { with: [], without: [] });
    const reasons = t.reasons ?? [];
    const match = typeof has === 'function' ? has(t) : reasons.some(r => String(r).includes(frag));
    (match ? byGroup[g].with : byGroup[g].without).push(t);
  }
  for (const [g, { with: w, without: wo }] of Object.entries(byGroup)) {
    const pw = w.length ? w.filter(t => t.win === 1).length / w.length : null;
    const po = wo.length ? wo.filter(t => t.win === 1).length / wo.length : null;
    if (pw !== null && po !== null && po > 0) {
      out[`${key}@${g}`] = Number((pw / po).toFixed(2));
    }
  }
  return out;
}

/** الاستدلال النشط (تقليل الطاقة الحرة المتوقعة):
 *  G(دخول) = -كسب معرفي (إنتروبيا النتيجة المتوقعة) - utility متوقعة (احتمال الربح × الـ payoff)
 *  قرار: دخول إن كانت G < عتبة؛ وإلا انتظار؛ وتخطي إن كانت التصفية مرفوضة. */
export function activeDecision({ pWin, payoff, regimeGate = true, minRR = 1.5 }) {
  const p = Math.max(0, Math.min(1, Number(pWin) || 0));
  const b = Math.max(0, Number(payoff) || 0);
  if (!regimeGate) return { action: 'skip', reason: 'بواب النظام: لا تُعرض الصفقة' };
  const epistemic = -(-(p * Math.log(p + 1e-12) + (1 - p) * Math.log(1 - p + 1e-12)));
  const pragmatic = p * b - (1 - p);
  const freeEnergy = epistemic - Math.max(0, pragmatic);
  if (payoff > 0 && payoff < minRR) return { action: 'wait', reason: 'الـ payoff أقل من الحد', freeEnergy: Number(freeEnergy.toFixed(3)) };
  const action = pragmatic > 0.05 && freeEnergy < 0.9 ? 'enter' : 'wait';
  return { action, reason: action === 'enter' ? 'طاقة حرة متوقعة مقبولة' : 'طاقة حرة متوقعة عالية — انتظار', freeEnergy: Number(freeEnergy.toFixed(3)) };
}

/** تخليق القواعد (قواعد صغيرة): بحث حتمي في مساحة صغيرة لتعظيم النجاح على مجموعة التحقق.
 *  القواعد: {minScore, minRR, requireCluster, requireBubble, allowSwept} */
export function synthFilters(validation, { targetWinRate = 0.7, minTrades = 8 } = {}) {
  if (!validation.length) return null;
  const score = (f, v) => {
    const kept = v.filter(x =>
      x.score >= f.minScore &&
      (!f.requireCluster || (x.clusterCount ?? 0) >= 2) &&
      (!f.requireBubble || (x.reasons ?? []).some(r => String(r).includes('فقاعة'))) &&
      (f.allowSwept || !x.swept) &&
      (!f.minRR || (x.rr ?? 0) >= f.minRR));
    if (kept.length < minTrades) return null;
    return { ...f, kept: kept.length, winRate: kept.filter(t => t.win === 1).length / kept.length };
  };
  const candidates = [];
  for (const minScore of [50, 55, 60, 65, 70]) {
    for (const allowSwept of [true, false]) {
      for (const requireCluster of [true, false]) {
        for (const requireBubble of [true, false]) {
          candidates.push({ minScore, allowSwept, requireCluster, requireBubble });
        }
      }
    }
  }
  let best = null;
  for (const c of candidates) {
    const r = score(c, validation);
    if (!r) continue;
    // التفضيل: تحقيق هدف ≥ 0.7 ثم أقصى kept ثم أقصى winRate
    const meetsGoal = r.winRate >= targetWinRate;
    const bestMeets = best && best.winRate >= targetWinRate;
    const better =
      !best ||
      (meetsGoal && !bestMeets) ||
      (meetsGoal === bestMeets && (meetsGoal ? (r.kept > best.kept || (r.kept === best.kept && r.winRate > best.winRate)) : r.winRate > best.winRate));
    if (better) best = r;
  }
  return best ? {
    minScore: best.minScore, allowSwept: best.allowSwept,
    requireCluster: best.requireCluster, requireBubble: best.requireBubble,
    kept: best.kept, winRate: Number(best.winRate.toFixed(3))
  } : null;
}

/** تقسيم walk-forward: 70% الأول (تدريب) / 30% الأخير (تحقق) حسب الوقت — بلا رؤية مستقبلية. */
export function walkForwardSplit(trades, trainRatio = 0.7) {
  const sorted = [...trades].sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
  const cut = Math.floor(sorted.length * trainRatio);
  return { train: sorted.slice(0, cut), validation: sorted.slice(cut) };
}

/** تقييم استراتيجية: النجاح النهائي النهائي على مجموعة معطاة (المحايد مُستبعد من المقام). */
export function evaluateStrategy(trades) {
  const decided = trades.filter(t => t.win === 1 || t.win === 0);
  if (!decided.length) return { kept: 0, winRate: null, avgRR: null };
  return {
    kept: decided.length,
    winRate: Number((decided.filter(t => t.win === 1).length / decided.length).toFixed(3)),
    avgRR: decided.filter(t => Number.isFinite(t.rr)).length
      ? Number((decided.filter(t => Number.isFinite(t.rr)).reduce((a, t) => a + t.rr, 0) / decided.length).toFixed(2))
      : null
  };
}
