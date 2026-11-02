/**
 * نموذج الشارت التاريخي لمحركي السيولة — منطق نقي مشترك بين الواجهة والاختبارات.
 *
 * الفصل الصارم (شرط المهمة):
 *   محرك الاكتشاف (server/liquidity-zones) ← لا يُعدَّل ولا يُعاد تعريفه هنا.
 *   خدمة التاريخ ← تُمرّر مخرجات المحرك كما هي + `availableAt` (أول لحظة معرفة).
 *   هذا الملف = طبقة العرض فقط: تحويل النتائج إلى عناصر قابلة للرسم، وتحديد ما يُعرض
 *   في لحظة تاريخية، وحساب الإحداثيات، واختبار الإصابة بالنقر. لا قاعدة كشف واحدة هنا.
 *
 * قاعدة منع تسرب المستقبل:
 *   - `availableAt` = أول لحظة يمكن فيها معرفة العنصر (من الخادم، مشتقة من قاعدة
 *     تأكيد البيفوت/تكون FVG المعلنة في المحرك نفسه).
 *   - `createdAt` = زمن نشأة العنصر السعري (قد يسبق المعرفة) — يُرسم كعلامة نشأة فقط.
 *   - `confirmedAt` = زمن التأكيد الفعلي. لا يُستنتج من `createdAt` أبداً.
 *   - `sweptAt`/`invalidatedAt` = زمن انتهاء الصلاحية.
 *   - في وضع التتبع لا يُعرض أي عنصر قبل `availableAt`، ولا لمسة قبل وقتها،
 *     ولا حالة لاحقة على لحظة سابقة.
 *   - `detectedAt` (ساعة الخادم عند الحساب) لا يدخل في أي قرار عرض تاريخي.
 */

/* ------------------------------------------------------------------ */
/* ثوابت الأنواع والحالات                                              */
/* ------------------------------------------------------------------ */

/** أنواع كل محرك كما تنتجها وحداته فعلياً — لا نقل أنواع بين المحركين */
export const ENGINE_TYPES = {
  legacy: ['horizontal_bsl', 'horizontal_ssl', 'trendline_bsl', 'trendline_ssl'],
  v2: ['horizontal_bsl', 'horizontal_ssl', 'trendline_bsl', 'trendline_ssl', 'supply', 'demand']
};

/** أنواع الأحداث البنيوية — v2 فقط */
export const STRUCTURE_TYPES = ['idm', 'bos_up', 'bos_down', 'choch_up', 'choch_down'];

/**
 * بيانات كل نوع للعرض: التسمية العربية، اللون، والشكل الملزم.
 * `shape` لا يُغيَّر حسب ما يسهل رسمه: Supply/Demand مستطيل، BSL/SSL مستوى/نطاق،
 * خط الاتجاه مائل، الأحداث علامة على شمعة الحدث.
 */
export const TYPE_META = {
  horizontal_bsl: { label: 'BSL أفقي', short: 'BSL', color: '#f23645', rgb: '242,54,69', shape: 'level', group: 'liquidity' },
  horizontal_ssl: { label: 'SSL أفقي', short: 'SSL', color: '#089981', rgb: '8,153,129', shape: 'level', group: 'liquidity' },
  trendline_bsl: { label: 'خط هابط BSL', short: 'خط BSL', color: '#f23645', rgb: '242,54,69', shape: 'trendline', group: 'liquidity' },
  trendline_ssl: { label: 'خط صاعد SSL', short: 'خط SSL', color: '#089981', rgb: '8,153,129', shape: 'trendline', group: 'liquidity' },
  supply: { label: 'عرض', short: 'عرض', color: '#f97316', rgb: '249,115,22', shape: 'box', group: 'imbalance' },
  demand: { label: 'طلب', short: 'طلب', color: '#3b82f6', rgb: '59,130,246', shape: 'box', group: 'imbalance' },
  fvg: { label: 'فجوة FVG', short: 'FVG', color: '#a78bfa', rgb: '167,139,250', shape: 'box', group: 'imbalance' },
  idm: { label: 'IDM', short: 'IDM', color: '#a855f7', rgb: '168,85,247', shape: 'event', group: 'structure' },
  bos_up: { label: 'BOS صاعد', short: 'BOS↑', color: '#089981', rgb: '8,153,129', shape: 'event', group: 'structure' },
  bos_down: { label: 'BOS هابط', short: 'BOS↓', color: '#f23645', rgb: '242,54,69', shape: 'event', group: 'structure' },
  choch_up: { label: 'CHoCH صاعد', short: 'CHoCH↑', color: '#089981', rgb: '8,153,129', shape: 'event', group: 'structure' },
  choch_down: { label: 'CHoCH هابط', short: 'CHoCH↓', color: '#f23645', rgb: '242,54,69', shape: 'event', group: 'structure' },
  swing_high: { label: 'قمة (Swing High)', short: 'قمة', color: '#e2e8f0', rgb: '226,232,240', shape: 'marker', group: 'swing' },
  swing_low: { label: 'قاع (Swing Low)', short: 'قاع', color: '#e2e8f0', rgb: '226,232,240', shape: 'marker', group: 'swing' }
};

export const STATE_META = {
  candidate: { label: 'مرشحة', order: 0 },
  confirmed: { label: 'مؤكدة', order: 1 },
  swept: { label: 'مسحوبة', order: 2 },
  invalidated: { label: 'مبطلة', order: 3 }
};

/** ترتيب ثابت لخيارات الفلاتر — لا يتغيّر بتغيّر البيانات */
export const TYPE_ORDER = [
  'horizontal_bsl', 'horizontal_ssl', 'trendline_bsl', 'trendline_ssl',
  'supply', 'demand', 'fvg', 'idm', 'bos_up', 'bos_down', 'choch_up', 'choch_down',
  'swing_high', 'swing_low'
];

export const FORMATION_LABELS = { A: 'الشكل A', B: 'الشكل B', C: 'الشكل C', trendline: 'خط مركَّب', pivots: 'قمم/قيعان متكررة' };

/* ------------------------------------------------------------------ */
/* أدوات                                                              */
/* ------------------------------------------------------------------ */

const num = (v) => {
  // Number(null) === 0 و Number('') === 0 — تحويل صامت يخلق قيماً وهمية (ثقة 0، سعر 0)
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** توحيد الزمن إلى ثوانٍ — يقبل ثوانٍ أو مللي ثانية، ويرفض غير الصالح */
export const toSeconds = (v) => {
  const n = num(v);
  if (n == null || n <= 0) return null;
  return n > 1e12 ? Math.floor(n / 1000) : Math.floor(n);
};

const minDefined = (...xs) => {
  const vals = xs.filter((v) => v != null);
  return vals.length ? Math.min(...vals) : null;
};
const maxDefined = (...xs) => {
  const vals = xs.filter((v) => v != null);
  return vals.length ? Math.max(...vals) : null;
};

/* ------------------------------------------------------------------ */
/* بناء العناصر                                                        */
/* ------------------------------------------------------------------ */

/**
 * @typedef {Object} HistoryElement
 * @property {string} id
 * @property {string} typeId
 * @property {'box'|'band'|'level'|'trendline'|'event'|'marker'} shape
 * @property {string|null} zoneId
 * @property {number|null} availableAt
 * @property {number|null} createdAt
 * @property {number|null} confirmedAt
 * @property {string} confirmedBasis
 * @property {number|null} sweptAt
 * @property {number|null} invalidatedAt
 * @property {number|null} endAt
 * @property {boolean} untimed
 * @property {number|null} high
 * @property {number|null} low
 * @property {number|null} price
 * @property {number|null} priceAlt
 * @property {number|null} liquidity
 * @property {Array<{index:number|null,time:number,price:number,availableAt:number|null}>} points
 * @property {number|null} touches
 * @property {number|null} confidence
 * @property {number|null} atr
 * @property {number|null} distanceAtr
 * @property {string|null} formation
 * @property {string|null} state
 * @property {Object} raw
 */

const ZONE_STATE_LABEL = (state) => STATE_META[state]?.label ?? state;

/** زمن التأكيد الفعلي — لا يُشتق من createdAt */
function resolveConfirmation(zone, sweptAt) {
  const confirmedAt = toSeconds(zone.confirmedAt);
  if (confirmedAt != null) return { confirmedAt, basis: 'engine' };
  /**
   * المحرك القديم يترك `confirmedAt = null` للمناطق المسحوبة حتى لو كانت قد تأكدت
   * قبل السحب. `finalBreak.breakTime` هو نفس زمن الكسر الذي يستخدمه المحرك للتأكيد
   * (stateFor ← reaction.breakIndex). نستخدمه فقط إذا كانت سلسلة الكسور مكتملة
   * وكان التأكيد أسبق من السحب — وإلا فالحالة عند تلك اللحظة كانت مسحوبة فعلاً.
   */
  const finalBreak = toSeconds(zone.finalBreak?.breakTime);
  const staircaseValid = zone.staircase?.valid === true;
  if (finalBreak != null && staircaseValid && (sweptAt == null || finalBreak < sweptAt)) {
    return { confirmedAt: finalBreak, basis: 'final_break_derived' };
  }
  return { confirmedAt: null, basis: 'none' };
}

function zoneTiming(zone) {
  const createdAt = toSeconds(zone.createdAt);
  // السويب والإبطال حدثان مختلفان: السويب = بلوغ سعر السيولة، الإبطال = انتهاء الصلاحية.
  // دمجهما كان يجعل كل منطقة مسحوبة تُصنَّف «مبطلة» وتفقد حالتها الحقيقية عند المؤشر.
  const sweptAt = toSeconds(zone.sweptAt);
  // لا سقوط إلى `invalidation.at`: الخادم يمرّر `invalidatedAt` النهائي فقط (يحذفه
  // حين يساوي السويب). السقوط هنا كان يعيد اختلاق إبطال مساوٍ للسويب في طبقة العميل
  // بعد إصلاحه على الخادم ⇒ سطرا زمن متطابقان في لوحة التفاصيل.
  const invalidatedAt = toSeconds(zone.invalidatedAt);
  // لا سقوط إلى createdAt: زمن النشأة يسبق المعرفة الحقيقية (rightBars) فاستخدامه
  // «معرفةً» هو بالضبط تسرب المستقبل. غيابه ⇒ العنصر غير مؤرخ ويُعامل صراحةً كذلك.
  const availableAt = toSeconds(zone.availableAt);
  const { confirmedAt, basis } = resolveConfirmation(zone, sweptAt ?? invalidatedAt);
  return {
    createdAt,
    availableAt,
    confirmedAt,
    confirmedBasis: basis,
    sweptAt,
    invalidatedAt,
    detectedAt: toSeconds(zone.detectedAt),
    availableAtBasis: zone.availableAtBasis ?? 'created'
  };
}

const zoneRange = (zone) => {
  const box = zone.zoneBox;
  if (box && num(box.high) != null && num(box.low) != null) {
    return { high: num(box.high), low: num(box.low) };
  }
  return { high: null, low: null };
};

/**
 * تحويل مخرجات محرك واحد إلى عناصر عرض.
 * كل عنصر يحمل نسخة `raw` من نتيجة المحرك للوحة التفاصيل — بلا أي اشتقاق مخفي.
 *
 * @param {{engine:'legacy'|'v2', zones:any[], structureEvents?:any[]}} input
 * @returns {{elements: HistoryElement[], meta: Object}}
 */
export function buildElements({ engine, zones = [], structureEvents = [] }) {
  const elements = [];
  const gaps = [];
  const seenFvg = new Set();
  const seenTouch = new Set();

  const engineTypes = ENGINE_TYPES[engine] ?? ENGINE_TYPES.legacy;
  const allowEvents = engine === 'v2';
  const unexpectedKinds = new Set();

  for (const zone of zones) {
    if (!zone || !TYPE_META[zone.kind]) continue;
    // حماية حدود المحركين: نوع لا ينتجه المحرك المختار لا يُبنى (يُعلن في الفجوات)
    if (!engineTypes.includes(zone.kind)) {
      unexpectedKinds.add(zone.kind);
      continue;
    }
    const timing = zoneTiming(zone);
    const meta = TYPE_META[zone.kind];
    const range = zoneRange(zone);
    const points = Array.isArray(zone.touchPoints)
      ? zone.touchPoints
          .map((p) => ({ index: num(p.index), time: toSeconds(p.time), price: num(p.price), availableAt: toSeconds(p.availableAt) }))
          .filter((p) => p.time != null && p.price != null)
          .sort((a, b) => a.time - b.time)
      : [];

    const isTrend = meta.shape === 'trendline';
    const isBox = meta.shape === 'box';

    // ---- نطاق السعر للرسم
    let high = range.high;
    let low = range.low;
    if (!isBox && !isTrend) {
      // BSL/SSL القديم: نطاق من نقاط اللمس الحقيقية + مستوى السيولة (نفس منطق شارت الشاشة)
      const prices = points.map((p) => p.price);
      const stop = num(zone.liquidityLevel);
      const bullish = zone.kind.includes('ssl');
      high = bullish ? maxDefined(...prices, stop) : maxDefined(...prices);
      low = bullish ? minDefined(...prices) : minDefined(...prices, stop);
    }

    const element = {
      id: `zone:${zone.id}`,
      typeId: zone.kind,
      shape: engine === 'legacy' && meta.shape === 'level' ? 'band' : meta.shape,
      zoneId: zone.id,
      label: meta.label,
      color: meta.color,
      rgb: meta.rgb,
      state: zone.state ?? null,
      createdAt: timing.createdAt,
      availableAt: timing.availableAt,
      confirmedAt: timing.confirmedAt,
      confirmedBasis: timing.confirmedBasis,
      sweptAt: timing.sweptAt,
      invalidatedAt: timing.invalidatedAt,
      // أول لحظة انتهاء فعلياً: السويب أو الإبطال، أيهما أسبق
      endAt: minDefined(timing.sweptAt, timing.invalidatedAt),
      // عنصر بلا زمن معرفة حقيقي: لا يُعرض في وضع التتبع إلا بخيار صريح
      untimed: timing.availableAt == null,
      high,
      low,
      bodyHigh: num(zone.bodyBox?.high),
      bodyLow: num(zone.bodyBox?.low),
      price: num(zone.referenceLevel),
      priceAlt: num(zone.referenceAlt),
      liquidity: num(zone.liquidityLevel),
      retailStop: num(zone.retailStop),
      points,
      trend: isTrend && zone.trendline && Array.isArray(zone.trendline.points) && zone.trendline.points.length >= 2
        ? {
            points: zone.trendline.points
              .map((p) => ({ index: num(p.index), time: toSeconds(p.time), price: num(p.price) }))
              .filter((p) => p.time != null && p.price != null),
            slope: num(zone.trendline.slope),
            projected: num(zone.trendline.projected),
            errorAtr: num(zone.trendline.errorAtr)
          }
        : null,
      touches: num(zone.touches),
      confidence: num(zone.confidence),
      atr: num(zone.atr),
      distanceAtr: num(zone.distanceAtr),
      formation: zone.form ?? (isTrend ? 'trendline' : 'pivots'),
      fvgs: Array.isArray(zone.fvgs) ? zone.fvgs : [],
      breaks: (() => {
        const steps = Array.isArray(zone.breakSteps) && zone.breakSteps.length
          ? zone.breakSteps
          : zone.finalBreak ? [zone.finalBreak] : [];
        return steps
          .map((b) => ({ time: toSeconds(b.time ?? b.breakTime), price: num(b.reactionPrice) }))
          .filter((b) => b.time != null && b.price != null);
      })(),
      eventKeys: Array.isArray(zone.structureEventKeys) ? zone.structureEventKeys : [],
      raw: zone
    };
    elements.push(element);

    // ---- نقاط اللمس/الارتكاز كعناصر مستقلة (قمة/قاع)
    /**
     * عرض/طلب (`shape: 'box'`) تُصدَّر بنقطة واحدة = **منتصف الصندوق** (تساوي
     * referenceLevel تماماً)، وليست بيفوتاً. تحويلها إلى علامة سويب كان يختلق «قمة
     * سعرية» عند منتصف مستطيل الطلب/العرض (578 علامة مختلقة مقيسة على v2/7d)،
     * ويكسر قاعدة «الشكل يطابق النوع». تُبنى العلامات لأنواع البيفوتات فقط.
     */
    const pivotBased = meta.shape !== 'box';
    if (pivotBased) {
      const swingType = zone.kind.includes('ssl') ? 'swing_low' : 'swing_high';
      for (const p of points) {
        const key = `${swingType}:${p.time}:${p.price}`;
        if (seenTouch.has(key)) continue;
        seenTouch.add(key);
        elements.push({
          id: `touch:${key}`,
          typeId: swingType,
          shape: 'marker',
          zoneId: zone.id,
          label: TYPE_META[swingType].label,
          color: TYPE_META[swingType].color,
          rgb: TYPE_META[swingType].rgb,
          state: 'confirmed',
          createdAt: p.time,
          availableAt: p.availableAt ?? p.time,
          confirmedAt: p.time,
          confirmedBasis: 'pivot',
          sweptAt: null,
          invalidatedAt: null,
          endAt: p.time,
          untimed: false,
          high: p.price,
          low: p.price,
          price: p.price,
          priceAlt: null,
          liquidity: null,
          points: [],
          trend: null,
          touches: 1,
          confidence: null,
          atr: null,
          distanceAtr: null,
          formation: null,
          fvgs: [],
          breaks: [],
          eventKeys: [],
          marker: 'circle',
          raw: { zoneId: zone.id, kind: zone.kind, time: p.time, price: p.price, availableAt: p.availableAt ?? p.time }
        });
      }
    }

    // ---- فجوات FVG المرتبطة (v2 فقط، وتُعرض مرة واحدة)
    if (allowEvents && Array.isArray(zone.fvgs)) {
      for (const f of zone.fvgs) {
        const top = num(f.top);
        const bottom = num(f.bottom);
        const index = num(f.index);
        const time = toSeconds(f.time);
        if (top == null || bottom == null || time == null) continue;
        const key = `${index}:${f.kind}:${top}:${bottom}`;
        if (seenFvg.has(key)) continue;
        seenFvg.add(key);
        const availableAt = toSeconds(f.availableAt) ?? time;
        const invalidatedAt = toSeconds(f.invalidatedAt);
        elements.push({
          id: `fvg:${key}`,
          typeId: 'fvg',
          shape: 'box',
          zoneId: zone.id,
          label: `FVG ${f.kind === 'bullish' ? 'صاعدة' : 'هابطة'}`,
          color: TYPE_META.fvg.color,
          rgb: TYPE_META.fvg.rgb,
          state: invalidatedAt != null ? 'invalidated' : 'confirmed',
          createdAt: time,
          availableAt,
          confirmedAt: availableAt,
          confirmedBasis: 'fvg_formed',
          sweptAt: null,
          invalidatedAt,
          endAt: invalidatedAt,
          untimed: false,
          high: top,
          low: bottom,
          bodyHigh: null,
          bodyLow: null,
          price: (top + bottom) / 2,
          priceAlt: null,
          liquidity: null,
          points: [],
          trend: null,
          touches: null,
          confidence: null,
          atr: null,
          distanceAtr: null,
          formation: null,
          fvgs: [],
          breaks: [],
          eventKeys: [],
          fvgKind: f.kind ?? null,
          raw: f
        });
      }
    }
  }

  // ---- أحداث البنية (v2): عنصر واحد لكل حدث بعد إزالة التكرار
  if (allowEvents) {
    for (const ev of structureEvents) {
      if (!ev || !TYPE_META[ev.type]) continue;
      const time = toSeconds(ev.time);
      const price = num(ev.price);
      if (time == null || price == null) continue;
      const meta = TYPE_META[ev.type];
      const availableAt = toSeconds(ev.availableAt) ?? time;
      const isIdm = ev.type === 'idm';
      /**
       * `confirmed:false` يُصدره المحرك لـIDM لم يُكسر (structure.mjs). عرضه
       * «مؤكداً» مع `confirmedAt` = زمن الارتداد كان يخترع تأكيداً. والتأكيد الحقيقي
       * لـIDM هو زمن كسر الحركة (`brokenTime`)، أما BOS/CHoCH فتأكيده إغلاق شمعة
       * الكسر نفسها (`time`) وهو ما يعلنه المحرك في `confirmBasis`.
       */
      const confirmed = ev.confirmed !== false;
      const confirmedAt = !confirmed ? null : isIdm ? toSeconds(ev.brokenTime) : time;
      elements.push({
        id: `event:${ev.key ?? `${ev.type}:${ev.index}`}`,
        typeId: ev.type,
        shape: 'event',
        zoneId: null,
        label: meta.label,
        color: meta.color,
        rgb: meta.rgb,
        state: confirmed ? 'confirmed' : 'candidate',
        createdAt: time,
        availableAt,
        confirmedAt,
        confirmedBasis: ev.confirmBasis ?? 'close',
        sweptAt: null,
        invalidatedAt: null,
        endAt: time,
        untimed: false,
        high: price,
        low: price,
        price,
        priceAlt: null,
        liquidity: null,
        points: [],
        trend: null,
        touches: null,
        confidence: null,
        atr: null,
        distanceAtr: null,
        formation: null,
        fvgs: [],
        breaks: [],
        eventKeys: [],
        spanFrom: minDefined(toSeconds(ev.brokenPivotTime), availableAt),
        marker: ev.type === 'bos_up' || ev.type === 'choch_up' ? 'triangle_up'
          : ev.type === 'bos_down' || ev.type === 'choch_down' ? 'triangle_down' : 'diamond',
        raw: ev
      });
    }
  }

  // ---- فجوات موثقة (تُعرض في الواجهة، لا تُخترع لها بيانات)
  if (engine === 'legacy') {
    gaps.push('المحرك القديم لا ينتج أحداث بنية (IDM/BOS/CHoCH) ولا FVG ولا مناطق عرض/طلب — لا تُنقل من v2.');
  }
  if (engine === 'v2') {
    gaps.push('`zone.idm` في مخرجات v2 فارغ دائماً؛ بيانات IDM متاحة فقط عبر أحداث البنية.');
    gaps.push('`structureEvents` داخل كل منطقة في v2 = كل الأحداث من نشأة المنطقة حتى نهاية النافذة، لا صلة محددة بها؛ تُعرض الأحداث مرة واحدة وتُفلتر في التفاصيل بنطاق زمن المنطقة.');
    gaps.push('مناطق العرض/الطلب لا تحمل sweptAt/invalidatedAt — تُرسم حتى آخر شمعة بحالة المحرك نفسها.');
    gaps.push('مناطق العرض/الطلب تحمل نقطة لمس واحدة = منتصف الصندوق لا بيفوتاً؛ لا تُبنى منها علامات قمة/قاع.');
    gaps.push('`fvg.invalidatedAt` يُمرَّر الآن كما حسبه المحرك (زمن ملء الفجوة) فيتوقف رسمها وزمن حالتها عند لحظة الملء؛ الفجوة التي لم تُملأ تبقى بلا إبطال ولا يُخترع لها زمن.');
  }
  if (unexpectedKinds.size > 0) {
    gaps.push(`أنواع وصلت من المحرك خارج قائمة أنواعه المعلنة ولم تُبنَ (حماية فصل المحركين): ${[...unexpectedKinds].join(', ')}.`);
  }
  gaps.push('المرجع البديل (referenceAlt) يُنتج بلا زمن تكوّن — يُعرض كخط بلا توقيت ويُخفى في وضع التتبع ما لم يُفعَّل خيار «العناصر غير المؤرخة».');
  gaps.push('`detectedAt` (ساعة الجهاز عند الحساب) لا يُمرَّر إلى الشارت التاريخي: لا يحمل معلومة تاريخية ويجعل المخرجات غير حتمية.');
  if (engine === 'v2') gaps.push('خط الاتجاه يُرسم بميل المحرك (سعر/شمعة) حتى مؤشر الوقت، لا بقيمة `projected` المحسوبة عند آخر شمعة (تلك قيمة مستقبلية عند لحظة سابقة).');

  const typesPresent = TYPE_ORDER.filter((t) => elements.some((e) => e.typeId === t));
  const statesPresent = ['candidate', 'confirmed', 'swept', 'invalidated'].filter((s) => {
    if (s === 'invalidated') return elements.some((e) => e.state === 'invalidated');
    return elements.some((e) => e.typeId !== 'fvg' && (e.state === s || (s === 'candidate' && e.confirmedAt == null)));
  });
  const formationsPresent = [...new Set(elements.map((e) => e.formation).filter(Boolean))];

  return {
    elements,
    meta: {
      engine,
      engineTypes,
      typesPresent,
      statesPresent,
      formationsPresent,
      gaps,
      untimedCount: elements.filter((e) => e.priceAlt != null).length
    }
  };
}

/* ------------------------------------------------------------------ */
/* الحالة الزمنية                                                      */
/* ------------------------------------------------------------------ */

/**
 * حالة العنصر عند لحظة تاريخية t (ثوانٍ) — مشتقة من الأزمنة الحقيقية فقط.
 * @returns {'pending'|'candidate'|'confirmed'|'swept'|'invalidated'}
 */
export function stateAt(element, t) {
  if (t == null) return 'pending';
  // عنصر بلا زمن معرفة: يُقيَّم من زمن نشأته كتقريب معلن (لا يُعرض في التتبع افتراضياً)
  const known = element.availableAt ?? element.createdAt;
  if (known == null || t < known) return 'pending';
  // السويب أولاً: منطقة سُحب سعرها لا تصبح «مبطلة» في نفس اللحظة
  if (element.sweptAt != null && t >= element.sweptAt) return 'swept';
  if (element.invalidatedAt != null && t >= element.invalidatedAt) return 'invalidated';
  if (element.confirmedAt != null && t >= element.confirmedAt) return 'confirmed';
  if (element.typeId === 'fvg') return 'confirmed';
  return 'candidate';
}

/** هل كان العنصر معروفاً عند t؟ */
export function isKnownAt(element, t) {
  if (element.availableAt == null) return false;
  return element.availableAt <= t;
}

/* ------------------------------------------------------------------ */
/* الفلاتر                                                            */
/* ------------------------------------------------------------------ */

export function defaultFilters() {
  return {
    types: {},
    states: {},
    formations: {},
    minTouches: 0,
    minConfidence: 0,
    timeFrom: null,
    timeTo: null,
    side: 'all',
    priceMin: null,
    priceMax: null,
    withinView: false,
    atrDistance: null,
    showHistory: true,
    confirmedOnly: false,
    untimed: false,
    appearance: {
      opacity: 1,
      lineWidth: 1,
      labels: true,
      touchPoints: true,
      alt: true,
      fvg: true,
      extend: false,
      body: true
    }
  };
}

/**
 * دمج فلاتر محفوظة مع الافتراضي (تحصين ضد مخطط قديم/ناقص/تالف).
 * الحقول الرقمية تُثبَّت عددياً: قيمة نصية في `localStorage` كانت تُسقط الرسم
 * عند `.toFixed`، وقيمة غير منتهية تُشوّه المدى.
 */
export function mergeFilters(saved) {
  const base = defaultFilters();
  if (!saved || typeof saved !== 'object') return base;
  const numOr = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
  // أرقام محفوظة فقط؛ `Number([]) === 0` و`Number('') === 0` كانت تحوّل مدخلاً
  // تالفاً إلى 0 صالح يخفي كل العناصر (timeTo=0) أو يصفّر الحد الأدنى.
  const nullableNum = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const bool = (v) => v === true;
  const side = saved.side === 'above' || saved.side === 'below' ? saved.side : 'all';
  return {
    ...base,
    ...saved,
    minTouches: numOr(saved.minTouches, base.minTouches),
    minConfidence: numOr(saved.minConfidence, base.minConfidence),
    timeFrom: nullableNum(saved.timeFrom),
    timeTo: nullableNum(saved.timeTo),
    side,
    priceMin: nullableNum(saved.priceMin),
    priceMax: nullableNum(saved.priceMax),
    withinView: bool(saved.withinView),
    atrDistance: nullableNum(saved.atrDistance),
    showHistory: saved.showHistory !== false,
    confirmedOnly: bool(saved.confirmedOnly),
    untimed: bool(saved.untimed),
    types: { ...base.types, ...(saved.types ?? {}) },
    states: { ...base.states, ...(saved.states ?? {}) },
    formations: { ...base.formations, ...(saved.formations ?? {}) },
    appearance: {
      ...base.appearance,
      ...(saved.appearance ?? {}),
      // الحدود مطابقة لمدى اللوحة (شفافية 0.15..1، سماكة 0.5..3): قيمة تالفة
      // خارجها كانت تُخفي الرسم كله (شفافية 0) أو تنتج حدوداً غير مرئية.
      opacity: Math.min(1, Math.max(0.15, numOr(saved.appearance?.opacity, base.appearance.opacity))),
      lineWidth: Math.min(3, Math.max(0.5, numOr(saved.appearance?.lineWidth, base.appearance.lineWidth))),
      labels: bool(saved.appearance?.labels ?? base.appearance.labels),
      touchPoints: bool(saved.appearance?.touchPoints ?? base.appearance.touchPoints),
      alt: bool(saved.appearance?.alt ?? base.appearance.alt),
      fvg: bool(saved.appearance?.fvg ?? base.appearance.fvg),
      extend: bool(saved.appearance?.extend ?? base.appearance.extend),
      body: bool(saved.appearance?.body ?? base.appearance.body)
    }
  };
}

/** خيارات الفلاتر المتاحة فعلاً — لا يُعرض فلتر لنوع غير موجود */
export function filterOptions(elements) {
  const types = TYPE_ORDER.filter((t) => elements.some((e) => e.typeId === t)).map((t) => ({
    id: t,
    label: TYPE_META[t].label,
    color: TYPE_META[t].color,
    count: elements.filter((e) => e.typeId === t).length
  }));
  const states = ['candidate', 'confirmed', 'swept', 'invalidated']
    .filter((s) => elements.some((e) => e.state === s || (s === 'candidate' && e.confirmedAt == null && e.typeId !== 'fvg')))
    .map((s) => ({ id: s, label: STATE_META[s].label }));
  const formations = [...new Set(elements.map((e) => e.formation).filter(Boolean))]
    .map((f) => ({ id: f, label: FORMATION_LABELS[f] ?? f }));
  return { types, states, formations };
}

const EMPTY_COUNTS = () => ({
  total: 0,
  visible: 0,
  hidden: { replay: 0, untimed: 0, type: 0, state: 0, formation: 0, strength: 0, time: 0, price: 0, history: 0 }
});

/**
 * اختيار العناصر المعروضة عند لحظة تاريخية مع أسباب الإخفاء مفصّلة.
 * لا يغيّر أي بيانات: كل الحساب على نسخ العرض فقط.
 *
 * @param {HistoryElement[]} elements
 * @param {Object} ctx
 * @param {Object} ctx.filters
 * @param {number|null} ctx.cursorTime لحظة العرض (ثوانٍ)
 * @param {boolean} ctx.replay
 * @param {number|null} [ctx.cursorPrice]
 * @param {number|null} [ctx.atrRef]
 */
export function selectElements(elements, { filters, cursorTime, replay, cursorPrice = null, atrRef = null }) {
  const f = mergeFilters(filters);
  const counts = EMPTY_COUNTS();
  counts.total = elements.length;
  const visible = [];
  // في العرض الكامل (بلا مؤشر) تُقيَّم الحالة على أنها «الآن» = ما بعد كل الأزمنة
  const t = cursorTime ?? Number.POSITIVE_INFINITY;

  for (const el of elements) {
    if (replay) {
      if (el.untimed) {
        // عنصر بلا زمن معرفة حقيقي: يُحجب افتراضياً، ويُعرض فقط بخيار صريح
        if (!f.untimed) { counts.hidden.untimed += 1; continue; }
      } else if (!isKnownAt(el, t)) { counts.hidden.replay += 1; continue; }
    }
    if (f.types[el.typeId] === false) { counts.hidden.type += 1; continue; }
    if (f.formations[el.formation] === false) { counts.hidden.formation += 1; continue; }

    const state = stateAt(el, t);
    if (f.states[state] === false) { counts.hidden.state += 1; continue; }
    if (f.confirmedOnly && state !== 'confirmed') { counts.hidden.state += 1; continue; }

    if (f.minTouches > 0 && (el.touches == null || el.touches < f.minTouches)) { counts.hidden.strength += 1; continue; }
    if (f.minConfidence > 0 && (el.confidence == null || el.confidence < f.minConfidence)) { counts.hidden.strength += 1; continue; }

    if (f.timeFrom != null && el.endAt != null && el.endAt < f.timeFrom) { counts.hidden.time += 1; continue; }
    if (f.timeTo != null && el.availableAt != null && el.availableAt > f.timeTo) { counts.hidden.time += 1; continue; }

    const lo = minDefined(el.low, el.price);
    const hi = maxDefined(el.high, el.price);
    if (f.priceMin != null && hi != null && hi < f.priceMin) { counts.hidden.price += 1; continue; }
    if (f.priceMax != null && lo != null && lo > f.priceMax) { counts.hidden.price += 1; continue; }
    if (f.side !== 'all' && cursorPrice != null && lo != null && hi != null) {
      const mid = (lo + hi) / 2;
      if (f.side === 'above' && mid < cursorPrice) { counts.hidden.price += 1; continue; }
      if (f.side === 'below' && mid > cursorPrice) { counts.hidden.price += 1; continue; }
    }
    if (f.atrDistance != null && atrRef != null && atrRef > 0 && cursorPrice != null && lo != null && hi != null) {
      const dist = Math.abs((lo + hi) / 2 - cursorPrice) / atrRef;
      if (dist > f.atrDistance) { counts.hidden.price += 1; continue; }
    }

    // «إظهار العناصر المنتهية» يخص العناصر ذات امتداد زمني؛ العلامات والأحداث
    // لحظية (endAt = زمنها) فاستبعادها كان يُخفي كل القمم/القيعان وكل أحداث البنية
    // رغم أن الفلتر لا يعنيهم.
    const isInstant = el.shape === 'marker' || el.shape === 'event';
    if (!f.showHistory && !isInstant && el.endAt != null && t != null && el.endAt <= t) { counts.hidden.history += 1; continue; }

    visible.push(el);
  }

  counts.visible = visible.length;
  return { visible, counts, filters: f };
}

/** مجموع المخفي لأي سبب */
export function hiddenTotal(counts) {
  return Object.values(counts.hidden).reduce((a, b) => a + b, 0);
}

/* ------------------------------------------------------------------ */
/* الإحداثيات                                                          */
/* ------------------------------------------------------------------ */

const OUT = 40; // هامش خارج الإطار قبل اعتبار العنصر خارج النطاق المرئي

const alphaForState = (state) => (state === 'confirmed' ? 1 : state === 'candidate' ? 0.68 : state === 'swept' ? 0.34 : state === 'invalidated' ? 0.26 : 0);

/**
 * تحويل العناصر إلى أوليات رسم بإحداثيات الشارت (بكسل).
 * دالة نقية: كل التحويلات تُمرَّر كدوال، فتُختبر حسابياً بلا متصفح.
 *
 * @param {Object} p
 * @param {HistoryElement[]} p.elements
 * @param {(t:number)=>number|null} p.tx
 * @param {(price:number)=>number|null} p.py
 * @param {(i:number)=>number|null} p.timeAtIndex
 * @param {(t:number)=>number|null} p.indexAtTime
 * @param {number} p.width
 * @param {number} p.height
 * @param {number|null} p.cursorTime
 * @param {number|null} p.cursorIndex
 * @param {Object} p.style
 * @param {boolean} p.replay
 * @param {string|null} p.selectedId
 * @param {string|null} p.hoverId
 * @param {number|null} [p.viewStartTime] أول زمن مرئي في النطاق (الاقتصاص الأفقي)
 * @param {number|null} [p.viewEndTime] آخر زمن مرئي في النطاق (الاقتصاص الأفقي)
 */
export function layoutElements({
  elements, tx, py, timeAtIndex, indexAtTime, width, height,
  cursorTime, cursorIndex, style, replay, selectedId = null, hoverId = null,
  altAllowed = true, viewStartTime = null, viewEndTime = null
}) {
  const rects = [];
  const segments = [];
  const markers = [];
  const labels = [];
  const placedLabels = [];
  let drawn = 0;
  let culled = 0;
  let labelSkips = 0;

  const opacity = Math.max(0, Math.min(1, Number(style?.opacity ?? 1)));
  const lineWidth = Math.max(0.5, Math.min(4, Number(style?.lineWidth ?? 1)));
  const showLabels = style?.labels !== false;
  const showTouches = style?.touchPoints !== false;
  const showAlt = style?.alt !== false;
  const showFvg = style?.fvg !== false;
  const extend = style?.extend === true;
  const showBody = style?.body !== false;

  const insideY = (y) => y != null && y >= -OUT && y <= height + OUT;
  const insideX = (x) => x != null && x >= -OUT && x <= width + OUT;
  /**
   * تقاطع رأسي: يكفي أن يمتد الشكل عبر الإطار ولو كان طرفاه خارجه. صندوق عرض/طلب
   * يمتد 2×ATR قد يتجاوز أعلى الشاشة وأسفلها معاً عند تكبير سعري ⇒ الحارس القديم
   * (`insideY(yTop) && insideY(yBot)` كلاهما كاذب) كان يُسقط منطقة تغطي الشاشة.
   */
  const spansY = (a, b) => a != null && b != null && Math.max(a, b) >= -OUT && Math.min(a, b) <= height + OUT;

  /**
   * نهاية رسم العنصر: لا تتجاوز مؤشر الوقت في وضع التتبع.
   * بدون هذا القيد تُرسم منطقة سُحبت لاحقاً حتى زمن سحبها المستقبلي ⇒ تسرب مستقبل.
   */
  const endTimeFor = (el) => {
    if (el.endAt == null) return extend ? null : cursorTime;
    if (replay && cursorTime != null && el.endAt > cursorTime) return cursorTime;
    return el.endAt;
  };

  /**
   * اقتصاص أفقي للنطاق المرئي: عنصر نشأ قبل أول شمعة مرئية وما زال حياً يجب أن
   * يُرسم من حافة النطاق لا أن يُستبعد. الاستبعاد كان يُخفي أغلب مناطق النطاق
   * الطويل عند أي تكبير (سقف صامت غير معلن).
   * يعيد [xStart, xEnd] بالبكسل.
   */
  const clipSpan = (el, startX, endX) => {
    let x = startX;
    let xe = endX;
    if (x != null && x < 0 && viewStartTime != null) {
      const knownBeforeView = (el.availableAt ?? el.createdAt) != null && (el.availableAt ?? el.createdAt) < viewStartTime;
      const aliveAtViewStart = el.endAt == null || el.endAt > viewStartTime;
      if (knownBeforeView && aliveAtViewStart) x = 0;
    }
    if (xe != null && xe > width && !replay && viewEndTime != null) {
      const aliveAtViewEnd = el.endAt == null || el.endAt >= viewEndTime;
      if (aliveAtViewEnd) xe = width;
    }
    return [x, xe];
  };

  const pushLabel = (text, x, y, color, align = 'left') => {
    if (!showLabels || !text) return;
    const w = Math.max(18, text.length * 5.6);
    const bx = align === 'right' ? x - w : x;
    const box = { x: bx, y: y - 9, w, h: 12 };
    const hit = placedLabels.some((p) => box.x < p.x + p.w && box.x + box.w > p.x && box.y < p.y + p.h && box.y + box.h > p.y);
    if (hit) { labelSkips += 1; return; }
    placedLabels.push(box);
    labels.push({ text, x, y, color, align });
  };

  for (const el of elements) {
    const state = cursorTime == null ? el.state ?? 'confirmed' : stateAt(el, cursorTime);
    const a = alphaForState(state) * opacity;
    if (a <= 0.02) continue;

    const selected = selectedId != null && el.id === selectedId;
    const hovered = hoverId != null && el.id === hoverId;


    // ---- علامة النشأة: تُظهر مكان تكوّن العنصر حتى قبل أن يصبح معروفاً
    // خط الاتجاه مستثنى: `el.price` له هو `projected` (قيمة آخر شمعة في النافذة)
    // لا سعر الخط عند زمن النشأة ⇒ الماسة كانت تُرسم بعيداً عن الخط بألف سعر.
    if (el.createdAt != null && el.availableAt != null && el.createdAt < el.availableAt
      && el.shape !== 'marker' && el.shape !== 'trendline') {
      const x = tx(el.createdAt);
      const y = py(el.price ?? el.high ?? el.low);
      if (insideX(x) && insideY(y)) {
        markers.push({ id: el.id, kind: 'birth', shape: 'diamond', x, y, color: el.color, alpha: 0.55 * opacity, size: 3 });
      }
    }

    // ---- مستويات BSL/SSL: مرجع + سيولة + مرجع بديل (بلا توقيت)
    if (el.shape === 'level' || el.shape === 'band') {
      const start = el.availableAt ?? el.createdAt;
      const end = endTimeFor(el);
      if (start == null) continue;
      const x1raw = tx(start);
      const x2raw = end != null ? tx(end) : width;
      if (x2raw == null) { culled += 1; continue; }
      const [x1, x2] = clipSpan(el, x1raw, x2raw);
      if (!insideX(x1) || x2 == null || x2 <= x1) { culled += 1; continue; }
      const yRef = el.price != null ? py(el.price) : null;
      const yLiq = el.liquidity != null ? py(el.liquidity) : null;
      // حدّا النطاق يُحسبان قبل بوابة الرسم: عند تكبير سعري قد تخرج القيمة المرجعية
      // ومستوى السيولة من الشاشة بينما جسم النطاق ظاهر — استبعاده كان يُخفي نطاقاً حياً.
      const yBandTop = el.high != null ? py(el.high) : null;
      const yBandBot = el.low != null ? py(el.low) : null;
      if (!insideY(yRef) && !insideY(yLiq) && !spansY(yBandTop, yBandBot)) { culled += 1; continue; }
      // النطاق القديم (شارت الشاشة نفسها): تعبئة من نقاط اللمس الحقيقية حتى مستوى السيولة
      if (el.shape === 'band') {
        const yTop = yBandTop;
        const yBot = yBandBot;
        if (yTop != null && yBot != null) {
          rects.push({
            id: el.id,
            x: x1,
            y: Math.min(yTop, yBot),
            w: x2 - x1,
            h: Math.max(Math.abs(yBot - yTop), 1),
            fill: `rgba(${el.rgb},${(0.13 * a).toFixed(3)})`,
            stroke: el.color,
            strokeAlpha: a * (selected ? 1 : 0.75),
            lineWidth: lineWidth * (selected ? 2.2 : 1),
            dashed: false
          });
        }
      }
      if (yRef != null && insideY(yRef)) {
        segments.push({ id: el.id, x1, y1: yRef, x2, y2: yRef, color: el.color, width: lineWidth * (selected ? 2.4 : 1.4), alpha: a, dashed: false });
      }
      if (yLiq != null && insideY(yLiq)) {
        segments.push({ id: el.id, x1, y1: yLiq, x2, y2: yLiq, color: el.color, width: lineWidth, alpha: a * 0.8, dashed: true });
      }
      if (showAlt && altAllowed && el.priceAlt != null && el.price != null && Math.abs(el.priceAlt - el.price) > Math.abs(el.price) * 0.001) {
        const yAlt = py(el.priceAlt);
        if (insideY(yAlt)) {
          segments.push({ id: `${el.id}:alt`, x1, y1: yAlt, x2, y2: yAlt, color: el.color, width: lineWidth, alpha: a * 0.45, dashed: 'dot' });
        }
      }
      if (yRef != null) pushLabel(`${TYPE_META[el.typeId].short} ${fmtPrice(el.price)}`, x1 + 3, yRef - 4, el.color);
      drawn += 1;
      continue;
    }

    // ---- خط اتجاه مائل: من أول نقطة إلى مؤشر الوقت بميل المحرك
    if (el.shape === 'trendline') {
      const tr = el.trend;
      if (!tr || tr.points.length < 2) { culled += 1; continue; }
      const p0 = tr.points[0];
      const startTime = el.availableAt ?? p0.time;
      /**
       * المحرك القديم يبني `trendline.points` بلا `index` (engine.mjs:341) بينما
       * نفس النقاط في `touchPoints` تحمله. غياب الفهرس كان يُسقط فرع حساب الميل
       * فيُستخدم `projected` (قيمة **آخر شمعة في النافذة**) طرفاً أيمن حتى في وضع
       * التتبع ⇒ تسرب مستقبل. يُشتق الفهرس من الزمن عند الحاجة، بلا اختراع بيانات.
       */
      const i0 = p0.index ?? (indexAtTime ? indexAtTime(p0.time) : null);
      let x0 = tx(p0.time);
      let y0 = py(p0.price);
      const priceAt = (t) => {
        if (tr.slope == null || i0 == null || t == null || !indexAtTime) return null;
        const idx = indexAtTime(t);
        return idx == null ? null : p0.price + tr.slope * (idx - i0);
      };
      // اقتصاص يسار: الخط الممتد من قبل النطاق يُعاد إسقاطه على حافته
      if (x0 != null && x0 < 0 && viewStartTime != null) {
        const yAtEdge = py(priceAt(viewStartTime));
        if (yAtEdge != null) { x0 = 0; y0 = yAtEdge; }
      }
      // لا يُرسم قبل لحظة المعرفة الحقيقية: يُقتصر الطرف الأيسر على زمن التأكيد
      const xKnow = tx(startTime);
      if (xKnow != null && x0 != null && xKnow > x0) {
        const yAtKnow = py(priceAt(startTime));
        if (yAtKnow != null) { x0 = xKnow; y0 = yAtKnow; }
      }
      let x1 = null;
      let y1 = null;
      if (tr.slope != null && cursorIndex != null && i0 != null) {
        const idx = Math.max(cursorIndex, i0);
        const priceEnd = p0.price + tr.slope * (idx - i0);
        const tEnd = timeAtIndex(idx);
        if (tEnd != null) {
          x1 = tx(tEnd);
          y1 = py(priceEnd);
        }
      }
      // لا سقوط إلى `projected` في وضع التتبع: قيمته محسوبة عند آخر شمعة في النافذة
      // (مستقبل بالنسبة للمؤشر) والخط يُرسم حينها كأنه يعرف سعره.
      if (x1 == null && tr.projected != null && !replay) {
        x1 = width;
        y1 = py(tr.projected);
      }
      if (x0 == null || y0 == null || x1 == null || y1 == null) { culled += 1; continue; }
      if (!spansY(y0, y1)) { culled += 1; continue; }
      segments.push({ id: el.id, x1: x0, y1: y0, x2: x1, y2: y1, color: el.color, width: lineWidth * (selected ? 2.2 : 1.6), alpha: a * 0.95, dashed: false });
      // نقاط خط الاتجاه هي نفس نقاط الارتكاز المبنية كعناصر علامة: كان رسمها هنا
      // نسخة ثانية فوق نفس الإحداثيات، وتسرق أولوية النقر من علامة القمة/القاع.
      pushLabel(`${TYPE_META[el.typeId].short} ${tr.points.length} نقاط`, x0 + 3, y0 - 4, el.color);
      drawn += 1;
      continue;
    }

    // ---- حدث بنيوي: مستوى الكسر + علامة على شمعة الحدث
    if (el.shape === 'event') {
      const x = tx(el.availableAt ?? el.createdAt);
      const y = py(el.price);
      if (!insideX(x) || !insideY(y)) { culled += 1; continue; }
      const from = el.spanFrom ?? el.availableAt ?? el.createdAt;
      const xFrom = tx(from);
      if (xFrom != null && xFrom < x) {
        segments.push({ id: `${el.id}:level`, x1: xFrom, y1: y, x2: x, y2: y, color: el.color, width: lineWidth, alpha: a * 0.55, dashed: 'dot' });
      }
      markers.push({ id: el.id, kind: 'event', shape: el.marker ?? 'diamond', x, y, color: el.color, alpha: a, size: selected ? 6 : 4.5 });
      pushLabel(TYPE_META[el.typeId].short, x + 6, y - 6, el.color);
      drawn += 1;
      continue;
    }

    // ---- علامة قمة/قاع
    if (el.shape === 'marker') {
      // إظهار/إخفاء نقاط الارتكاز من تفضيلات العرض (لا علاقة له بالفلاتر)
      if (!showTouches) continue;
      // العلامة تجلس على **زمن البيفوت نفسه** (createdAt) لا على زمن تأكيده:
      // إزاحتها بمقدار rightBars كانت تضعها على شمعة ليست القمة/القاع.
      // منع الظهور قبل المعرفة يقع في selectElements عبر availableAt.
      const x = tx(el.createdAt ?? el.availableAt);
      const y = py(el.price);
      if (!insideX(x) || !insideY(y)) { culled += 1; continue; }
      markers.push({ id: el.id, kind: 'swing', shape: 'circle', x, y, color: el.color, alpha: a * 0.75, size: selected ? 4 : 2.6 });
      drawn += 1;
      continue;
    }

    // ---- مستطيل: Supply/Demand أو FVG
    const start = el.availableAt ?? el.createdAt;
    if (start == null) continue;
    const end = endTimeFor(el);
    const x1raw = tx(start);
    const x2raw = end != null ? tx(end) : width;
    if (x1raw == null || x2raw == null) { culled += 1; continue; }
    const [x1, x2] = clipSpan(el, x1raw, x2raw);
    if (x2 <= x1) { culled += 1; continue; }
    const yTop = py(el.high);
    const yBot = py(el.low);
    if (yTop == null || yBot == null) { culled += 1; continue; }
    if (!spansY(yTop, yBot)) { culled += 1; continue; }
    const isFvg = el.typeId === 'fvg';
    if (isFvg && !showFvg) continue;
    const fillAlpha = (isFvg ? 0.10 : 0.16) * a;
    rects.push({
      id: el.id,
      x: x1,
      y: Math.min(yTop, yBot),
      w: x2 - x1,
      h: Math.max(Math.abs(yBot - yTop), 1),
      fill: `rgba(${el.rgb},${fillAlpha.toFixed(3)})`,
      stroke: el.color,
      strokeAlpha: a * (selected ? 1 : 0.8),
      lineWidth: lineWidth * (selected ? 2.2 : 1),
      dashed: isFvg
    });
    if (showBody && !isFvg && el.bodyHigh != null && el.bodyLow != null && el.bodyHigh > el.bodyLow) {
      const yb1 = py(el.bodyHigh);
      const yb2 = py(el.bodyLow);
      if (yb1 != null && yb2 != null) {
        rects.push({
          id: `${el.id}:body`,
          x: x1,
          y: Math.min(yb1, yb2),
          w: x2 - x1,
          h: Math.max(Math.abs(yb2 - yb1), 1),
          fill: 'rgba(0,0,0,0)',
          stroke: 'rgba(255,255,255,0.35)',
          strokeAlpha: a * 0.6,
          lineWidth: 1,
          dashed: 'dot'
        });
      }
    }
    pushLabel(`${TYPE_META[el.typeId].short} ${el.low != null && el.high != null ? `${fmtPrice(el.low)}–${fmtPrice(el.high)}` : ''}`, x1 + 3, Math.min(yTop, yBot) - 4, el.color);
    drawn += 1;
  }

  // ---- خطوات الكسر (زخرفة العناصر المؤهلة).
  // نقاط الارتكاز لا تُرسم هنا: كل نقطة تتحول في `buildElements` إلى عنصر علامة
  // مستقل (swing_high/swing_low) بنفس الزمن والسعر تماماً، فرسمها مرة ثانية كان
  // نسخة مكررة فوق نفس الإحداثيات (34247 دائرة في legacy و2249 في v2). إبقاء الرسم
  // على عناصر العلامة وحدها يجعل فلتر النوع يعمل فعلاً: إخفاء «قمة (Swing High)»
  // يُخفي كل دوائر القمم لا بعضها، لأن نسخة «touch» كانت تمرّ من تحت الفلتر.
  if (showTouches) {
    for (const el of elements) {
      if (!el.breaks?.length) continue;
      const state = cursorTime == null ? el.state ?? 'confirmed' : stateAt(el, cursorTime);
      const a = alphaForState(state) * opacity;
      for (const b of el.breaks) {
        if (replay && cursorTime != null && b.time > cursorTime) continue;
        const x = tx(b.time);
        const y = py(b.price);
        if (insideX(x) && insideY(y)) markers.push({ id: el.id, kind: 'break', shape: 'cross', x, y, color: '#eab308', alpha: a, size: 3 });
      }
    }
  }

  return { rects, segments, markers, labels, drawn, culled, labelSkips };
}

export const fmtPrice = (p) => {
  const n = Number(p);
  if (!Number.isFinite(n)) return '—';
  const digits = Math.abs(n) >= 1000 ? 2 : Math.abs(n) >= 1 ? 4 : 6;
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: digits }).format(n);
};

/* ------------------------------------------------------------------ */
/* اختبار الإصابة بالنقر                                              */
/* ------------------------------------------------------------------ */

const distToSegment = (px, py_, x1, y1, x2, y2) => {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(px - x1, py_ - y1);
  let t = ((px - x1) * dx + (py_ - y1) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py_ - (y1 + t * dy));
};

/**
 * إصابة النقر: العلامات أولاً (دقة أعلى)، ثم الخطوط، ثم المستطيلات.
 * يعيد id العنصر الأعلى أولوية أو null.
 */
export function hitTest(layout, point, tol = 8) {
  if (!layout || !point) return null;
  const { x, y } = point;
  let best = null;

  for (let i = layout.markers.length - 1; i >= 0; i -= 1) {
    const m = layout.markers[i];
    const d = Math.hypot(x - m.x, y - m.y);
    const r = Math.max(tol, (m.size ?? 3) + 4);
    if (d <= r && (!best || d < best.d)) best = { id: m.id, d, kind: 'marker' };
  }
  if (best) return best.id;

  for (let i = layout.segments.length - 1; i >= 0; i -= 1) {
    const s = layout.segments[i];
    const d = distToSegment(x, y, s.x1, s.y1, s.x2, s.y2);
    if (d <= tol && (!best || d < best.d)) best = { id: s.id, d, kind: 'segment' };
  }
  if (best) return best.id.replace(/:(alt|level)$/, '');

  // المستطيلات: قاعدة واحدة معلنة ومحسومة
  //   1) «هدف مرئي» = مستطيل عرضه وارتفاعه ≥ MIN_TARGET px (أصغر بكثير من ذلك لا
  //      يمكن أن يقصده المستخدم بصرياً: شريط مستوى ارتفاعه بكسل أو فجوة عمرها
  //      أقل من شمعة).
  //   2) إن كان تحت المؤشر هدف مرئي ← أصغرها مساحة (الأكثر تحديداً: صندوق FVG
  //      داخل منطقة عرض/طلب كبيرة، أو جسم شمعة داخل صندوقها).
  //   3) وإلا ← أكبر مستطيل يحتوي النقطة (الخلفية التي يراها المستخدم فعلاً).
  // مرحلتان: الاحتواء الصارم أولاً ثم هامش 2px للعناصر الرفيعة فقط.
  const MIN_TARGET = 3;
  const insideRect = (r, pad) => x >= r.x - pad && x <= r.x + r.w + pad && y >= r.y - pad && y <= r.y + r.h + pad;
  const pickRect = (pad) => {
    let smallestVisible = null;
    let largest = null;
    for (let i = 0; i < layout.rects.length; i += 1) {
      const r = layout.rects[i];
      if (!insideRect(r, pad)) continue;
      const area = Math.max(r.w, 1) * Math.max(r.h, 1);
      if (!largest || area >= largest.area) largest = { id: r.id, area };
      if (r.w >= MIN_TARGET && r.h >= MIN_TARGET && (!smallestVisible || area <= smallestVisible.area)) {
        smallestVisible = { id: r.id, area };
      }
    }
    return smallestVisible ?? largest;
  };
  const bestRect = pickRect(0) ?? pickRect(2);
  if (bestRect) return bestRect.id.replace(/:body$/, '');
  return null;
}

/* ------------------------------------------------------------------ */
/* التتبع الزمني                                                       */
/* ------------------------------------------------------------------ */

export const clampIndex = (i, length) => {
  if (!Number.isFinite(length) || length <= 0) return 0;
  return Math.max(0, Math.min(length - 1, Math.trunc(i)));
};

/** خطوة حتمية: نفس (البداية، الخطوة، الطول) ⇒ نفس النتيجة */
export const stepIndex = (i, delta, length) => clampIndex(clampIndex(i, length) + delta, length);

/**
 * لقطة تتبع: العناصر المعروضة + حالاتها عند المؤشر + الأحداث التي وقعت.
 * دالة نقية تماماً (لا وقت جهاز) ⇒ إعادة تشغيل قابلة للإنتاج حرفياً.
 */
export function replaySnapshot(elements, { cursorTime, replay, filters, cursorPrice = null, atrRef = null }) {
  const selection = selectElements(elements, { filters, cursorTime, replay, cursorPrice, atrRef });
  const states = selection.visible.map((el) => ({ id: el.id, state: stateAt(el, cursorTime) }));
  const known = elements.filter((el) => isKnownAt(el, cursorTime)).map((el) => el.id).sort();
  return { ...selection, states, known };
}
