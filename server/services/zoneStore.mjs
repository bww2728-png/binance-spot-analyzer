/**
 * سياسة تخزين مخزون مناطق السيولة (ذاكرة).
 *
 * القياس على التشغيل الحقيقي: حجم المنطقة الواحدة ~2.5KB JSON. ودورة الفحص الكاملة
 * (429 زوجاً × 14 فريماً) تنتج ~27 ألف منطقة حيّة و~357 ألف منطقة تاريخية (~700MB)،
 * أي أن الخادم يقتل نفسه بالـOOM قبل إكمال أي تشغيل طويل على حاوية حدّها 1GB.
 *
 * الفصل هنا جوهري:
 *  - **التاريخي**: بيانات عرض ومراجعة فقط (لا محرك قرار يقرأها). فيُحفظ لكل
 *    (رمز، فريم) أحدث مسح فقط، مع سقف كلي يُسقط الأقدم. هذا يطابق سياسة الاحتفاظ
 *    المعتمدة (الاحتفاظ بأحدث اللقطات لكل رمز لا بكل التاريخ).
 *  - **الحي**: يقرأه محرك الفرص (`zoneSource`)، فلا يُحذف منه شيء **بالسقف** داخل هذه
 *    الوحدة. الحماية الوحيدة المتاحة بلا تغيير سلوكي هي إيقاف **بدء** دورة جديدة عند
 *    بلوغ السقف، مع تصريح ظاهر في الصحة، بدل النمو المستمر حتى موت الحاوية.
 *    الاستثناء الوحيد: `pruneMissingKeys` تُسقط مناطق مفتاح **غادر المخزن فعلاً**
 *    بعد مهلة سماح، لأن بقاءها يعني قراراً على سعر لم يعد في الذاكرة.
 */

/** سقف المخزون التاريخي (عرض فقط): 40 ألف منطقة ≈ 100MB في الذاكرة */
export const DEFAULT_HISTORY_MAX_ZONES = 40_000;
/** سقف المخزون الحي: عنده تُؤجَّل الدورة الجديدة، ولا يُحذف أي منطقة */
export const DEFAULT_LIVE_MAX_ZONES = 40_000;

/**
 * تسامح هوية المنطقة (نسبة سعرية).
 *
 * الرقم مشتق من القياس لا من التقدير:
 *  - **أقصى انزلاق مُقاس** لنفس المستوى = 0.012% (4 نسخ بين 76,507.38 و76,516.40)،
 *    فالتسامح يجب أن يعلوه.
 *  - **أقرب مستويين مختلفين مُقاسين** = 0.033% (76,752.19 مقابل 76,777.37 — الشارت
 *    يرسمهما منفصلين بلمسات 217 و18)، فالتسامح يجب أن ينزل عنه.
 *
 * 0.02% = 1.7× الانزلاق و0.6× المسافة بين مستويين حقيقيين: يمسح التكرار ولا يمسّ
 * التمييز. قابل للتغيير بـ`LIQUIDITY_ZONE_ID_TOLERANCE` داخل حدود آمنة (انظر TOL_MIN/MAX).
 */
export const DEFAULT_IDENTITY_TOLERANCE_PCT = 0.0002;

/**
 * حدود التسامح. السقف 0.05% = أدنى تسامح تقطيع في `adaptiveConfig` (`engine.mjs:97`،
 * `:390`)؛ أي قيمة أعلى تدمج مستويات يعتبرها المُكتشف منفصلة وتُغذّي محرك القرار.
 * الأرضية 1e-6 تمنع `Math.log1p(tol) === 0` الذي يجعل كل الأسعار كتلة واحدة.
 */
export const IDENTITY_TOLERANCE_MIN = 1e-6;
export const IDENTITY_TOLERANCE_MAX = 5e-4;

/** التسامح المُطبَّق فعلاً (يُعرض في الصحة كي لا يكذب الإعداد) */
export function resolveIdentityTolerance(tolerancePct) {
  const v = Number(tolerancePct);
  if (!Number.isFinite(v) || v <= 0) return DEFAULT_IDENTITY_TOLERANCE_PCT;
  return Math.min(IDENTITY_TOLERANCE_MAX, Math.max(IDENTITY_TOLERANCE_MIN, v));
}

/** مهلة السماح قبل إسقاط مناطق مفتاح غادر المخزن (تُحسب من لحظة أول غياب) */
export const DEFAULT_STALE_GRACE_MS = 60 * 60_000;

const refOf = (z) => {
  const v = Number(z?.referenceLevel);
  return Number.isFinite(v) && v > 0 ? v : null;
};

const tolOf = (tolerancePct) => resolveIdentityTolerance(tolerancePct);

/** كتلة سعرية لوغاريتمية: نسبية، فتعمل على 0.0001 و100,000 بالسواء */
const bucketOf = (ref, tol) => Math.round(Math.log(ref) / Math.log1p(tol));

const baseKeyOf = (z) => `${z?.symbol}|${z?.timeframe}|${z?.kind ?? ''}`;

/**
 * مفتاح هوية المنطقة **من محتواها لا من معرّفها**.
 *
 * السبب المُقاس: `id` يحمل رقم العنقود (`cluster-low-2`)، ورقم العنقود يتغيّر مع كل
 * انزلاق للنافذة (بيفوت يدخل أو يخرج). فيبقى للمستوى الفعلي الواحد صفّان أو أربعة
 * بأسماء مختلفة. القياس على مخزون BTCUSDT الحيّ: 18 منطقة لـ**10 مستويات** فقط،
 * بتكرار ×2 إلى ×4 لنفس السعر (76,956–76,961 أربع مرات، 76,507–76,516 أربع مرات).
 *
 * عند غياب سعر مرجعي (صفوف قديمة/اختبارات) نعود إلى المعرّف كما كان، فلا يتغيّر شيء.
 */
export function zoneLevelKey(z, tolerancePct = DEFAULT_IDENTITY_TOLERANCE_PCT) {
  const base = baseKeyOf(z);
  const ref = refOf(z);
  if (ref == null) return `${base}|id:${z?.id ?? ''}`;
  return `${base}|~${bucketOf(ref, tolOf(tolerancePct))}`;
}

/** الكتل المجاورة: الحدّ بين كتلتين ليس فرقاً سعرياً حقيقياً.
 *  كفاية ±1 برهان لا تقدير: الشرط |Δسعر|/سعر ≤ tol يعني |Δln| ≤ ln(1+tol) = عرض الكتلة،
 *  ومؤشر الكتلة = ln/عرض، فتغييره بهذا المقدار يُحرّك `Math.round` درجة واحدة كأقصى حد.
 *  ويُضاف مفتاح المعرّف (بنوعه وبلا نوع) كي يُستبدل صف قديم بلا سعر مرجعي أو بلا `kind`
 *  — بيانات ما قبل الإصلاح لا تُترك تكراراً أبدياً.
 */
const neighborKeys = (z, tol) => {
  const base = baseKeyOf(z);
  const idKey = `${base}|id:${z?.id ?? ''}`;
  const bareIdKey = `${z?.symbol}|${z?.timeframe}||id:${z?.id ?? ''}`;
  const ref = refOf(z);
  if (ref == null) return [idKey, bareIdKey];
  const b = bucketOf(ref, tol);
  return [idKey, bareIdKey, `${base}|~${b - 1}`, `${base}|~${b}`, `${base}|~${b + 1}`];
};

/** مفاتيح فهرسة صف موجود: كتلته السعرية + مفاتيح معرّفه (للمقارنة الخلفية) */
const indexKeysOf = (r, tol) => {
  const keys = [zoneLevelKey(r, tol)];
  if (r?.id != null) {
    keys.push(`${baseKeyOf(r)}|id:${r.id}`);
    keys.push(`${r.symbol}|${r.timeframe}||id:${r.id}`);
  }
  return keys;
};

/** هل الصفّان نفس المستوى الفعلي؟ (رمز + فريم + نوع + سعر داخل التسامح)
 *  `kind` الغائب في أحد الطرفين يُعدّ «غير معروف» لا «مخالفاً»: الصفوف القديمة بلا نوع
 *  يجب أن تُستبدل، لا أن تبقى بجانب نظيرها الجديد.
 */
export function isSameLevel(a, b, tolerancePct = DEFAULT_IDENTITY_TOLERANCE_PCT) {
  if (!a || !b) return false;
  if (a.symbol !== b.symbol || a.timeframe !== b.timeframe) return false;
  const ka = a.kind ?? '';
  const kb = b.kind ?? '';
  if (ka && kb && ka !== kb) return false;
  const ra = refOf(a);
  const rb = refOf(b);
  if (ra == null || rb == null) return a.id != null && a.id === b.id;
  return Math.abs(ra - rb) / Math.min(ra, rb) <= tolOf(tolerancePct);
}

/**
 * دمج الوارد في المخزون بهوية المحتوى، مع ترتيب تنازلي بالثقة (نفس دلالات الدمج
 * الأصلية). الفرق الوحيد: صفوف المخزون التي تقع على نفس المستوى الفعلي **تُستبدل**
 * كلها، لا صف واحد فقط؛ فالتكرار المتراكم من الدورات السابقة يُنظَّف تلقائياً في
 * أول دورة تُعيد كشف ذلك المفتاح.
 *
 * التعقيد: فهرس Map على `rows` + مرور خطي على `rows` والوارد المرتب — O(n + m).
 */
export function mergeZones(rows, incoming, { tolerancePct = DEFAULT_IDENTITY_TOLERANCE_PCT } = {}) {
  const tol = tolOf(tolerancePct);
  if (!Array.isArray(incoming) || incoming.length === 0) return rows;

  // فهرس الصفوف الحالية بالكتلة السعرية (كتلة واحدة + جيرانها تغطي أي تسامح)
  /**
   * الفهرسة محدودة بنطاق الوارد: في المسار الساخن (مفتاح واحد لكل نداء) لا نبني كائناً
   * لكل صف من 40 ألف صف — نقارن رمزاً وفريماً (بلا تخصيص) ونفهرس الصفوف المطابقة فقط.
   * هذه الكلفة كانت O(n) في النسخة القديمة أيضاً (`keyOf` لكل صف في حلقة الدمج)،
   * لكن بناء Map لكل المخزون في كل نداء كان سيضاعفها بلا داع، و6,006 نداء في الدورة
   * تجعل الفرق مقاساً لا نظرياً.
   */
  const first = incoming.find((z) => z && z.symbol != null && z.timeframe != null) ?? null;
  if (!first) return rows;
  const singleScope = incoming.every((z) => z && z.symbol === first.symbol && z.timeframe === first.timeframe);
  /**
   * نطاق متعدد (مسح رمز كامل = 14 فريماً): فحص بالمجموعتين لا بمفتاح نصي لكل صف —
   * بناء نص لـ40 ألف صف × 429 رمزاً في الدورة كان تخصيصاً بلا فائدة.
   * الشمول الزائد (رمز من الوارد × فريم من آخر) غير ضار: `isSameLevel` يشترط الرمز
   * والفريم معاً، فلا يُدمج أو يُستبدل صف خارج النطاق الحقيقي.
   */
  const scopeSymbols = singleScope ? null : new Set(incoming.filter(Boolean).map((z) => z.symbol));
  const scopeFrames = singleScope ? null : new Set(incoming.filter(Boolean).map((z) => z.timeframe));

  const index = new Map();
  for (let i = 0; i < rows.length; i += 1) {
    const r = rows[i];
    if (singleScope) {
      if (r.symbol !== first.symbol || r.timeframe !== first.timeframe) continue;
    } else if (!scopeSymbols.has(r.symbol) || !scopeFrames.has(r.timeframe)) {
      continue;
    }
    for (const key of indexKeysOf(r, tol)) {
      const list = index.get(key);
      if (list) {
        if (list[list.length - 1] !== i) list.push(i);
      } else {
        index.set(key, [i]);
      }
    }
  }

  const replaced = new Set();
  const kept = [];
  /**
   * إزالة تكرار الوارد عبر Map لا عبر `findIndex` (كان O(m²): مسح رمز واحد = 14 فريماً ×
   * حتى 200 منطقة = 2,800 صف ⇒ ~3.9M مقارنة لكل رمز، ×429 رمزاً في الدورة).
   */
  const keptIndex = new Map();
  const keptSlots = (z) => {
    const base = baseKeyOf(z);
    const ref = refOf(z);
    if (ref == null) return [`${base}|id:${z?.id ?? ''}`];
    const b = bucketOf(ref, tol);
    return [`${base}|~${b - 1}`, `${base}|~${b}`, `${base}|~${b + 1}`];
  };
  /** الأفضل: ثقة أعلى، وعند التعادل الأحدث إنشاءً (حتمي لا يعتمد على ترتيب الوارد) */
  const betterThan = (a, b) => {
    const ca = a?.confidence ?? 0;
    const cb = b?.confidence ?? 0;
    if (ca !== cb) return ca > cb;
    return (Number(a?.createdAt) || 0) > (Number(b?.createdAt) || 0);
  };

  for (const z of incoming) {
    if (!z) continue;
    for (const key of neighborKeys(z, tol)) {
      const list = index.get(key);
      if (!list) continue;
      for (const i of list) {
        if (replaced.has(i)) continue;
        if (!isSameLevel(rows[i], z, tol)) continue;
        replaced.add(i);
      }
    }
    // الوارد نفسه قد يحمل مستويين متقاربين (عنقودان انزلقا في نفس الدفعة)
    let dupAt = -1;
    for (const key of keptSlots(z)) {
      for (const pos of keptIndex.get(key) ?? []) {
        if (isSameLevel(kept[pos], z, tol)) { dupAt = pos; break; }
      }
      if (dupAt >= 0) break;
    }
    if (dupAt >= 0) {
      if (betterThan(z, kept[dupAt])) kept[dupAt] = z;
      continue;
    }
    const pos = kept.push(z) - 1;
    const ownKey = zoneLevelKey(z, tol);
    const slot = keptIndex.get(ownKey);
    if (slot) slot.push(pos);
    else keptIndex.set(ownKey, [pos]);
  }
  if (kept.length === 0) return rows;

  const sortedIncoming = kept.sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));

  const out = [];
  let i = 0;
  let j = 0;
  while (i < rows.length || j < sortedIncoming.length) {
    if (i < rows.length && replaced.has(i)) {
      i += 1;
      continue;
    }
    if (i >= rows.length) {
      out.push(sortedIncoming[j++]);
    } else if (j >= sortedIncoming.length) {
      out.push(rows[i++]);
    } else if ((rows[i].confidence ?? 0) >= (sortedIncoming[j].confidence ?? 0)) {
      out.push(rows[i++]);
    } else {
      out.push(sortedIncoming[j++]);
    }
  }
  return out;
}

/**
 * كتابة مناطق زوج/فريم مع استبدال مسحه السابق.
 * الغرض: منع تراكم مسح قديم بجانب مسح جديد لنفس الزوج والفريم (نفس السبب في كل دورة).
 * `options.tolerancePct` يُمرَّر إلى الدمج كي لا يختلف سلوك المسارين عند ضبط الـenv.
 */
export function replacePairScan(rows, symbol, timeframe, zones, options = {}) {
  const rest = rows.filter(r => !(r.symbol === symbol && r.timeframe === timeframe));
  return mergeZones(rest, zones, options);
}

/**
 * كتابة مناطق رمز كامل (كل فريماته) دفعة واحدة مع استبدال مسحه السابق.
 *
 * السبب: الاستبدال لكل فريم يعني فرز وتصفية 40 ألف صف × 14 فريماً × 429 زوجاً في كل
 * دورة، أي دقائق من CPU على نواة واحدة. تجميعه لكل زوج يجعل الكلفة مرة واحدة لكل زوج
 * (429 مرة في الدورة) بلا أي فرق في الناتج.
 */
export function replaceSymbolScan(rows, symbol, timeframes, zones, options = {}) {
  const tfSet = new Set(timeframes);
  const rest = rows.filter(r => !(r.symbol === symbol && tfSet.has(r.timeframe)));
  return mergeZones(rest, zones, options);
}

/** إسقاط الأقدم عند تجاوز السقف (الأحدث أولاً بالاحتفاظ) */
export function boundByNewest(rows, cap) {
  if (!Number.isFinite(cap) || cap <= 0 || rows.length <= cap) return rows;
  const score = (r) => Number(r.detectedAt ?? r.at ?? r.confirmedAt ?? 0) || 0;
  return [...rows].sort((a, b) => score(b) - score(a)).slice(0, cap);
}

/**
 * آخر لمسة للمنطقة بالمللي ثانية.
 * `touchPoints[].time` و`createdAt` بالثواني (زمن شمعة بينانس)، فتُضرب في 1000.
 */
export function lastTouchMs(z) {
  let max = 0;
  const points = Array.isArray(z?.touchPoints) ? z.touchPoints : [];
  for (const p of points) {
    const t = Number(p?.time);
    if (Number.isFinite(t) && t > max) max = t;
  }
  if (max > 0) return max * 1000;
  const created = Number(z?.createdAt);
  if (Number.isFinite(created) && created > 0) return created * 1000;
  return null;
}

/**
 * إسقاط مناطق المفاتيح التي غادرت مخزن الشموع.
 *
 * السبب المُقاس: بعد فشل بذر 3,503 مفتاحاً من 3,766، بقيت مناطق 1m لـBTCUSDT في
 * المخزون الحيّ بعمر 274–321 دقيقة، لأن سياسة المخزون الحيّ لا تُسقط شيئاً أبداً.
 * عرضها كمناطق «حالية» يعني قراراً على سعر لم يعد في المخزن.
 *
 * السياسة: مفتاح غائب ⇒ إسقاط **بعد** مهلة سماح تُحسب من **لحظة أول غياب** لا من عمر
 * المنطقة. الفرق جوهري: منطقة عمرها 5 ساعات لمفتاح انقطع الآن يجب أن تُمهَّل كاملة،
 * وإلا صار «السماح» صفراً للمناطق القديمة — وهي بالضبط الحالة التي وُجد الإصلاح لها.
 *
 * `absentSince` خريطة يملكها المستدعي (مفتاح ⟶ أول لحظة غياب) وتُحدَّث هنا: تُضاف
 * المفاتيح الغائبة، وتُحذف عند عودتها، وتُنظَّف مفاتيح لا صفوف لها.
 *
 * @param {Array} rows
 * @param {{ hasKey?: (symbol: string, timeframe: string) => boolean, now?: number, graceMs?: number, absentSince?: Map<string, number> | null }} [options]
 * @returns {{ rows: Array, dropped: number, stale: number, kept: number }}
 */
export function pruneMissingKeys(rows, { hasKey, now = Date.now(), graceMs = DEFAULT_STALE_GRACE_MS, absentSince = null } = {}) {
  if (!Array.isArray(rows) || typeof hasKey !== 'function') {
    return { rows, dropped: 0, stale: 0, kept: Array.isArray(rows) ? rows.length : 0 };
  }
  const grace = Number.isFinite(Number(graceMs)) && Number(graceMs) >= 0
    ? Number(graceMs)
    : DEFAULT_STALE_GRACE_MS;
  const out = [];
  const seenKeys = new Set();
  let dropped = 0;
  let stale = 0;
  for (const z of rows) {
    const key = `${z.symbol}|${z.timeframe}`;
    if (hasKey(z.symbol, z.timeframe)) {
      if (absentSince) absentSince.delete(key);
      out.push(z);
      continue;
    }
    seenKeys.add(key);
    let since = absentSince ? absentSince.get(key) : null;
    if (!Number.isFinite(since)) {
      since = now;
      if (absentSince) absentSince.set(key, since);
    }
    const absentFor = now - since;
    /**
     * بلا خريطة غياب (استدعاء قديم) نعود للعمر — لكن العمر لا يُسقط منطقة حديثة اللمس
     * إلا إذا تجاوز المهلة فعلاً.
     */
    const measure = absentSince ? absentFor : (lastTouchMs(z) == null ? Infinity : now - lastTouchMs(z));
    if (measure > grace) {
      dropped += 1;
      continue;
    }
    stale += 1;
    out.push(z);
  }
  if (absentSince) {
    for (const key of absentSince.keys()) if (!seenKeys.has(key)) absentSince.delete(key);
  }
  if (dropped === 0) return { rows, dropped, stale, kept: rows.length };
  return { rows: out, dropped, stale, kept: out.length };
}

/** هل يُسمح ببدء دورة جديدة؟ (سقف <= 0 يعني بلا سقف) */
export function shouldStartRotation(currentCount, cap) {
  if (!Number.isFinite(cap) || cap <= 0) return true;
  return currentCount < cap;
}

/** الفحص الكامل للسياسة: يعني أن السقف مُفعَّل وأن المخزون بلغه */
export function capState(count, cap) {
  const bounded = Number.isFinite(cap) && cap > 0;
  return {
    capped: bounded && count >= cap,
    cap: bounded ? cap : null,
    count,
    usagePct: bounded ? Math.round((count / cap) * 100) : null
  };
}
