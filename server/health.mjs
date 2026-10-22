/**
 * قياس صحة النظام من داخل العملية + عيّنات دورية دائمة.
 *
 * الغرض: إتاحة الحكم على الاستقرار من أدلة مرصودة فعلاً (لا من انطباع)،
 * وكشف التوقف والتأخر وتقادم البيانات قبل أن تتفاقم.
 *
 * لا يعتمد على أي مكتبة خارجية. كل المحركات تُبلّغ هنا بحالتها.
 */
import { readFileSync } from 'node:fs';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { PerformanceObserver } from 'node:perf_hooks';
import v8 from 'node:v8';

const SAMPLER_MS = 5 * 60 * 1000;

/**
 * ضغط عيّنة الصحة قبل حفظها في القاعدة — **للحفظ فقط**، والفحص اللحظي يبقى كاملاً.
 *
 * السبب مُقاس: العيّنة الواحدة كانت 16,016 بايت وتُكتب كل 5 دقائق ولا يُحذف
 * جدولها أبداً (4.6 ميغابايت/يوم إلى الأبد). وأكثر الحجم من مصفوفات كائنات
 * تشخيصية (`liquidityV2.recent`، `shadow.records`، `zoneIdentity.examples`)
 * وهي أمثلة للعرض لا قياس: تكفي منها العدّة.
 *
 * القاعدة: مصفوفة كائنات ⇒ `{ n }`؛ مصفوفة قيم أولية ⇒ تبقى (بسقف 20 عنصراً)؛
 * نص ⇒ يُقصّ إلى 240 حرفاً؛ والكائنات تُعبر حتى عمق 4. البنية تبقى كما هي، فلا
 * ينكسر أي مستهلك يتوقّع مفتاحاً (`zones.live.count` مثلاً يبقى).
 */
export function compactSample(input, { maxDepth = 4, maxString = 240, maxPrimArray = 20, maxObjectArray = 8 } = {}) {
  const walk = (v, depth, inHead = false) => {
    if (v === null || v === undefined) return v;
    if (typeof v === 'string') return v.length > maxString ? `${v.slice(0, maxString)}…` : v;
    if (typeof v === 'number' || typeof v === 'boolean') return v;
    if (Array.isArray(v)) {
      const primitivesOnly = v.every(x => x === null || ['string', 'number', 'boolean'].includes(typeof x));
      if (primitivesOnly) return v.length > maxPrimArray ? { n: v.length, head: v.slice(0, maxPrimArray) } : v;
      /**
       * مصفوفة كائنات: **لا تُسقط إلى عدّاد فقط**. كان ذلك يُخفي تشخيصاً أساسياً —
       * اكشفته عيّنة إنتاجية حقيقية بعد النشر: `engines` (أهم قسم في العيّنة: دورات
       * كل محرك وإخفاقاته وتوقفه) صار `{n:8}` أي 7 بايت بدل تفاصيل المحركات الثمانية.
       * لذلك يُحفظ رأس محدود منها كاملاً (يكفي المحركات والأمثلة القليلة)، والقوائم
       * الطويلة (مثل `liquidityV2.recent` بمئات المناطق) يُحفظ رأسها ويُذكر طولها.
       * وداخل عناصر الرأس تُسقط المصفوفات إلى عدّاد (منع التفخيم المتداخل).
       */
      if (inHead) return { n: v.length };
      const head = v.slice(0, maxObjectArray).map(x => walk(x, depth + 1, true));
      return { n: v.length, head };
    }
    if (typeof v !== 'object') return String(v).slice(0, maxString);
    if (depth >= maxDepth) return { keys: Object.keys(v).slice(0, 12) };
    const out = {};
    for (const [k, val] of Object.entries(v)) out[k] = walk(val, depth + 1, inHead);
    return out;
  };
  return walk(input, 0, false);
}

/**
 * سقف مقصّ للفترة. السبب مُقاس: فترة أكبر من 2^31-1 مللي ثانية تُفيض في `setTimeout`
 * فيحوّلها Node إلى 1ms (`TimeoutOverflowWarning`)، فينقلب المُعيّن إلى مطرقة على
 * القاعدة بدل عيّنة كل دقائق. ولا معنى لفترة أقل من 30 ثانية أصلاً.
 */
const clampIntervalMs = (ms) => {
  const value = Number(ms);
  if (!Number.isFinite(value) || value <= 0) return SAMPLER_MS;
  return Math.min(Math.max(value, 30_000), 24 * 60 * 60 * 1000);
};

/** حد الذاكرة الفعلي للحاوية (cgroup v2 ثم v1) — null إن لم يُتاح */
function containerLimits() {
  const read = (p) => {
    try { return Number(readFileSync(p, 'utf8').trim()); } catch { return NaN; }
  };
  const v2 = read('/sys/fs/cgroup/memory.max');
  if (Number.isFinite(v2) && v2 > 0) {
    const cpuMax = readFileSync('/sys/fs/cgroup/cpu.max', 'utf8').trim().split(/\s+/);
    const quota = Number(cpuMax[0]) / Number(cpuMax[1] || 1);
    return { memoryLimitMb: Math.round(v2 / 1048576), cpuCores: Number.isFinite(quota) && quota > 0 ? quota : null };
  }
  const v1 = read('/sys/fs/cgroup/memory/memory.limit_in_bytes');
  if (Number.isFinite(v1) && v1 > 0 && v1 < 2 ** 62) {
    return { memoryLimitMb: Math.round(v1 / 1048576), cpuCores: null };
  }
  return { memoryLimitMb: null, cpuCores: null };
}

/** ذاكرة المضيف المتاحة (للسياق) */
function hostMemory() {
  try {
    const info = readFileSync('/proc/meminfo', 'utf8');
    const total = /MemTotal:\s+(\d+) kB/.exec(info);
    const avail = /MemAvailable:\s+(\d+) kB/.exec(info);
    return {
      hostTotalMb: total ? Math.round(Number(total[1]) / 1024) : null,
      hostAvailableMb: avail ? Math.round(Number(avail[1]) / 1024) : null
    };
  } catch {
    return { hostTotalMb: null, hostAvailableMb: null };
  }
}

function emptyEngine(name) {
  return {
    name,
    cycles: 0,
    failures: 0,
    lastCycleAt: 0,
    lastCycleMs: null,
    lastErrorAt: 0,
    lastError: null,
    stalled: false,
    extra: {}
  };
}

export function createHealth({ startedAt = Date.now(), stalls = {}, log = console } = {}) {
  /** أقسام إضافية تُدرَج في العيّنات المحفوظة (تُربط من الخادم بعد تهيئة المحركات) */
  const extraSections = {};
  /**
   * مزوّد قسم الشموع المجمّعة. يُربط من الخادم بعد تهيئة مخزن البث، ويُعرض داخل لقطة
   * الصحة مباشرة (لا في العيّنات فقط) لأن أثر التحويل الحادث يجب أن يُقاس لحظياً:
   * { keys, bars, bytesMb, capacity, gaps, lastUpdateAt, universe, seededKeys, seededPct, aggregateMode }.
   */
  let candlesProvider = null;
  const engines = new Map();
  const counters = {
    persistFailures: 0, persistWrites: 0, lastPersistAt: 0, lastPersistError: null,
    /** حجم آخر عيّنة قبل الضغط وبعده — دليل أثر التقليم على سعة التخزين */
    sampleBytesFull: 0, sampleBytesSaved: 0
  };
  const marks = {};

  /**
   * فحص الإقلاع: هل سقف الـheap أقل من حدّ الحاوية بهامش يكفي لغير الـheap؟
   * الهدف: أن يقتل V8 العملية بخطأ JS واضح عند الضغط، لا أن يقتلها الـcgroup صامتاً.
   * لا يُصلح السقف تلقائياً — لا يمكن تغيير `--max-old-space-size` بأمان بعد الإقلاع —
   * لكنه يجعل التعارض ظاهراً في كل عيّنة صحة بدل أن يظهر كتوقف بلا سبب.
   */
  const bootLimits = containerLimits();
  const bootHeapLimitMb = Math.round(v8.getHeapStatistics().heap_size_limit / 1048576);
  if (bootLimits.memoryLimitMb && bootHeapLimitMb > 0.7 * bootLimits.memoryLimitMb) {
    const warn = `سقف heap (${bootHeapLimitMb}MB) يتجاوز 70% من حدّ الحاوية (${bootLimits.memoryLimitMb}MB) — خطر قتل OOM صامت`;
    marks.heapCapWarning = warn;
    try { log.warn?.(`[health] ${warn}`); } catch { /* التسجيل لا يوقف الإقلاع */ }
  } else {
    marks.heapCapWarning = null;
  }

  const lag = monitorEventLoopDelay({ resolution: 20 });
  lag.enable();

  /**
   * قياس تجمّدات جامع القمامة (GC) — المرشَّح الأول لتجمّد ثوانٍ مع heap عند 87%.
   *
   * القياس الإنتاجي (البناء السابق): تأخّر الحلقة p50 = 52–82ms (سليم) بينما
   * p99 = 3,093–3,681ms وmax حتى 6,891ms. أنبوب سليم بهذه الحدّة يعني **توقفات
   * قليلة وطويلة** لا بطئاً منتشراً — وهذا التوقيع المميّز لتوقف V8 الكامل (major GC)
   * أو لحلقة متزامنة طويلة. بلا هذا القياس يبقى الترجيح تخميناً وأي إصلاح بلا أساس.
   *
   * `kind`: 1 = scavenge صغير، 2 = mark-sweep-compact كامل، 4 = تزايدي، 8 = ضعيف.
   * كل القياس في الذاكرة (حلقة محدودة) ولا يُضيف أي حمل على القاعدة.
   */
  const gcStats = { count: 0, totalMs: 0, maxMs: 0, majorCount: 0, majorMs: 0, majorMaxMs: 0, byKind: {}, worst: [] };
  let gcObserver = null;
  try {
    gcObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const ms = Number(entry.duration) || 0;
        const kind = Number(entry.detail?.kind ?? 0);
        gcStats.count += 1;
        gcStats.totalMs += ms;
        if (ms > gcStats.maxMs) gcStats.maxMs = ms;
        gcStats.byKind[kind] = gcStats.byKind[kind] ?? { count: 0, ms: 0 };
        gcStats.byKind[kind].count += 1;
        gcStats.byKind[kind].ms += ms;
        if (kind === 2) {                       // mark-sweep-compact = التوقف الكامل
          gcStats.majorCount += 1;
          gcStats.majorMs += ms;
          if (ms > gcStats.majorMaxMs) gcStats.majorMaxMs = ms;
        }
        if (ms >= 50) {                         // لا يُسجَّل إلا ما يستحق التفسير
          gcStats.worst.push({ at: Date.now(), ms: Number(ms.toFixed(1)), kind });
          if (gcStats.worst.length > 12) gcStats.worst.shift();
        }
      }
    });
    gcObserver.observe({ entryTypes: ['gc'] });
  } catch { gcObserver = null; }

  /** لقطة تجمّدات GC مع دقائق آخر توقف — تُصفَّر مع كل عيّنة مثل قياس التأخّر */
  function gcSnapshot() {
    const sinceMs = counters.lastPersistAt ? Date.now() - counters.lastPersistAt : null;
    return {
      enabled: gcObserver !== null,
      windowMs: sinceMs,
      count: gcStats.count,
      totalMs: Number(gcStats.totalMs.toFixed(1)),
      maxMs: Number(gcStats.maxMs.toFixed(1)),
      major: { count: gcStats.majorCount, totalMs: Number(gcStats.majorMs.toFixed(1)), maxMs: Number(gcStats.majorMaxMs.toFixed(1)) },
      byKind: gcStats.byKind,
      worst: gcStats.worst.slice(-6)
    };
  }
  function resetGc() {
    gcStats.count = 0; gcStats.totalMs = 0; gcStats.maxMs = 0;
    gcStats.majorCount = 0; gcStats.majorMs = 0; gcStats.majorMaxMs = 0;
    gcStats.byKind = {}; gcStats.worst = [];
  }

  /**
   * توزيع الـheap على مساحات V8 — يحدّد **مَن** يستهلك الذاكرة لا كم استُهلك فقط.
   *
   * السبب: `heapUsed` ثبت عند 81–89% من الحد (531–579MB من 652MB)، وهي المنطقة التي
   * يبدأ فيها V8 بالتجميع الكامل المتكرر، والتجميع الكامل على 550MB يستغرق ثوانيَ
   * ويوقف حلقة الأحداث — وهذا يفسّر p50 سليماً (52–82ms) مع p99 بالثواني (3,093–3,681ms).
   * لكن «الضغط مرتفع» لا يقول **ما** يجب تصغيره. مساحات V8 تقول ذلك:
   *  - `new` (الحضانة): كائنات قصيرة العمر ⇒ حمولة إنشاء عالية.
   *  - `old`: كائنات معمَّرة ومصفوفات عادية ⇒ مخازن الحالة الطويلة (المناطق، الفرص).
   *  - `large_object`: كائنات أكبر من ~500KB ⇒ **المصفوفات الضخمة** (مخزن الشموع).
   *  - `code`/`read_only`: النصوص البرمجية ⇒ كبر الحزمة أو تكرار تحميل وحدات.
   * والقراءة رخيصة (عدّادات V8 لا مسح ذاكرة) فلا تُثقل العيّنة.
   */
  function heapSpaces() {
    try {
      const spaces = v8.getHeapSpaceStatistics().map(s => ({
        space: s.space_name,
        usedMb: Number((s.space_used_size / 1048576).toFixed(1)),
        totalMb: Number((s.space_size / 1048576).toFixed(1)),
        pct: s.space_size ? Number((100 * s.space_used_size / s.space_size).toFixed(1)) : 0
      })).sort((a, b) => b.usedMb - a.usedMb);
      const st = v8.getHeapStatistics();
      return {
        spaces,
        heapUsedMb: Number((st.used_heap_size / 1048576).toFixed(1)),
        heapLimitMb: Number((st.heap_size_limit / 1048576).toFixed(1)),
        /** نسبة الضغط الحقيقية على الحد: علامة التجميع المتكرر قبل القتل */
        pressurePct: Number((100 * st.used_heap_size / Math.max(1, st.heap_size_limit)).toFixed(1)),
        contexts: st.number_of_native_contexts,
        physicalMb: Number((st.total_physical_size / 1048576).toFixed(1)),
        mallocedMb: Number((st.malloced_memory / 1048576).toFixed(1))
      };
    } catch (e) {
      return { error: String(e?.message ?? e).slice(0, 160) };
    }
  }

  const defaults = {
    /** ms بلا دورة تُعدّ إشارة تعليق للمحرك */
    defaultStallMs: 10 * 60 * 1000,
    ...stalls
  };

  function register(name, opts = {}) {
    const rec = engines.get(name) ?? emptyEngine(name);
    if (opts.stallMs) rec.stallMs = opts.stallMs;
    engines.set(name, rec);
    return {
      beat: ({ ms = null, extra = null } = {}) => {
        rec.cycles += 1;
        rec.lastCycleAt = Date.now();
        if (Number.isFinite(ms)) rec.lastCycleMs = Math.round(ms);
        if (extra) rec.extra = { ...rec.extra, ...extra };
      },
      fail: (err) => {
        rec.failures += 1;
        rec.lastErrorAt = Date.now();
        rec.lastError = String(err?.message ?? err).slice(0, 300);
      },
      set: (extra) => { rec.extra = { ...rec.extra, ...extra }; }
    };
  }

  function notePersist({ ok, error = null } = {}) {
    if (ok) {
      counters.persistWrites += 1;
      counters.lastPersistAt = Date.now();
    } else {
      counters.persistFailures += 1;
      counters.lastPersistError = String(error?.message ?? error).slice(0, 300);
    }
  }

  function mark(key, value = Date.now()) {
    marks[key] = value;
  }

  function enginesSnapshot(now = Date.now()) {
    const out = [];
    for (const rec of engines.values()) {
      const stallMs = rec.stallMs ?? defaults.defaultStallMs;
      const since = rec.lastCycleAt ? now - rec.lastCycleAt : null;
      out.push({
        name: rec.name,
        cycles: rec.cycles,
        failures: rec.failures,
        lastCycleAt: rec.lastCycleAt || null,
        sinceCycleMs: since,
        lastCycleMs: rec.lastCycleMs,
        stalled: rec.lastCycleAt > 0 && since > stallMs,
        lastError: rec.lastError,
        lastErrorAt: rec.lastErrorAt || null,
        extra: rec.extra
      });
    }
    return out;
  }

  function snapshot() {
    const now = Date.now();
    const mem = process.memoryUsage();
    const limits = containerLimits();
    const rssMb = Math.round(mem.rss / 1048576);
    const heapLimitMb = Math.round(v8.getHeapStatistics().heap_size_limit / 1048576);
    return {
      ok: true,
      now,
      up: startedAt,
      uptimeSec: Math.round((now - startedAt) / 1000),
      mem: {
        rssMb,
        heapUsedMb: Math.round(mem.heapUsed / 1048576),
        heapTotalMb: Math.round(mem.heapTotal / 1048576),
        externalMb: Math.round(mem.external / 1048576),
        arrayBuffersMb: Math.round(mem.arrayBuffers / 1048576),
        limitMb: limits.memoryLimitMb,
        headroomMb: limits.memoryLimitMb ? limits.memoryLimitMb - rssMb : null,
        cpuCores: limits.cpuCores,
        ...hostMemory()
      },
      /**
       * حد الـheap الفعلي داخل V8 (`--max-old-space-size`). يُسجَّل لأن أهم خطر على
       * التشغيل المستمر هو أن يتجاوز سقف heap حدّ الحاوية فيقتل الـcgroup العملية
       * قبل أن يضغط V8 نفسه. الرقم هنا هو الدليل، لا الافتراض.
       */
      heapLimitMb,
      lagMs: {
        p50: Number((lag.percentile(50) / 1e6).toFixed(1)),
        p95: Number((lag.percentile(95) / 1e6).toFixed(1)),
        p99: Number((lag.percentile(99) / 1e6).toFixed(1)),
        max: Number((lag.max / 1e6).toFixed(1))
      },
      /**
       * تجمّدات GC: تفسّر بقيّة قياس التأخّر أعلاه. p50 سليم مع p99 بالثواني يعني
       * توقفات قليلة وطويلة، والفرق بينهما هو ما يحدّد الإصلاح (GC مقابل حلقة متزامنة).
       */
      gc: gcSnapshot(),
      /** توزيع الـheap: يحدّد أي مساحة تسبب الضغط الذي يوقف الحلقة */
      heap: heapSpaces(),
      persist: { ...counters, sincePersistMs: counters.lastPersistAt ? now - counters.lastPersistAt : null },
      /**
       * قسم الشموع المجمّعة: يُقاس لحظياً في كل لقطة صحة. أي فشل في المزوّد لا يُسقط
       * اللقطة (يُعرض كخطأ نصي) لأن الصحة نفسها يجب أن تبقى متاحة.
       */
      candles: (() => {
        if (typeof candlesProvider !== 'function') return null;
        try { return candlesProvider(); } catch (e) { return { error: String(e?.message ?? e).slice(0, 160) }; }
      })(),
      engines: enginesSnapshot(now),
      marks
    };
  }

  function resetLag() { lag.reset(); }

  function startSampler({ db, intervalMs = SAMPLER_MS, log = console, sections = {} } = {}) {
    let timer = null;
    const period = clampIntervalMs(intervalMs);
    const write = async () => {
      try {
        const snap = snapshot();
        /**
         * إثراء العيّنة بمقاييس الجاهزية: التخزين الدائم جزء من الدليل المطلوب
         * للحكم بعد 72 ساعة (عمر آخر سعر، حداثة الشموع، المستهدفة، حالة العمال،
         * إخفاقات الحفظ). عيّنة الذاكرة وحدها لا تثبت صحة التشغيل.
         */
        const extra = {};
        for (const [key, fn] of Object.entries(extraSections)) {
          try { extra[key] = fn(); } catch (e) { extra[key] = { error: String(e?.message ?? e).slice(0, 160) }; }
        }
        const full = { ...snap, ...extra };
        const body = { ts: snap.now, data: compactSample(full) };
        await db.health.append(body);
        /**
         * عدّاد النجاح كان **غير موصول بأي كاتب**، فيبقى `persistWrites` صفراً أبداً
         * بينما الحفظ يعمل فعلاً — وهذا ينفي دليل الاستمرارية في الحكم النهائي.
         * يُحتسب هنا، ويُسجَّل حجم العيّنة قبل/بعد الضغط ليكون أثر التقليم مقيساً لا مُدّعى.
         */
        counters.persistWrites += 1;
        counters.lastPersistAt = snap.now;
        counters.sampleBytesFull = JSON.stringify(full).length;
        counters.sampleBytesSaved = JSON.stringify(body.data).length;
        resetLag();
        resetGc();
      } catch (e) {
        counters.persistFailures += 1;
        counters.lastPersistError = `health sample: ${e.message}`.slice(0, 300);
        log.error?.('[health] فشل حفظ العيّنة:', e.message);
      }
    };
    timer = setInterval(() => { void write(); }, period);
    if (timer.unref) timer.unref();
    void write();
    return { stop: () => clearInterval(timer), write, periodMs: period };
  }

  /** ربط قسم إضافي بالعيّنات المحفوظة (market/targets/shariah/dataFresh/workers) */
  function addSection(key, fn) { if (typeof fn === 'function') extraSections[key] = fn; }

  /**
   * تقييم كل الأقسام المسجَّلة وإرجاعها كائناً واحداً.
   *
   * السبب: نقطة `/api/health/deep` كانت تنسخ الأقسام **يدوياً** في جسم الرد، فكل قسم
   * يُسجَّل لاحقاً يظهر في العيّنات المحفوظة ولا يظهر في الفحص اللحظي بلا أي إنذار —
   * وهو ما حدث فعلاً مع `liquidityV2`: مسجَّل ومكتوب في العيّنات، وغائب كلياً عن الرد
   * اللحظي. الآن مصدر واحد: ما يُسجَّل يُعرض، بلا قائمة تُنسى.
   * فشل قسم واحد لا يُسقط الفحص: يُعرض كخطأ نصي في مكانه.
   */
  function sections() {
    const out = {};
    for (const [key, fn] of Object.entries(extraSections)) {
      try { out[key] = fn(); } catch (e) { out[key] = { error: String(e?.message ?? e).slice(0, 160) }; }
    }
    return out;
  }

  /** ربط مزوّد قسم الشموع المجمّعة (يُعرض في كل لقطة صحة) */
  function setCandlesProvider(fn) { candlesProvider = typeof fn === 'function' ? fn : null; }

  return { register, snapshot, startSampler, notePersist, mark, resetLag, gcSnapshot, heapSpaces, addSection, sections, setCandlesProvider };
}

export default createHealth;
