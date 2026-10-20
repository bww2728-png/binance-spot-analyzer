/* مخزن شموع رقمي بحلقة دائرية — تجميع دقائق حية إلى كل الفريمات بلا شبكة ولا مؤقّتات
 *
 * العلة التي يُصلحها هذا الملف:
 *  - مخزن streams.mjs يحفظ الشموع في Map(openTime → صف) لكل مفتاح، فكل شمعة كائن
 *    مستقل + مرجع في الخريطة، والترتيب يُعاد بناؤه بالفرز عند كل قراءة (getKlines).
 *    هنا كل مفتاح Float64Array واحد بحلقة دائرية: ذاكرة متصلة، بلا فرز، وبلا كائنات.
 *  - التجميع من الدقائق إلى الفريمات الأعلى كان يُشتق من الحقبة (epoch) أو بحدود
 *    تخمينية، وهذا يخطئ في الفريمات ذات المحاذاة الخاصة (3d و1w). هنا الحدود تُشتق
 *    من بيانات البذر نفسها: نافذة الشمعة الحالية = openTime لآخر شمعة مبذورة.
 *  - جمع volume/takerBuyBase كأعداد عشرية يراكم انزياح الفاصلة العائمة على مدى
 *    مئات الشموع. هنا يُجمعان كأعداد صحيحة بوحدات 1e-8 ثم يُقسمان عند القراءة.
 *
 * الوحدة نقية: لا مؤقّتات، لا شبكة، لا أثر جانبي خارج الحالة الداخلية.
 */

/** مدة كل فريم بالمللي — المصدر الوحيد للحقيقة في هذه الوحدة */
export const TF_MS = {
  '1m': 60000,
  '3m': 180000,
  '5m': 300000,
  '15m': 900000,
  '30m': 1800000,
  '1h': 3600000,
  '2h': 7200000,
  '4h': 14400000,
  '6h': 21600000,
  '8h': 28800000,
  '12h': 43200000,
  '1d': 86400000,
  '3d': 259200000,
  '1w': 604800000
};

/** عدد القيم المخزَّنة لكل شمعة داخل Float64Array الواحد */
const STRIDE = 8;
/** مواضع الحقول داخل الشمعة (بترتيب التخزين) */
const F_OPEN_TIME = 0;
const F_OPEN = 1;
const F_HIGH = 2;
const F_LOW = 3;
const F_CLOSE = 4;
const F_VOLUME = 5;
const F_TAKER = 6;
const F_CLOSE_TIME = 7;
/** وحدة ترميز volume/takerBuyBase كأعداد صحيحة (1e-8) لمنع انزياح الفاصلة العائمة */
const Q = 1e8;

/** رقم منتهٍ فقط (يرفض NaN وInfinity والنصوص غير الرقمية) */
const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** رمز صالح: نص غير فارغ (يُطبَّع إلى أحرف كبيرة) */
const normSymbol = (symbol) => {
  if (typeof symbol !== 'string') return null;
  const s = symbol.trim().toUpperCase();
  return s ? s : null;
};

/** فريم معروف: مفتاح موجود في TF_MS */
const normTf = (tf) => (typeof tf === 'string' && Object.prototype.hasOwnProperty.call(TF_MS, tf) ? tf : null);

/**
 * إنشاء مخزن الشموع.
 * @param {{ capacity?: number, log?: object }} [options]
 *   capacity: سقف صلب لعدد الشموع لكل مفتاح (استبدال الأقدم عند الامتلاء)
 *   log: كائن سجل متوافق مع console (يُستخدم للتحذير فقط، ولا يُستدعى في المسار الساخن)
 */
export function createCandleStore({ capacity = 400, log = console } = {}) {
  // سقف صلب: قيمة غير صالحة أو أقل من 1 تُرفض إلى الافتراضي
  const cap = Number.isFinite(Number(capacity)) && Number(capacity) >= 1 ? Math.floor(Number(capacity)) : 400;

  /**
   * key = "SYMBOL|tf" → {
   *   data: Float64Array(cap * STRIDE) — حلقة دائرية، كل شمعة 8 قيم متتالية
   *   start: مؤشر أول شمعة (الأقدم) داخل الحلقة
   *   size: عدد الشموع المخزَّنة فعلاً (≤ cap)
   *   curOpenTime: openTime للنافذة الجارية (آخر شمعة مبذورة أو آخر نافذة فُتحت)
   *   curIdx: مؤشر الشمعة الجارية داخل الحلقة (-1 إن لا شمعة جارية)
   *   volInt/takerInt: مجاميع صحيحة بوحدات 1e-8 للشمعة الجارية (منع الانزياح)
   * }
   */
  const store = new Map();
  /**
   * فهرس بالرمز: الرمز → مجموعة الفريمات المخزَّنة له.
   * بلا هذا الفهرس تُمرّ `apply1m` على كل مفاتيح المخزن في كل شمعة دقيقة (429 رمزاً ×
   * 6,006 مفتاحاً = ملايين فحوص النصوص في الدقيقة). بالفهرس تكون الكلفة 14 مفتاحاً فقط
   * لكل رمز، وهي نفس عدد فريماته.
   */
  const bySymbol = new Map();
  let lastUpdateAt = null;
  let gaps = 0; // عدّاد الفجوات: انتقال أكثر من خطوة واحدة بين نافذتين

  /** موضع الشمعة رقم i (0 = الأقدم) داخل الحلقة */
  const slotOf = (rec, i) => ((rec.start + i) % cap) * STRIDE;

  /** إنشاء/إعادة تهيئة سجل مفتاح */
  function ensureRec(key) {
    let rec = store.get(key);
    if (!rec) {
      rec = {
        data: new Float64Array(cap * STRIDE),
        start: 0,
        size: 0,
        curOpenTime: null,
        curIdx: -1,
        volInt: 0,
        takerInt: 0
      };
      store.set(key, rec);
      const cut = key.indexOf('|');
      const sym = key.slice(0, cut);
      const frame = key.slice(cut + 1);
      let frames = bySymbol.get(sym);
      if (!frames) { frames = new Set(); bySymbol.set(sym, frames); }
      frames.add(frame);
    }
    return rec;
  }

  /** كتابة شمعة كاملة في موضع الحلقة (8 قيم) */
  function writeBar(rec, slot, openTime, open, high, low, close, volume, taker, closeTime) {
    const d = rec.data;
    d[slot + F_OPEN_TIME] = openTime;
    d[slot + F_OPEN] = open;
    d[slot + F_HIGH] = high;
    d[slot + F_LOW] = low;
    d[slot + F_CLOSE] = close;
    d[slot + F_VOLUME] = volume;
    d[slot + F_TAKER] = taker;
    d[slot + F_CLOSE_TIME] = closeTime;
  }

  /** إضافة شمعة جديدة في نهاية الحلقة (استبدال الأقدم عند الامتلاء) — تُعيد مؤشرها */
  function pushBar(rec, openTime, open, high, low, close, volume, taker, closeTime) {
    let idx;
    if (rec.size < cap) {
      idx = rec.size;
      rec.size += 1;
    } else {
      // ممتلئ: نكتب فوق الأقدم ونقدّم مؤشر البداية
      idx = rec.size - 1;
      rec.start = (rec.start + 1) % cap;
    }
    writeBar(rec, slotOf(rec, idx), openTime, open, high, low, close, volume, taker, closeTime);
    return idx;
  }

  /** قراءة شمعة من الحلقة ككائن (بلا نسخ للحلقة) */
  function readBar(rec, i) {
    const s = slotOf(rec, i);
    const d = rec.data;
    return {
      openTime: d[s + F_OPEN_TIME],
      open: d[s + F_OPEN],
      high: d[s + F_HIGH],
      low: d[s + F_LOW],
      close: d[s + F_CLOSE],
      volume: d[s + F_VOLUME],
      takerBuyBase: d[s + F_TAKER],
      closeTime: d[s + F_CLOSE_TIME]
    };
  }

  /** تثبيت الشمعة الجارية: كتابة المجاميع الصحيحة المُقسَّمة على 1e8 */
  function flushCurrent(rec) {
    if (rec.curIdx < 0) return;
    const s = slotOf(rec, rec.curIdx);
    rec.data[s + F_VOLUME] = rec.volInt / Q;
    rec.data[s + F_TAKER] = rec.takerInt / Q;
  }

  /**
   * بذر مفتاح بصفوف REST على شكل بينانس:
   * [0]=openTime، [1]=open، [2]=high، [3]=low، [4]=close، [5]=volume، [6]=closeTime، [9]=takerBuyBase.
   * تُخزَّن كأرقام، وتُبنى حلقة بسعة capacity تحتفظ بأحدث capacity شمعة بترتيب زمني تصاعدي.
   * الصفوف غير الصالحة (قيم غير منتهية أو openTime غير صالح) تُتجاهل بلا رمي.
   * @returns {number} عدد الشموع المخزَّنة
   */
  function seed(symbol, tf, rows) {
    const sym = normSymbol(symbol);
    const frame = normTf(tf);
    if (!sym || !frame || !Array.isArray(rows)) return 0;
    const key = `${sym}|${frame}`;
    const rec = ensureRec(key);
    // إعادة البذر تبني الحلقة من جديد (لا خلط بين بذرتين)
    rec.start = 0;
    rec.size = 0;
    rec.curOpenTime = null;
    rec.curIdx = -1;
    rec.volInt = 0;
    rec.takerInt = 0;

    // استخراج الصفوف الصالحة أولاً ثم الاحتفاظ بأحدث capacity منها (بترتيب تصاعدي)
    const valid = [];
    for (const row of rows) {
      if (!Array.isArray(row)) continue;
      const openTime = num(row[0]);
      const open = num(row[1]);
      const high = num(row[2]);
      const low = num(row[3]);
      const close = num(row[4]);
      const volume = num(row[5]);
      const closeTime = num(row[6]);
      const taker = num(row[9]);
      if (openTime === null || open === null || high === null || low === null || close === null) continue;
      valid.push({
        openTime,
        open,
        high,
        low,
        close,
        volume: volume === null ? 0 : volume,
        closeTime: closeTime === null ? openTime : closeTime,
        taker: taker === null ? 0 : taker
      });
    }
    valid.sort((a, b) => a.openTime - b.openTime);
    const kept = valid.length > cap ? valid.slice(valid.length - cap) : valid;
    for (const b of kept) {
      pushBar(rec, b.openTime, b.open, b.high, b.low, b.close, b.volume, b.taker, b.closeTime);
    }
    if (kept.length) {
      const last = kept[kept.length - 1];
      rec.curOpenTime = last.openTime;
      rec.curIdx = rec.size - 1;
      rec.volInt = Math.round(last.volume * Q);
      rec.takerInt = Math.round(last.taker * Q);
    }
    lastUpdateAt = Date.now();
    return rec.size;
  }

  /**
   * تطبيق شمعة دقيقة على كل الفريمات المخزَّنة للرمز.
   * @param {string} symbol
   * @param {{ openTime:number, open:number, high:number, low:number, close:number, volume:number, takerBuyBase:number }} bar
   * @returns {Array<{ tf:string, bar:object }>} الشموع التي أُغلقت في هذه النقلة
   */
  function apply1m(symbol, bar) {
    const sym = normSymbol(symbol);
    if (!sym || !bar || typeof bar !== 'object') return [];
    const openTime = num(bar.openTime);
    const open = num(bar.open);
    const high = num(bar.high);
    const low = num(bar.low);
    const close = num(bar.close);
    if (openTime === null || open === null || high === null || low === null || close === null) return [];
    const volume = num(bar.volume);
    const taker = num(bar.takerBuyBase);
    const vol = volume === null ? 0 : volume;
    const tk = taker === null ? 0 : taker;

    const closed = [];
    const frames = bySymbol.get(sym);
    if (!frames) return closed;
    for (const frame of frames) {
      const rec = store.get(`${sym}|${frame}`);
      if (!rec) continue;
      const tfMs = TF_MS[frame];
      if (!tfMs) continue;
      // لا نافذة جارية (مفتاح فارغ) → لا شيء نطبّقه عليه
      if (rec.curOpenTime === null || rec.curIdx < 0) continue;

      // 1) بيانات أقدم من المخزَّن: تُتجاهل ولا تُفسد الترتيب
      if (openTime < rec.curOpenTime) continue;

      // 2) داخل النافذة الجارية: تحديث تراكمي (open وopenTime لا يتغيران)
      if (openTime < rec.curOpenTime + tfMs) {
        const s = slotOf(rec, rec.curIdx);
        const d = rec.data;
        if (high > d[s + F_HIGH]) d[s + F_HIGH] = high;
        if (low < d[s + F_LOW]) d[s + F_LOW] = low;
        d[s + F_CLOSE] = close;
        rec.volInt += Math.round(vol * Q);
        rec.takerInt += Math.round(tk * Q);
        d[s + F_VOLUME] = rec.volInt / Q;
        d[s + F_TAKER] = rec.takerInt / Q;
        continue;
      }

      // 3) شمعة جديدة: تُغلق النافذة الجارية وتُعاد في الناتج
      flushCurrent(rec);
      const closedBar = readBar(rec, rec.curIdx);
      closed.push({ tf: frame, bar: closedBar });

      // تقدّم بالنافذة خطوة TF_MS حتى تحتوي T. تقدّم أكثر من خطوة = فجوة في الدقائق:
      // لا تُصنّع شموع وهمية، بل ابدأ نافذة جديدة بالشمعة الواردة فقط وسجّل الفجوة.
      const steps = Math.floor((openTime - rec.curOpenTime) / tfMs);
      if (steps > 1) gaps += 1;
      const newOpenTime = rec.curOpenTime + steps * tfMs;
      const newIdx = pushBar(rec, newOpenTime, open, high, low, close, vol, tk, newOpenTime + tfMs - 1);
      rec.curOpenTime = newOpenTime;
      rec.curIdx = newIdx;
      // الشمعة الواردة هي أول شمعة في النافذة الجديدة، فتُدرج في المجاميع الصحيحة
      rec.volInt = Math.round(vol * Q);
      rec.takerInt = Math.round(tk * Q);
    }
    if (closed.length) lastUpdateAt = Date.now();
    return closed;
  }

  /**
   * صفوف على شكل REST: كل صف طوله 10 عناصر
   * [openTime, open, high, low, close, volume, closeTime, 0, 0, takerBuyBase] بأرقام.
   * متوافقة مع normalizeCandles (يقرأ [0..5]) ومع computeCvd (يقرأ [5] و[9]).
   * @returns {Array<Array<number>>} [] إن لم يكن المفتاح مبذوراً
   */
  /**
   * شموع جاهزة بشكل `normalizeCandles` مباشرة: {time بالثواني, open, high, low, close, volume, index}.
   *
   * الغرض: حذف تخصيص وسيط. المسار القديم كان يبني مصفوفة 500×10 عناصر لكل نداء ثم
   * يحوّلها `normalizeCandles` إلى 500 كائن — أي ضِعف التخصيص لكل فحص. على 6,006 مفتاحاً
   * في الدقيقة يعني ذلك ملايين العناصر المؤقتة في الثانية، وهي ما يرفع rss بلا فائدة
   * (قياس محلي: rss 946MB على حدّ 1024MB). القيم هنا **نفسها بالحرف** بلا أي حساب.
   */
  function getCandles(symbol, tf) {
    const sym = normSymbol(symbol);
    const frame = normTf(tf);
    if (!sym || !frame) return [];
    const rec = store.get(`${sym}|${frame}`);
    if (!rec || rec.size === 0) return [];
    const out = new Array(rec.size);
    for (let i = 0; i < rec.size; i += 1) {
      const b = readBar(rec, i);
      out[i] = {
        time: b.openTime / 1000,
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
        volume: b.volume,
        index: i
      };
    }
    return out;
  }

  function getRows(symbol, tf) {
    const sym = normSymbol(symbol);
    const frame = normTf(tf);
    if (!sym || !frame) return [];
    const rec = store.get(`${sym}|${frame}`);
    if (!rec || rec.size === 0) return [];
    const out = new Array(rec.size);
    for (let i = 0; i < rec.size; i += 1) {
      const b = readBar(rec, i);
      out[i] = [b.openTime, b.open, b.high, b.low, b.close, b.volume, b.closeTime, 0, 0, b.takerBuyBase];
    }
    return out;
  }

  /**
   * عرض للقراءة فقط على المخزن الداخلي (بلا نسخ).
   * data = Float64Array(cap * 8) بحلقة دائرية، size = عدد الشموع الفعلي.
   * @returns {{ data: Float64Array, size: number } | null}
   */
  function buffer(symbol, tf) {
    const sym = normSymbol(symbol);
    const frame = normTf(tf);
    if (!sym || !frame) return null;
    const rec = store.get(`${sym}|${frame}`);
    if (!rec) return null;
    return { data: rec.data, size: rec.size };
  }

  /** هل المفتاح مبذور؟ */
  function has(symbol, tf) {
    const sym = normSymbol(symbol);
    const frame = normTf(tf);
    if (!sym || !frame) return false;
    return store.has(`${sym}|${frame}`);
  }

  /** عدد الشموع المخزَّنة للمفتاح (0 إن لم يُبَذ) */
  function size(symbol, tf) {
    const sym = normSymbol(symbol);
    const frame = normTf(tf);
    if (!sym || !frame) return 0;
    return store.get(`${sym}|${frame}`)?.size ?? 0;
  }

  /** openTime لأحدث شمعة مخزَّنة (null إن لم يُبَذ) */
  function lastOpen(symbol, tf) {
    const sym = normSymbol(symbol);
    const frame = normTf(tf);
    if (!sym || !frame) return null;
    const rec = store.get(`${sym}|${frame}`);
    if (!rec || rec.size === 0) return null;
    return rec.data[slotOf(rec, rec.size - 1) + F_OPEN_TIME];
  }

  /** حذف كل مفاتيح رمز (كل فريماته) — يُعيد عدد المفاتيح المحذوفة */
  function deleteSymbol(symbol) {
    const sym = normSymbol(symbol);
    if (!sym) return 0;
    const frames = bySymbol.get(sym);
    let removed = 0;
    if (frames) {
      for (const frame of frames) {
        if (store.delete(`${sym}|${frame}`)) removed += 1;
      }
      bySymbol.delete(sym);
    }
    return removed;
  }

  /**
   * إحصاء المخزن.
   * bytes تقدير فعلي لأحجام Float64Array المحجوزة (8 بايت × cap × 8 قيم لكل مفتاح).
   */
  function stats() {
    let bars = 0;
    for (const rec of store.values()) bars += rec.size;
    return {
      keys: store.size,
      bars,
      bytes: store.size * cap * STRIDE * 8,
      capacity: cap,
      lastUpdateAt,
      gaps
    };
  }

  return { seed, apply1m, getRows, getCandles, buffer, has, size, lastOpen, deleteSymbol, stats };
}
