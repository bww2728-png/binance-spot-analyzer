import type { Candle } from './types';

const API = '/api';

export interface SpotSymbol {
  symbol: string;   // e.g. BTCUSDT
  base: string;     // e.g. BTC
  tickSize: number;
}

interface SymbolRow {
  symbol: string;
  base: string;
  quote: string;
  tick_size: number;
  status: string;
}

/** قراءة القائمة المخزنة مسبقاً في قاعدة البيانات (عبر الخادم) */
export async function fetchSpotSymbols(quote: string): Promise<SpotSymbol[]> {
  const res = await fetch(`${API}/symbols?quote=${encodeURIComponent(quote)}`);
  if (!res.ok) throw new Error(`symbols HTTP ${res.status}`);
  const rows = (await res.json()) as SymbolRow[];
  return rows.map(r => ({ symbol: r.symbol, base: r.base, tickSize: Number(r.tick_size) || 0.01 }));
}

/** مزامنة القائمة من بينانس إلى قاعدة البيانات (عبر الخادم) */
export async function syncSymbols(): Promise<{ total: number; saved: number }> {
  const res = await fetch(`${API}/symbols/sync`, { method: 'POST' });
  if (!res.ok) throw new Error(`sync HTTP ${res.status}`);
  return res.json();
}

const klinesCache = new Map<string, Candle[]>();
const KLINE_CACHE_MAX = 40; // LRU — منع نمو الذاكرة غير المحدود طوال الجلسة

function cacheGet(key: string) {
  const v = klinesCache.get(key);
  if (v != null) {
    klinesCache.delete(key);
    klinesCache.set(key, v);
  }
  return v;
}

function cacheSet(key: string, v: Candle[]) {
  klinesCache.delete(key);
  klinesCache.set(key, v);
  if (klinesCache.size > KLINE_CACHE_MAX) {
    const oldest = klinesCache.keys().next().value;
    if (oldest != null) klinesCache.delete(oldest);
  }
}

function cacheKey(symbol: string, interval: string) {
  return `${symbol}:${interval}`;
}

function mergeCandles(existing: Candle[] = [], incoming: Candle[] = []): Candle[] {
  const map = new Map<number, Candle>();
  for (const c of existing) map.set(c.time, c);
  for (const c of incoming) map.set(c.time, c);
  return Array.from(map.values()).sort((a, b) => a.time - b.time);
}

export { mergeCandles };

export async function fetchKlines(
  symbol: string,
  interval: string,
  limit = 1000,
  startTime?: number,
  endTime?: number
): Promise<Candle[]> {
  const key = cacheKey(symbol, interval);
  const params = new URLSearchParams({
    symbol,
    interval,
    limit: String(Math.min(limit, 1000))
  });
  if (startTime) params.set('startTime', String(startTime));
  if (endTime) params.set('endTime', String(endTime));
  const res = await fetch(`${API}/klines?${params.toString()}`);
  if (!res.ok) throw new Error(`klines HTTP ${res.status}`);
  const incoming: Candle[] = await res.json();
  const merged = mergeCandles(cacheGet(key), incoming);
  cacheSet(key, merged);
  return merged;
}

/** يجلب دفعات تاريخية إضافية قبل أقدم شمعة محفوظة */
export async function fetchOlderKlines(
  symbol: string,
  interval: string,
  oldestTime: number
): Promise<Candle[]> {
  // endTime يجعل Binance يبحث للخلف في الزمن ويعيد آخر 1000 شمعة قبل أقدم شمعة لدينا
  const endTime = oldestTime * 1000 - 1; // Binance uses ms
  const incoming = await fetchKlines(symbol, interval, 1000, undefined, endTime);
  return incoming.filter(c => c.time < oldestTime);
}

type StreamHandler = (data: unknown) => void;

/** تنسيق سعر مرن: أقل من 0.001 → أرقام معنوية (لا قصب)، وأكبر → كسور حتى 8 كما في السابق */
export function fmtPrice(p: number | null | undefined): string {
  if (p == null || !Number.isFinite(p)) return '—';
  const a = Math.abs(p);
  if (a > 0 && a < 0.001) return p.toLocaleString('en', { maximumSignificantDigits: 6 });
  return p.toLocaleString('en', { maximumFractionDigits: 8 });
}

interface Conn {
  ws: WebSocket;
  streams: Set<string>;
  keepAlive: ReturnType<typeof setInterval>;
  hostIndex: number;
}

/** نقاط WebSocket بترتيب التجربة (العامة بلا حجب أولاً) */
const WS_HOSTS = [
  'wss://data-stream.binance.vision',
  'wss://stream.binance.com:9443',
  'wss://stream.binance.com:443'
];

/**
 * مدير اتصالات WebSocket مجمّعة مع إعادة اتصال تلقائي وheartbeat
 * (حد آمن: 150 stream لكل اتصال، بحد أقصى 1024 مسموح من بينانس)
 */
export class BinanceStreams {
  private conns: Conn[] = [];
  private handlers = new Map<string, Set<StreamHandler>>();
  private pending: string[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private maxPerConn: number;
  private lastGoodHost = 0;

  constructor(maxPerConn = 150) {
    this.maxPerConn = maxPerConn;
  }

  subscribe(stream: string, handler: StreamHandler): () => void {
    let set = this.handlers.get(stream);
    if (!set) { set = new Set(); this.handlers.set(stream, set); }
    set.add(handler);
    if (!this.conns.some(c => c.streams.has(stream)) && !this.pending.includes(stream)) {
      this.pending.push(stream);
      this.scheduleFlush();
    }
    return () => this.unsubscribe(stream, handler);
  }

  private unsubscribe(stream: string, handler: StreamHandler) {
    const set = this.handlers.get(stream);
    if (!set) return;
    set.delete(handler);
    if (set.size === 0) {
      this.handlers.delete(stream);
      this.removeStream(stream);
    }
  }

  private scheduleFlush() {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, 300);
  }

  private flush() {
    while (this.pending.length) {
      const conn = this.conns.find(c => c.streams.size < this.maxPerConn && c.ws.readyState === WebSocket.OPEN);
      const batch = this.pending.splice(0, this.maxPerConn);
      if (conn) {
        this.sendSubs(conn, batch);
      } else {
        this.openConn(batch);
      }
    }
  }

  private nextHost(): string {
    const host = WS_HOSTS[this.lastGoodHost % WS_HOSTS.length];
    return host;
  }

  private openConn(initial: string[], hostIndex = this.lastGoodHost) {
    if (this.closed) return;
    const streams = new Set(initial);
    const host = WS_HOSTS[hostIndex % WS_HOSTS.length] ?? this.nextHost();
    const url = `${host}/stream?streams=${[...streams].join('/')}`;
    const ws = new WebSocket(url);
    const keepAlive = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        try { ws.send(JSON.stringify({ method: 'LIST_SUBSCRIPTIONS', id: Date.now() })); } catch { /* ignore */ }
      }
    }, 60_000);
    const conn: Conn = { ws, streams, keepAlive, hostIndex };
    ws.onopen = () => {
      this.lastGoodHost = hostIndex;
    };
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data as string) as { stream?: string; data?: unknown };
        if (msg.stream) {
          const set = this.handlers.get(msg.stream);
          if (set) for (const h of set) h(msg.data);
        }
      } catch { /* ignore malformed */ }
    };
    ws.onclose = () => {
      clearInterval(keepAlive);
      this.conns = this.conns.filter(c => c !== conn);
      if (this.closed) return;
      // إعادة اتصال: جرب النقطة التالية إذا فشلت الحالية
      const lost = [...streams].filter(s => this.handlers.has(s));
      if (lost.length) {
        const nextIndex = (hostIndex + 1) % WS_HOSTS.length;
        setTimeout(() => {
          this.pending.push(...lost);
          this.scheduleFlush();
        }, 2000);
        if (hostIndex === this.lastGoodHost) this.lastGoodHost = nextIndex;
      }
    };
    ws.onerror = () => { /* onclose follows */ };
    this.conns.push(conn);
  }

  private sendSubs(conn: Conn, streams: string[]) {
    const fresh = streams.filter(s => !conn.streams.has(s));
    if (!fresh.length) return;
    for (const s of fresh) conn.streams.add(s);
    if (conn.ws.readyState === WebSocket.OPEN) {
      conn.ws.send(JSON.stringify({ method: 'SUBSCRIBE', params: fresh, id: Date.now() }));
    }
  }

  private removeStream(stream: string) {
    for (const conn of this.conns) {
      if (conn.streams.has(stream)) {
        conn.streams.delete(stream);
        if (conn.ws.readyState === WebSocket.OPEN) {
          conn.ws.send(JSON.stringify({ method: 'UNSUBSCRIBE', params: [stream], id: Date.now() }));
        }
        break;
      }
    }
  }

  destroy() {
    this.closed = true;
    for (const c of this.conns) {
      clearInterval(c.keepAlive);
      try { c.ws.close(); } catch { /* ignore */ }
    }
    this.conns = [];
    this.handlers.clear();
  }
}

export function priceStreamName(symbol: string) {
  return `${symbol.toLowerCase()}@miniTicker`;
}

export function klineStreamName(symbol: string, interval: string) {
  return `${symbol.toLowerCase()}@kline_${interval}`;
}

export interface MiniTicker { s: string; c: string; }
export interface KlineMsg {
  e: string; s: string; k: {
    t: number; T: number; i: string; o: string; c: string; h: string; l: string; v: string; x: boolean;
  };
}

/* ============================================================
   قناة تحديث قائمة الأزواج: بث لحظي من الخادم + احتياطي دوري
   ============================================================ */

export interface SymbolsUpdateMsg {
  type: 'symbols_updated' | 'hello' | 'zones_changed' | 'zone_near' | 'zone_swept' | 'shariah_researched' | string;
  total?: number;
  changed?: number;
  new_bases?: string[];
  last_updated?: number;
  symbol?: string;
  zone?: import('./types').LiquidityZone;
  price?: number;
}

/** اتصال WebSocket بنفس أصل الخادم (مسار /ws) مع إعادة اتصال تلقائي */
export function connectSymbolsSocket(onUpdate: (msg: SymbolsUpdateMsg) => void): () => void {
  let ws: WebSocket | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0;
  let closed = false;

  const open = () => {
    if (closed) return;
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${proto}//${location.host}/ws`);
    ws.onopen = () => { attempt = 0; };
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data as string) as SymbolsUpdateMsg;
        if (msg.type) onUpdate(msg);
      } catch { /* ignore malformed */ }
    };
    ws.onclose = () => {
      if (closed) return;
      attempt += 1;
      const delay = Math.min(30000, 1000 * 2 ** Math.min(attempt, 5));
      retryTimer = setTimeout(open, delay);
    };
    ws.onerror = () => { /* onclose follows */ };
  };

  open();

  return () => {
    closed = true;
    if (retryTimer) clearTimeout(retryTimer);
    try { ws?.close(); } catch { /* ignore */ }
  };
}

/** احتياطي دوري: يراقب /api/symbols/meta ويستدعي المعالج عند تغيّر آخر تحديث */
export function pollSymbolsMeta(intervalSec: number, onChanged: () => void): () => void {
  let last = -1;
  let first = true;
  const tick = async () => {
    try {
      const res = await fetch(`${API}/symbols/meta`);
      if (!res.ok) return;
      const meta = (await res.json()) as { last_updated: number };
      if (first) { last = meta.last_updated; first = false; return; }
      if (meta.last_updated !== last) {
        last = meta.last_updated;
        onChanged();
      }
    } catch { /* ignore */ }
  };
  void tick();
  const t = setInterval(tick, intervalSec * 1000);
  return () => clearInterval(t);
}
