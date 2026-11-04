/* طبقة بيانات السوق الحية عبر WebSocket — أسعار كل السوق + شموع حية + تدفق صفقات لحظي
 *
 * المصدر: streams عامة من بينانس (بلا مفاتيح):
 *  - !miniTicker@arr  → كل السوق (~3700 رمز) كل ثانية → خريطة أسعار حية (صفر REST للأسعار)
 *  - <sym>@kline_<tf> → الشمعة الجارية كل ~1-2 ث وعلم x عند الإغلاق → مخازن شموع حية
 *  - <sym>@aggTrade   → كل الصفقات → CVD حي + فقاعات + آيسبرغ (بدون REST ولا توقف)
 *
 * حدود بينانس الرسمية ويُصمَّم حولها:
 *  - 1024 stream لكل اتصال (سقفنا العملي 900) → **توزيع تلقائي على عدة اتصالات** عند الحاجة
 *    (لا قص صامت: كل stream مطلوب يُشترك فعلاً — المالك ثابت عبر إعادة الاتصال)
 *  - 5 رسائل تحكم/ثانية لكل اتصال (طوابير تحكم مستقلة لكل اتصال، تجميع كل 300ms)
 *  - ping كل 3 دقائق (حزمة ws ترد بـpong تلقائياً) + فحص حياة: بلا رسائل 90 ث → قطع وإعادة
 *  - قطع إجباري بعد 24 ساعة → إعادة اتصال استباقية عند 23.5 ساعة
 *  - 300 محاولة اتصال/5 د → تراجع أُسّي 2s→30s فقط
 *
 * النمط: بذر REST مرة واحدة (500 شمعة) → تحديث حي بالبث → تسوية REST خفيفة دورية ضد الانجراف.
 */

// حزمة ws اختيارية: منصات تمنع WebSockets (مثل الخطط المجانية) تشغّل الموديول بلا بث حي —
// تعمل عندها الأسعار والشموع على بذر REST ودوريات الاستطلاع بدل البث، بلا أي انهيار.
let WebSocket = null;
try { WebSocket = (await import('ws')).default; } catch { WebSocket = null; }
const WS_OPEN = 1; // يكافئ WS_OPEN في حزمة ws
export const marketStreamsAvailable = () => WebSocket != null;
import { detectBubbles, detectIceberg } from '../liquidity/orderbook.mjs';
import { createCandleStore, TF_MS } from './candleStore.mjs';

const WS_HOSTS = [
  'wss://data-stream.binance.vision',
  'wss://stream.binance.com:9443',
  'wss://stream.binance.com:443'
];

/**
 * طابور مفاتيح منزوع التكرار يُجدول معالجة واحدة في نهاية دورة الأحداث الحالية
 * (ميكروتاسك واحد لكل نبضة). العلة التي يُصلحها: إغلاق عدة شموع لنفس المفتاح في نفس
 * النبضة كان يُشغّل الكشف مرات متعددة لنفس (رمز، فريم) بلا فائدة.
 * @param {(keys: string[]) => void} onFlush يُنادى مرة واحدة بكل المفاتيح المتغيّرة
 * @returns {{ add: (key:string)=>void, size: ()=>number, flushNow: ()=>void }}
 */
export function createKeyQueue(onFlush) {
  const pending = new Set();
  let scheduled = false;
  const flush = () => {
    scheduled = false;
    if (!pending.size) return;
    const keys = [...pending];
    pending.clear();
    try { onFlush(keys); } catch { /* معالجة فاشلة لا تُسقط الطابور */ }
  };
  return {
    add(key) {
      if (typeof key !== 'string' || !key) return;
      pending.add(key);
      if (scheduled) return;
      scheduled = true;
      queueMicrotask(flush);
    },
    size: () => pending.size,
    flushNow: flush
  };
}

export function createMarketStreams({
  log = console,
  now = () => Date.now(),
  seedKlines = null, // (symbol, tf, limit) => Promise<rawRows[]>
  fetchAllPrices = null, // () => Promise<{ [SYMBOL]: price }> — استطلاع REST احتياطي للسعر
  config = {}
} = {}) {
  const cfg = {
    /**
     * سقف الستريمات لكل اتصال. حدّ بينانس الشكلي 1024، لكن حشو كل الستريمات على
     * اتصال واحد يجعل الإنتاج الفعلي أبطأ من الطلب، فتتأخر نبضات الأسعار وتتقادم
     * (قياس: 880 ستريماً على اتصال واحد أعطى ~33 رسالة/ث بينما المطلوب ~860، فتراجعت
     * نسبة الرموز حديثة السعر من 105/180 إلى 65/180 خلال 20 ثانية).
     * التوزيع على اتصالات متعددة يرفع الإنتاجية ويعطي عزلاً عند انقطاع اتصال.
     */
    maxStreamsPerConn: Number(process.env.MAX_STREAMS_PER_CONN) || 250,
    controlBatchMs: 300,
    controlBatchSize: 200,        // عدد الستريمات في رسالة SUBSCRIBE الواحدة
    reconnectBaseMs: 2000,
    reconnectMaxMs: 30_000,
    proactiveReconnectMs: 23.5 * 3600_000,
    livenessTimeoutMs: 90_000,
    /** عمر السعر الذي يُعدّ بعده قديماً (تُوقف القرارات وتُعلن الحالة) */
    priceStaleMs: 10_000,
    /** سقف اشتراكات السعر لكل رمز (نبض 1 ثانية) */
    maxPriceSubs: Number(process.env.MAX_PRICE_SUBS) || 400,
    /** سقف عدد الرموز في كاش الأسعار (كل السوق ~1400) */
    maxPriceSymbols: Number(process.env.MAX_PRICE_SYMBOLS) || 2000,
    /**
     * فاصل استطلاع أسعار السوق عبر REST. العلة:
     * مضيفات البث الإنتاجية محجوبة (451) من عنوان الحاوية، والمتاح `*.vision` يدفع
     * نبضات السعر على دفعات متقطعة بفجوات تجاوزت 10 ثوان، فتتقادم أسعار الرموز الخاملة
     * (قياس فعلي: 62% من رموز القرار متقادمة). هذا الاستطلاع يضمن حداثة كل رمز.
     * الكلفة: طلب واحد ~26KB مضغوطاً لكل دورة، عبر مسار مستقل عن ستريمات البث.
     */
    pricePollMs: Number(process.env.PRICE_POLL_MS) || 5000,
    /**
     * عمق البذر = 500 شمعة لكل (رمز، فريم)، وهو **عمق المسار القديم نفسه**.
     *
     * عيب مُثبت بالقياس: كان 250 «توفيراً»، لكن تجربة على بيانات حقيقية (8 أزواج × 6
     * فريمات، 48 عيّنة، 330 منطقة مرجعية) أثبتت أن عمق النافذة يغيّر النتائج جوهرياً:
     *   عمق 500 = المرجع (100%) | عمق 400 → مطابقة 72.4% | عمق 250 → مطابقة 50.3%
     * السبب البنيوي: أقدم شموع النافذة تُحدّد المستوى المرجعي في كشف المناطق البصرية،
     * فنافذة أضيق = مرجع مختلف = حالة منطقة مختلفة (candidate/confirmed/swept).
     * فتقليل العمق **تغيير صامت في النتائج** لا يُقبل بلا دليل ظل.
     */
    seedLimit: Number(process.env.LIQUIDITY_SEED_LIMIT) || 500,
    // حجر المفاتيح الميتة (علة OOM مثبتة بالسجلات): رموز محجوبة جغرافياً (451) كانت
    // تُعاد محاولتها بلا نهاية (REST ×3 مضيفين + سجلات) فتخنق الذاكرة والشبكة والسجلات
    maxSeedFails451: 2,            // إخفاقان 451 متتاليان = حظر دائم → حجر فوري
    maxSeedFailsOther: 15,         // الأعطال العابرة تُمهل أكثر (انقطاع مؤقت لا يُحجر سريعا)
    quarantineMs: 6 * 3600_000,    // مدة الحجر ثم إعادة محاولة تلقائية (شفاء ذاتي لو تغيرت المنطقة)
    maxBarsKept: 400,             // سقف الشموع المحفوظة لكل مفتاح — يمنع نمو المخزن بلا حد (تسرب ذاكرة)
    reconcileMs: 5 * 60_000,
    reconcileBatch: 20,
    tradeWindowMs: 10 * 60_000,
    /**
     * نافذة «رمز تداول فعلاً» لقياس صمت دفق الشموع. أقصر بكثير من نافذة التدفق:
     * بينانس تدفع تحديث الشمعة فور وقوع صفقة، فإن تداول الرمز خلال آخر دقيقة ولم
     * تُدفع شمعته فالدفق معطوب لهذا الرمز. نافذة التدفق (10 دقائق) فضفاضة لهذا الغرض.
     */
    tradingWindowMs: 60_000,
    maxTradesPerSymbol: 1500,     // خفّض من 4000: يخفض ذاكرة التدفق ~62%
    aggTradeSubLimit: 0,          // 0 = بلا قص (التوزيع على الاتصالات يتكفل بالحدود)
    klineSubLimit: 0,             // 0 = بلا قص — كل المطلوب يُشترك فعلاً عبر اتصالات إضافية
    maxConns: 6,                  // خفّض من 8: يحد من استهلاك السوكتات والذاكرة
    /**
     * مخزن الشموع المجمّع (candleStore): يُغذّى من بث 1m وحده ويشتق كل الفريمات
     * محلياً على حدث إغلاق الشمعة — فلا REST لكل رمز وفريم في كل دورة فحص.
     * aggregateMode=0 يعطّل التغذية (يبقى المخزن موجوداً لكنه لا يُحدَّث من البث).
     */
    aggregateMode: process.env.LIQUIDITY_AGGREGATE !== '0',
    /**
     * عمق المخزن = 500 شمعة لكل (رمز، فريم) = **عمق المسار القديم نفسه** (500 كان يقرأه
     * الفحص الحي من REST). كان 400، وقيس أثره على بيانات حقيقية (8 أزواج × 6 فريمات،
     * 48 عيّنة، 330 منطقة مرجعية):
     *   عمق 500 = المرجع (100%) | عمق 400 → مطابقة 72.4% | عمق 250 → مطابقة 50.3%
     * عدا على ذلك، أقدم شموع النافذة تُحدّد المرجع في الكشف البصري، فالنافذة الأضيق
     * تعني حالة منطقة مختلفة (candidate/confirmed/swept) — أي تغيير صامت في النتائج.
     */
    aggregateCapacity: Number(process.env.LIQUIDITY_AGGREGATE_CAPACITY) || 500,
    /** حجم دفعة البذر التسلسلي في warmUniverse (لا نفتح آلاف الطلبات في لحظة) */
    warmBatch: Number(process.env.LIQUIDITY_WARM_BATCH) || 8,
    hosts: WS_HOSTS,              // قابلة للاستبدال (اختبار اتصال حقيقي/تثبيت مضيف)
    ...config
  };

  /* ---- حالة مشتركة (قراءة متزامنة بلا شبكة) ---- */
  const prices = new Map();          // symbol → { price, at }
  const klines = new Map();          // "SYM|tf" → Map(openTime → rawRow)
  const klineSeeding = new Map();    // "SYM|tf" → Promise (منع البذر المزدوج)
  const seedFails = new Map();       // "SYM|tf" → { fails, quarantinedUntil } (حجر المفاتيح الميتة)
  const trades = new Map();          // symbol → [{price, qty, isBuyerMaker, at}]
  let candleCloseHandlers = new Set();
  const klineUpdateHandlers = new Set();
  /**
   * مخزن الشموع المجمّع: مصدر واحد للشموع لكل الفريمات، يُغذّى من بث 1m وحده.
   * العلة التي يُصلحها: فحص مناطق السيولة الحي كان يطلب REST لكل (رمز × فريم) في كل
   * دورة (6,006 طلباً مقيساً). هنا تُبنى الفريمات الأعلى محلياً من الدقائق، فيصير
   * الكشف حدثياً على إغلاق الشمعة بلا شبكة في المسار الحادث.
   */
  const candles = createCandleStore({ capacity: cfg.aggregateCapacity, log });
  /** مستمعو إغلاق الشموع المجمّعة: cb({ symbol, tf, bar }) — عدة مستمعين، معزولون */
  const aggregatedCloseHandlers = new Set();
  /** "SYM|tf" → زمن فتح آخر شمعة أُعلن إغلاقها (منع تكرار الإعلان لنفس الشمعة بدقة) */
  const lastClosedBar = new Map();
  /** "SYM|tf" → زمن فتح أحدث شمعة محفوظة (لكشف الفجوات والتحقق من الحداثة) */
  const klineLastBar = new Map();

  /* ---- الاشتراكات المطلوبة (مستأجرون متعددون: محرك الفرص + محرك الاستراتيجية) ----
   * كل مستهلك يسجّل طلباته بمفتاح tenant، والاتحاد يُشترك به فعلياً موزعاً على الاتصالات. */
  const klineWants = new Map();      // tenant → Set("SYM|tf")
  const flowWants = new Map();       // tenant → Set(symbol)
  let wantedKlines = new Set();      // الاتحاد الفعلي
  let wantedFlow = new Set();
  let wantedPrices = new Set();      // رموز لها اشتراك سعر مضمون النبض (لكل رمز)
  let pricePollBusy = false;
  let pricePollTimer = null;
  const pricePoll = { lastAt: 0, applied: 0, total: 0, failures: 0, lastError: null };

  /* ---- الاتصالات المُوزَّعة ----
   * connOwned(id → Set) يبقى عبر إعادة الاتصال — streamOwner(stream → id) لاصق بلا churn.
   * كل اتصال طوابير تحكم مستقلة (حد 5 رسالة/ث لكل اتصال من بينانس). */
  let conns = [];                    // { id, ws, active:Set, pendingSubs, pendingUnsubs, controlTimer, keepAlive, lifetimeTimer, lastMsgAt }
  const connOwned = new Map();       // id → Set(streamName)
  const streamOwner = new Map();     // streamName → connId
  let nextConnId = 1;
  let hostIndex = 0;
  let attempt = 0;
  let started = false;
  let stopped = false;
  let messageCount = 0;
  let lastMessageAt = null;
  let startedAt = null;
  let reconcileTimer = null;

  const tfFromStream = (streamName) => {
    const i = streamName.indexOf('@kline_');
    return i >= 0 ? streamName.slice(i + 7) : null;
  };
  const symbolFromStream = (streamName) => {
    const i = streamName.indexOf('@');
    return i > 0 ? streamName.slice(0, i).toUpperCase() : null;
  };

  /* ================= الاتصالات المُوزَّعة ================= */

  function ownedCapacity() {
    let cap = 0;
    for (const id of connOwned.keys()) cap += cfg.maxStreamsPerConn;
    return cap;
  }

  function openConn(id) {
    if (stopped || !WebSocket) return;
    const host = cfg.hosts[hostIndex % cfg.hosts.length];
    // الاتصال الأول يحمل أسعار السوق الإجمالية في URL — البقية تتصل عاراة وتشترك بطلباتها
    const url = id === 1 ? `${host}/stream?streams=!miniTicker@arr` : `${host}/stream`;
    const ws = new WebSocket(url);
    const conn = {
      id,
      ws,
      active: new Set(id === 1 ? ['!miniTicker@arr'] : []),
      pendingSubs: new Set(),
      pendingUnsubs: new Set(),
      controlTimer: null,
      keepAlive: null,
      lifetimeTimer: null,
      lastMsgAt: now()
    };
    if (!connOwned.has(id)) {
      connOwned.set(id, new Set(id === 1 ? ['!miniTicker@arr'] : []));
      if (id === 1) streamOwner.set('!miniTicker@arr', 1);
    }
    ws.on('open', () => {
      attempt = 0;
      conn.lastMsgAt = now();
      conn.keepAlive = setInterval(() => {
        if (ws.readyState === WS_OPEN) {
          try { ws.ping(); } catch { /* onclose يتبع */ }
        }
      }, 30_000);
      // مراقب حياة: اتصال أصمّ بلا رسائل (شبكة معلقة بلا إغلاق) يُقطع لإعادة الفتح
      conn.livenessTimer = setInterval(() => {
        if (stopped || ws.readyState !== WS_OPEN) return;
        const silent = now() - (conn.lastMsgAt || 0);
        if (silent > cfg.livenessTimeoutMs) {
          log.warn?.(`[market-streams] shard#${id} silent ${Math.round(silent / 1000)}s — recycling`);
          conn.silentRecycles = (conn.silentRecycles || 0) + 1;
          try { ws.terminate(); } catch { /* ignore */ }
        }
      }, 15_000);
      // إعادة اتصال استباقية قبل قطع بينانس الإجباري (24 ساعة)
      conn.lifetimeTimer = setTimeout(() => {
        try { ws.terminate(); } catch { /* ignore */ }
      }, cfg.proactiveReconnectMs);
      // إعادة اشتراك ما يملكه هذا الاتصال فقط (وليس كل المطلوب عالمياً)
      const owned = connOwned.get(id) ?? new Set();
      for (const s of owned) {
        if (!conn.active.has(s)) scheduleOn(conn, 'sub', s);
      }
      // إصلاح الفجوات: الشموع التي تأخّرت بعد الانقطاع تُعاد بذرها من REST
      if (id > 1 || owned.size) setTimeout(() => { if (!stopped) refreshStaleKlines(); }, 3000);
      log.log?.(`[market-streams] connected: ${host} shard#${id} (${owned.size} owned streams)`);
    });
    ws.on('message', (buf) => {
      conn.lastMsgAt = now();
      lastMessageAt = now();
      messageCount += 1;
      try { handleMessage(JSON.parse(buf.toString())); } catch { /* رسالة مشوهة تُتجاهل */ }
    });
    ws.on('pong', () => { conn.lastMsgAt = now(); });
    ws.on('error', () => { /* onclose يتبع */ });
    ws.on('close', () => {
      clearInterval(conn.keepAlive);
      clearInterval(conn.livenessTimer);
      clearTimeout(conn.lifetimeTimer);
      if (conn.controlTimer) { clearTimeout(conn.controlTimer); conn.controlTimer = null; }
      conns = conns.filter(c => c !== conn);
      if (stopped) return;
      // تراجع أُسّي مع تدوير النقطة — ثم إعادة فتح نفس الشارد باشتراكاته المحفوظة
      attempt += 1;
      hostIndex = (hostIndex + 1) % cfg.hosts.length;
      const delay = Math.min(cfg.reconnectMaxMs, cfg.reconnectBaseMs * 2 ** Math.min(attempt, 5));
      log.warn?.(`[market-streams] shard#${id} lost — reconnect in ${delay}ms (attempt ${attempt})`);
      setTimeout(() => { if (!stopped && connOwned.has(id)) openConn(id); }, delay);
    });
    conns.push(conn);
    return conn;
  }

  /** رسالة مجمعة من أي اتصال: أسعار السوق / شمعة / صفقة */
  function handleMessage(msg) {
    const data = msg?.data;
    if (!data) return;
    // !miniTicker@arr → مصفوفة تغيّرات الأسعار
    if (Array.isArray(data)) {
      const t = now();
      for (const tick of data) {
        const p = Number(tick?.c);
        if (tick?.s && Number.isFinite(p)) prices.set(tick.s, { price: p, at: t, src: 'arr' });
        // سقف صريح لمنع نمو الكاش بلا حد لو ظهرت رموز خارج نطاق التحليل
        if (prices.size > cfg.maxPriceSymbols) prunePrices();
      }
      return;
    }
    const stream = String(msg.stream ?? '');
    /**
     * نبض سعر الرمز الواحد. العلة التي يُصلحها:
     * `!miniTicker@arr` صار يرسل فقط الرموز التي تغيّر سعرها في الثانية (~50-130)،
     * وستريم الشموع لا يدفع إلا عند وجود صفقة (10-16 ثانية للرموز الخاملة).
     * فبقي معجم الأسعار متقادماً لمعظم رموز التحليل → قرارات على أسعار قديمة.
     * هذا الستريم يدفع كل 1000ms لكل رمز مشترك، فهو مصدر سعر القرار المعتمد.
     */
    if (stream.includes('@miniTicker')) {
      const sym = String(data?.s ?? symbolFromStream(stream));
      const p = Number(data?.c);
      if (sym && Number.isFinite(p) && p > 0) prices.set(sym, { price: p, at: now(), src: 'ticker' });
      return;
    }
    if (stream.includes('@kline_')) {
      const k = data?.k;
      if (!k || !data?.s) return;
      const tf = String(k.i ?? tfFromStream(stream));
      upsertKline(data.s, tf, k);
      for (const cb of klineUpdateHandlers) {
        try { cb({ symbol: data.s, timeframe: tf, kline: k }); } catch { /* مستمع فاشل لا يوقف البث */ }
      }
      /**
       * تغذية المخزن المجمّع من شمعة 1m وحدها: القيم تُؤخذ من رسالة بينانس كما هي
       * بلا أي حساب (open/high/low/close/volume، وtakerBuyBase من الميدان V).
       * المخزن يشتق منها كل الفريمات الأعلى ويُعيد ما أُغلق منها.
       */
      if (tf === '1m' && cfg.aggregateMode) applyAggregated1m(data.s, k);
      if (k.x === true) notifyCandleClose(data.s, tf, Number(k.c), k.t);
      return;
    }
    if (stream.includes('@aggTrade')) {
      const sym = String(data.s ?? symbolFromStream(stream));
      if (!sym || !wantedFlow.has(sym)) return;
      let arr = trades.get(sym);
      if (!arr) { arr = []; trades.set(sym, arr); }
      arr.push({ price: Number(data.p), qty: Number(data.q), isBuyerMaker: Boolean(data.m), at: Number(data.T) || now() });
      const cutoff = now() - cfg.tradeWindowMs;
      if (arr.length > cfg.maxTradesPerSymbol || (arr.length && arr[0].at < cutoff)) {
        let start = 0;
        while (start < arr.length && (arr[start].at < cutoff || arr.length - start > cfg.maxTradesPerSymbol)) start += 1;
        if (start > 0) trades.set(sym, arr.slice(start));
      }
    }
  }

  /* ================= الشموع الحية ================= */

  const klineStreamOf = (key) => {
    const [sym, tf] = key.split('|');
    return `${String(sym).toLowerCase()}@kline_${tf}`;
  };
  const aggStreamOf = (sym) => `${String(sym).toLowerCase()}@aggTrade`;
  /** نبض سعر مضمون لكل رمز: stream منفصل يدفع كل ثانية حتى بلا صفقات */
  const priceStreamOf = (sym) => `${String(sym).toLowerCase()}@miniTicker`;

  /** تقليم مخزن الشموع لسقف maxBarsKept (الأحدث يبقى) — يمنع نمو الذاكرة بلا حد */
  function trimKlines(key) {
    const buf = klines.get(key);
    if (!buf || buf.size <= cfg.maxBarsKept) return;
    const keys = [...buf.keys()].sort((a, b) => a - b);
    const drop = keys.length - cfg.maxBarsKept;
    for (let i = 0; i < drop; i += 1) buf.delete(keys[i]);
  }

  /**
   * تحويل صف بينانس (نصوص) إلى أرقام بنفس الترتيب والطول (12 خانة).
   * سبب هذا الإصلاح (السبب الجذري لانهيار الذاكرة سابقاً):
   * كان كل صف يُخزَّن كمصفوفة من 12 **نصاً**، وكل نص كائن مستقل يشغل ~40+ بايت
   * إضافة لمرجع الصف. القياس الفعلي: 337,600 شمعة استهلكت وحدها ~190MB من الـ heap
   * (heapUsed 512MB في خادم واحد). التخزين كأرقام يخفض ذلك نحو الثلث ويقلّل ضغط GC.
   * جميع القرّاء يستخدمون Number(k[i]) (normalizeCandles، computeCvd، derivatives)
   * فالصفوف الرقمية متوافقة تماماً وبلا أي تغيير في القيم المحسوبة.
   */
  function toNumericRow(k) {
    return [
      Number(k.t), Number(k.o), Number(k.h), Number(k.l), Number(k.c), Number(k.v),
      Number(k.T ?? 0), Number(k.q ?? 0), Number(k.n ?? 0), Number(k.V ?? 0),
      Number(k.Q ?? 0), 0
    ];
  }

  /** تحديث مخزن الشموع بصيغة صفوف بنفس ترتيب حقول بينانس (تُقرأ بـnormalizeCandles/computeCvd) */
  function upsertKline(symbol, tf, k) {
    const key = `${symbol}|${tf}`;
    /**
     * المفتاح الذي يملكه المخزن الرقمي لا يُخزَّن ثانيةً في الخريطة القديمة.
     * المخزن يتلقّى الشمعة نفسها عبر apply1m من نفس الرسالة (في `onKlineMessage`)،
     * فالخريطة القديمة نسخة مكرَّرة بلا قارئ — وهي ما رفع rss إلى 946MB قبل الإصلاح.
     */
    const inStore = cfg.aggregateMode && candles.has(symbol, tf);
    const openTime = Number(k.t);
    const prevLast = klineLastBar.get(key) ?? 0;
    if (!inStore) {
      let buf = klines.get(key);
      if (!buf) { buf = new Map(); klines.set(key, buf); }
      buf.set(openTime, toNumericRow(k));
      if (buf.size > cfg.maxBarsKept) trimKlines(key);
    }
    if (openTime > prevLast) klineLastBar.set(key, openTime);
    /**
     * سعر حي من الشمعة — العلة التي يُصلحها هذا:
     * `!miniTicker@arr` لم يعد يرسل كل السوق، بل ~50-130 رمزاً «تغيّر سعرها» في الثانية.
     * فبقيت أسعار الرموز الخاملة متقادمة دقائق، واتُّخذت قرارات دخول على أسعار قديمة.
     * الشمعة الجارية تصل كل ثانية لكل رمز مشترك فيه (وهو الرمز الذي نحلّله فعلاً) وتحمل سعر
     * الإغلاق الحي — فهو المصدر الصحيح للقرار: نفس السعر الذي تقيّمه الاستراتيجية.
     * نحدّث فقط من الشمعة الأحدث، فلا تُلوّث رسالة متأخرة السعر بسعر شمعة قديمة.
     */
    if (openTime >= prevLast) {
      const px = Number(k.c);
      if (Number.isFinite(px) && px > 0) prices.set(symbol, { price: px, at: now(), src: 'kline' });
    }
  }

  /**
   * اشتراكات السعر المضمونة: تُشتق تلقائياً من رموز التحليل (الشموع + التدفق)،
   * فلا يحتاج أي محرك لتعديل. عند تخفيف المحركات لنطاقها يتقلّص الاشتراك تلقائياً.
   * سقف maxPriceSubs يمنع تجاوز حدود بينانس على اتصال واحد.
   */
  function refreshPriceSubscriptions() {
    const next = new Set();
    const cap = cfg.maxPriceSubs;
    for (const key of wantedKlines) {
      if (next.size >= cap) break;
      next.add(key.split('|')[0]);
    }
    for (const sym of wantedFlow) {
      if (next.size >= cap) break;
      next.add(sym);
    }
    // إخلاء أسعار الرموز التي لم تعد تحت التحليل (منع نمو الكاش بلا حد)
    for (const sym of [...prices.keys()]) {
      if (next.has(sym)) continue;
      const rec = prices.get(sym);
      if (rec && rec.src === 'ticker' && !next.has(sym)) prices.delete(sym);
    }
    wantedPrices = next;
  }

  /** الرموز التي تُبنى عليها قرارات فعلاً: المشتركة في الشموع أو في التدفق */
  function analyzedSymbols() {
    const out = new Set();
    for (const key of wantedKlines) out.add(key.split('|')[0]);
    for (const s of wantedFlow) out.add(s);
    return out;
  }

  let lastFastAt = 0;
  /**
   * إعلان إغلاق شمعة — منع التكرار بمفتاح (رمز|فريم|زمن الشمعة) لا بتخفيف زمني عام.
   * العلة السابقة: تخفيف 200ms على مستوى السوق كله كان يُسقط إغلاقات كل الرموز
   * التي تُغلق في نفس اللحظة (كل دقيقة) فلا يصل منها إلا واحد.
   */
  function notifyCandleClose(symbol, tf, closePrice, barOpenTime = null) {
    const key = `${symbol}|${tf}`;
    // منع التكرار مشروط بزمن شمعة صالح فعلاً: غيابه يعني «أعلن دائماً» لا «أعلن مرة واحدة»
    const openTime = Number(barOpenTime);
    if (Number.isFinite(openTime) && openTime > 0) {
      if (lastClosedBar.get(key) === openTime) return; // نفس الشمعة أُعلنت سابقاً
      lastClosedBar.set(key, openTime);
    }
    const t = now();
    lastFastAt = t;
    for (const cb of candleCloseHandlers) {
      try { cb(symbol, tf, closePrice); } catch { /* معالج فاشل لا يوقف البقية */ }
    }
  }

  /**
   * تغذية المخزن المجمّع بشمعة 1m من رسالة بينانس، ثم إعلان كل شمعة أُغلقت.
   * القيم تُؤخذ من الحمولة كما هي بلا أي حساب: open/high/low/close/volume،
   * وtakerBuyBase من الميدان V (taker buy base volume)، وإن غاب فصفر.
   * كل مستمع يُنادى داخل try/catch مستقل فلا يُسقط مستمعٌ فاشلٌ البقية.
   */
  function applyAggregated1m(symbol, k) {
    try {
      const closed = candles.apply1m(symbol, {
        openTime: Number(k.t),
        open: Number(k.o),
        high: Number(k.h),
        low: Number(k.l),
        close: Number(k.c),
        volume: Number(k.v),
        takerBuyBase: k.V === undefined || k.V === null ? 0 : Number(k.V)
      });
      for (const item of closed) {
        for (const cb of aggregatedCloseHandlers) {
          try { cb({ symbol, tf: item.tf, bar: item.bar }); } catch { /* مستمع فاشل لا يوقف البقية */ }
        }
      }
    } catch { /* مدخل فاسد لا يوقف معالجة الرسائل */ }
  }

  /** مدة الفريم بالمللي */
  function tfMsOf(tf) {
    const m = /^(\d+)([mhdw])$/.exec(String(tf));
    if (!m) return null;
    const n = Number(m[1]);
    const unit = { m: 60_000, h: 3600_000, d: 86_400_000, w: 604_800_000 }[m[2]];
    return n * unit;
  }

  /**
   * إعادة بذر المفاتيح التي تأخّرت شموعها (فجوة بعد انقطاع أو اتصال أصمّ).
   * شرط الاستدعاء: اتصال أُعيد فتحه، أو مراقب الحداثة الدوري.
   */
  function refreshStaleKlines({ maxKeys = 40 } = {}) {
    if (!seedKlines) return 0;
    const t = now();
    const stale = [];
    for (const key of klineWantsNow()) {
      if (quarantinedUntil(key)) continue;
      const tfMs = tfMsOf(key.split('|')[1]);
      if (!tfMs) continue;
      const last = klineLastBar.get(key) ?? 0;
      // فجوة: آخر شمعة أقدم من شمعتين + هامش 5 ثوانٍ
      if (klineSeeding.has(key)) continue;
      if (!last || t - last > 2 * tfMs + 5000) stale.push(key);
    }
    for (const key of stale.slice(0, maxKeys)) void ensureKlineSeed(key, { force: true });
    return Math.min(stale.length, maxKeys);
  }

  /** المفاتيح المطلوبة فعلياً الآن (اتحاد المستأجرين) */
  function klineWantsNow() {
    return wantedKlines;
  }

  /** هل المفتاح محجور حالياً؟ (يُمسح الحجر المنتهي تلقائياً) */
  function quarantinedUntil(key) {
    const rec = seedFails.get(key);
    if (!rec?.quarantinedUntil) return 0;
    if (now() >= rec.quarantinedUntil) { seedFails.delete(key); return 0; }
    return rec.quarantinedUntil;
  }

  /**
   * بذر/إعادة بذر مخزن شموع من REST.
   * force=true يُعيد الجلب حتى لو كان المفتاح مزروعاً — لإصلاح الفجوات بعد انقطاع.
   */
  function ensureKlineSeed(key, { force = false } = {}) {
    const [symbol, tf] = String(key).split('|');
    /**
     * «مبذور؟» يشمل المخزن الرقمي، لا الخريطة القديمة وحدها.
     * العلة: بعد منع التخزين المزدوج لم تعد مفاتيح المخزن في الخريطة القديمة، فكان هذا
     * الشرط يرى المفتاح «غير مبذور» فيعيد جلبه من REST — **شبكة مهدورة في المسار الذي
     * يُطلب فيه إصلاح الفجوات** (وهو أكثر ما يُستدعى عند الانقطاع).
     */
    const served = klines.has(key) || (cfg.aggregateMode && symbol && tf && candles.has(symbol, tf));
    if ((!force && served) || klineSeeding.has(key) || !seedKlines) {
      return klineSeeding.get(key) ?? Promise.resolve();
    }
    if (quarantinedUntil(key)) return Promise.resolve(); // مفتاح ميت — بلا شبكة بلا سجلات
    const p = (async () => {
      try {
        const raw = await seedKlines(symbol, tf, cfg.seedLimit);
        /**
         * بذر المخزن المجمّع أولاً من نفس صفوف REST (بلا طلب إضافي): مفتاح 1m يبذر
         * الدقائق التي تُشتق منها كل الفريمات، والفريمات الأعلى تُبذر مباشرة لتسريع
         * الجاهزية. البذر لا يرمي: صفوف فاسدة تُتجاهل داخل المخزن.
         *
         * الترتيب مقصود: بعد بذر المخزن يصبح `candles.has` صادقاً، فنعرف فوراً أن
         * المفتاح لا يحتاج نسخة ثانية في الخريطة القديمة.
         */
        if (cfg.aggregateMode) {
          try { candles.seed(symbol, tf, raw ?? []); } catch { /* بذر فاسد لا يُسقط المفتاح */ }
        }
        /**
         * لا نكتب في الخريطة القديمة إلا للمفاتيح التي لا يملكها المخزن الرقمي.
         * السبب: منع تخزين الشموع مرتين — وهو ما رفع rss إلى 946MB قبل هذا الإصلاح
         * (6,006 مفاتيح × 400 صفاً في الخريطة القديمة فوق 500 شمعة في المخزن الجديد).
         */
        if (cfg.aggregateMode && candles.has(symbol, tf)) {
          // المفتاح في المخزن: يكفي تتبّع آخر شمعة، بلا صفوف مكرَّرة
          const last = Number(raw?.[raw.length - 1]?.[0]);
          if (Number.isFinite(last) && last > (klineLastBar.get(key) ?? 0)) klineLastBar.set(key, last);
          klines.delete(key); // تُحرَّر أي نسخة سابقة
        } else {
          const buf = klines.get(key) ?? new Map();
          for (const row of raw ?? []) {
            const openTime = Number(row[0]);
            // الصف من REST مصفوفة حقول بينانس بترتيبها نفسه — يُخزَّن رقماً لتوفير الذاكرة
            buf.set(openTime, Array.isArray(row)
              ? row.map((v, i) => (i === 11 ? 0 : Number(v)))
              : row);
            if (openTime > (klineLastBar.get(key) ?? 0)) klineLastBar.set(key, openTime);
          }
          klines.set(key, buf);
          trimKlines(key);
        }
        seedFails.delete(key); // نجاح يصفّر العداد
      } catch (e) {
        const msg = String(e?.message ?? e);
        const geo = msg.includes('451');
        const rec = seedFails.get(key) ?? { fails: 0, quarantinedUntil: 0 };
        rec.fails += 1;
        const limit = geo ? cfg.maxSeedFails451 : cfg.maxSeedFailsOther;
        if (rec.fails >= limit) {
          rec.quarantinedUntil = now() + cfg.quarantineMs;
          log.warn?.(`[market-streams] quarantine ${key} after ${rec.fails} fails (${geo ? 'geo-blocked 451' : 'transient'}) until ${new Date(rec.quarantinedUntil).toISOString()}`);
        } else {
          log.warn?.(`[market-streams] seed failed ${key}: ${msg}`);
        }
        seedFails.set(key, rec);
      } finally {
        klineSeeding.delete(key);
      }
    })();
    klineSeeding.set(key, p);
    return p;
  }

  /**
   * صفوف الشموع الخام مرتبة زمنياً (null إن لم تُبَذ).
   *
   * الأولوية للمخزن الرقمي: مفتاح موجود في المخزن يُقرأ منه، فلا تُخزَّن الشموع مرتين.
   * عيب مُثبت بالقياس: كان المخزن الجديد يُبَذ لكل الـ6,006 مفاتيح، **والخريطة القديمة
   * تُبَذ منها أيضاً** — أي شموع مكرَّرة مرتين. القياس المحلي: rss 946MB على حدّ حاوية
   * 1024MB، والفرق الحقيقي كان ~480MB من الخريطة القديمة وحدها (6,006 × 400 صفاً).
   * الخريطة القديمة تبقى للمفاتيح التي لا يملكها المخزن فقط (اشتراكات لحظية خارج
   * قائمة التحليل، مثل رمز يعرضه المستخدم في الشاشة).
   */
  function getKlines(symbol, tf) {
    if (cfg.aggregateMode && candles.has(symbol, tf)) return candles.getRows(symbol, tf);
    const buf = klines.get(`${symbol}|${tf}`);
    if (!buf) return null;
    return Array.from(buf.entries()).sort((a, b) => a[0] - b[0]).map(([, row]) => row);
  }

  /**
   * تسخين المخزن المجمّع لكل (رمز × فريم) من REST مرة واحدة عند الإقلاع.
   * يعمل على دفعات متسلسلة (لا يفتح آلاف الطلبات في لحظة) عبر مسار البذر الموجود
   * (ensureKlineSeed) فيحترم الlimiter والحجر وإصلاح الفجوات كما هي.
   * لا يُكرّر بذر مفتاح مبذور بالفعل (ensureKlineSeed يتخطاه بلا force).
   * @param {string[]} symbols
   * @param {{ tfs?: string[], capacity?: number }} [opts]
   * @returns {Promise<{ queued:number, seeded:number, failed:number }>}
   */
  async function warmUniverse(symbols, { tfs = Object.keys(TF_MS) } = {}) {
    const list = Array.isArray(symbols) ? symbols : [];
    const frames = Array.isArray(tfs) && tfs.length ? tfs : Object.keys(TF_MS);
    const keys = [];
    for (const sym of list) {
      const s = String(sym ?? '').trim().toUpperCase();
      if (!s) continue;
      for (const tf of frames) {
        if (!Object.prototype.hasOwnProperty.call(TF_MS, tf)) continue;
        keys.push(`${s}|${tf}`);
      }
    }
    const queued = keys.length;
    let seeded = 0;
    let failed = 0;
    const batch = Math.max(1, Number(cfg.warmBatch) || 8);
    for (let i = 0; i < keys.length; i += batch) {
      const slice = keys.slice(i, i + batch);
      // دفعة متسلسلة: ننتظر كل دفعة قبل التالية فلا تتراكم الطلبات
      await Promise.all(slice.map(async (key) => {
        try {
          await ensureKlineSeed(key);
          if (candles.has(key.split('|')[0], key.split('|')[1])) seeded += 1;
          else failed += 1;
        } catch { failed += 1; }
      }));
    }
    return { queued, seeded, failed };
  }

  /* ================= تدفق الصفقات (CVD/فقاعات/آيسبرغ حي) ================= */

  /** لقطة تدفق حية بنفس دلالات bookSignals — تُدمج في flowScore بلا REST */
  function flowSnapshot(symbol) {
    const arr = trades.get(symbol);
    if (!arr || arr.length < 3) return null;
    const tradesList = arr.map(t => ({ price: t.price, qty: t.qty, isBuyerMaker: t.isBuyerMaker }));
    let buyQty = 0;
    let vol = 0;
    for (const t of arr) {
      vol += t.qty;
      if (!t.isBuyerMaker) buyQty += t.qty; // isBuyerMaker=false → مشترٍ آجل (عدواني شرائياً)
    }
    const cvd = vol > 0
      ? { recentSum: 2 * buyQty - vol, buyRatioPct: (buyQty / vol) * 100, window: arr.length }
      : null;
    return {
      cvd,
      bubbles: detectBubbles(tradesList),
      icebergs: detectIceberg(tradesList),
      book: null,
      spoofs: []
    };
  }

  /* ================= طوابير التحكم لكل اتصال (حد 5/ث لكل اتصال) ================= */

  function scheduleOn(conn, op, streamName) {
    (op === 'sub' ? conn.pendingSubs : conn.pendingUnsubs).add(streamName);
    if (conn.controlTimer) return;
    conn.controlTimer = setTimeout(() => {
      conn.controlTimer = null;
      flushOn(conn, 'sub');
      flushOn(conn, 'unsub');
    }, cfg.controlBatchMs);
  }

  function flushOn(conn, op) {
    if (conn.ws.readyState !== WS_OPEN) return; // on open يُعاد الإرسال تلقائياً
    const bag = op === 'sub' ? conn.pendingSubs : conn.pendingUnsubs;
    if (!bag.size) return;
    const names = [...bag];
    bag.clear();
    for (let i = 0; i < names.length; i += cfg.controlBatchSize) {
      const batch = names.slice(i, i + cfg.controlBatchSize);
      try {
        conn.ws.send(JSON.stringify({
          method: op === 'sub' ? 'SUBSCRIBE' : 'UNSUBSCRIBE',
          params: batch,
          id: Date.now() + i
        }));
        for (const s of batch) {
          if (op === 'sub') conn.active.add(s);
          else conn.active.delete(s);
        }
      } catch { /* onclose يتبع */ }
    }
  }

  /* ================= المزامنة المُوزَّعة — لا قص صامت ================= */

  /** كل الستريمات المطلوبة فعلاً (بلا أي قص) — التوزيع على الاتصالات يتكفل بالحدود */
  function desiredStreams() {
    const out = ['!miniTicker@arr'];
    for (const key of wantedKlines) out.push(klineStreamOf(key));
    for (const sym of wantedFlow) out.push(aggStreamOf(sym));
    for (const sym of wantedPrices) out.push(priceStreamOf(sym));
    return out;
  }

  /**
   * تقليم كاش الأسعار: يُبقي رموز القرار (بلا حد عملي) ثم الأحدث من الباقي.
   * يمنع النمو غير المحدود الذي كان يُسقط الحاوية (OOM).
   */
  function prunePrices() {
    const keep = analyzedSymbols();
    const rest = [];
    for (const [sym, rec] of prices) {
      if (keep.has(sym)) continue;
      rest.push([sym, rec.at ?? 0]);
    }
    rest.sort((a, b) => b[1] - a[1]);
    const allowed = Math.max(0, cfg.maxPriceSymbols - keep.size);
    for (let i = allowed; i < rest.length; i += 1) prices.delete(rest[i][0]);
  }

  /**
   * استطلاع أسعار السوق عبر REST ودمجها في كاش الأسعار.
   * القواعد:
   *  - لا يطغى على سعر حدّثه البث خلال آخر 1.5 ثانية (البث أسرع حين يعمل).
   *  - يُحدّث كل رمز أعادته Binance، فيضمن حداثة الرموز الخاملة التي لا يدفعها البث.
   *  - فشل الاستطلاع لا يؤثر على البث (يُسجَّل ويُعاد في الدورة التالية).
   */
  async function pollPrices() {
    if (!fetchAllPrices || stopped) return;
    if (pricePollBusy) return;              // لا تتراكم الدورات إن تأخرت الشبكة
    pricePollBusy = true;
    try {
      const all = await fetchAllPrices();
      const t = now();
      let applied = 0;
      for (const [symbol, rawPrice] of Object.entries(all ?? {})) {
        const price = Number(rawPrice);
        if (!Number.isFinite(price) || price <= 0) continue;
        const rec = prices.get(symbol);
        if (rec && rec.src !== 'rest' && t - rec.at < 1500) continue; // البث أحدث
        prices.set(symbol, { price, at: t, src: 'rest' });
        applied += 1;
      }
      pricePoll.lastAt = t;
      pricePoll.applied = applied;
      pricePoll.total = Object.keys(all ?? {}).length;
      pricePoll.failures = 0;
      if (prices.size > cfg.maxPriceSymbols) prunePrices();
    } catch (e) {
      pricePoll.failures += 1;
      pricePoll.lastError = String(e?.message ?? e).slice(0, 200);
      log.warn?.('[market-streams] فشل استطلاع الأسعار:', pricePoll.lastError);
    } finally {
      pricePollBusy = false;
    }
  }

  function syncSubs() {
    if (!started || stopped) return;
    const desired = desiredStreams();
    const desiredSet = new Set(desired);

    // 1) تحرير ملاك الستريمات غير المطلوبة + إخلاء ذاكرتها (إصلاح تسرب OOM)
    for (const s of [...streamOwner.keys()]) {
      if (desiredSet.has(s)) continue;
      const id = streamOwner.get(s);
      streamOwner.delete(s);
      connOwned.get(id)?.delete(s);
      const conn = conns.find(c => c.id === id);
      if (conn) { scheduleOn(conn, 'unsub', s); }
      // إخلاء مخزن الشموع/الصفقات للمشتركين المحرَّرين — كان ينمو بلا حد
      try {
        if (s.includes('@kline_')) {
          const tf = tfFromStream(s);
          const sym = symbolFromStream(s);
          /**
           * الإخلاء يشمل المخزن الرقمي أيضاً: بعد منع التخزين المزدوج صارت شموع المشترك
           * المحرَّر في المخزن وحده، فحذف الخريطة القديمة وحدها كان يُبقي 500 شمعة
           * لرمز لم يعد مطلوباً — أي **الإخلاء الذي يمنع نمو الذاكرة صار بلا أثر**.
           */
          if (sym && tf) {
            klines.delete(`${sym}|${tf}`);
            if (cfg.aggregateMode && !wantedKlines.has(`${sym}|${tf}`)) {
              try { candles.deleteSymbol(sym); } catch { /* لا يُعطّل المزامنة */ }
            }
          }
        } else if (s.includes('@aggTrade')) {
          const sym = symbolFromStream(s);
          if (sym && !wantedFlow.has(sym)) trades.delete(sym);
        }
      } catch { /* الإخلاء لا يعطل المزامنة */ }
    }

    // 2) فتح اتصالات إضافية عند الحاجة (سقف 900/اتصال — حد بينانس 1024)
    while (desired.length > ownedCapacity() && connOwned.size < cfg.maxConns) {
      openConn(nextConnId);
      nextConnId += 1;
    }

    // 3) إسناد الستريمات غير المملوكة — لاصقة (الجديد يذهب لأول اتصال به مساحة)
    for (const s of desired) {
      if (streamOwner.has(s)) continue;
      let conn = conns.find(c => (connOwned.get(c.id)?.size ?? 0) < cfg.maxStreamsPerConn);
      if (!conn) {
        if (connOwned.size >= cfg.maxConns) {
          log.warn?.(`[market-streams] max conns reached (${cfg.maxConns}) — cannot subscribe ${s}`);
          continue;
        }
        openConn(nextConnId);
        nextConnId += 1;
        conn = conns[conns.length - 1];
      }
      connOwned.get(conn.id).add(s);
      streamOwner.set(s, conn.id);
      scheduleOn(conn, 'sub', s);
    }
  }

  /* ================= التسوية الدورية ضد الانجراف ================= */

  function reconcileTick() {
    if (!seedKlines) return;
    /**
     * مجموعة المفاتيح المُسوّاة = المخزن ∪ الخريطة القديمة ∪ الاشتراكات المطلوبة.
     *
     * عيب مُثبت: كانت التسوية تعتمد `klines.size` وحده، وبعد منع التخزين المزدوج أصبحت
     * الخريطة القديمة فارغة لمفاتيح المخزن — فكان `!klines.size` يُلغي التسوية كلها
     * بصمت، وهو **تعطيل صامت لإصلاح الفجوات** (المسار الوحيد الذي يلتقط شمعة ضائعة).
     */
    const keySet = new Set(wantedKlines);
    for (const k of klines.keys()) keySet.add(k);
    const keys = [...keySet];
    if (!keys.length) return;
    const base = Math.floor(Math.random() * keys.length);
    for (let i = 0; i < Math.min(cfg.reconcileBatch, keys.length); i += 1) {
      const key = keys[(base + i) % keys.length];
      if (quarantinedUntil(key)) continue; // لا تسوية لمفتاح محجور
      const [symbol, tf] = key.split('|');
      void (async () => {
        try {
          const fresh = await seedKlines(symbol, tf, 2);
          const lastFresh = fresh?.[fresh.length - 1];
          if (!lastFresh) return;
          const freshOpen = Number(lastFresh[0]);
          /**
           * آخر شمعة محلية من المخزن الرقمي إن ملك المفتاح، وإلا من الخريطة القديمة.
           * كان الفحص يتوقف إن غابت الخريطة القديمة (`!buf`)، فتصبح التسوية بلا أثر.
           */
          if (cfg.aggregateMode && candles.has(symbol, tf)) {
            const lastLocal = candles.lastOpen(symbol, tf);
            if (lastLocal == null) return;
            if (freshOpen !== lastLocal) {
              await ensureKlineSeed(key, { force: true }); // شمعة ضائعة → إعادة بذر كاملة
            }
            return;
          }
          const buf = klines.get(key);
          if (!buf) return;
          const lastLocal = Array.from(buf.keys()).sort((a, b) => a - b).pop() ?? null;
          if (freshOpen !== lastLocal) {
            await ensureKlineSeed(key, { force: true });
          } else {
            const local = buf.get(freshOpen);
            // تصحيح قيم الشمعة الجارية إن انحرفت عن REST
            if (local && Number(local[4]) !== Number(lastFresh[4])) buf.set(freshOpen, lastFresh);
          }
        } catch { /* تسوية فاشلة تُعاد لاحقاً */ }
      })();
    }
  }

  /* ================= الواجهة العامة ================= */

  return {
    start() {
      if (started) return;
      started = true;
      stopped = false;
      startedAt = now();
      if (WebSocket) syncSubs(); // يفتح الاتصالات المطلوبة ويوزع الاشتراكات (يتخطى عند غياب ws)
      else log.warn?.('[market-streams] ws unavailable — REST seeding/polling only, no live streaming');
      reconcileTimer = setInterval(reconcileTick, cfg.reconcileMs);
      if (reconcileTimer.unref) reconcileTimer.unref();
      // استطلاع أسعار REST: يضمن حداثة كل رمز رغم تقطّع نبضات البث المتاح
      if (fetchAllPrices && cfg.pricePollMs > 0) {
        pricePollTimer = setInterval(() => { void pollPrices(); }, cfg.pricePollMs);
        if (pricePollTimer.unref) pricePollTimer.unref();
        void pollPrices();
      }
    },
    stop() {
      stopped = true;
      started = false;
      clearInterval(reconcileTimer);
      clearInterval(pricePollTimer);
      for (const c of conns) {
        clearInterval(c.keepAlive);
        clearInterval(c.livenessTimer);
        clearTimeout(c.lifetimeTimer);
        try { c.ws.close(); } catch { /* ignore */ }
      }
      conns = [];
    },
    /**
     * هل البث الحي صالح للاستخدام؟ اتصال مفتوح + أسعار موجودة + آخر رسالة حديثة.
     * الشرط الأخير ضروري: اتصال «مفتوح» بلا رسائل يعني بيانات مجمّدة، وهي أسوأ من
     * الرجوع إلى REST لأنها تبدو صالحة. الاستهلاك يعرف الفرق من getPriceAt.
     */
    connected: () => conns.some(c => c.ws.readyState === WS_OPEN)
      && prices.size > 0
      && (!lastMessageAt || now() - lastMessageAt <= cfg.priceStaleMs),
    getPrice: (symbol) => prices.get(String(symbol).toUpperCase())?.price ?? null,
    getPriceAt: (symbol) => prices.get(String(symbol).toUpperCase())?.at ?? null,
    /** سعر حديث فقط — null إن كان أقدم من الحد (لقرارات لا تُبنى على بيانات قديمة) */
    getFreshPrice: (symbol) => {
      const rec = prices.get(String(symbol).toUpperCase());
      if (!rec || now() - rec.at > cfg.priceStaleMs) return null;
      return rec.price;
    },
    priceStaleMs: cfg.priceStaleMs,
    getPrices(symbols) {
      const out = {};
      for (const s of symbols ?? []) {
        const v = prices.get(String(s).toUpperCase());
        if (v) out[s] = v.price;
      }
      return out;
    },
    setKlineSubscriptions(keys, tenant = 'default') {
      const next = new Set(keys ?? []);
      const prev = klineWants.get(tenant);
      if (prev && prev.size === next.size && [...next].every(k => prev.has(k))) return;
      klineWants.set(tenant, next);
      // الاتحاد عبر المستأجرين — يُشترك به كله موزعاً (بلا قص)
      const merged = [];
      const seen = new Set();
      for (const set of klineWants.values()) {
        for (const k of set) if (!seen.has(k)) { seen.add(k); merged.push(k); }
      }
      wantedKlines = new Set(merged);
      refreshPriceSubscriptions();
      syncSubs();
    },
    setAggTradeSubscriptions(symbols, tenant = 'default') {
      const next = new Set(symbols ?? []);
      const prev = flowWants.get(tenant);
      if (prev && prev.size === next.size && [...next].every(s => prev.has(s))) return;
      flowWants.set(tenant, next);
      const merged = [];
      const seen = new Set();
      for (const set of flowWants.values()) {
        for (const s of set) if (!seen.has(s)) { seen.add(s); merged.push(s); }
      }
      wantedFlow = new Set(merged);
      refreshPriceSubscriptions();
      syncSubs();
    },
    onCandleClose(cb) {
      candleCloseHandlers.add(cb);
      return () => candleCloseHandlers.delete(cb);
    },
    onKlineUpdate(cb) {
      if (typeof cb !== 'function') return () => {};
      klineUpdateHandlers.add(cb);
      return () => klineUpdateHandlers.delete(cb);
    },
    /**
     * مستمع إغلاق الشموع المجمّعة: cb({ symbol, tf, bar }) لكل شمعة أُغلقت في المخزن.
     * يقبل عدة مستمعين، وكل نداء معزول بـtry/catch فلا يُسقط مستمعٌ فاشلٌ البقية.
     * @returns {() => void} دالة إلغاء الاشتراك
     */
    onAggregatedClose(cb) {
      if (typeof cb !== 'function') return () => {};
      aggregatedCloseHandlers.add(cb);
      return () => aggregatedCloseHandlers.delete(cb);
    },
    /** المخزن المجمّع كاملاً (getRows/seed/apply1m/stats/…) — مصدر الشموع بلا REST */
    candles,
    /** تسخين المخزن المجمّع لكل (رمز × فريم) من REST مرة واحدة عند الإقلاع */
    warmUniverse,
    /**
     * «هل هذا المفتاح مخدوم؟» يرجع المصدرين معاً.
     * العلة: بعد منع التخزين المزدوج لم تعد مفاتيح المخزن موجودة في الخريطة القديمة،
     * فكان هذا الفحص يُجيب «لا» عن مفاتيح مخدومة فعلاً — وهو ما يجعل مستهلكيه يعيدون
     * البذر بلا داعٍ (شبكة مهدورة) أو يظنّون الفريم غائباً.
     */
    hasKline: (key) => {
      const k = String(key);
      if (klines.has(k)) return true;
      if (!cfg.aggregateMode) return false;
      const cut = k.indexOf('|');
      if (cut <= 0) return false;
      return candles.has(k.slice(0, cut), k.slice(cut + 1));
    },
    /** زمن فتح أحدث شمعة محفوظة للمفتاح (0 إن لم تُبَذ) */
    lastBarAt: (symbol, tf) => klineLastBar.get(`${symbol}|${tf}`) ?? 0,
    ensureKlineSeed,
    /** إصلاح فجوات الشموع يدوياً/دورياً (عدد المفاتيح المُعاد بذرها) */
    refreshStaleKlines,
    getKlines,
    flowSnapshot,
    stats() {
      let quarantined = 0;
      for (const [, rec] of seedFails) if (Number(rec?.quarantinedUntil) > now()) quarantined += 1;
      const t = now();
      /**
       * حداثة السعر تُقاس على الرموز التي تُبنى عليها القرارات فعلاً، لا على كل ما في
       * الكاش: `!miniTicker@arr` يغطي السوق أجمع لكنه لا يحدّث إلا ما تغيّر سعره، فقياس
       * النسبة على كل السوق يُخفي الحقيقة: رموز التحليل قد تكون سليمة بينما الرموز
       * الخاملة متقادمة دقائق. المقياس الصحيح للجاهزية هو حالة رموز القرار.
       */
      const analyzed = analyzedSymbols();
      let stalePrices = 0;
      let newestPriceAt = 0;
      let klineSourced = 0;
      let restSourcedCount = 0;
      for (const sym of analyzed) {
        const rec = prices.get(sym);
        if (!rec) { stalePrices += 1; continue; }
        if (rec.at > newestPriceAt) newestPriceAt = rec.at;
        if (rec.src === 'kline') klineSourced += 1;
        if (rec.src === 'rest') restSourcedCount += 1;
        if (t - rec.at > cfg.priceStaleMs) stalePrices += 1;
      }
      /**
       * صمت دفق الشموع — بمعيارين، لأن الخلط بينهما كان يجعل المقياس كاذباً:
       *  - `staleCandles`: كل مفتاح لم تُدفع شمعته خلال فريمين. بينانس لا تدفع تحديث
       *    شمعة لرمز بلا صفقات أصلاً، فرقم كبير هنا متوقّع ولا يعني عطلاً.
       *  - `tradingStaleCandles`: مفتاح رمز **تداول فعلاً** خلال آخر دقيقة ومع ذلك
       *    شمعته صامتة. هذا هو العطل الحقيقي (انقطاع دفق الشموع لهذا الرمز).
       * الفرق ضروري: الأول معلوماتي، والثاني هو إشارة الجاهزية.
       */
      const tradingCutoff = t - cfg.tradingWindowMs;
      const recentTraders = new Set();
      for (const sym of wantedFlow) {
        const arr = trades.get(sym);
        const at = arr?.length ? arr[arr.length - 1].at : 0;
        if (at >= tradingCutoff) recentTraders.add(sym);
      }
      let staleCandles = 0;
      let tradingStaleCandles = 0;
      for (const key of wantedKlines) {
        const [sym, tf] = key.split('|');
        const tfMs = tfMsOf(tf);
        if (!tfMs) continue;
        const last = klineLastBar.get(key) ?? 0;
        if (last && t - last <= 2 * tfMs + 5000) continue;
        staleCandles += 1;
        if (recentTraders.has(sym)) tradingStaleCandles += 1;
      }
      const silent = conns
        .filter(c => c.ws.readyState === WS_OPEN && t - (c.lastMsgAt || 0) > cfg.livenessTimeoutMs)
        .length;
      /**
       * إحصاء المخزن المجمّع: دليل أثر التحويل الحادث (مفاتيح/شموع/ذاكرة/فجوات).
       * bytes تُحوَّل إلى ميغابايت بمنزلتين، وaggregateMode يصرّح بحالة التغذية.
       */
      const agg = candles.stats();
      const aggregate = {
        keys: agg.keys,
        bars: agg.bars,
        bytesMb: Number((agg.bytes / 1048576).toFixed(2)),
        gaps: agg.gaps,
        lastUpdateAt: agg.lastUpdateAt
      };
      return {
        /** هل حزمة البث متاحة أصلاً؟ false ⇒ مسار REST/الاستطلاع فقط (تدهور معلن لا صامت) */
        available: WebSocket != null,
        transport: WebSocket != null ? 'ws' : 'rest-fallback',
        connected: conns.some(c => c.ws.readyState === WS_OPEN),
        connections: conns.length,
        streams: conns.reduce((a, c) => a + c.active.size, 0),
        klineSubs: wantedKlines.size,
        aggTradeSubs: wantedFlow.size,
        priceSubs: wantedPrices.size,
        priceSymbols: prices.size,
        analyzedSymbols: analyzed.size,
        analyzedPriced: analyzed.size - stalePrices,
        klineSourced,
        restSourced: restSourcedCount,
        pricePoll: { ...pricePoll, intervalMs: cfg.pricePollMs },
        quarantinedKeys: quarantined,
        messages: messageCount,
        lastMessageAt,
        startedAt,
        // حداثة البيانات — أساس قرار «هل نمنع القرارات على بيانات قديمة»
        priceAgeMs: lastMessageAt ? t - lastMessageAt : null,
        newestPriceAt: newestPriceAt || null,
        stalePrices,
        stalePriceRatio: analyzed.size ? Number((stalePrices / analyzed.size).toFixed(3)) : null,
        staleCandles,
        tradingStaleCandles,
        recentTraders: recentTraders.size,
        /**
         * عدد المفاتيح المخدومة فعلاً = المخزن ∪ الخريطة القديمة.
         * كان `klines.size` وحده، وبعد منع التخزين المزدوج صار يُبلّغ رقماً أقل من
         * الحقيقة (وقد يبلغ صفراً) بينما النظام يخدم 6,006 مفتاحاً — رقم كاذب في الصحة.
         * `legacyKlineKeys` يبقى ظاهراً للشفافية عن حجم الخريطة القديمة.
         */
        klineKeys: new Set([...klines.keys(), ...wantedKlines]).size,
        legacyKlineKeys: klines.size,
        silentConns: silent,
        silentRecycles: conns.reduce((a, c) => a + (c.silentRecycles || 0), 0),
        aggregate,
        aggregateMode: cfg.aggregateMode
      };
    }
  };
}
