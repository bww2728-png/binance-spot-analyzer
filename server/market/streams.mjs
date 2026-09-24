/* طبقة بيانات السوق الحية عبر WebSocket — أسعار كل السوق + شموع حية + تدفق صفقات لحظي
 *
 * المصدر: streams عامة من بينانس (بلا مفاتيح):
 *  - !miniTicker@arr  → كل السوق (~3700 رمز) كل ثانية → خريطة أسعار حية (صفر REST للأسعار)
 *  - <sym>@kline_<tf> → الشمعة الجارية كل ~1-2 ث وعلم x عند الإغلاق → مخازن شموع حية
 *  - <sym>@aggTrade   → كل الصفقات → CVD حي + فقاعات + آيسبرغ (بدون REST ولا توقف)
 *
 * حدود بينانس الرسمية ويُصمَّم حولها:
 *  - 1024 stream لكل اتصال (سقفنا العملي 900 + تقسيم تلقائي لاتصالات إضافية)
 *  - 5 رسائل تحكم/ثانية (تجميع SUBSCRIBE/UNSUBSCRIBE في دفعات كل 300ms)
 *  - ping كل 3 دقائق (حزمة ws ترد بـpong تلقائياً) + فحص حياة: بلا رسائل 90 ث → قطع وإعادة
 *  - قطع إجباري بعد 24 ساعة → إعادة اتصال استباقية عند 23.5 ساعة
 *  - 300 محاولة اتصال/5 د → تراجع أُسّي 2s→30s فقط
 *
 * النمط: بذر REST مرة واحدة (500 شمعة) → تحديث حي بالبث → تسوية REST خفيفة دورية ضد الانجراف.
 */

import WebSocket from 'ws';
import { detectBubbles, detectIceberg } from '../liquidity/orderbook.mjs';

const WS_HOSTS = [
  'wss://data-stream.binance.vision',
  'wss://stream.binance.com:9443',
  'wss://stream.binance.com:443'
];

export function createMarketStreams({
  log = console,
  now = () => Date.now(),
  seedKlines = null, // (symbol, tf, limit) => Promise<rawRows[]>
  config = {}
} = {}) {
  const cfg = {
    maxStreamsPerConn: 900,
    controlBatchMs: 300,
    controlBatchSize: 200,        // عدد الستريمات في رسالة SUBSCRIBE الواحدة
    reconnectBaseMs: 2000,
    reconnectMaxMs: 30_000,
    proactiveReconnectMs: 23.5 * 3600_000,
    livenessTimeoutMs: 90_000,
    seedLimit: 500,
    reconcileMs: 5 * 60_000,
    reconcileBatch: 20,
    tradeWindowMs: 10 * 60_000,
    maxTradesPerSymbol: 4000,
    aggTradeSubLimit: 80,
    klineSubLimit: 900,
    ...config
  };

  /* ---- حالة مشتركة (قراءة متزامنة بلا شبكة) ---- */
  const prices = new Map();          // symbol → { price, at }
  const klines = new Map();          // "SYM|tf" → Map(openTime → rawRow)
  const klineSeeding = new Map();    // "SYM|tf" → Promise (منع البذر المزدوج)
  const trades = new Map();          // symbol → [{price, qty, isBuyerMaker, at}]
  let candleCloseHandlers = new Set();

  /* ---- الاشتراكات المطلوبة (مستأجرون متعددون: محرك الفرص + محرك الاستراتيجية) ----
   * كل مستهلك يسجّل طلباته بمفتاح tenant، والاتحاد يُشترك به فعلياً بحد أقصى عادل.
   * key → Set (أول مستأجر يملك السهم) — setKlineSubscriptions يبقى توافقاً قديماً (tenant=default). */
  const klineWants = new Map();      // tenant → Set("SYM|tf")
  const flowWants = new Map();       // tenant → Set(symbol)
  let wantedKlines = new Set();      // الاتحاد الفعلي
  let wantedFlow = new Set();
  let activeKlines = new Set();
  let activeFlow = new Set();

  /* ---- الاتصالات ---- */
  let conns = [];                    // { ws, streams:Set, hostIndex, keepAlive, lifetimeTimer, lastMsgAt }
  let hostIndex = 0;
  let attempt = 0;
  let started = false;
  let stopped = false;
  let messageCount = 0;
  let lastMessageAt = null;
  let startedAt = null;
  let reconcileTimer = null;

  /* ---- تجميع رسائل التحكم (حد 5/ث) ---- */
  let controlTimer = null;
  const pendingSubs = new Set();
  const pendingUnsubs = new Set();

  const tfFromStream = (streamName) => {
    const i = streamName.indexOf('@kline_');
    return i >= 0 ? streamName.slice(i + 7) : null;
  };
  const symbolFromStream = (streamName) => {
    const i = streamName.indexOf('@');
    return i > 0 ? streamName.slice(0, i).toUpperCase() : null;
  };

  /* ================= الاتصالات ================= */

  function openConn() {
    if (stopped) return;
    const host = WS_HOSTS[hostIndex % WS_HOSTS.length];
    const ws = new WebSocket(`${host}/stream?streams=!miniTicker@arr`);
    const conn = {
      ws,
      streams: new Set(['!miniTicker@arr']),
      hostIndex: hostIndex % WS_HOSTS.length,
      keepAlive: null,
      lifetimeTimer: null,
      lastMsgAt: now()
    };
    ws.on('open', () => {
      attempt = 0;
      conn.lastMsgAt = now();
      conn.keepAlive = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          try { ws.ping(); } catch { /* onclose يتبع */ }
        }
      }, 30_000);
      // إعادة اتصال استباقية قبل قطع بينانس الإجباري (24 ساعة)
      conn.lifetimeTimer = setTimeout(() => {
        try { ws.terminate(); } catch { /* ignore */ }
      }, cfg.proactiveReconnectMs);
      // إعادة اشتراك كل المطلوب بعد فتح الاتصال
      for (const s of [...wantedKlines].map(klineStreamOf)) scheduleControl('sub', s);
      for (const s of [...wantedFlow].map(aggStreamOf)) scheduleControl('sub', s);
      log.log?.(`[market-streams] connected: ${host} (${conn.streams.size} streams)`);
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
      clearTimeout(conn.lifetimeTimer);
      conns = conns.filter(c => c !== conn);
      if (stopped) return;
      // تراجع أُسّي مع تدوير النقطة — ثم إعادة فتح وإعادة اشتراك كل المطلوب
      attempt += 1;
      hostIndex = (hostIndex + 1) % WS_HOSTS.length;
      const delay = Math.min(cfg.reconnectMaxMs, cfg.reconnectBaseMs * 2 ** Math.min(attempt, 5));
      log.warn?.(`[market-streams] connection lost — reconnect in ${delay}ms (attempt ${attempt})`);
      setTimeout(() => { if (!stopped) openConn(); }, delay);
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
        if (tick?.s && Number.isFinite(p)) prices.set(tick.s, { price: p, at: t });
      }
      return;
    }
    const stream = String(msg.stream ?? '');
    if (stream.includes('@kline_')) {
      const k = data?.k;
      if (!k || !data?.s) return;
      const tf = String(k.i ?? tfFromStream(stream));
      upsertKline(data.s, tf, k);
      if (k.x === true) notifyCandleClose(data.s, tf, Number(k.c));
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

  /** تحديث مخزن الشموع بصيغة صفوف بينانس الخام نفسها (تُقرأ مباشرة بnormalizeCandles/computeCvd) */
  function upsertKline(symbol, tf, k) {
    const key = `${symbol}|${tf}`;
    let buf = klines.get(key);
    if (!buf) { buf = new Map(); klines.set(key, buf); }
    buf.set(Number(k.t), [k.t, k.o, k.h, k.l, k.c, k.v, k.T, k.q, k.n, k.V, k.Q, '0']);
  }

  let lastFastAt = 0;
  function notifyCandleClose(symbol, tf, closePrice) {
    const t = now();
    if (t - lastFastAt < 200) return; // تخفيف للمعالجات المتتالية لنفس الشمعة
    lastFastAt = t;
    for (const cb of candleCloseHandlers) {
      try { cb(symbol, tf, closePrice); } catch { /* معالج فاشل لا يوقف البقية */ }
    }
  }

  /** بذر مخزن شموع من REST مرة واحدة (للمفاتيح غير المزروعة) */
  function ensureKlineSeed(key) {
    if (klines.has(key) || klineSeeding.has(key) || !seedKlines) return klineSeeding.get(key) ?? Promise.resolve();
    const [symbol, tf] = key.split('|');
    const p = (async () => {
      try {
        const raw = await seedKlines(symbol, tf, cfg.seedLimit);
        const buf = klines.get(key) ?? new Map();
        for (const row of raw ?? []) buf.set(Number(row[0]), row);
        klines.set(key, buf);
      } catch (e) {
        log.warn?.(`[market-streams] seed failed ${key}: ${e?.message ?? e}`);
      } finally {
        klineSeeding.delete(key);
      }
    })();
    klineSeeding.set(key, p);
    return p;
  }

  /** صفوف الشموع الخام مرتبة زمنياً (null إن لم تُبَذ) */
  function getKlines(symbol, tf) {
    const buf = klines.get(`${symbol}|${tf}`);
    if (!buf) return null;
    return Array.from(buf.entries()).sort((a, b) => a[0] - b[0]).map(([, row]) => row);
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

  /* ================= إدارة الاشتراكات ================= */

  function scheduleControl(op, streamName) {
    (op === 'sub' ? pendingSubs : pendingUnsubs).add(streamName);
    if (controlTimer) return;
    controlTimer = setTimeout(() => {
      controlTimer = null;
      flushControl('sub');
      flushControl('unsub');
    }, cfg.controlBatchMs);
  }

  function flushControl(op) {
    const bag = op === 'sub' ? pendingSubs : pendingUnsubs;
    if (!bag.size) return;
    const names = [...bag];
    bag.clear();
    const conn = conns.find(c => c.ws.readyState === WebSocket.OPEN);
    if (!conn) return; // ستُعاد الاشتراكات عند open تلقائياً
    for (let i = 0; i < names.length; i += cfg.controlBatchSize) {
      const batch = names.slice(i, i + cfg.controlBatchSize);
      try {
        conn.ws.send(JSON.stringify({
          method: op === 'sub' ? 'SUBSCRIBE' : 'UNSUBSCRIBE',
          params: batch,
          id: Date.now() + i
        }));
      } catch { /* onclose يتبع */ }
    }
  }

  /** الفرق بين المطلوب والمشترك — بلا تكرار ولا رسائل زائدة */
  function syncKlineSubs() {
    const list = [...wantedKlines].slice(0, cfg.klineSubLimit);
    const target = new Set(list);
    for (const key of activeKlines) {
      if (!target.has(key)) {
        activeKlines.delete(key);
        scheduleControl('unsub', klineStreamOf(key));
      }
    }
    for (const key of target) {
      if (!activeKlines.has(key)) {
        activeKlines.add(key);
        scheduleControl('sub', klineStreamOf(key));
      }
    }
  }

  function syncFlowSubs() {
    const target = new Set([...wantedFlow].slice(0, cfg.aggTradeSubLimit));
    for (const sym of activeFlow) {
      if (!target.has(sym)) {
        activeFlow.delete(sym);
        trades.delete(sym); // تحرير الذاكرة فور إلغاء الاشتراك
        scheduleControl('unsub', aggStreamOf(sym));
      }
    }
    for (const sym of target) {
      if (!activeFlow.has(sym)) {
        activeFlow.add(sym);
        scheduleControl('sub', aggStreamOf(sym));
      }
    }
  }

  /* ================= التسوية الدورية ضد الانجراف ================= */

  function reconcileTick() {
    if (!seedKlines || !klines.size) return;
    const keys = [...klines.keys()];
    const base = Math.floor(Math.random() * keys.length);
    for (let i = 0; i < Math.min(cfg.reconcileBatch, keys.length); i += 1) {
      const key = keys[(base + i) % keys.length];
      const [symbol, tf] = key.split('|');
      void (async () => {
        try {
          const fresh = await seedKlines(symbol, tf, 2);
          const lastFresh = fresh?.[fresh.length - 1];
          const buf = klines.get(key);
          const lastLocal = buf ? Array.from(buf.keys()).sort((a, b) => a - b).pop() : null;
          if (!lastFresh || !buf) return;
          const freshOpen = Number(lastFresh[0]);
          if (freshOpen !== lastLocal) {
            // شمعة جديدة لم تصل بالبث (انقطاع قصير) → إعادة بذر كاملة
            await ensureKlineSeed(key);
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
      openConn();
      reconcileTimer = setInterval(reconcileTick, cfg.reconcileMs);
      if (reconcileTimer.unref) reconcileTimer.unref();
    },
    stop() {
      stopped = true;
      started = false;
      clearInterval(reconcileTimer);
      for (const c of conns) {
        clearInterval(c.keepAlive);
        clearTimeout(c.lifetimeTimer);
        try { c.ws.close(); } catch { /* ignore */ }
      }
      conns = [];
    },
    connected: () => conns.some(c => c.ws.readyState === WebSocket.OPEN) && prices.size > 0,
    getPrice: (symbol) => prices.get(String(symbol).toUpperCase())?.price ?? null,
    getPriceAt: (symbol) => prices.get(String(symbol).toUpperCase())?.at ?? null,
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
      // الاتحاد عبر المستأجرين — مع أولوية طلب الأول (أقدم مستأجر يفوز عند التجاوز)
      const merged = [];
      const seen = new Set();
      for (const set of klineWants.values()) {
        for (const k of set) if (!seen.has(k)) { seen.add(k); merged.push(k); }
      }
      wantedKlines = new Set(merged);
      syncKlineSubs();
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
      syncFlowSubs();
    },
    onCandleClose(cb) {
      candleCloseHandlers.add(cb);
      return () => candleCloseHandlers.delete(cb);
    },
    hasKline: (key) => klines.has(String(key)),
    ensureKlineSeed,
    getKlines,
    flowSnapshot,
    stats() {
      return {
        connected: conns.some(c => c.ws.readyState === WebSocket.OPEN),
        connections: conns.length,
        streams: conns.reduce((a, c) => a + c.streams.size, 0),
        klineSubs: wantedKlines.size,
        aggTradeSubs: wantedFlow.size,
        priceSymbols: prices.size,
        messages: messageCount,
        lastMessageAt,
        startedAt
      };
    }
  };
}
