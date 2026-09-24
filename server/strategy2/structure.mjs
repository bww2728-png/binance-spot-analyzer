/* نواة استراتيجية «الفرص الحية — استراتيجيتي» — حتمية بالكامل (بلا شبكة)
 *
 * الإستراتيجية ميكانيكية بالكامل وفق تعليمات المستخدم:
 *
 * 1) الفريم الأكبر = الفريم الحالي × 8 (يُجمَّع من شموع فريم الدخول نفسها — بلا اشتراكات إضافية)
 * 2) الهيكل الخارجي (HTF): بيفوتات كبرى + كسور حقيقية بالإغلاق → الاتجاه + «هل الكسر بعد بريميوم»
 * 3) الهيكل الداخلي: بيفوتات أصغر بين النقاط الخارجية → مناطق BSL/SSL داخلية تُسجَّل لحظة تكوّنها
 * 4) القمة المحمية (آلة الخطوات الخمس): تعدي BSL ← كسر قاع فرعي/ديماند ← sellers induced (اختياري)
 *    ← ssl sweep (اختياري) ← عودة فوق مستوى الـBSL + نموذج شمعتين بيعي (خاصة الابتلاع)
 *    → القمة المحمية = أعلى سعر شمعة الدخول البيعية. والقاع المحمية معكوسة تماماً.
 * 5) الاتجاه: آخر كسر حقيقي لقمة/قاع محمية. صاعد وصل bsl خارجي/سبلاي على HTF هابط → انتهى المشوار.
 * 6) الدخول شراء: بعد choch up (اختراق قمة محمية) ← ديسكاونت إلزامي (فيبو ≤ 0.5 أو sellers induced)
 *    ← إن سبقه تعدي bsl داخلي قبل الديسكاونت → يُشترط تعدي ssl داخلي
 *    ← نموذج 1: سويب bsl داخلي + سويب ssl داخلي + صعود + choch up داخلي
 *       نموذج 2: إخراج المشترين المبكرين (سويب ssl واستعادة) + ابتلاع شرائي
 *    ← فشل الدخول: سويب ssl ← صعود ← سويب bsl ← هبوط ← كسر قاع السويب
 * 7) الأهداف: TP1 = قمة choch up الحقيقي · TP2 = bsl خارجي · الوقف تحت قاع السويب
 *
 * كل الدوال نقية: نفس المدخلات → نفس المخرجات. هذا يجعل المعايرة إعادة تشغيل لنفس الكود على التاريخ.
 */

/* ================= أدوات أساسية ================= */

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const numOrNaN = (v) => (v == null || v === '' ? NaN : Number(v));

/** ATR كلاسيكي (Wilder مبسط بمتوسط) */
export function atr(candles, index, period = 14) {
  if (!Array.isArray(candles) || candles.length < 2) return NaN;
  const end = Number.isFinite(Number(index)) ? index : candles.length - 1;
  const start = Math.max(1, end - period + 1);
  let sum = 0, n = 0;
  for (let i = start; i <= end; i += 1) {
    const h = numOrNaN(candles[i].high), l = numOrNaN(candles[i].low), pc = numOrNaN(candles[i - 1].close);
    if (!Number.isFinite(h) || !Number.isFinite(l) || !Number.isFinite(pc)) continue;
    sum += Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
    n += 1;
  }
  return n ? sum / n : NaN;
}

/** بيفوتات فراكتال: شمعة أعلى/أدنى من جيرانها (left يساراً وright يميناً) */
export function findPivots(candles, left = 2, right = 2) {
  const out = [];
  for (let i = left; i < candles.length - right; i += 1) {
    const h = numOrNaN(candles[i].high), l = numOrNaN(candles[i].low);
    if (!Number.isFinite(h) || !Number.isFinite(l)) continue;
    let isHigh = true, isLow = true;
    for (let j = i - left; j <= i + right && (isHigh || isLow); j += 1) {
      if (j === i) continue;
      if (numOrNaN(candles[j].high) >= h) isHigh = false;
      if (numOrNaN(candles[j].low) <= l) isLow = false;
    }
    if (isHigh) out.push({ i, time: candles[i].time, price: h, kind: 'high' });
    if (isLow) out.push({ i, time: candles[i].time, price: l, kind: 'low' });
  }
  return out;
}

/** تجميع شموع فريم الدخول إلى فريم أكبر ×8 (دلو مرتكز على أول شمعة — مستقر لأي محاذاة) */
export function aggregateX8(candles) {
  if (!Array.isArray(candles) || !candles.length) return [];
  const step = candles.length > 1 && Number(candles[1].time) > Number(candles[0].time)
    ? Number(candles[1].time) - Number(candles[0].time)
    : 60;
  const bucket = Math.max(step * 8, step);
  const anchor = Number(candles[0].time);
  const out = [];
  let cur = null, curT = -1;
  for (const c of candles) {
    const t = Number(c.time);
    const bt = anchor + Math.floor((t - anchor) / bucket) * bucket;
    if (!cur || bt !== curT) {
      if (cur) out.push(cur);
      curT = bt;
      cur = {
        time: bt,
        open: numOrNaN(c.open), high: numOrNaN(c.high),
        low: numOrNaN(c.low), close: numOrNaN(c.close),
        volume: numOrNaN(c.volume) || 0,
        openTimeMs: Number(c.timeMs ?? c.time * 1000)
      };
    } else {
      cur.high = Math.max(cur.high, numOrNaN(c.high));
      cur.low = Math.min(cur.low, numOrNaN(c.low));
      cur.close = numOrNaN(c.close);
      cur.volume += numOrNaN(c.volume) || 0;
    }
  }
  if (cur) out.push(cur);
  return out.filter(c => Number.isFinite(c.open) && Number.isFinite(c.close));
}

/* ================= الهيكل الخارجي (فريم أكبر ×8) ================= */

/**
 * مسار هيكل الخارجي: كسور بالإغلاق فوق/تحت آخر بيفوت مؤكد → الاتجاه + بريميوم.
 * يعيد أيضاً القمة/القاع المحمي الآخر (مرساة الاتجاه) ومناطق bsl/سبلاي/ديماند الخارجية.
 */
export function buildHtfContext(htfCandles, { pivotWidth = 2, price = null } = {}) {
  const empty = {
    direction: 'range', afterPremium: null,
    protectedHigh: null, protectedLow: null,
    externalBslAbove: [], externalSslBelow: [], externalDemandBelow: [],
    externalBslAll: [],
    range: null, lastBreak: null, breaks: []
  };
  if (!Array.isArray(htfCandles) || htfCandles.length < 12) return empty;
  const pivots = findPivots(htfCandles, pivotWidth, pivotWidth);
  const highs = pivots.filter(p => p.kind === 'high');
  const lows = pivots.filter(p => p.kind === 'low');

  // مسار زمني: تتبع آخر بيفوت مؤكد + كسر بالإغلاق
  let direction = 'range';
  let pendingHigh = null, pendingLow = null;
  let afterPremium = null;
  let anchorHigh = null, anchorLow = null; // مراسئ الاتجاه (القمة/القاع المحمي للكسر الأخير)
  let legDeath = null; // مستوى موت المشوار الصاعد: أقرب bsl خارجية سابقة فوق أصل الرِجل
  const breaks = [];
  let pIdx = 0;

  for (let i = 0; i < htfCandles.length; i += 1) {
    const c = htfCandles[i];
    const close = numOrNaN(c.close);
    if (!Number.isFinite(close)) continue;
    // تأكيد البيفوتات التي اكتمل نافذتها عند i
    while (pIdx < pivots.length && pivots[pIdx].i + pivotWidth <= i) {
      const p = pivots[pIdx];
      if (p.kind === 'high') pendingHigh = p;
      else pendingLow = p;
      pIdx += 1;
    }
    // موت المشوار الصاعد داخل المسار: بلوغ/تجاوز bsl خارجية سابقة → انتهى الصعود
    if (direction === 'up' && legDeath != null && close >= legDeath) {
      direction = 'down';
      legDeath = null;
      breaks.push({ i, time: c.time, dir: 'down', level: close, exhausted: true });
    }
    const legLow = anchorLow?.price ?? pendingLow?.price ?? null;
    const legHigh = anchorHigh?.price ?? pendingHigh?.price ?? null;
    if (pendingHigh && close > pendingHigh.price && direction !== 'up') {
      // كسر صاعد حقيقي — هل كان بعد بريميوم؟ نطاق الرِجل قبل الكسر
      let ap = null;
      if (Number.isFinite(legLow) && Number.isFinite(pendingHigh.price) && pendingHigh.price > legLow) {
        ap = (close - legLow) / (pendingHigh.price - legLow);
      }
      direction = 'up';
      afterPremium = ap == null ? null : ap > 0.5;
      anchorLow = pendingHigh; // القمة المكسورة تصبح المرساة العلوية
      anchorHigh = null;
      // مستوى موت المشوار: أقرب قمة خارجية سابقة فوق مستوى الكسر
      const abovePrior = highs.filter(hp => hp.price > pendingHigh.price && hp.i < i).map(hp => hp.price);
      legDeath = abovePrior.length ? Math.min(...abovePrior) : null;
      breaks.push({ i, time: c.time, dir: 'up', level: pendingHigh.price, afterPremium: ap == null ? null : ap > 0.5, pos: ap });
      pendingHigh = null;
    } else if (pendingHigh && close > pendingHigh.price) {
      pendingHigh = null; // استمرار صاعد — البيفوت القديم استُهلك
    }
    if (pendingLow && close < pendingLow.price && direction !== 'down') {
      let ap = null;
      if (Number.isFinite(legHigh) && Number.isFinite(pendingLow.price) && legHigh > pendingLow.price) {
        ap = (legHigh - close) / (legHigh - pendingLow.price);
      }
      direction = 'down';
      legDeath = null;
      afterPremium = ap == null ? null : ap > 0.5;
      anchorHigh = pendingLow; // القاع المكسور يصبح المرساة السفلية
      anchorLow = null;
      breaks.push({ i, time: c.time, dir: 'down', level: pendingLow.price, afterPremium: ap == null ? null : ap > 0.5, pos: ap });
      pendingLow = null;
    } else if (pendingLow && close < pendingLow.price) {
      pendingLow = null;
    }
  }
  // كسر استمراري بعد آخر اتجاه: يبقى الاتجاه كما هو — الكسر الأخير هو الحاكم
  const lastBreak = breaks[breaks.length - 1] ?? null;

  // نطاق التعامل: آخر رِجل خارجية بين بيفوتين خارجيين متجاورين
  let range = null;
  const recentHighs = highs.slice(-2), recentLows = lows.slice(-2);
  if (recentHighs.length && recentLows.length) {
    const lastH = recentHighs[recentHighs.length - 1];
    const lastL = recentLows[recentLows.length - 1];
    const hi = Math.max(lastH.price, lastL.price), lo = Math.min(lastH.price, lastL.price);
    if (hi > lo) {
      const p = Number.isFinite(Number(price)) ? Number(price) : numOrNaN(htfCandles[htfCandles.length - 1].close);
      range = {
        low: lo, high: hi,
        mid: (lo + hi) / 2,
        pos: Number.isFinite(p) ? clamp((p - lo) / (hi - lo), 0, 1) : null
      };
    }
  }

  const cur = Number.isFinite(Number(price)) ? Number(price) : numOrNaN(htfCandles[htfCandles.length - 1]?.close);
  return {
    direction,
    afterPremium,
    protectedHigh: anchorHigh?.price ?? pendingHigh?.price ?? null,
    protectedLow: anchorLow?.price ?? pendingLow?.price ?? null,
    externalBslAbove: highs.map(p => p.price).filter(v => Number.isFinite(cur) && v > cur).sort((a, b) => a - b),
    externalSslBelow: lows.map(p => p.price).filter(v => Number.isFinite(cur) && v < cur).sort((a, b) => b - a),
    externalDemandBelow: lows.map(p => p.price).filter(v => Number.isFinite(cur) && v < cur).sort((a, b) => b - a),
    // كل bsl الخارجية (حتى المسحوبة) — لموت المشوار: HTF هابط + بلوغ/تجاوز أقربها = انتهى الصعود
    externalBslAll: [...new Set(highs.map(p => p.price))].sort((a, b) => a - b),
    // مستوى موت المشوار الصاعد الحالي (HTF صاعد لكن سبقه اتجاه هابط أكبر — البلوغ للعرض الخارجي يقتله)
    upLegDeathLevel: direction === 'up' ? legDeath : null,
    range,
    lastBreak,
    breaks: breaks.slice(-6)
  };
}

/* ================= الهيكل الداخلي (فريم الدخول) ================= */

/**
 * مناطق BSL/SSL داخلية من بيفوتات ضيقة — تُسجَّل لحظة تكوّنها وتبقى (قاعدة التدوين).
 * حالة كل منطقة: open → swept (ذيل عبرها وإغلاق تحتها/فوقها) أو broken (إغلاق عبرها).
 */
export function buildInternal(candles, { pivotWidth = 1 } = {}) {
  const pivots = findPivots(candles, pivotWidth, pivotWidth);
  const zones = []; // {kind:'bsl'|'ssl', level, i, time, state, sweptAt, sweptLow/High, brokenAt}
  let internalTrend = 'range';
  let lastSellersInduced = null; // آخر ssl داخلي سُحبت (مستوى)
  let lastBuyersInduced = null;  // آخر bsl داخلي سُحبت

  const byKind = (kind) => zones.filter(z => z.kind === kind);

  for (let i = 0; i < candles.length; i += 1) {
    const c = candles[i];
    const h = numOrNaN(c.high), l = numOrNaN(c.low), close = numOrNaN(c.close);
    if (!Number.isFinite(h) || !Number.isFinite(l) || !Number.isFinite(close)) continue;
    // تأكيد بيفوت جديد (اكتملت نافذته)
    for (const p of pivots) {
      if (p.i !== i - pivotWidth) continue;
      zones.push({
        kind: p.kind === 'high' ? 'bsl' : 'ssl',
        level: p.price, i: p.i, time: p.time,
        state: 'open', sweptAt: null, sweptExtreme: null, brokenAt: null
      });
    }
    // تحديث حالات المناطق المفتوحة مقابل الشمعة الحالية
    for (const z of zones) {
      if (z.state !== 'open') continue;
      if (z.kind === 'bsl') {
        if (h > z.level) {
          if (close > z.level) {
            z.state = 'broken'; z.brokenAt = c.time;
            internalTrend = 'up';
          } else {
            z.state = 'swept'; z.sweptAt = c.time; z.sweptExtreme = h;
            lastBuyersInduced = { level: z.level, at: c.time, extreme: h };
          }
        }
      } else {
        if (l < z.level) {
          if (close < z.level) {
            z.state = 'broken'; z.brokenAt = c.time;
            internalTrend = 'down';
          } else {
            z.state = 'swept'; z.sweptAt = c.time; z.sweptExtreme = l;
            lastSellersInduced = { level: z.level, at: c.time, extreme: l };
          }
        }
      }
    }
  }

  return {
    pivots,
    bsl: byKind('bsl').slice(-24),   // سقف ذاكرة لكل نوع
    ssl: byKind('ssl').slice(-24),
    internalTrend,
    lastSellersInduced,
    lastBuyersInduced,
    // آخر bsl داخلي مفتوح (لم تكسر بالإغلاق)
    openBsl: byKind('bsl').filter(z => z.state === 'open').map(z => z.level).sort((a, b) => a - b),
    openSsl: byKind('ssl').filter(z => z.state === 'open').map(z => z.level).sort((a, b) => b - a)
  };
}

/* ================= نموذجي الشمعتين (الابتلاع خصوصاً) ================= */

/** ابتلاع شرائي: جسم صاعد يبتلع جسم الشمعة الهابطة السابقة */
export function isBullishEngulfing(c1, c2) {
  // c1 سابقة (هابطة)، c2 لاحقة (صاعدة)
  const o1 = numOrNaN(c1?.open), cl1 = numOrNaN(c1?.close);
  const o2 = numOrNaN(c2?.open), cl2 = numOrNaN(c2?.close);
  if (![o1, cl1, o2, cl2].every(Number.isFinite)) return false;
  return cl1 < o1 && cl2 > o2 && cl2 >= Math.max(o1, cl1) && o2 <= Math.min(o1, cl1) &&
    (cl2 - o2) > (Math.max(o1, cl1) - Math.min(o1, cl1)) * 0.5;
}

/** ابتلاع بيعي: عكس ما سبق */
export function isBearishEngulfing(c1, c2) {
  const o1 = numOrNaN(c1?.open), cl1 = numOrNaN(c1?.close);
  const o2 = numOrNaN(c2?.open), cl2 = numOrNaN(c2?.close);
  if (![o1, cl1, o2, cl2].every(Number.isFinite)) return false;
  return cl1 > o1 && cl2 < o2 && o2 >= Math.max(o1, cl1) && cl2 <= Math.min(o1, cl1) &&
    (o2 - cl2) > (Math.max(o1, cl1) - Math.min(o1, cl1)) * 0.5;
}

/** نموذج شمعتين صاعد عام (ابتلاع أو ابتلاع جزئي قوي + إغلاق فوق منتصف الأولى) */
export function isBullishPair(c1, c2) {
  if (isBullishEngulfing(c1, c2)) return true;
  const o1 = numOrNaN(c1?.open), cl1 = numOrNaN(c1?.close);
  const o2 = numOrNaN(c2?.open), cl2 = numOrNaN(c2?.close);
  if (![o1, cl1, o2, cl2].every(Number.isFinite)) return false;
  const body1 = Math.abs(cl1 - o1), body2 = cl2 - o2;
  return cl2 > o2 && cl2 > numOrNaN(c1.high) * 0.999 &&
    body2 > body1 * 0.8 && cl2 > (o1 + cl1) / 2;
}

/** نموذج شمعتين هابط عام */
export function isBearishPair(c1, c2) {
  if (isBearishEngulfing(c1, c2)) return true;
  const o1 = numOrNaN(c1?.open), cl1 = numOrNaN(c1?.close);
  const o2 = numOrNaN(c2?.open), cl2 = numOrNaN(c2?.close);
  if (![o1, cl1, o2, cl2].every(Number.isFinite)) return false;
  const body1 = Math.abs(cl1 - o1), body2 = o2 - cl2;
  return cl2 < o2 && cl2 < numOrNaN(c1.low) * 1.001 &&
    body2 > body1 * 0.8 && cl2 < (o1 + cl1) / 2;
}

/* ================= آلة الخطوات الخمس — القمة/القاع المحمية ================= */

/**
 * مسح زمني يبحث عن آخر قمة محمية مكتملة بخطواتها الخمس:
 * 1. سويب bsl داخلي (ذيل فوق المستوى وإغلاق تحته) — يُسجَّل المستوى
 * 2. إغلاق تحت أول قاع فرعي داخلي (دخل البائعون)
 * 3. (اختياري) سويب ssl داخلي — sellers induced
 * 4. (اختياري) سويب أعمق (قاع جديد تحت القاع المكسور)
 * 5. صعود وإغلاق فوق مستوى الـBSL المسحوب + نموذج شمعتين بيعي (خاصة الابتلاع)
 * القمة المحمية = أعلى قاع سويب..شمعة الدخول البيعية
 */
export function scanProtectedHigh(candles, internal, { maxStepsBars = 120 } = {}) {
  const n = candles.length;
  if (n < 20) return { completed: null, inProgress: null };
  const a = atr(candles, n - 1) || Math.abs(numOrNaN(candles[n - 1].close)) * 0.005 || 1;
  const bslOpen = new Set(internal.bsl.filter(z => z.state !== 'broken').map(z => z.level));
  const sslLevels = internal.ssl.map(z => z.level);

  let st = null; // آلة جارية
  const completedList = [];
  const startIdx = Math.max(0, n - maxStepsBars);
  for (let i = startIdx; i < n; i += 1) {
    const c = candles[i];
    const h = numOrNaN(c.high), l = numOrNaN(c.low), close = numOrNaN(c.close);
    if (!st) {
      // خطوة 1: سويب bsl داخلي مفتوح
      for (const level of bslOpen) {
        if (h > level && close < level) {
          st = { phase: 1, bslLevel: level, sweepHigh: h, startIdx: i, brokenLow: null, sellersInduced: null, deepLow: null, refLow: null };
          break;
        }
      }
      continue;
    }
    if (st.phase === 1) {
      // المرجع السفلي: آخر قاع فرعي داخلي تحت مستوى الـBSL
      const lowsBelow = internal.ssl.filter(z => z.i <= i && z.level < st.bslLevel).map(z => z.level);
      st.refLow = lowsBelow.length ? Math.max(...lowsBelow) : null;
      if (st.refLow != null && close < st.refLow) {
        st.phase = 2;
        st.brokenLow = Math.min(l, st.refLow);
      } else if (close > st.bslLevel + 0.5 * a) {
        st = null; // ارتد فوق المستوى بلا كسر قاع — سويب فاشل بلا تكوّن
      }
      continue;
    }
    if (st.phase >= 2) {
      // خطوتا 3/4 (اختياريتان): سويب ssl داخلي أو قاع أعمق — الأعمق هو المستدرج الحقيقي
      for (const level of sslLevels) {
        if (level < st.bslLevel && l < level && close > level) {
          if (!st.sellersInduced || l < st.sellersInduced.extreme) {
            st.sellersInduced = { level, at: c.time, extreme: l };
          }
          break;
        }
      }
      if (st.brokenLow != null && l < st.brokenLow) st.deepLow = Math.min(l, st.deepLow ?? l);
      // خطوة 5: عودة لمستوى الـBSL المسحوب (لمس أو إغلاق) ثم نموذج بيعي (قد يغلق تحت المستوى — دخول البيع)
      if (h > st.bslLevel) st.revisited = true;
      if (st.revisited && isBearishPair(candles[i - 1], c)) {
        const fromIdx = Math.max(0, st.startIdx - 2);
        let formedHigh = st.sweepHigh;
        for (let j = fromIdx; j <= i; j += 1) formedHigh = Math.max(formedHigh, numOrNaN(candles[j].high));
        completedList.push({
          level: st.bslLevel, protectedHigh: formedHigh,
          formedIdx: i, formedAt: c.time,
          steps: {
            bslLevel: st.bslLevel, sweepHigh: st.sweepHigh, brokenLow: st.brokenLow,
            sellersInduced: st.sellersInduced, deepLow: st.deepLow
          }
        });
        st = null;
      }
      // كسر حقيقي فوق منطقة السويب بلا نموذج → التكوين فشل (القمة ليست هنا)
      else if (close > st.bslLevel + 1.5 * a || close > st.sweepHigh) {
        st = null;
      } else if (close < Math.min(st.brokenLow ?? l, st.deepLow ?? l) - 2 * a) {
        st = null; // انهيار بعيد — لا تكوين
      }
    }
  }
  const completed = completedList.length ? completedList[completedList.length - 1] : null;
  return { completed, completedList, inProgress: st };
}

/** القاع المحمية — مرآة القمة المحمية تماماً (للتحقق من كسور القيعان وتتبع الاتجاه) */
export function scanProtectedLow(candles, internal, { maxStepsBars = 120 } = {}) {
  const n = candles.length;
  if (n < 20) return { completed: null, inProgress: null };
  const a = atr(candles, n - 1) || Math.abs(numOrNaN(candles[n - 1].close)) * 0.005 || 1;
  const sslOpen = new Set(internal.ssl.filter(z => z.state !== 'broken').map(z => z.level));
  const bslLevels = internal.bsl.map(z => z.level);

  let st = null;
  const completedList = [];
  const startIdx = Math.max(0, n - maxStepsBars);
  for (let i = startIdx; i < n; i += 1) {
    const c = candles[i];
    const h = numOrNaN(c.high), l = numOrNaN(c.low), close = numOrNaN(c.close);
    if (!st) {
      for (const level of sslOpen) {
        if (l < level && close > level) {
          st = { phase: 1, sslLevel: level, sweepLow: l, startIdx: i, brokenHigh: null, buyersInduced: null, deepHigh: null, refHigh: null };
          break;
        }
      }
      continue;
    }
    if (st.phase === 1) {
      const highsAbove = internal.bsl.filter(z => z.i <= i && z.level > st.sslLevel).map(z => z.level);
      st.refHigh = highsAbove.length ? Math.min(...highsAbove) : null;
      if (st.refHigh != null && close > st.refHigh) {
        st.phase = 2;
        st.brokenHigh = Math.max(h, st.refHigh);
      } else if (close < st.sslLevel - 0.5 * a) {
        st = null;
      }
      continue;
    }
    if (st.phase >= 2) {
      for (const level of bslLevels) {
        if (level > st.sslLevel && h > level && close < level) {
          if (!st.buyersInduced || h > st.buyersInduced.extreme) {
            st.buyersInduced = { level, at: c.time, extreme: h };
          }
          break;
        }
      }
      if (st.brokenHigh != null && h > st.brokenHigh) st.deepHigh = Math.max(h, st.deepHigh ?? h);
      // خطوة 5 المعكوسة: عودة لمستوى الـSSL المسحوب ثم نموذج شرائي (قد يغلق فوق المستوى)
      if (l < st.sslLevel) st.revisited = true;
      if (st.revisited && isBullishPair(candles[i - 1], c)) {
        const fromIdx = Math.max(0, st.startIdx - 2);
        let protectedLow = st.sweepLow;
        for (let j = fromIdx; j <= i; j += 1) protectedLow = Math.min(protectedLow, numOrNaN(candles[j].low));
        completedList.push({
          level: st.sslLevel, protectedLow,
          formedIdx: i, formedAt: c.time,
          steps: {
            sslLevel: st.sslLevel, sweepLow: st.sweepLow, brokenHigh: st.brokenHigh,
            buyersInduced: st.buyersInduced, deepHigh: st.deepHigh
          }
        });
        st = null;
      }
      // كسر حقيقي تحت منطقة السويب بلا نموذج → التكوين فشل
      else if (close < st.sslLevel - 1.5 * a || close < st.sweepLow) {
        st = null;
      } else if (close > Math.max(st.brokenHigh ?? h, st.deepHigh ?? h) + 2 * a) {
        st = null;
      }
    }
  }
  const completed = completedList.length ? completedList[completedList.length - 1] : null;
  return { completed, completedList, inProgress: st };
}

/* ================= تدفق الدخول الشرائي الكامل ================= */

/**
 * المسح الكامل على فريم الدخول: choch up (اختراق قمة محمية) → ديسكاونت إلزامي
 * → شرط ssl عند تعدي bsl داخلي → نموذج 1 أو 2 → إشارة شراء أو فشل موثق.
 * حتمي بالكامل — يعيد أحدث إشارة وأسباب مراحل الانتظار الحالية.
 */
export function scanBuyFlow(candles, ctx, internal, phScan, {
  discountPos = 0.5, oteLow = 0.62, oteHigh = 0.79, maxFlowBars = 200,
  minRR = 1.0, bandPct = 0.0015
} = {}) {
  const n = candles.length;
  const empty = { signal: null, phase: 'بانتظار تكوّن قمة محمية', phaseDetail: null, invalid: null, waiting: {} };
  if (n < 30 || (!phScan?.completed && !phScan?.completedList?.length)) return empty;
  const a = atr(candles, n - 1) || Math.abs(numOrNaN(candles[n - 1].close)) * 0.005 || 1;

  // اختيار التكوين المناسب: آخر قمة محمية مكتملة كسرها الإغلاق فعلاً (choch up) —
  // قد تتكوّن قمم أحدث دون choch up بينما مسار سابق ما زال حياً
  const candidates = phScan.completedList?.length ? phScan.completedList : (phScan.completed ? [phScan.completed] : []);
  let ph = null, chochIdx = -1;
  for (let k = candidates.length - 1; k >= 0 && chochIdx < 0; k -= 1) {
    const cand = candidates[k];
    for (let i = cand.formedIdx + 1; i < n; i += 1) {
      if (numOrNaN(candles[i].close) > cand.protectedHigh) { ph = cand; chochIdx = i; break; }
    }
  }
  if (!ph || chochIdx < 0) {
    const lastPh = candidates[candidates.length - 1] ?? null;
    return {
      signal: null, phase: 'بانتظار choch up — اختراق القمة المحمية',
      phaseDetail: lastPh ? { protectedHigh: lastPh.protectedHigh, level: lastPh.level } : null,
      invalid: null, waiting: lastPh ? { protectedHigh: lastPh.protectedHigh } : {}
    };
  }

  const chochHigh = ph.protectedHigh; // الهدف 1: قمة choch up الحقيقي
  // نطاق رِجل الصعود بعد choch up (للديسكاونت الفيبو)
  const flowEnd = Math.min(n - 1, chochIdx + maxFlowBars);
  let legLow = Infinity, legHigh = -Infinity;
  for (let i = chochIdx; i <= flowEnd; i += 1) {
    legLow = Math.min(legLow, numOrNaN(candles[i].low));
    legHigh = Math.max(legHigh, numOrNaN(candles[i].high));
  }
  if (!Number.isFinite(legLow) || !Number.isFinite(legHigh) || legHigh <= legLow) return empty;
  const rangeLow = Math.min(legLow, ph.steps.brokenLow ?? legLow);
  const rangeHigh = chochHigh;
  const discountLevel = rangeLow + discountPos * (rangeHigh - rangeLow);

  // مراقبة ما بعد choch up شمعة بشمعة (حتمي — من chochIdx حتى آخر شمعة)
  let discountReached = false, sslRetestDone = false, bslRetestBeforeDiscount = false;
  let lastSweepLow = null;          // قاع آخر سويب ssl (وقف + شرط الفشل)
  let bslSweptAfterDiscount = false; // فشل: سويب bsl بعد السويب الأخير
  let model1Ready = false, model2Ready = false;
  let invalid = null;
  let stepIdx = chochIdx;

  // 1) هل سبق choch up تعدي bsl داخلي قبل الديسكاونت؟ (يُشترط عنده ssl لاحقاً)
  for (let i = chochIdx; i <= flowEnd; i += 1) {
    const c = candles[i], h = numOrNaN(c.high), l = numOrNaN(c.low), close = numOrNaN(c.close);
    const pos = (close - rangeLow) / (rangeHigh - rangeLow);
    // تعدي bsl داخلي (سويب) قبل بلوغ الديسكاونت
    if (!discountReached && pos > discountPos) {
      for (const z of internal.bsl) {
        if (z.level < rangeHigh && h > z.level && close <= z.level) { bslRetestBeforeDiscount = true; break; }
      }
    }
    // بلوغ الديسكاونت (فيبو) أو sellers induced (سويب ssl داخلي واستعادته)
    if (pos <= discountPos) discountReached = true;
    for (const z of internal.ssl) {
      if (z.level >= rangeLow && l < z.level && close > z.level) {
        lastSweepLow = Math.min(lastSweepLow ?? l, l);
        sslRetestDone = true;
        bslSweptAfterDiscount = false; // سويب جديد يعيد ضبط شرط الفشل
        model1Ready = true;            // سويب ssl داخلي حصل — جزء نموذج 1
      }
    }
    // سويب bsl داخلي بعد السويب الأخير (بداية مسار الفشل)
    if (lastSweepLow != null && !invalid) {
      for (const z of internal.bsl) {
        if (h > z.level && close <= z.level) { bslSweptAfterDiscount = true; break; }
      }
      // فشل الدخول: بعد سويب bsl — كسر قاع السويب بالإغلاق
      if (bslSweptAfterDiscount && close < lastSweepLow) {
        invalid = { at: c.time, reason: 'فشل الدخول: سويب ssl ثم bsl ثم كسر قاع السويب' };
        break;
      }
    }
    if (i === flowEnd) break;
  }

  if (invalid) {
    return { signal: null, phase: 'فشل نقطة الدخول — بانتظار تكوين جديد', phaseDetail: null, invalid, waiting: {} };
  }

  const needSsl = bslRetestBeforeDiscount; // قاعدة الملاحظة: تعدي bsl داخلي قبل الديسكاونت → يُشترط ssl
  const sslOk = sslRetestDone || !needSsl;

  if (!discountReached) {
    return {
      signal: null, phase: 'بانتظار الديسكاونت (إلزامي)',
      phaseDetail: { discountLevel, rangeLow, rangeHigh, needSsl },
      invalid: null,
      waiting: { discountLevel, needSsl, ote: [rangeLow + oteLow * (rangeHigh - rangeLow), rangeLow + oteHigh * (rangeHigh - rangeLow)] }
    };
  }
  if (!sslOk) {
    return {
      signal: null, phase: 'الديسكاونت بلغ — بانتظار تعدي ssl الداخلي (شرط بعد تعدي bsl)',
      phaseDetail: { discountLevel, needSsl }, invalid: null, waiting: { sslLevels: internal.openSsl.slice(0, 4) }
    };
  }

  // نموذج 2: إخراج المشترين المبكرين (سويب ssl حصل) + ابتلاع شرائي على آخر شمعتين
  const last = candles[n - 1], prev = candles[n - 2];
  const bullPair = isBullishPair(prev, last);
  const bullishEngulf = isBullishEngulfing(prev, last);
  if (lastSweepLow != null && bullPair && numOrNaN(last.close) > lastSweepLow) {
    model2Ready = true;
  }
  // نموذج 1: سويب ssl + صعود + choch up داخلي (إغلاق فوق آخر قمة داخلية هابطة)
  let internalChochUp = false;
  if (model1Ready) {
    const lowerHighs = internal.bsl.filter(z => z.time >= candles[chochIdx].time && z.state === 'broken').map(z => z.level);
    const lastClosed = candles[n - 1].close;
    const nearestLowerHigh = lowerHighs.length ? Math.min(...lowerHighs) : null;
    // choch up داخلي: إغلاق فوق آخر bsl داخلي مكسور تحت نطاق الرِجل العلوية
    const recentBsl = internal.bsl
      .filter(z => z.i > chochIdx && z.level < rangeHigh && z.level > numOrNaN(last))
      .map(z => z.level);
    const target = nearestLowerHigh ?? (recentBsl.length ? Math.min(...recentBsl) : null);
    if (target != null && numOrNaN(lastClosed) > target) internalChochUp = true;
  }

  const price = numOrNaN(last.close);
  if (model1Ready && internalChochUp) {
    const stop = lastSweepLow - Math.max(lastSweepLow * bandPct, 0.25 * a);
    const tp2 = ctx.externalBslAbove?.find(v => v > chochHigh) ?? null;
    const risk = price - stop;
    const rr1 = risk > 0 ? (chochHigh - price) / risk : 0;
    if (price > stop && rr1 >= minRR) {
      return {
        signal: {
          model: 1, at: last.time, price,
          entry: price, stop, tp1: chochHigh, tp2,
          rr: Number(rr1.toFixed(2)),
          stopRef: lastSweepLow,
          reasons: [
            'choch up: اختراق قمة محمية بخطواتها الخمس',
            `الديسكاونت بلغ (فيبو ≤ ${(discountPos * 100).toFixed(0)}%)`,
            'سويب SSL داخلي + إعادة تحمّل',
            'choch up داخلي بتأكيد إغلاق'
          ]
        },
        phase: 'إشارة نموذج 1', phaseDetail: { tp1: chochHigh, tp2 }, invalid: null,
        waiting: {}
      };
    }
  }
  if (model2Ready && bullishEngulf) {
    const stop = lastSweepLow - Math.max(lastSweepLow * bandPct, 0.25 * a);
    const tp2 = ctx.externalBslAbove?.find(v => v > chochHigh) ?? null;
    const risk = price - stop;
    const rr1 = risk > 0 ? (chochHigh - price) / risk : 0;
    if (price > stop && rr1 >= minRR) {
      return {
        signal: {
          model: 2, at: last.time, price,
          entry: price, stop, tp1: chochHigh, tp2,
          rr: Number(rr1.toFixed(2)),
          stopRef: lastSweepLow,
          reasons: [
            'choch up: اختراق قمة محمية بخطواتها الخمس',
            `الديسكاونت بلغ (فيبو ≤ ${(discountPos * 100).toFixed(0)}%)`,
            'إخراج المشترين المبكرين (سويب ssl واستعادة)',
            'ابتلاع شرائي مؤكد'
          ]
        },
        phase: 'إشارة نموذج 2', phaseDetail: { tp1: chochHigh, tp2 }, invalid: null,
        waiting: {}
      };
    }
  }

  // توثيق رفض R:R — النموذج مكتمل لكن الهدف القريب يجعل المخاطرة غير مجدية (بلا صمت)
  const readyModel = (model1Ready && internalChochUp) ? 1 : ((model2Ready && bullishEngulf) ? 2 : null);
  if (readyModel != null) {
    const sweepRef = lastSweepLow;
    const stopCalc = sweepRef - Math.max(sweepRef * bandPct, 0.25 * a);
    const rrCalc = (price - stopCalc) > 0 ? (chochHigh - price) / (price - stopCalc) : 0;
    if (rrCalc < minRR) {
      return {
        signal: null,
        phase: 'النموذج مكتمل لكن R:R دون الحد — لا دخول',
        phaseDetail: { rr: Number(rrCalc.toFixed(2)), minRR, tp1: chochHigh, stop: stopCalc },
        invalid: null,
        waiting: { chochHigh }
      };
    }
  }

  return {
    signal: null,
    phase: 'الديسكاونت بلغ وssl متحقق — بانتظار تأكيد النموذج',
    phaseDetail: {
      discountLevel, model1Progress: model1Ready, model2Progress: model2Ready,
      internalChochUp, bullishPair: bullPair, lastSweepLow
    },
    invalid: null,
    waiting: { chochHigh, tp1: chochHigh }
  };
}

/* ================= المُنسِّق: سياق كامل لرمز/فريم من شموعه ================= */

/**
 * المعالجة الكاملة لرمز/فريم: تجميع HTF ×8 + الهياكل + آلة القمم/القيعان + تدفق الشراء.
 * يعيد كل ما تحتاجه الواجهة: الاتجاه + المرحلة + المناطق + الإشارة أو سبب الانتظار.
 */
export function analyzeCandles(candles, opts = {}) {
  const price = opts.price ?? (candles.length ? numOrNaN(candles[candles.length - 1].close) : NaN);
  const htf = aggregateX8(candles);
  const ctx = buildHtfContext(htf, { price });
  const internal = buildInternal(candles);
  const phScan = scanProtectedHigh(candles, internal);
  const plScan = scanProtectedLow(candles, internal);
  const flow = scanBuyFlow(candles, ctx, internal, phScan, opts);

  // حكم الاتجاه الخارجي: بلوغ/تجاوز العرض الخارجي يقتل أي مشوار صاعد
  // (أ) HTF هابط + السعر عند/فوق أقرب bsl خارجية
  // (ب) HTF صاعد بعد تعافٍ من هابط أكبر + السعر بلغ مستوى موت المشوار (bsl خارجية سابقة)
  let upLegDead = false;
  if (Number.isFinite(price)) {
    if (ctx.direction === 'down') {
      const all = ctx.externalBslAll ?? [];
      if (all.length) {
        const above = all.filter(v => v >= price);
        const death = above.length ? Math.min(...above) : all[all.length - 1];
        if (price >= death * 0.999) upLegDead = true;
      }
    } else if (ctx.direction === 'up' && ctx.upLegDeathLevel != null && price >= ctx.upLegDeathLevel) {
      upLegDead = true;
    }
  }

  return {
    price,
    atr: atr(candles, candles.length - 1),
    htf: {
      direction: ctx.direction,
      afterPremium: ctx.afterPremium,
      protectedHigh: ctx.protectedHigh,
      protectedLow: ctx.protectedLow,
      externalBslAbove: ctx.externalBslAbove.slice(0, 4),
      externalSslBelow: ctx.externalSslBelow.slice(0, 4),
      range: ctx.range,
      lastBreak: ctx.lastBreak,
      candles: htf.slice(-40)
    },
    internal: {
      trend: internal.internalTrend,
      openBsl: internal.openBsl.slice(0, 6),
      openSsl: internal.openSsl.slice(0, 6),
      lastSellersInduced: internal.lastSellersInduced,
      lastBuyersInduced: internal.lastBuyersInduced
    },
    protectedHigh: phScan.completed
      ? { level: phScan.completed.protectedHigh, at: phScan.completed.formedAt, steps: phScan.completed.steps }
      : null,
    protectedHighInProgress: phScan.inProgress,
    protectedLow: plScan.completed
      ? { level: plScan.completed.protectedLow, at: plScan.completed.formedAt, steps: plScan.completed.steps }
      : null,
    flow,
    upLegDead,
    candles: candles.slice(-60)
  };
}
