/* نواة سجل الاتجاهات الحي — حتمية بالكامل (بلا شبكة)
 *
 * منطق المستخدم الحرفي (معمّم لكل فريم):
 *  - اتجاه كل عملة يُحدَّد من فريمها وفريمها الأكبر (تجميع ×8).
 *  - إن كان الاتجاه صاعداً: هل حصل تعدي منطقة bsl؟
 *      نعم → تحديد منطقة ديسكاونت + ssl (شرط إضافي قبل التأكيد)
 *      لا  → تحديد منطقة ديسكاونت فقط
 *  - ثم بعد بلوغ الديسكاونت: بانتظار تأكيد الدخول (حيث تتولد الإشارة عبر تدفق الشراء القائم).
 *  - هابط: رصد نهاية الهبوط (بانتظار قمة محمية / choch up).
 *  - عرضي: رصد تكوّن هيكل.
 *
 * التوافق الخلفي: الاستدعاء القديم (شموع 1m + candles5m) يعيد نفس الحقول القديمة
 * (dir1m/dir40m/atr1m) بلا أي تغيير سلوكي.
 *
 * كل الدوال نقية: نفس المدخلات → نفس المخرجات.
 */

import { aggregateX8, buildHtfContext, buildInternal, atr } from './structure.mjs';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** دقائق الفريم من رمزه */
function tfMinutes(tf) {
  const n = parseInt(tf, 10) || 1;
  const u = String(tf).replace(/[0-9]/g, '') || 'm';
  const mult = { m: 1, h: 60, d: 1440, w: 10080 }[u] ?? 1;
  return n * mult;
}

/** رمز الفريم الأكبر (×8) */
export function htfLabelOf(tf) {
  const m = tfMinutes(tf) * 8;
  if (m < 60) return `${m}m`;
  if (m % 60 === 0) return `${m / 60}h`;
  return `${Math.floor(m / 60)}h${m % 60}m`;
}

/** اتجاه بنية 1m من آخر كسور المناطق الداخلية (مساعد) */
function internalDir(internal) {
  return internal.internalTrend === 'up' ? 'up'
    : internal.internalTrend === 'down' ? 'down' : 'range';
}

/** موضع السعر ضمن رِجل الصعود الحالية (0 = القاع، 1 = القمة) — نافذة زمنية ~4 ساعات */
function upLegPosition(candles, flipLevel, price) {
  let low = Math.min(flipLevel ?? Infinity, price);
  let high = Math.max(flipLevel ?? -Infinity, price);
  const lastMs = Number(candles[candles.length - 1]?.timeMs ?? candles[candles.length - 1]?.time * 1000);
  const windowStart = lastMs - 4 * 3600_000;
  for (let i = candles.length - 1; i >= 0; i -= 1) {
    const c = candles[i];
    const ms = Number(c.timeMs ?? c.time * 1000);
    if (ms < windowStart) break;
    const h = Number(c.high), l = Number(c.low);
    if (Number.isFinite(h) && h > high) high = h;
    if (Number.isFinite(l) && l < low) low = l;
  }
  if (!Number.isFinite(low) || !Number.isFinite(high) || high <= low) return { low, high, pos: null, discountLevel: null };
  return {
    low, high,
    pos: clamp((price - low) / (high - low), 0, 1),
    discountLevel: low + 0.5 * (high - low)
  };
}

/**
 * الحالة الكاملة لاتجاه عملة واحدة على فريم معين.
 * @param candles شموع الفريم الأساسي (1m: ≥120 · غيرها: ≥96)
 * @param opts { price, candles5m?, candlesConfirm?, tf?, confirmTf? }
 *  - candles5m: توافق 40m للتوافق الخلفي (1m فقط)
 *  - candlesConfirm + confirmTf: تأكيد عام لأي فريم
 *  - tf: رمز الفريم الأساسي (افتراضي '1m')
 */
export function computeDirectionState(candles, { price = null, candles5m = null, candlesConfirm = null, tf = null, confirmTf = null } = {}) {
  const baseTf = tf ?? '1m';
  const confirm = candlesConfirm ?? candles5m ?? null;
  const confTf = confirmTf ?? (confirm != null ? (baseTf === '1m' ? '40m' : htfLabelOf(baseTf)) : null);
  const minBars = baseTf === '1m' ? 120 : 96;
  const candles1m = candles;
  const empty = {
    dir: 'range', dirTF: 'range', dirHTF: null, tf: baseTf, htfTf: htfLabelOf(baseTf), agreement: 'single',
    stage: 'جارٍ تكوين البنية — شموع غير كافية', stageDetail: {},
    anchorHigh: null, anchorLow: null, afterPremium: null,
    externalNext: null, distToExternalPct: null,
    deathLevel: null, dead: false,
    discountLevel: null, legLow: null, legHigh: null,
    price: Number.isFinite(Number(price)) ? Number(price) : null,
    atrTF: null
  };
  if (!Array.isArray(candles1m) || candles1m.length < minBars) return empty;

  const px = Number.isFinite(Number(price))
    ? Number(price)
    : Number(candles1m[candles1m.length - 1]?.close);

  // 1) الفريم الأكبر (×8): الاتجاه الحاكم
  const htf = aggregateX8(candles1m);
  const ctx = buildHtfContext(htf, { price: px });
  // 2) بنية الفريم الأساسي الداخلية
  const internal = buildInternal(candles1m);
  // 3) التوافق من الفريم الأكبر الثاني (اختياري)
  let dirHTF = null;
  if (Array.isArray(confirm) && confirm.length >= 60) {
    dirHTF = buildHtfContext(aggregateX8(confirm), { price: px }).direction;
  }

  const dBase = internalDir(internal);
  const dir = ctx.direction; // الحاكم: بنية الفريم الأكبر
  const agreement = dirHTF == null ? 'single' : (dirHTF === dir ? 'confirmed' : 'conflicted');

  const a = atr(candles1m, candles1m.length - 1) || (px ? px * 0.001 : 1);

  const state = {
    ...empty,
    dir, dirTF: dBase, dirHTF, agreement,
    anchorHigh: ctx.protectedHigh,
    anchorLow: ctx.protectedLow,
    afterPremium: ctx.afterPremium,
    price: Number.isFinite(px) ? px : null,
    atrTF: Number.isFinite(a) ? a : null,
    stageDetail: {}
  };
  // توافق خلفي لصفوف 1m: نفس الحقول القديمة حرفياً
  if (baseTf === '1m') {
    state.dir1m = dBase;
    state.dir40m = dirHTF;
    state.atr1m = state.atrTF;
  }

  // العرض الخارجي التالي + موت المشوار
  if (Number.isFinite(px)) {
    if (dir === 'down' || dir === 'range') {
      const below = (ctx.externalSslBelow ?? [])[0] ?? null;
      state.externalNext = below;
      if (below != null) state.distToExternalPct = Number((((below - px) / px) * 100).toFixed(3));
    }
    if (dir === 'up') {
      const above = (ctx.externalBslAbove ?? [])[0] ?? null;
      state.externalNext = above;
      if (above != null) state.distToExternalPct = Number((((above - px) / px) * 100).toFixed(3));
    }
  }

  // موت المشوار الصاعد: HTF هابط وبلغ العرض الخارجي، أو HTF صاعد وبلغ مستوى الموت
  if (Number.isFinite(px)) {
    if (dir === 'down') {
      const all = ctx.externalBslAll ?? [];
      if (all.length) {
        const above = all.filter(v => v >= px);
        const death = above.length ? Math.min(...above) : all[all.length - 1];
        state.deathLevel = death;
        if (px >= death * 0.999) state.dead = true;
      }
    } else if (dir === 'up' && ctx.upLegDeathLevel != null) {
      state.deathLevel = ctx.upLegDeathLevel;
      if (px >= ctx.upLegDeathLevel) state.dead = true;
    }
  }

  /* ---- آلة المراحل — منطق المستخدم حرفياً ---- */
  if (dir === 'up' || (dir === 'range' && dBase === 'up')) {
    const flipLevel = ctx.lastBreak?.dir === 'up' ? ctx.lastBreak.level : (ctx.protectedLow ?? null);
    const leg = upLegPosition(candles1m, flipLevel, px);
    state.legLow = leg.low; state.legHigh = leg.high; state.discountLevel = leg.discountLevel;

    // هل حصل تعدي منطقة bsl داخلي بعد الانقلاب الصاعد؟
    const flipTime = ctx.lastBreak?.dir === 'up' ? ctx.lastBreak.time : null;
    const bslRetest = internal.bsl.some(z =>
      z.state === 'swept' && (flipTime == null || z.time >= flipTime));
    state.stageDetail = {
      bslRetest,
      discountReached: leg.pos != null && leg.pos <= 0.5,
      sslOpenBelow: internal.openSsl.slice(0, 3)
    };

    if (state.dead) {
      state.stage = 'المشوار الصاعد مات — بلوغ العرض الخارجي';
    } else if (bslRetest) {
      // نعم تعدي bsl → ديسكاونت + ssl
      if (leg.pos != null && leg.pos <= 0.5) {
        const sslRetested = internal.ssl.some(z => z.state === 'swept' && z.level <= (leg.high ?? Infinity) && z.level >= (leg.low ?? -Infinity));
        state.stage = sslRetested ? 'بانتظار تأكيد الدخول (ديسكاونت + ssl متحققان)'
          : 'بانتظار تعدي ssl الداخلي (بعد تعدي bsl — ديسكاونت بلغ)';
      } else {
        state.stage = 'تحديد ديسكاونت + ssl (بعد تعدي bsl)';
      }
    } else {
      // لا تعدي bsl → ديسكاونت فقط
      state.stage = (leg.pos != null && leg.pos <= 0.5)
        ? 'بانتظار تأكيد الدخول (الديسكاونت بلغ)'
        : 'تحديد ديسكاونت فقط';
    }
  } else if (dir === 'down' || (dir === 'range' && dBase === 'down')) {
    state.stage = state.dead
      ? 'الهبوط مات — بلوغ العرض الخارجي (بانتظار قمة محمية)'
      : 'رصد نهاية الهبوط — بانتظار قمة محمية / choch up';
    state.stageDetail = {
      nextSsl: state.externalNext,
      protectedLow: ctx.protectedLow,
      internalSslOpen: internal.openSsl.slice(0, 3)
    };
  } else {
    state.stage = 'رصد تكوّن هيكل (عرضي)';
    state.stageDetail = { openBsl: internal.openBsl.slice(0, 3), openSsl: internal.openSsl.slice(0, 3) };
  }

  return state;
}

/** تحديث خفيف لحظي — لا إعادة تحليل: الموت والمسافة فقط بين إغلاقات الشموع */
export function updateWithPrice(state, price) {
  const px = Number(price);
  if (!state || !Number.isFinite(px) || !Number.isFinite(state.deathLevel)) return state;
  const next = { ...state, price: px };
  if (state.deathLevel != null && px >= state.deathLevel * 0.999 && !state.dead) {
    next.dead = true;
    next.stage = state.dir === 'up'
      ? 'المشوار الصاعد مات — بلوغ العرض الخارجي'
      : 'الهبوط مات — بلوغ العرض الخارجي (بانتظار قمة محمية)';
  }
  if (state.externalNext != null) {
    next.distToExternalPct = Number((((state.externalNext - px) / px) * 100).toFixed(3));
  }
  return next;
}

/** تصنيف تغيّر الحالتين — يغذي السجل والإشعار المركزي */
export function classifyChange(prev, next) {
  if (!prev) return { kind: 'init', notify: false, label: 'تكوين أولي' };
  if (prev.dir !== next.dir) {
    const flippedUp = next.dir === 'up' && (prev.dir === 'down' || prev.dir === 'range') && next.agreement !== 'conflicted';
    return {
      kind: 'flip',
      notify: flippedUp, // إشعار مركزي فقط للانقلاب الهيكلي إلى صاعد مؤكد
      label: `انقلاب الاتجاه: ${prev.dir} → ${next.dir}`
    };
  }
  if (prev.stage !== next.stage) return { kind: 'stage', notify: false, label: `تغير المرحلة: ${next.stage}` };
  if (!prev.dead && next.dead) return { kind: 'dead', notify: false, label: 'موت المشوار — بلوغ العرض الخارجي' };
  return null;
}
