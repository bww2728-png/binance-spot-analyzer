import { createClient } from '@supabase/supabase-js';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { BarcodeScan, CoinShariahRow, EventLog, LiquidityZone, Settings, ShariahResearch, ShariahResearchStatus, ZonesAccuracy, LiveOpportunitiesResponse, LiquidityDetection, LiquidityZoneEngineStatus, BuyFeed, BuyStatus, BuyOpportunity, BuyHistoryResponse, PersistedOpportunityHistoryPage, PersistedOpportunityHistorySummary, PersistedRejectionReason, Strategy2Feed, Strategy2HistoryResponse, Strategy2DirectionsResponse, LiquidityV2ZonesResponse, LiquidityV2StatusResponse, Candle } from './types';

/**
 * خلفية البيانات موحدة عبر REST API (نفس-الأصل) دائماً.
 * - محلياً (localhost): يخدمها خادم Express على 8787.
 * - سحابياً (Railway/etc.): يخدمها نفس خادم Express الذي يوجّه إلى Supabase عبر server/db.js.
 * (وراء وكيل BaaS ذو أصل مشترك يمكن تفعيل مسار Supabase SDK لاحقاً عبر VITE_ إن لزم.)
 */
const envUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const envKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined;

/**
 * مسار Supabase SDK معطّل نهائياً (`useSupabase=false` أدناه): كل النداءات تمرّ عبر
 * Express. كان `createClient` يُنفَّذ دائماً عند تحميل الوحدة، فيسحب حزمة
 * `vendor-supabase` (~221KB خام / 57KB مضغوطة) إلى التحميل الأول بلا أي مستهلك.
 *
 * الآن الإنشاء مشروط بنفس العلَم، فيستطيع المجمّع إسقاط الفرع الميت والاعتمادية معه.
 * لا تغيير سلوكي: العلَم ثابت `false`، و`sbApi` لا يُستدعى إطلاقاً.
 */
const useSupabase = false;

export const supabase = (useSupabase
  ? createClient(envUrl || window.location.origin, envKey || 'verdent-baas-proxy')
  : null) as unknown as SupabaseClient;
// Force REST path: works on both localhost (dev) and any deployed origin (Railway/Vercel/etc.)
// The Express server talks to Supabase via server/db.js (baked defaults).
// Using the Supabase SDK directly from the client only works behind a same-origin BaaS proxy (e.g. Verdent Publish).

const SB = {
  coin_shariah: 'coin_shariah' as const,
  settings: 'settings' as const,
  events_log: 'events_log' as const
};

// حقول boolean في Postgres تُمثَّل 0/1 في الواجهة، وnumeric يعود كنص
const BOOL_FIELDS = [
  'ext_bsl_sweep', 'ext_supply_touch', 'int_bsl_sweep', 'sellers_induced',
  'int_ssl_sweep', 'bsl_touched', 'ssl_touched', 'passed_bsl_after_ssl', 'notify_enabled'
] as const;
const NUM_FIELDS = ['ssl_price', 'bsl_price'] as const;

type AnyRow = Record<string, unknown>;

const fromDb = <T,>(row: AnyRow): T => {
  const out: AnyRow = { ...row };
  for (const f of BOOL_FIELDS) if (f in out) out[f] = out[f] === null ? null : (out[f] ? 1 : 0);
  for (const f of NUM_FIELDS) if (f in out) out[f] = out[f] === null ? null : Number(out[f]);
  return out as T;
};

const pgErr = (e: { message?: string } | null): Error => new Error(e?.message ?? 'Supabase error');

// ---------- Supabase adapter ----------
const sbApi = {
  async getBarcodeScans(): Promise<BarcodeScan[]> {
    const res = await fetch(`${BASE}/barcode-scans`);
    return j<BarcodeScan[]>(res);
  },
  async getShariah(): Promise<CoinShariahRow[]> {
    const { data, error } = await supabase.from(SB.coin_shariah).select('*').order('symbol');
    if (error) throw pgErr(error);
    return (data as AnyRow[]).map(r => fromDb<CoinShariahRow>(r));
  },
  async setShariah(symbol: string, row: Partial<CoinShariahRow>): Promise<CoinShariahRow> {
    const { data, error } = await supabase.from(SB.coin_shariah)
      .upsert({ symbol, ...row, updated_at: Date.now() }, { onConflict: 'symbol' })
      .select().single();
    if (error) throw pgErr(error);
    return fromDb<CoinShariahRow>(data as AnyRow);
  },
  async deleteShariah(symbol: string): Promise<{ ok: boolean }> {
    const { error } = await supabase.from(SB.coin_shariah).delete().eq('symbol', symbol);
    if (error) throw pgErr(error);
    return { ok: true };
  },
  async researchShariah(symbol: string): Promise<ShariahResearch> {
    const res = await fetch(`${BASE}/shariah-research/${encodeURIComponent(symbol)}`, { method: 'POST' });
    return j<ShariahResearch>(res);
  },
  async shariahResearchStatus(): Promise<ShariahResearchStatus> {
    const res = await fetch(`${BASE}/shariah-research/status`);
    return j<ShariahResearchStatus>(res);
  },
  async logShariahChange(body: { symbol: string; message: string; meta?: Record<string, unknown> }): Promise<{ ok: boolean }> {
    const res = await fetch(`${BASE}/shariah-research/changes`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return j<{ ok: boolean }>(res);
  },
  async getSettings(): Promise<Settings> {
    const { data, error } = await supabase.from(SB.settings).select('*').eq('id', 1).single();
    if (error) throw pgErr(error);
    return fromDb<Settings>(data as AnyRow);
  },
  async updateSettings(body: Partial<Settings>): Promise<Settings> {
    const patch: AnyRow = { ...body };
    if ('sound_enabled' in patch) patch.sound_enabled = !!patch.sound_enabled;
    const { data, error } = await supabase.from(SB.settings).update(patch).eq('id', 1).select().single();
    if (error) throw pgErr(error);
    return fromDb<Settings>(data as AnyRow);
  },
  async getZones(symbol?: string): Promise<{ zones: LiquidityZone[] }> {
    let q = supabase.from(SB.events_log).select('*').eq('type', 'liquidity_zone').order('ts', { ascending: true }).limit(2000);
    if (symbol) q = q.eq('symbol', symbol.toUpperCase());
    const { data, error } = await q;
    if (error) throw pgErr(error);
    const latest = new Map<string, LiquidityZone>();
    for (const e of data as EventLog[]) {
      try {
        const z = JSON.parse(e.meta || 'null') as LiquidityZone | null;
        if (z?.id) latest.set(z.id, z);
      } catch { /* ignore */ }
    }
    return { zones: [...latest.values()].filter(z => z.active !== false) };
  },
  async createZone(body: { symbol: string; timeframe: string; type: 'BSL' | 'SSL'; price: number; note?: string; expires_at?: number | null }): Promise<{ ok: boolean; zone: LiquidityZone }> {
    const zone: LiquidityZone = {
      id: crypto.randomUUID(),
      symbol: body.symbol.toUpperCase(),
      type: body.type,
      price: body.price,
      timeframe: body.timeframe,
      note: body.note ?? '',
      created_at: Date.now(),
      expires_at: body.expires_at ?? null,
      active: true
    };
    const { error } = await supabase.from(SB.events_log).insert({
      ts: Date.now(), symbol: zone.symbol, type: 'liquidity_zone', message: zone.note || zone.type, meta: JSON.stringify(zone)
    });
    if (error) throw pgErr(error);
    return { ok: true, zone };
  },
  async updateZone(id: string, body: { price?: number; note?: string; type?: 'BSL' | 'SSL'; active?: boolean }): Promise<{ ok: boolean; zone: LiquidityZone }> {
    const { zones } = await this.getZones();
    const cur = zones.find(z => z.id === id);
    if (!cur) throw new Error('المنطقة غير موجودة');
    const zone: LiquidityZone = { ...cur, ...body };
    const { error } = await supabase.from(SB.events_log).insert({
      ts: Date.now(), symbol: zone.symbol, type: 'liquidity_zone', message: zone.note || zone.type, meta: JSON.stringify(zone)
    });
    if (error) throw pgErr(error);
    return { ok: true, zone };
  },
  async deleteZone(id: string): Promise<{ ok: boolean }> {
    return this.updateZone(id, { active: false });
  },
  async zoneFeedback(id: string, verdict: 'confirm' | 'reject' | 'clear', note?: string) {
    // التغذية الراجعة والمعايرة تمر عبر الخادم دائماً (منطق المعايرة موجود فيه)
    return fetch(`${BASE}/zones/${id}/feedback`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(note !== undefined ? { verdict, note } : { verdict }) }).then(j<{ ok: boolean; zone: LiquidityZone }>);
  },
  async zoneNote(id: string, note: string) {
    return fetch(`${BASE}/zones/${id}/note`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ note }) }).then(j<{ ok: boolean; zone: LiquidityZone }>);
  },
  async getAccuracy(symbol?: string) {
    return fetch(`${BASE}/zones/accuracy${symbol ? '?symbol=' + encodeURIComponent(symbol) : ''}`).then(j<ZonesAccuracy>);
  },
  // السجل التاريخي للتحديد الآلي — يمر عبر الخادم دائماً (التفكيك والفلاتر منطق خادم)
  // ==================== الباك تيست (sb — نفس REST) ====================
  getLiveOpportunities(signal?: AbortSignal): Promise<LiveOpportunitiesResponse> {
    return fetch(`${BASE}/live/opportunities`, { signal }).then(j<LiveOpportunitiesResponse>);
  },
  getLiquidityZoneStatus(signal?: AbortSignal): Promise<LiquidityZoneEngineStatus> {
    return fetch(`${BASE}/liquidity-zones/status`, { signal }).then(j<LiquidityZoneEngineStatus>);
  },
  getLiquidityZones(opts: { mode: 'live' | 'history'; symbol?: string; timeframe?: string; kind?: string; limit?: number; offset?: number } = { mode: 'live' }, signal?: AbortSignal): Promise<{ results: LiquidityDetection[]; total: number; rotation: number; updatedAt?: number }> {
    const q = new URLSearchParams();
    if (opts.symbol) q.set('symbol', opts.symbol);
    if (opts.timeframe) q.set('timeframe', opts.timeframe);
    if (opts.kind) q.set('kind', opts.kind);
    if (opts.limit != null) q.set('limit', String(opts.limit));
    if (opts.offset != null) q.set('offset', String(opts.offset));
    return fetch(`${BASE}/liquidity-zones/${opts.mode}?${q}`, { signal }).then(j<{ results: LiquidityDetection[]; total: number; rotation: number; updatedAt?: number }>);
  },
  getLiquidityZone(id: string, signal?: AbortSignal): Promise<{ zone: LiquidityDetection; screenshotAt: string; screenshotAfter: string }> {
    return fetch(`${BASE}/liquidity-zones/${encodeURIComponent(id)}`, { signal }).then(j<{ zone: LiquidityDetection; screenshotAt: string; screenshotAfter: string }>);
  },
  /** شموع من وكيل الخادم (نفس مصدر المخزن) — يستخدمها عرض v2 بدل الاتصال المباشر ببينانس */
  getKlines(symbol: string, interval: string, limit = 500, signal?: AbortSignal): Promise<Candle[]> {
    return fetch(`${BASE}/klines?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}&limit=${limit}`, { signal }).then(j<Candle[]>);
  },
  /** محرك السيولة v2: حصيلة قياس الظل. عرض فقط — لا يُغذّي أي قرار منشور */
  getLiquidityV2Status(signal?: AbortSignal): Promise<LiquidityV2StatusResponse> {
    return fetch(`${BASE}/liquidity-zones/v2/status`, { signal }).then(j<LiquidityV2StatusResponse>);
  },
  /** محرك السيولة v2: مناطق (رمز، فريم) محسوبة عند الطلب من المخزن نفسه */
  getLiquidityV2Zones(opts: { symbol: string; timeframe: string; cap?: number; state?: string; kind?: string }, signal?: AbortSignal): Promise<LiquidityV2ZonesResponse> {
    const q = new URLSearchParams({ symbol: opts.symbol, timeframe: opts.timeframe });
    if (opts.cap != null) q.set('cap', String(opts.cap));
    if (opts.state) q.set('state', opts.state);
    if (opts.kind) q.set('kind', opts.kind);
    return fetch(`${BASE}/liquidity-zones/v2/zones?${q}`, { signal }).then(j<LiquidityV2ZonesResponse>);
  },
  reviewLiquidityZone(id: string, body: { verdict: 'accept' | 'reject' | 'confirm' | 'clear'; note?: string; correction?: unknown }): Promise<{ ok: boolean; zone: LiquidityDetection; adjustment: LiquidityZoneEngineStatus['adjustment'] }> {
    return fetch(`${BASE}/liquidity-zones/${encodeURIComponent(id)}/review`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    }).then(j<{ ok: boolean; zone: LiquidityDetection; adjustment: LiquidityZoneEngineStatus['adjustment'] }>);
  },
  runLiquidityZones(): Promise<{ ok: boolean; started: boolean }> {
    return fetch(`${BASE}/liquidity-zones/run`, { method: 'POST' }).then(j<{ ok: boolean; started: boolean }>);
  },
  runCustomLiquidityZones(opts: { symbol: string; timeframe: string; fromTs: number; toTs: number }): Promise<{ ok: boolean; symbol: string; timeframe: string; fromTs: number; toTs: number; results: LiquidityDetection[]; candles: Array<[number, number, number, number, number]> }> {
    return fetch(`${BASE}/liquidity-zones/run-custom`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(opts)
    }).then(j<{ ok: boolean; symbol: string; timeframe: string; fromTs: number; toTs: number; results: LiquidityDetection[]; candles: Array<[number, number, number, number, number]> }>);
  },
  getLiquidityTargets(signal?: AbortSignal): Promise<{ targets: string[] }> {
    return fetch(`${BASE}/symbols/targets`, { signal }).then(j<{ targets: string[] }>);
  },
  getMarketRead(symbol: string, timeframes: string, signal?: AbortSignal): Promise<MarketReadResponse> {
    return fetch(`${BASE}/market-read?symbol=${encodeURIComponent(symbol)}&timeframes=${encodeURIComponent(timeframes)}`, { signal }).then(j<MarketReadResponse>);
  }
};

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

export const api = { ...(useSupabase ? sbApi : restApi), ...liveOpportunitiesApi };
