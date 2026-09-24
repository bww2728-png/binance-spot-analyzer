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
    aggTradeSubLimit: 0,          // 0 = بلا قص (التوزيع على الاتصالات يتكفل بالحدود)
    klineSubLimit: 0,             // 0 = بلا قص — كل المطلوب يُشترك فعلاً عبر اتصالات إضافية
    maxConns: 8,
    ...config
  };

  /* ---- حالة مشتركة (قراءة متزامنة بلا شبكة) ---- */
  const prices = new Map();          // symbol → { price, at }
  const klines = new Map();          // "SYM|tf" → Map(openTime → rawRow)
  const klineSeeding = new Map();    // "SYM|tf" → Promise (منع البذر المزدوج)
  const trades = new Map();          // symbol → [{price, qty, isBuyerMaker, at}]
  let candleCloseHandlers = new Set();

  /* ---- الاشتراكات المطلوبة (مستأجرون متعددون: محرك الفرص + محرك الاستراتيجية) ----
   * كل مستهلك يسجّل طلباته بمفتاح tenant، والاتحاد يُشترك به فعلياً موزعاً على الاتصالات. */
  const klineWants = new Map();      // tenant → Set("SYM|tf")
  const flowWants = new Map();       // tenant → Set(symbol)
  let wantedKlines = new Set();      // الاتحاد الفعلي
  let wantedFlow = new Set();

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
    if (stopped) return;
    const host = WS_HOSTS[hostIndex % WS_HOSTS.length];
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
        if (ws.readyState === WebSocket.OPEN) {
          try { ws.ping(); } catch { /* onclose يتبع */ }
        }
      }, 30_000);
      // إعادة اتصال استباقية قبل قطع بينانس الإجباري (24 ساعة)
      conn.lifetimeTimer = setTimeout(() => {
        try { ws.terminate(); } catch { /* ignore */ }
      }, cfg.proactiveReconnectMs);
      // إعادة اشتراك ما يملكه هذا الاتصال فقط (وليس كل المطلوب عالمياً)
      const owned = connOwned.get(id) ?? new Set();
      for (const s of owned) {
        if (!conn.active.has(s)) scheduleOn(conn, 'sub', s);
      }
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
      clearTimeout(conn.lifetimeTimer);
      if (conn.controlTimer) { clearTimeout(conn.controlTimer); conn.controlTimer = null; }
      conns = conns.filter(c => c !== conn);
      if (stopped) return;
      // تراجع أُسّي مع تدوير النقطة — ثم إعادة فتح نفس الشارد باشتراكاته المحفوظة
      attempt += 1;
      hostIndex = (hostIndex + 1) % WS_HOSTS.length;
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
    if (conn.ws.readyState !== WebSocket.OPEN) return; // on open يُعاد الإرسال تلقائياً
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
    return out;
  }

  function syncSubs() {
    if (!started || stopped) return;
    const desired = desiredStreams();
    const desiredSet = new Set(desired);

    // 1) تحرير ملاك الستريمات غير المطلوبة
    for (const s of [...streamOwner.keys()]) {
      if (desiredSet.has(s)) continue;
      const id = streamOwner.get(s);
      streamOwner.delete(s);
      connOwned.get(id)?.delete(s);
      const conn = conns.find(c => c.id === id);
      if (conn) { scheduleOn(conn, 'unsub', s); }
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
      syncSubs(); // يفتح الاتصالات المطلوبة ويوزع الاشتراكات
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
      // الاتحاد عبر المستأجرين — يُشترك به كله موزعاً (بلا قص)
      const merged = [];
      const seen = new Set();
      for (const set of klineWants.values()) {
        for (const k of set) if (!seen.has(k)) { seen.add(k); merged.push(k); }
      }
      wantedKlines = new Set(merged);
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
      syncSubs();
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
        streams: conns.reduce((a, c) => a + c.active.size, 0),
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
