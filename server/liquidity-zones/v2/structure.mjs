import { normalizeCandles, atrAt, adaptiveConfig, findPivots } from '../engine.mjs';

/**
 * الطبقة 2: هيكل السوق وفق تعريف صاحب النظام (SMC/ICT) — حتمية بالكامل.
 * لا معلومة مستقبلية: كل قرار في الشمعة i يُبنى على شموع ≤ i فقط.
 * لا شبكة ولا مؤقتات ولا Date.now داخل النتائج.
 *
 * المفاهيم المنفَّذة حرفياً:
 *  - الحركة الارتدادية: لا يُعتمد لون الشمعة بل السعر؛ الارتداد = كسر هاي/لو الشمعة السابقة.
 *  - الشمعة الداخلية: لا تكسر هاي ولا لو السابقة → تُهمل تماماً ولا تدخل عدّ الارتدادات.
 *  - الشمعة الاحتوائية (Engulfing): تحتوي السابقة (high ≥ السابقة و low ≤ السابقة) → لا يُحسم
 *    الاتجاه منها؛ يُعلَّق الحكم حتى الشمعة التالية.
 *  - IDM: آخر حركة ارتدادية قبل القمة/القاع الحقيقية؛ ولا تُعدّ القمة/القاع مؤكدة إلا بكسر IDM.
 *    الكسر يُحسب بالذيل أو بالإغلاق، أيهما سبق.
 *  - البوس الصاعد: صعود → IDM → صعود وقمة1 → هبوط يكسر IDM → قاع1 → صعود يكسر قمة1
 *    بالإغلاق فقط = بوس صاعد. والعكس في الهابط.
 *  - CHoCH down = كسر قاع1 بالإغلاق فقط داخل سيناريو البوس الصاعد (والعكس choch up).
 *  - شرط البنية الخارجية: البوس/CHoCH يُحتسب فقط على قمة/قاع خارجي لا داخلي.
 */

export const STRUCTURE_EVENT_TYPES = ['idm', 'bos_up', 'bos_down', 'choch_up', 'choch_down'];

const EPS = 1e-12;

/** تحويل آمن إلى رقم منتهٍ — يمنع تسرّب NaN/نصوص إلى النتائج */
const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** شمعة صالحة: كل الحقول الرقمية منتهية */
const validCandle = (c) => Boolean(c)
  && Number.isFinite(c.high) && Number.isFinite(c.low)
  && Number.isFinite(c.close) && Number.isFinite(c.open);

/**
 * تطبيع المدخل إلى شموع صالحة حتى endIndex (شامل).
 * يقبل مصفوفة REST خام (10 عناصر) أو كائنات شموع. يعيد [] عند الفساد.
 */
function prepareCandles(raw, endIndex) {
  if (!Array.isArray(raw) || raw.length === 0) return [];
  let candles;
  try {
    candles = normalizeCandles(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(candles)) return [];
  const end = Number.isInteger(endIndex) ? endIndex : candles.length - 1;
  if (end < 0) return [];
  const slice = candles.slice(0, Math.min(end, candles.length - 1) + 1);
  return slice.filter(validCandle);
}

/**
 * تصنيف الارتدادات على السعر (لا اللون):
 *  - كسر هاي السابقة → ارتداد صاعد (up).
 *  - كسر لو السابقة → ارتداد هابط (down).
 *  - لا كسر (شمعة داخلية) → تُهمل تماماً.
 *  - احتوائية (high ≥ السابقة و low ≤ السابقة) → لا يُحسم الاتجاه؛ يُعلَّق حتى الشمعة التالية.
 * يعيد قائمة ارتدادات مؤكدة: { index, time, price, kind, direction, basis }.
 * `basis` = 'wick' إن تحقق الكسر بالذيل، أو 'close' إن تحقق بالإغلاق فقط.
 */
function detectReactions(candles) {
  const out = [];
  let pending = null; // شمعة احتوائية معلّقة بانتظار الحسم
  for (let i = 1; i < candles.length; i += 1) {
    const prev = candles[i - 1];
    const c = candles[i];
    const brokeHigh = c.high > prev.high;
    const brokeLow = c.low < prev.low;
    const engulfing = c.high >= prev.high && c.low <= prev.low;

    // احتوائية: لا يُحسم الاتجاه منها — يُعلَّق الحكم حتى الشمعة التالية
    if (engulfing) {
      pending = { index: i, time: c.time, high: c.high, low: c.low };
      continue;
    }

    // شمعة داخلية: لا تكسر هاي ولا لو السابقة → تُهمل تماماً
    if (!brokeHigh && !brokeLow) continue;

    // حسم الشمعة المعلّقة (الاحتوائية) بالشمعة التالية: الاتجاه من كسر هذه الشمعة
    const ref = pending ?? prev;
    const up = c.high > ref.high;
    const down = c.low < ref.low;
    if (!up && !down) { pending = null; continue; }

    const direction = up && !down ? 'up' : down && !up ? 'down' : (c.close >= c.open ? 'up' : 'down');
    const kind = direction === 'up' ? 'high' : 'low';
    const price = direction === 'up' ? c.high : c.low;
    // الأساس: هل تحقق الكسر بالذيل أم بالإغلاق فقط؟
    const closeBroke = direction === 'up' ? c.close > ref.high : c.close < ref.low;
    const basis = closeBroke ? 'close' : 'wick';
    out.push({ index: i, time: c.time, price, kind, direction, basis });
    pending = null;
  }
  return out;
}

/**
 * تصنيف القمم/القيعان إلى خارجي/داخلي وفق قاعدة قابلة للقياس:
 *  - خارجي إذا كان prominenceAtr >= externalMinAtr
 *    و لم يُحتَره pivot أحدث منه بنفس النوع (سعره أقصى/أدنى من سعر أي pivot أحدث حتى نهاية النافذة).
 *  - وإلا فهو داخلي.
 * يعيد نسخة من pivots مع حقل level: 'external'|'internal'.
 */
export function classifyExternalPivots(pivots, candles, endIndex, opts = {}) {
  const list = Array.isArray(pivots) ? pivots.filter(p => p && Number.isFinite(p.price)) : [];
  if (!list.length) return [];
  const externalMinAtr = Number.isFinite(opts.externalMinAtr) ? opts.externalMinAtr : 1.0;
  const end = Number.isInteger(endIndex) ? endIndex : (Array.isArray(candles) ? candles.length - 1 : -1);

  return list.map((p) => {
    const prom = Number.isFinite(p.prominenceAtr) ? p.prominenceAtr : 0;
    const strongEnough = prom >= externalMinAtr;
    // هل يحوطه pivot أحدث بنفس النوع؟ (بالنسبة لنوعه: قمة أحدث أعلى، قاع أحدث أدنى)
    const newer = list.filter(q => q.kind === p.kind && q.index > p.index && q.index <= end);
    const engulfed = p.kind === 'high'
      ? newer.some(q => q.price >= p.price)
      : newer.some(q => q.price <= p.price);
    const level = strongEnough && !engulfed ? 'external' : 'internal';
    return { ...p, level };
  });
}

/**
 * كشف IDM: آخر حركة ارتدادية **معاكسة** قبل القمة/القاع الحقيقية (قاع السحب قبل القمة).
 *  - قمة حقيقية → آخر ارتداد هابط قبلها (IDM = قاع السحب، kind='low')، يُكسر بـ low < price.
 *  - قاع حقيقي → آخر ارتداد صاعد قبلها (IDM = قمة السحب، kind='high')، يُكسر بـ high > price.
 * الكسر يُعتبر محققاً إن وقع high > price (لكسر IDM هابط) أو low < price (لكسر IDM صاعد).
 * `brokenBy` = الحقل الذي تحقق به الكسر فعلاً ('wick'|'close')، و`brokenKind` = نوع الكسر.
 * يعيد [{ index, time, price, kind, brokenAt, brokenIndex, brokenBy, brokenKind, prominenceAtr, confirmed, forExtreme }].
 */
export function detectInducement(candles, pivots, endIndex, opts = {}) {
  const cs = prepareCandles(candles, endIndex);
  if (cs.length < 3) return [];
  const list = Array.isArray(pivots) ? pivots.filter(p => p && Number.isFinite(p.price) && Number.isFinite(p.index)) : [];
  if (!list.length) return [];
  const end = cs.length - 1;
  const reactions = detectReactions(cs);
  const out = [];

  for (const p of list) {
    if (p.index > end) continue;
    // IDM = الحركة الارتدادية المعاكسة قبل القمة/القاع (قاع السحب قبل القمة، وقمة السحب قبل القاع)
    const wantDir = p.kind === 'high' ? 'down' : 'up';
    const prior = reactions.filter(r => r.direction === wantDir && r.index < p.index);
    if (!prior.length) continue;
    const idm = prior[prior.length - 1];
    const idmPrice = idm.price;
    // idmKind يصف سعر مستوى IDM: قاع السحب = 'low' (يُكسر بهبوط تحته)، وقمة السحب = 'high' (تُكسر بصعود فوقها)
    const idmKind = idm.kind;

    // البحث عن أول شمعة تالية تكسر IDM (ذيل أو إغلاق، أيهما سبق)
    let brokenIndex = null;
    let brokenBy = null;
    let brokenKind = null;
    for (let i = p.index + 1; i <= end; i += 1) {
      const c = cs[i];
      /**
       * عطل مُثبت كان هنا: **اتجاه الكسر معكوس**.
       *
       * `idmKind` يصف نوع **سعر** مستوى IDM لا اتجاه الحركة: قاع السحب = 'low'، وقمة السحب
       * قبل القاع = 'high'. وكسر القاع يقع **بهبوط تحته** (`low < price`)، وكسر القمة
       * **بصعود فوقها** (`high > price`). الكود كان يفعل العكس تماماً: كان يكسر القاع
       * بـ`high > price`، أي يصبح أي صعود طفيف فوق القاع «كسر IDM» — وهو ما جعل اختبار
       * الذيل يُرجع 'close' واختبار الإغلاق يُرجع 'wick' (انقلاب متبادل).
       */
      if (idmKind === 'low') {
        // قاع السحب: يُكسر بالهبوط تحته، والإغلاق أدنى منه يعني كسراً بالإغلاق لا بالذيل
        if (c.low < idmPrice) {
          brokenIndex = i;
          brokenBy = c.close < idmPrice ? 'close' : 'wick';
          brokenKind = 'wick';
          break;
        }
      } else if (c.high > idmPrice) {
        // قمة السحب قبل القاع: تُكسر بالصعود فوقها
        brokenIndex = i;
        brokenBy = c.close > idmPrice ? 'close' : 'wick';
        brokenKind = 'wick';
        break;
      }
    }

    out.push({
      index: idm.index,
      time: idm.time,
      price: idmPrice,
      kind: idmKind,
      brokenAt: brokenIndex != null ? cs[brokenIndex].time : null,
      brokenIndex,
      brokenBy,
      brokenKind,
      prominenceAtr: Number.isFinite(p.prominenceAtr) ? p.prominenceAtr : 0,
      confirmed: brokenIndex != null,
      // القمة/القاع الحقيقية التي يخصّها هذا الـIDM (بوابة تأكيد البوس)
      forExtreme: { index: p.index, kind: p.kind }
    });
  }
  return out;
}

/**
 * كشف أحداث البنية: BOS / CHoCH وفق سيناريو البوس الصاعد/الهابط.
 * البوس الصاعد: صعود → IDM → قمة1 → هبوط يكسر IDM → قاع1 → صعود يكسر قمة1 بالإغلاق فقط.
 * CHoCH down = كسر قاع1 بالإغلاق فقط داخل سيناريو البوس الصاعد (والعكس choch up).
 * شرط البنية الخارجية: يُحتسب الحدث فقط على قمة/قاع خارجي (level === 'external').
 * يعيد [{ type, index, time, price, brokenLevel, brokenPivotIndex, confirmBasis, external, priorBos, evidence }].
 */
export function detectStructureEvents(candles, pivots, endIndex, opts = {}) {
  const cs = prepareCandles(candles, endIndex);
  if (cs.length < 3) return [];
  const list = Array.isArray(pivots) ? pivots.filter(p => p && Number.isFinite(p.price) && Number.isFinite(p.index)) : [];
  if (!list.length) return [];
  const end = cs.length - 1;
  const classified = classifyExternalPivots(list, cs, end, opts);
  const events = [];

  // أحداث IDM أولاً (تُدرج كأحداث معلنة)
  const idms = detectInducement(cs, list, end, opts);
  for (const idm of idms) {
    events.push({
      type: 'idm',
      index: idm.index,
      time: idm.time,
      price: idm.price,
      brokenLevel: idm.price,
      brokenPivotIndex: idm.index,
      confirmBasis: idm.brokenBy ?? 'wick',
      external: true,
      priorBos: null,
      evidence: { kind: idm.kind, brokenIndex: idm.brokenIndex, confirmed: idm.confirmed }
    });
  }

  // ترتيب القمم/القيعان الخارجية زمنياً
  const extHighs = classified.filter(p => p.kind === 'high' && p.level === 'external').sort((a, b) => a.index - b.index);
  const extLows = classified.filter(p => p.kind === 'low' && p.level === 'external').sort((a, b) => a.index - b.index);

  /**
   * سيناريو صاعد (حرفياً كما حدّده صاحب النظام):
   *   صعود → IDM (قاع السحب) → قمة 1 → هبوط **يكسر IDM** (ذيل أو إغلاق) → قاع 1 →
   *   صعود **يكسر قمة 1 بالإغلاق فقط** = bos_up. ثم إغلاق تحت قاع 1 = choch_down.
   * كسر IDM بوابة إلزامية: لا بوس بلا كسر IDM الذي يسبق قمة 1.
   */
  for (let h = 0; h < extHighs.length; h += 1) {
    const high1 = extHighs[h];
    // بوابة 1: كسر IDM الذي يخصّ قمة 1 (يؤكّد القمة)
    const idmBefore = idms
      .filter(x => x.forExtreme.index === high1.index && x.confirmed)
      .filter(x => x.brokenIndex > high1.index)
      .sort((a, b) => a.brokenIndex - b.brokenIndex)[0];
    if (!idmBefore) continue;
    // قاع 1: أول قاع خارجي بعد كسر IDM
    const low1 = extLows.find(l => l.index > idmBefore.brokenIndex);
    if (!low1) continue;
    // بوابة 2: كسر قمة 1 بالإغلاق فقط
    let bosIndex = null;
    for (let i = low1.index + 1; i <= end; i += 1) {
      if (cs[i].close > high1.price) { bosIndex = i; break; }
    }
    if (bosIndex != null) {
      events.push({
        type: 'bos_up',
        index: bosIndex,
        time: cs[bosIndex].time,
        price: high1.price,
        brokenLevel: high1.price,
        brokenPivotIndex: high1.index,
        idmLevel: idmBefore.price,
        idmBrokenIndex: idmBefore.brokenIndex,
        idmBrokenBy: idmBefore.brokenBy,
        confirmBasis: 'close',
        external: true,
        priorBos: null,
        evidence: { high1: high1.index, low1: low1.index, idm: idmBefore.index, close: cs[bosIndex].close }
      });
    }
    // CHoCH down: كسر قاع1 بالإغلاق فقط داخل السيناريو الصاعد (لا يشترط بوساً سابقاً)
    for (let i = low1.index + 1; i <= end; i += 1) {
      if (cs[i].close < low1.price) {
        events.push({
          type: 'choch_down',
          index: i,
          time: cs[i].time,
          price: low1.price,
          brokenLevel: low1.price,
          brokenPivotIndex: low1.index,
          confirmBasis: 'close',
          external: true,
          priorBos: bosIndex,
          evidence: { low1: low1.index, high1: high1.index, close: cs[i].close }
        });
        break;
      }
    }
  }

  /** سيناريو هابط: مرآة السيناريو الصاعد تماماً */
  for (let l = 0; l < extLows.length; l += 1) {
    const low1 = extLows[l];
    const idmBefore = idms
      .filter(x => x.forExtreme.index === low1.index && x.confirmed)
      .filter(x => x.brokenIndex > low1.index)
      .sort((a, b) => a.brokenIndex - b.brokenIndex)[0];
    if (!idmBefore) continue;
    const high1 = extHighs.find(h => h.index > idmBefore.brokenIndex);
    if (!high1) continue;
    let bosIndex = null;
    for (let i = high1.index + 1; i <= end; i += 1) {
      if (cs[i].close < low1.price) { bosIndex = i; break; }
    }
    if (bosIndex != null) {
      events.push({
        type: 'bos_down',
        index: bosIndex,
        time: cs[bosIndex].time,
        price: low1.price,
        brokenLevel: low1.price,
        brokenPivotIndex: low1.index,
        idmLevel: idmBefore.price,
        idmBrokenIndex: idmBefore.brokenIndex,
        idmBrokenBy: idmBefore.brokenBy,
        confirmBasis: 'close',
        external: true,
        priorBos: null,
        evidence: { low1: low1.index, high1: high1.index, idm: idmBefore.index, close: cs[bosIndex].close }
      });
    }
    // CHoCH up: كسر قمة 1 بالإغلاق فقط داخل السيناريو الهابط (لا يشترط بوساً سابقاً)
    for (let i = high1.index + 1; i <= end; i += 1) {
      if (cs[i].close > high1.price) {
        events.push({
          type: 'choch_up',
          index: i,
          time: cs[i].time,
          price: high1.price,
          brokenLevel: high1.price,
          brokenPivotIndex: high1.index,
          confirmBasis: 'close',
          external: true,
          priorBos: bosIndex,
          evidence: { high1: high1.index, low1: low1.index, close: cs[i].close }
        });
        break;
      }
    }
  }

  return events.sort((a, b) => a.index - b.index || a.type.localeCompare(b.type));
}
