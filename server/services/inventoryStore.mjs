/**
 * استمرارية مخزون مناطق السيولة وملخصات الباك تيست (المرحلة 6 الناقصة).
 *
 * العيب المؤكد (B11): بعد إعادة التشغيل يضيع:
 *   • مخزون المناطق الحيّ (`liquidityState.liveResults`) — أكبر مخزن في الذاكرة.
 *   • نتائج الباك تيست (كانت في الذاكرة فقط، و`/api/backtest/results` يقول «لا يوجد»
 *     بعد كل نشرة رغم أن دورة كاملة استغرقت دقائق من نداءات بينانس).
 * فبدا النظام «يعمل» بينما تاريخه يعود إلى الصفر مع كل نشر.
 *
 * قرار التنفيذ: التخزين عبر `engineState` (مفتاح/قيمة في `events_log` بنوع
 * `engine_state`) لا جداول جديدة — لأن هذا المخزن **محمي صراحةً في سياسة الاحتفاظ**
 * (`PROTECTED_TYPES` في `retention.mjs`)، وصف واحد لكل مفتاح يُحدَّث في مكانه فلا
 * ينمو، ويعمل بلا تطبيق هجرة جديدة على القاعدة المنشورة.
 *
 * والقيد الأساسي: **لا يُحفظ مخزون المناطق كاملاً**. المخزون يصل إلى 40 ألف منطقة،
 * وحفظه نصاً يعني عدة ميغابايتات في كل دورة حفظ = إغراق القاعدة (A10) بلا فائدة:
 * المناطق تُعاد كشفها من المخزن المجمّع في أول دورة بعد الإقلاع. المحفوظ هو **ملخص
 * مضغوط** يجيب على ما يُسأل فعلاً بعد إعادة التشغيل: كم منطقة كانت، وبأي أنواع،
 * وما آخر مستويات سُحبت — وهو ما يسمح بمتابعة البوابات والسويبات فوراً.
 */

export const INVENTORY_KEY = 'liquidity_inventory';
export const BACKTEST_KEY = 'backtest_last_run';

/** سقف الرموز في الملخص المضغوط (الأكثر مناطق أولاً) */
export const INVENTORY_MAX_SYMBOLS = 400;
/** سقف المستويات المسحوبة لكل رمز */
export const INVENTORY_MAX_LEVELS = 6;

/**
 * ملخص مضغوط من مخزون المناطق الحيّ. حتمي: نفس المدخل → نفس المخرج (يُختبر).
 * @param {Array} zones مناطق المخزون الحيّ (`liquidityState.liveResults`)
 */
export function summarizeInventory(zones = [], { maxSymbols = INVENTORY_MAX_SYMBOLS, maxLevels = INVENTORY_MAX_LEVELS } = {}) {
  const bySymbol = new Map();
  const byKind = {};
  const byState = {};
  let total = 0;
  for (const z of zones) {
    if (!z) continue;
    total += 1;
    const kind = String(z.kind ?? 'unknown');
    const state = String(z.state ?? 'unknown');
    byKind[kind] = (byKind[kind] ?? 0) + 1;
    byState[state] = (byState[state] ?? 0) + 1;
    const symbol = String(z.symbol ?? '?').toUpperCase();
    const bucket = bySymbol.get(symbol) ?? { symbol, count: 0, swept: [] };
    bucket.count += 1;
    /**
     * أحدث المستويات المسحوبة فقط: هي التي يعتمد عليها محرك Fabio في «سويب ← استعادة»،
     * والمسحوبة القديمة لا قيمة لها بعد الإقلاع لأن البوابات تعيد تقييم الحالة من المخزن.
     */
    if (state === 'swept') {
      const level = Number(z.liquidityLevel ?? z.referenceLevel);
      const at = Number(z.sweptAt ?? z.detectedAt ?? 0);
      if (Number.isFinite(level)) bucket.swept.push({ level: Number(level.toPrecision(10)), at, kind, timeframe: z.timeframe ?? null });
    }
    bySymbol.set(symbol, bucket);
  }
  const symbols = [...bySymbol.values()]
    .sort((a, b) => b.count - a.count || (a.symbol < b.symbol ? -1 : 1))
    .slice(0, maxSymbols)
    .map((b) => ({
      symbol: b.symbol,
      count: b.count,
      swept: b.swept.sort((x, y) => y.at - x.at).slice(0, maxLevels)
    }));
  return {
    version: 1,
    total,
    symbols: symbols.length,
    byKind,
    byState,
    inventory: symbols
  };
}

/** حفظ الملخص. يُعيد true/false صريحاً ليعرف المشرف أن الحفظ تم (لا فشل صامت). */
export async function saveInventory(db, snapshot) {
  if (!db?.engineState?.put || !snapshot) return false;
  try {
    await db.engineState.put(INVENTORY_KEY, { ...snapshot, savedAt: Date.now() });
    return true;
  } catch { return false; }
}

export async function loadInventory(db) {
  if (!db?.engineState?.get) return null;
  try {
    const data = await db.engineState.get(INVENTORY_KEY);
    return data && typeof data === 'object' ? data : null;
  } catch { return null; }
}

/**
 * ملخص تشغيل باك تيست: يُختصر إلى ما يمكن عرضه وحفظه بلا تضخّم.
 * سبب الاختصار مُقاس: `lastRun.results` يحمل صفقات كل (رمز × فريم) كاملة، وكانت
 * تُحتجز في الذاكرة بلا حد — وهي جزء من سبب تضخّم الذاكرة، وحفظها نصاً في القاعدة
 * يعني آلاف الصفوف لكل دورة كل بضع دقائق.
 */
export function summarizeBacktestRun(run, { maxPairs = 60, maxTrades = 200 } = {}) {
  if (!run) return null;
  const results = Array.isArray(run.results) ? run.results : [];
  let trades = 0;
  let wins = 0;
  const pairs = [];
  for (const r of results) {
    const list = Array.isArray(r?.trades) ? r.trades : [];
    trades += list.length;
    for (const t of list) if (Number(t?.win) === 1) wins += 1;
    if (pairs.length < maxPairs) {
      pairs.push({ symbol: r?.symbol ?? null, timeframe: r?.timeframe ?? null, trades: list.length, reason: r?.reason ?? null });
    }
  }
  return {
    version: 1,
    savedAt: Date.now(),
    startedAt: run.startedAt ?? null,
    lastRunAt: run.lastRunAt ?? null,
    pairs: results.length,
    trades,
    wins,
    winRate: trades ? Number((wins / trades).toFixed(4)) : null,
    learn: run.learn ? { enough: !!run.learn.enough, winRate: run.learn.winRate ?? null, bias: run.learn.bias ?? null } : null,
    pairDetails: pairs,
    /** عيّنة صفقات محدودة للعرض: التفاصيل الكاملة لا تُحفظ في المفتاح/القيمة */
    sample: results.flatMap(r => (Array.isArray(r?.trades) ? r.trades.slice(0, 3) : [])).slice(0, maxTrades)
  };
}

export async function saveBacktestRun(db, run) {
  const summary = summarizeBacktestRun(run);
  if (!db?.engineState?.put || !summary) return false;
  try { await db.engineState.put(BACKTEST_KEY, summary); return true; } catch { return false; }
}

export async function loadBacktestRun(db) {
  if (!db?.engineState?.get) return null;
  try {
    const data = await db.engineState.get(BACKTEST_KEY);
    return data && typeof data === 'object' ? data : null;
  } catch { return null; }
}

/**
 * جدولة دورية لحفظ المخزون. الفاصل الافتراضي 10 دقائق: الملخص كيلوبايتات قليلة،
 * والحفظ الأكثر تواتراً لا يضيف معلومة (المناطق تتغيّر ببطء) ويزاحم القاعدة.
 */
export function startInventorySaver({ db, snapshotFn, intervalMs = 10 * 60_000, log = console, onSaved = null, now = () => Date.now() }) {
  const tick = async () => {
    try {
      const snapshot = summarizeInventory(snapshotFn?.() ?? []);
      const ok = await saveInventory(db, snapshot);
      try { onSaved?.({ ok, zones: snapshot.total, symbols: snapshot.symbols, at: now() }); } catch { /* القياس لا يعطّل الحفظ */ }
      if (!ok) log.warn?.('[inventory] تعذّر حفظ ملخص المخزون');
      return ok;
    } catch (e) {
      log.warn?.('[inventory] فشل الحفظ:', String(e?.message ?? e).slice(0, 160));
      return false;
    }
  };
  const timer = setInterval(() => { void tick(); }, intervalMs);
  if (timer.unref) timer.unref();
  return { stop: () => clearInterval(timer), run: tick };
}
