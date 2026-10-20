/**
 * الطبقة 2 (v2): الاختلال السعري — FVG ومناطق العرض/الطلب وفق تعريف صاحب النظام ومعيار SMC/ICT.
 *
 * مبادئ صارمة:
 *  - دوال نقية حتمية: لا Date.now ولا شبكة ولا مؤقتات ولا عشوائية.
 *  - لا معلومة مستقبلية: حساب الشمعة i يعتمد على شموع ≤ i فقط، والإبطال/الامتلاء يُحسبان حتى endIndex الممرر.
 *  - مقاومة للمدخلات الفاسدة: []، NaN، شموع ناقصة، structureEvents غير مصفوفة → لا رمي.
 *  - كل العتبات من opts بلا قيم مخفية داخل المنطق (القيم الافتراضية معلنة في DEFAULT_OPTS).
 *
 * نستورد من المحرك بلا تعديل: normalizeCandles, atrAt, adaptiveConfig.
 */
import { normalizeCandles, atrAt, adaptiveConfig } from '../engine.mjs';

/** العتبات الافتراضية — معلنة صراحةً، وكلها قابلة للتجاوز عبر opts */
export const DEFAULT_OPTS = {
  minSizeAtr: 0.25,   // حد أدنى لحجم الفجوة بوحدات ATR
  atrPeriod: 14,      // فترة ATR
  maxFvgAge: 0        // 0 = بلا حد للعمر (يُحسب حتى endIndex فقط)
};

const isFiniteNum = (v) => typeof v === 'number' && Number.isFinite(v);

/** شمعة صالحة: كل الحقول الرقمية منتهية */
function validCandle(c) {
  return Boolean(c)
    && isFiniteNum(c.open) && isFiniteNum(c.high) && isFiniteNum(c.low) && isFiniteNum(c.close)
    && isFiniteNum(c.time);
}

/** تطبيع آمن: يقبل مصفوفة أو أي شيء آخر (يعيد []) */
function safeCandles(raw) {
  if (!Array.isArray(raw)) return [];
  let out;
  try {
    out = normalizeCandles(raw);
  } catch {
    out = [];
  }
  return Array.isArray(out) ? out : [];
}

/** تطبيع آمن لأحداث البنية: غير مصفوفة → []، ويُستبعد كل حدث غير صالح */
function safeEvents(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.filter(e => e && typeof e === 'object' && isFiniteNum(e.index) && isFiniteNum(e.price));
}

/** دمج العتبات: opts يتجاوز الافتراضي، والقيم غير الصالحة تُستبعد */
function resolveOpts(opts) {
  const o = (opts && typeof opts === 'object') ? opts : {};
  const merged = { ...DEFAULT_OPTS };
  for (const k of Object.keys(DEFAULT_OPTS)) {
    if (isFiniteNum(o[k])) merged[k] = o[k];
  }
  return merged;
}

/** اتجاه الفجوة: صاعدة (bullish) أو هابطة (bearish) */
const dirOf = (kind) => (kind === 'bullish' ? 'up' : 'down');

/** هل الحدث البنيوي في اتجاه الفجوة؟ يقبل 'bullish'/'bearish' أو 'up'/'down' */
function eventMatchesDirection(ev, kind) {
  if (kind === 'bullish' || kind === 'up') return ev.type === 'bos_up' || ev.type === 'choch_up';
  return ev.type === 'bos_down' || ev.type === 'choch_down';
}

/**
 * كشف فجوات القيمة العادلة (FVG) بالتعريف الثلاثي.
 * الفجوة الصاعدة: high[i-1] < low[i+1]  → النطاق [high[i-1], low[i+1]]
 * الفجوة الهابطة: low[i-1] > high[i+1]  → النطاق [high[i+1], low[i-1]]
 * الشمعة الوسطى i هي شمعة الإدفاع.
 *
 * @param {Array} candles شموع {time, open, high, low, close, volume, index}
 * @param {number} endIndex آخر شمعة مسموح النظر إليها (لا معلومة مستقبلية)
 * @param {Array} structureEvents أحداث بنيوية مُمرَّرة (لا نستورد وحدة البنية)
 * @param {Object} opts { minSizeAtr, atrPeriod, maxFvgAge }
 * @returns {Array} [{ index, time, kind, top, bottom, sizeAtr, filledPct, invalidatedAt, triggered, brakeless, skipReason }]
 */
export function detectFvgs(candles, endIndex, structureEvents = [], opts = {}) {
  const cs = safeCandles(candles);
  const events = safeEvents(structureEvents);
  const cfg = resolveOpts(opts);
  const n = cs.length;
  if (n < 3) return [];

  // endIndex: غير صالح → آخر شمعة؛ وإلا يُقصّ داخل الحدود
  let end = isFiniteNum(endIndex) ? Math.floor(endIndex) : n - 1;
  if (end > n - 1) end = n - 1;
  if (end < 2) return [];

  const out = [];
  for (let i = 1; i <= end - 1; i += 1) {
    const prev = cs[i - 1];
    const next = cs[i + 1];
    if (!validCandle(prev) || !validCandle(next)) continue;

    // التعريف الثلاثي: الفجوة بين high[i-1] و low[i+1] (صاعدة) أو low[i-1] و high[i+1] (هابطة)
    let kind = null;
    let top = null;
    let bottom = null;
    if (prev.high < next.low) {
      kind = 'bullish';
      top = next.low;
      bottom = prev.high;
    } else if (prev.low > next.high) {
      kind = 'bearish';
      top = prev.low;
      bottom = next.high;
    }
    if (!kind) continue;

    const size = top - bottom;
    if (!(size > 0)) continue;

    // حد أدنى لحجم الفجوة بـATR
    const atr = atrAt(cs, i, cfg.atrPeriod);
    const sizeAtr = size / Math.max(atr, 1e-12);
    if (sizeAtr < cfg.minSizeAtr) continue;

    // الإبطال بالامتلاء الكامل فقط — يُحسب حتى endIndex الممرر
    let filledPct = 0;
    let invalidatedAt = null;
    for (let j = i + 1; j <= end; j += 1) {
      const c = cs[j];
      if (!validCandle(c)) continue;
      const overlap = Math.min(c.high, top) - Math.max(c.low, bottom);
      if (overlap > 0) {
        const pct = (overlap / size) * 100;
        if (pct > filledPct) filledPct = pct;
      }
      // اللمس الكامل: الشمعة تغطي كامل نطاق الفجوة
      if (c.low <= bottom && c.high >= top) {
        invalidatedAt = c.time;
        filledPct = 100;
        break;
      }
    }

    // شرط البوس/CHoCH: حدث بنيوي خارجي في اتجاه الفجوة عند i+1 أو لاحقة
    let triggered = false;
    let bosIndex = null;
    for (const ev of events) {
      if (ev.index < i + 1 || ev.index > end) continue;
      if (ev.external !== true) continue;
      if (!eventMatchesDirection(ev, kind)) continue;
      triggered = true;
      if (bosIndex == null || ev.index < bosIndex) bosIndex = ev.index;
    }

    out.push({
      index: i,
      time: cs[i].time,
      kind,
      top,
      bottom,
      sizeAtr,
      filledPct,
      invalidatedAt,
      triggered,
      brakeless: !triggered,
      skipReason: triggered ? null : 'no_structural_break'
    });
  }
  return out;
}

/** هل توجد فجوة صاعدة/هابطة عند فهرس معيّن؟ */
function fvgAt(fvgs, index, kind) {
  return fvgs.find(f => f.index === index && f.kind === kind) ?? null;
}

/** هل يوجد حدث بنيوي خارجي في الاتجاه عند فهرس ≥ fromIndex؟ */
function externalBreakAt(events, fromIndex, kind, end) {
  for (const ev of events) {
    if (ev.index < fromIndex || ev.index > end) continue;
    if (ev.external !== true) continue;
    if (!eventMatchesDirection(ev, kind)) continue;
    return ev;
  }
  return null;
}

/**
 * كشف مناطق العرض/الطلب بثلاثة أشكال مقبولة (A/B/C).
 * الحدود من الذيل إلى الذيل (zoneHigh/zoneLow) ومن الإغلاق إلى الإغلاق (bodyHigh/bodyLow).
 * الاعتماد يشترط حادثة الكسر (bosIndex مثبت)، وإلا provisional:true.
 *
 * @param {Array} candles شموع
 * @param {Array} fvgs مخرج detectFvgs
 * @param {Array} structureEvents أحداث بنيوية مُمرَّرة
 * @param {number} endIndex آخر شمعة مسموح النظر إليها
 * @param {Object} opts { minSizeAtr, atrPeriod, maxFvgAge }
 * @returns {Array} [{ index, time, kind, form, zoneHigh, zoneLow, bodyHigh, bodyLow, originCandleIndex, fvgs, bosIndex, confirmed, provisional }]
 */
export function detectSupplyDemand(candles, fvgs, structureEvents = [], endIndex, opts = {}) {
  const cs = safeCandles(candles);
  const list = Array.isArray(fvgs) ? fvgs.filter(f => f && isFiniteNum(f.index) && isFiniteNum(f.top) && isFiniteNum(f.bottom)) : [];
  const events = safeEvents(structureEvents);
  const cfg = resolveOpts(opts);
  const n = cs.length;
  if (n < 3 || !list.length) return [];

  let end = isFiniteNum(endIndex) ? Math.floor(endIndex) : n - 1;
  if (end > n - 1) end = n - 1;
  if (end < 2) return [];

  const out = [];
  const seen = new Set();

  const push = (zone) => {
    const key = `${zone.kind}|${zone.form}|${zone.originCandleIndex}|${zone.index}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(zone);
  };

  // بناء منطقة من شمعة أصلية + قائمة فجوات + اتجاه
  const build = (originIndex, kind, form, fvgList) => {
    const origin = cs[originIndex];
    if (!validCandle(origin)) return;
    const dir = kind === 'demand' ? 'up' : 'down';
    const bos = externalBreakAt(events, originIndex + 1, dir, end);
    const bosIndex = bos ? bos.index : null;
    const confirmed = bosIndex != null;
    push({
      index: originIndex,
      time: origin.time,
      kind,
      form,
      zoneHigh: origin.high,
      zoneLow: origin.low,
      bodyHigh: Math.max(origin.open, origin.close),
      bodyLow: Math.min(origin.open, origin.close),
      originCandleIndex: originIndex,
      fvgs: fvgList.map(f => ({ index: f.index, time: f.time, kind: f.kind, top: f.top, bottom: f.bottom })),
      bosIndex,
      confirmed,
      provisional: !confirmed
    });
  };

  // ---- الشكل A: كسر قاع سابق + FVG + كسر قمة (طلب) / كسر قمة سابقة + FVG + كسر قاع (عرض)
  for (let i = 1; i <= end - 1; i += 1) {
    const c = cs[i];
    if (!validCandle(c)) continue;
    const bullFvg = fvgAt(list, i, 'bullish');
    const bearFvg = fvgAt(list, i, 'bearish');
    if (bullFvg) {
      // كسر أدنى سعر لشمعة سابقة (قاع فرعي/دعم)
      let brokeLow = false;
      for (let k = 0; k < i; k += 1) {
        if (validCandle(cs[k]) && c.low < cs[k].low) { brokeLow = true; break; }
      }
      if (brokeLow) build(i, 'demand', 'A', [bullFvg]);
    }
    if (bearFvg) {
      let brokeHigh = false;
      for (let k = 0; k < i; k += 1) {
        if (validCandle(cs[k]) && c.high > cs[k].high) { brokeHigh = true; break; }
      }
      if (brokeHigh) build(i, 'supply', 'A', [bearFvg]);
    }
  }

  // ---- الشكل C: شمعة يليها FVG مباشرة (i+1) ثم كسر قمة (طلب) / كسر قاع (عرض)
  for (let i = 1; i <= end - 2; i += 1) {
    const c = cs[i];
    if (!validCandle(c)) continue;
    const bullFvg = fvgAt(list, i + 1, 'bullish');
    const bearFvg = fvgAt(list, i + 1, 'bearish');
    if (bullFvg) build(i, 'demand', 'C', [bullFvg]);
    if (bearFvg) build(i, 'supply', 'C', [bearFvg]);
  }

  // ---- الشكل B: FVG ثم تذبذب ثم FVG آخر (طلب) / والعكس (عرض)
  for (let i = 1; i <= end - 1; i += 1) {
    const c = cs[i];
    if (!validCandle(c)) continue;
    const bullFvg = fvgAt(list, i, 'bullish');
    const bearFvg = fvgAt(list, i, 'bearish');
    if (bullFvg) {
      const second = list.find(f => f.kind === 'bullish' && f.index > i + 1 && f.index <= end);
      if (second) build(i, 'demand', 'B', [bullFvg, second]);
    }
    if (bearFvg) {
      const second = list.find(f => f.kind === 'bearish' && f.index > i + 1 && f.index <= end);
      if (second) build(i, 'supply', 'B', [bearFvg, second]);
    }
  }

  return out;
}
