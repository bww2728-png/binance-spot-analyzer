import type { BarcodeScan, CoinShariahRow, LiquidityZone, Settings, ShariahResearch, ShariahResearchStatus, ZonesAccuracy, LiveOpportunitiesResponse, LiquidityDetection, LiquidityZoneEngineStatus, BuyFeed, BuyStatus, BuyOpportunity, BuyHistoryResponse, PersistedOpportunityHistoryPage, PersistedOpportunityHistorySummary, PersistedRejectionReason, Strategy2Feed, Strategy2HistoryResponse, Strategy2DirectionsResponse, LiquidityV2ZonesResponse, LiquidityV2StatusResponse, Candle } from './types';

/**
 * جميع بيانات التطبيق تمر عبر Express (same-origin).
 * لا يبنى عميل Supabase في المتصفح، ولا يقترح هذا الملف أي اتصال مباشر بقاعدة البيانات.
 */
// ---------- Legacy local REST adapter (localhost dev) ----------
async function j<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { const b = await res.json(); if (b?.error) msg = b.error; } catch { /* ignore */ }
    throw new Error(msg);
  }
  return res.json() as Promise<T>;
}

const BASE = '/api';
const restApi = {
  getBarcodeScans: () => fetch(`${BASE}/barcode-scans`).then(j<BarcodeScan[]>),
  getShariah: () => fetch(`${BASE}/shariah`).then(j<CoinShariahRow[]>),
  setShariah: (symbol: string, row: Partial<CoinShariahRow>) =>
    fetch(`${BASE}/shariah/${symbol}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(row) }).then(j<CoinShariahRow>),
  deleteShariah: (symbol: string) =>
    fetch(`${BASE}/shariah/${symbol}`, { method: 'DELETE' }).then(j<{ ok: boolean }>),
  researchShariah: (symbol: string) =>
    fetch(`${BASE}/shariah-research/${encodeURIComponent(symbol)}`, { method: 'POST' }).then(j<ShariahResearch>),
  shariahResearchStatus: () => fetch(`${BASE}/shariah-research/status`).then(j<ShariahResearchStatus>),
  logShariahChange: (body: { symbol: string; message: string; meta?: Record<string, unknown> }) =>
    fetch(`${BASE}/shariah-research/changes`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(j<{ ok: boolean }>),
  getSettings: () => fetch(`${BASE}/settings`).then(j<Settings>),
  updateSettings: (body: Partial<Settings>) =>
    fetch(`${BASE}/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(j<Settings>),
  getZones: (symbol?: string) =>
    fetch(`${BASE}/zones${symbol ? '/' + encodeURIComponent(symbol) : ''}`).then(j<{ zones: LiquidityZone[] }>),
  createZone: (body: { symbol: string; timeframe: string; type: 'BSL' | 'SSL'; price: number; note?: string; expires_at?: number | null }) =>
    fetch(`${BASE}/zones`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(j<{ ok: boolean; zone: LiquidityZone }>),
  updateZone: (id: string, body: { price?: number; note?: string; type?: 'BSL' | 'SSL'; active?: boolean }) =>
    fetch(`${BASE}/zones/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(j<{ ok: boolean; zone: LiquidityZone }>),
  deleteZone: (id: string) =>
    fetch(`${BASE}/zones/${id}`, { method: 'DELETE' }).then(j<{ ok: boolean }>),
  zoneFeedback: (id: string, verdict: 'confirm' | 'reject' | 'clear', note?: string) =>
    fetch(`${BASE}/zones/${id}/feedback`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(note !== undefined ? { verdict, note } : { verdict }) }).then(j<{ ok: boolean; zone: LiquidityZone }>),
  zoneNote: (id: string, note: string) =>
    fetch(`${BASE}/zones/${id}/note`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ note }) }).then(j<{ ok: boolean; zone: LiquidityZone }>),
  getAccuracy: (symbol?: string) =>
    fetch(`${BASE}/zones/accuracy${symbol ? '?symbol=' + encodeURIComponent(symbol) : ''}`).then(j<ZonesAccuracy>),
  getLiveOpportunities: (signal?: AbortSignal) =>
    fetch(`${BASE}/live/opportunities`, { signal }).then(j<LiveOpportunitiesResponse>),
  getLiquidityTargets: (signal?: AbortSignal) =>
    fetch(`${BASE}/symbols/targets`, { signal }).then(j<{ targets: string[] }>),
  getMarketRead: (symbol: string, timeframes: string, signal?: AbortSignal) =>
    fetch(`${BASE}/market-read?symbol=${encodeURIComponent(symbol)}&timeframes=${encodeURIComponent(timeframes)}`, { signal }).then(j<MarketReadResponse>),
  /** شموع من وكيل الخادم (نفس مصدر المخزن) — يستخدمها عرض v2 بدل الاتصال المباشر ببينانس */
  getKlines: (symbol: string, interval: string, limit = 500, signal?: AbortSignal): Promise<Candle[]> =>
    fetch(`${BASE}/klines?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}&limit=${limit}`, { signal }).then(j<Candle[]>),
  /** محرك السيولة v2 (محرك موازٍ — عرض فقط، بلا أي تفعيل): حصيلة قياس الظل */
  getLiquidityV2Status: (signal?: AbortSignal) =>
    fetch(`${BASE}/liquidity-zones/v2/status`, { signal }).then(j<LiquidityV2StatusResponse>),
  /** محرك السيولة v2: مناطق (رمز، فريم) محسوبة عند الطلب من نفس المخزن */
  getLiquidityV2Zones: (opts: { symbol: string; timeframe: string; cap?: number; state?: string; kind?: string }, signal?: AbortSignal) => {
    const q = new URLSearchParams({ symbol: opts.symbol, timeframe: opts.timeframe });
    if (opts.cap != null) q.set('cap', String(opts.cap));
    if (opts.state) q.set('state', opts.state);
    if (opts.kind) q.set('kind', opts.kind);
    return fetch(`${BASE}/liquidity-zones/v2/zones?${q}`, { signal }).then(j<LiquidityV2ZonesResponse>);
  },
  getLiquidityZoneStatus: (signal?: AbortSignal) =>
    fetch(`${BASE}/liquidity-zones/status`, { signal }).then(j<LiquidityZoneEngineStatus>),
  getLiquidityZones: (opts: { mode: 'live' | 'history'; symbol?: string; timeframe?: string; kind?: string; limit?: number; offset?: number } = { mode: 'live' }, signal?: AbortSignal) => {
    const q = new URLSearchParams();
    if (opts.symbol) q.set('symbol', opts.symbol);
    if (opts.timeframe) q.set('timeframe', opts.timeframe);
    if (opts.kind) q.set('kind', opts.kind);
    if (opts.limit != null) q.set('limit', String(opts.limit));
    if (opts.offset != null) q.set('offset', String(opts.offset));
    return fetch(`${BASE}/liquidity-zones/${opts.mode}?${q}`, { signal }).then(j<{ results: LiquidityDetection[]; total: number; rotation: number; updatedAt?: number }>);
  },
  getLiquidityZone: (id: string, signal?: AbortSignal) =>
    fetch(`${BASE}/liquidity-zones/${encodeURIComponent(id)}`, { signal }).then(j<{ zone: LiquidityDetection; screenshotAt: string; screenshotAfter: string }>),
  reviewLiquidityZone: (id: string, body: { verdict: 'accept' | 'reject' | 'confirm' | 'clear'; note?: string; correction?: unknown }) =>
    fetch(`${BASE}/liquidity-zones/${encodeURIComponent(id)}/review`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(j<{ ok: boolean; zone: LiquidityDetection; adjustment: LiquidityZoneEngineStatus['adjustment'] }>),
  runLiquidityZones: () =>
    fetch(`${BASE}/liquidity-zones/run`, { method: 'POST' }).then(j<{ ok: boolean; started: boolean }>) ,
  runCustomLiquidityZones: (opts: { symbol: string; timeframe: string; fromTs: number; toTs: number }) =>
    fetch(`${BASE}/liquidity-zones/run-custom`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(opts) }).then(j<{ ok: boolean; symbol: string; timeframe: string; fromTs: number; toTs: number; results: LiquidityDetection[]; candles: Array<[number, number, number, number, number]> }>)
};

// ==================== الفرص الحية (سويب SSL + أوردر فلو) — مشتركة بين الواجهتين ====================
const liveOpportunitiesApi = {
  getBuyFeed: (opts: { timeframe?: string } = {}, signal?: AbortSignal) => {
    const q = new URLSearchParams();
    if (opts.timeframe) q.set('timeframe', opts.timeframe);
    const qs = q.toString();
    return fetch(`${BASE}/live-opportunities${qs ? `?${qs}` : ''}`, { signal }).then(j<BuyFeed>);
  },
  getBuyStatus: (signal?: AbortSignal) =>
    fetch(`${BASE}/live-opportunities/status`, { signal }).then(j<BuyStatus>),
  getBuyCalibration: (signal?: AbortSignal) =>
    fetch(`${BASE}/live-opportunities/calibration`, { signal }).then(j<BuyFeed['calibration']>),
  getBuyHistory: (signal?: AbortSignal) =>
    fetch(`${BASE}/live-opportunities/history`, { signal }).then(j<{ opportunities: BuyOpportunity[]; total: number }>),
  getBuyHistoryEvents: (days: number, signal?: AbortSignal) =>
    fetch(`${BASE}/live-opportunities/history?days=${days}`, { signal }).then(j<BuyHistoryResponse>),
  getPersistedOpportunityHistory: (engine: 'live' | 'strategy2', opts: { beforeId?: number | null; limit?: number } = {}, signal?: AbortSignal) => {
    const q = new URLSearchParams({ engine, limit: String(opts.limit ?? 30) });
    if (opts.beforeId != null) q.set('beforeId', String(opts.beforeId));
    return fetch(`${BASE}/opportunities/persisted-history?${q}`, { signal }).then(j<PersistedOpportunityHistoryPage>);
  },
  getPersistedOpportunityHistorySummary: (engine: 'live' | 'strategy2', signal?: AbortSignal) =>
    fetch(`${BASE}/opportunities/persisted-history/summary?engine=${engine}`, { signal }).then(j<PersistedOpportunityHistorySummary>),
  getRejectedOpportunitySummary: (engine: 'live' | 'strategy2', signal?: AbortSignal) =>
    fetch(`${BASE}/opportunities/rejected-summary?engine=${engine}`, { signal }).then(j<{ engine: string; reasons: PersistedRejectionReason[]; generatedAt: number }>),
  setBuyPaused: (paused: boolean) =>
    fetch(`${BASE}/live-opportunities/control`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paused }) }).then(j<{ ok: boolean; paused: boolean; pauseUpdatedAt: number | null }>),
  runBuyScan: () =>
    fetch(`${BASE}/live-opportunities/run`, { method: 'POST' }).then(j<{ ok: boolean; started: boolean }>),
  runBuyCalibration: (body?: { symbols?: string[]; timeframes?: string[] }) =>
    fetch(`${BASE}/live-opportunities/calibrate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) }).then(j<{ ok: boolean; started: boolean; symbols: number | null; timeframes: number | null }>),
  buyOpportunityChartUrl: (id: string) => `${BASE}/live-opportunities/${encodeURIComponent(id)}/screenshot`,
  watchZoneChartUrl: (symbol: string, timeframe: string, zoneId: string) =>
    `${BASE}/live-opportunities/watch/${encodeURIComponent(symbol)}/${encodeURIComponent(timeframe)}/${encodeURIComponent(zoneId)}/screenshot`,

  /* ---- الفرص الحية — استراتيجيتي (محرك SMC المستقل) ---- */
  getStrategy2Feed: (opts: { symbol?: string; tf?: string; model?: string; tier?: string; htfDir?: string; sort?: string; limit?: number; offset?: number } = {}, signal?: AbortSignal) => {
    const qs = new URLSearchParams();
    if (opts.symbol) qs.set('symbol', opts.symbol);
    if (opts.tf) qs.set('tf', opts.tf);
    if (opts.model) qs.set('model', opts.model);
    if (opts.tier) qs.set('tier', opts.tier);
    if (opts.htfDir) qs.set('htfDir', opts.htfDir);
    if (opts.sort) qs.set('sort', opts.sort);
    if (opts.limit) qs.set('limit', String(opts.limit));
    if (opts.offset) qs.set('offset', String(opts.offset));
    const q = qs.toString();
    return fetch(`${BASE}/strategy2/feed${q ? `?${q}` : ''}`, { signal }).then(j<Strategy2Feed>);
  },
  getStrategy2History: (days: number, signal?: AbortSignal) =>
    fetch(`${BASE}/strategy2/history?days=${days}`, { signal }).then(j<Strategy2HistoryResponse>),
  getStrategy2Directions: (opts: { symbol?: string; tf?: string; dir?: string; stage?: string; dead?: string; agreement?: string; sort?: string; limit?: number; offset?: number } = {}, signal?: AbortSignal) => {
    const qs = new URLSearchParams();
    if (opts.symbol) qs.set('symbol', opts.symbol);
    if (opts.tf) qs.set('tf', opts.tf);
    if (opts.dir) qs.set('dir', opts.dir);
    if (opts.stage) qs.set('stage', opts.stage);
    if (opts.dead) qs.set('dead', opts.dead);
    if (opts.agreement) qs.set('agreement', opts.agreement);
    if (opts.sort) qs.set('sort', opts.sort);
    if (opts.limit) qs.set('limit', String(opts.limit));
    if (opts.offset) qs.set('offset', String(opts.offset));
    const q = qs.toString();
    return fetch(`${BASE}/strategy2/directions${q ? `?${q}` : ''}`, { signal }).then(j<Strategy2DirectionsResponse>);
  },
  runStrategy2Scan: () =>
    fetch(`${BASE}/strategy2/run`, { method: 'POST' }).then(j<{ ok: boolean; started: boolean }>),
  runStrategy2Calibration: (body?: { symbols?: string[] }) =>
    fetch(`${BASE}/strategy2/calibrate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) }).then(j<{ ok: boolean; started: boolean; symbols: number | null }>),
  getStrategy2Csse: (symbol?: string, tf?: string, signal?: AbortSignal) => {
    const qs = new URLSearchParams();
    if (symbol) qs.set('symbol', symbol);
    if (tf) qs.set('tf', tf);
    const q = qs.toString();
    return fetch(`${BASE}/strategy2/csse${q ? `?${q}` : ''}`, { signal }).then(j<unknown>);
  },
  getStrategy2Feedback: (limit = 200, signal?: AbortSignal) =>
    fetch(`${BASE}/strategy2/feedback?limit=${limit}`, { signal }).then(j<{ id: string; elementId: string; symbol: string; tf: string; verdict: string; reason: string; at: number }[]>),
  sendStrategy2Feedback: (body: { symbol: string; tf?: string; elementId: string; verdict: 'valid' | 'invalid' | 'note'; reason?: string; revokes?: string }) =>
    fetch(`${BASE}/strategy2/feedback`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(j<{ ok: boolean }>)
};

export interface MarketReadZone { id: string; kind: string; level: number; confidence: number; touches: number; state: string; }
export interface MarketReadPerTf {
  symbol: string; timeframe: string; lastPrice: number;
  direction: string; lastBreak: string | null;
  above: MarketReadZone[]; below: MarketReadZone[];
  sweptCount: number; rejections: number;
  baseCase: { low: number; high: number; atr: number; capped: number | null };
  biasScore: number; steps: string[];
}
export interface MarketReadResponse {
  ok: boolean; symbol: string; bias: string; net: number; summary: string; reads: MarketReadPerTf[];
}

export const api = { ...restApi, ...liveOpportunitiesApi };
