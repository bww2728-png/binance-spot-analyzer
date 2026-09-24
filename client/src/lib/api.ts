import { createClient } from '@supabase/supabase-js';
import type { Analysis, AutoHistoryResponse, AutoZoneScreenshot, BarcodeScan, CaseActor, CaseImage, CaseRow, CoinShariahRow, EventLog, LiquidityZone, Settings, ShariahResearch, ShariahResearchStatus, ZoneHistoryGroup, ZonesAccuracy, BacktestStatus, BacktestResults, LiveOpportunitiesResponse, LiquidityDetection, LiquidityZoneEngineStatus, BuyFeed, BuyStatus, BuyOpportunity } from './types';

/**
 * خلفية البيانات موحدة عبر REST API (نفس-الأصل) دائماً.
 * - محلياً (localhost): يخدمها خادم Express على 8787.
 * - سحابياً (Railway/etc.): يخدمها نفس خادم Express الذي يوجّه إلى Supabase عبر server/db.js.
 * (وراء وكيل BaaS ذو أصل مشترك يمكن تفعيل مسار Supabase SDK لاحقاً عبر VITE_ إن لزم.)
 */
const envUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const envKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined;

export const supabase = createClient(
  envUrl || window.location.origin,
  envKey || 'verdent-baas-proxy'
);
// Force REST path: works on both localhost (dev) and any deployed origin (Railway/Vercel/etc.)
// The Express server talks to Supabase via server/db.js (baked defaults).
// Using the Supabase SDK directly from the client only works behind a same-origin BaaS proxy (e.g. Verdent Publish).
const useSupabase = false;

const SB = {
  analyses: 'analyses' as const,
  coin_shariah: 'coin_shariah' as const,
  settings: 'settings' as const,
  events_log: 'events_log' as const,
  cases: 'cases' as const,
  case_images: 'case_images' as const
};

// حقول boolean في Postgres تُمثَّل 0/1 في الواجهة، وnumeric يعود كنص
const BOOL_FIELDS = [
  'ext_bsl_sweep', 'ext_supply_touch', 'int_bsl_sweep', 'sellers_induced',
  'int_ssl_sweep', 'bsl_touched', 'ssl_touched', 'passed_bsl_after_ssl', 'notify_enabled'
] as const;
const NUM_FIELDS = ['ssl_price', 'bsl_price'] as const;

type AnyRow = Record<string, unknown>;

const toDb = (body: AnyRow): AnyRow => {
  const out: AnyRow = { ...body };
  for (const f of BOOL_FIELDS) if (f in out) out[f] = out[f] === null ? null : !!out[f];
  return out;
};

const fromDb = <T,>(row: AnyRow): T => {
  const out: AnyRow = { ...row };
  for (const f of BOOL_FIELDS) if (f in out) out[f] = out[f] === null ? null : (out[f] ? 1 : 0);
  for (const f of NUM_FIELDS) if (f in out) out[f] = out[f] === null ? null : Number(out[f]);
  return out as T;
};

const pgErr = (e: { message?: string } | null): Error => new Error(e?.message ?? 'Supabase error');

// ---------- Supabase adapter ----------
const sbApi = {
  async getAnalyses(): Promise<Analysis[]> {
    const { data, error } = await supabase.from(SB.analyses).select('*').order('id', { ascending: false });
    if (error) throw pgErr(error);
    return (data as AnyRow[]).map(r => fromDb<Analysis>(r));
  },
  async createAnalysis(body: Partial<Analysis> & { symbol: string }): Promise<Analysis> {
    const now = Date.now();
    const row = { ...body, created_at: now, updated_at: now };
    const { data, error } = await supabase.from(SB.analyses).insert(toDb(row as AnyRow)).select().single();
    if (error) throw pgErr(error);
    return fromDb<Analysis>(data as AnyRow);
  },
  async updateAnalysis(id: number, body: Partial<Analysis>): Promise<Analysis> {
    const patch = { ...body, updated_at: Date.now() };
    const { data, error } = await supabase.from(SB.analyses).update(toDb(patch as AnyRow)).eq('id', id).select().single();
    if (error) throw pgErr(error);
    return fromDb<Analysis>(data as AnyRow);
  },
  async deleteAnalysis(id: number): Promise<{ ok: boolean }> {
    const { error } = await supabase.from(SB.analyses).delete().eq('id', id);
    if (error) throw pgErr(error);
    return { ok: true };
  },
  async getBarcodeScans(): Promise<BarcodeScan[]> {
    const res = await fetch(`${BASE}/barcode-scans`);
    return j<BarcodeScan[]>(res);
  },
  async scanBarcode(symbol: string): Promise<BarcodeScan> {
    const res = await fetch(`${BASE}/barcode-scans/${encodeURIComponent(symbol)}/scan`, { method: 'POST' });
    return j<BarcodeScan>(res);
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
  async getEvents(opts: { symbol?: string; from?: number; limit?: number; type?: string; offset?: number } = {}): Promise<EventLog[]> {
    let q = supabase.from(SB.events_log).select('*').order('ts', { ascending: false })
      .limit(Math.min(opts.limit ?? 500, 2000));
    if (opts.symbol) q = q.eq('symbol', opts.symbol.toUpperCase());
    if (opts.type) q = q.eq('type', opts.type);
    if (opts.from) q = q.gte('ts', opts.from);
    if (opts.offset) q = q.range(opts.offset, opts.offset + (opts.limit ?? 500) - 1);
    const { data, error } = await q;
    if (error) throw pgErr(error);
    return data as EventLog[];
  },
  async postEvent(symbol: string, type: string, message: string, meta?: unknown): Promise<EventLog> {
    const { data, error } = await supabase.from(SB.events_log)
      .insert({ ts: Date.now(), symbol: symbol.toUpperCase(), type, message, meta: meta ? JSON.stringify(meta) : null })
      .select().single();
    if (error) throw pgErr(error);
    return data as EventLog;
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
  async getCases(symbol?: string): Promise<CaseRow[]> {
    return fetch(`${BASE}/cases${symbol ? '?symbol=' + encodeURIComponent(symbol) : ''}`).then(j<CaseRow[]>);
  },
  async createCase(body: { symbol: string; actor: CaseActor; decided_at: number; snapshot: unknown }): Promise<{ ok: boolean; id: number | null }> {
    return fetch(`${BASE}/cases`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(j<{ ok: boolean; id: number | null }>);
  },
  async getCase(id: number): Promise<CaseRow & { images: CaseImage[] }> {
    const { data, error } = await supabase.from(SB.cases).select('*').eq('id', id).single();
    if (error || !data) throw pgErr(error ?? { message: 'القرار غير موجود' });
    const { data: imgs, error: err2 } = await supabase.from(SB.case_images).select('*').eq('case_id', id).order('captured_at', { ascending: true });
    if (err2) throw pgErr(err2);
    return {
      ...(data as AnyRow),
      payload: JSON.parse(String((data as AnyRow).payload ?? '{}')),
      images: (imgs ?? []) as CaseImage[]
    } as CaseRow & { images: CaseImage[] };
  },
  async getZonesHistory(opts: { symbol?: string; limit?: number; offset?: number } = {}): Promise<{ events: EventLog[]; groups: ZoneHistoryGroup[]; total: number; limit: number; offset: number }> {
    let q = supabase.from(SB.events_log).select('*').eq('type', 'liquidity_zone')
      .order('ts', { ascending: true }).limit(Math.min(opts.limit ?? 2000, 5000));
    if (opts.symbol) q = q.eq('symbol', opts.symbol.toUpperCase());
    if (opts.offset) q = q.range(opts.offset, opts.offset + Math.min(opts.limit ?? 2000, 5000) - 1);
    const { data, error } = await q;
    if (error) throw pgErr(error);
    const events = data as EventLog[];
    const { groupZoneHistory } = await import('./zonesHistory');
    return { events, groups: groupZoneHistory(events), total: events.length, limit: opts.limit ?? 2000, offset: opts.offset ?? 0 };
  },
  // السجل التاريخي للتحديد الآلي — يمر عبر الخادم دائماً (التفكيك والفلاتر منطق خادم)
  getAutoHistory(opts: { symbol?: string; timeframe?: string; type?: 'BSL' | 'SSL'; minScore?: number; from?: number; to?: number; fabioOnly?: boolean; limit?: number; offset?: number } = {}, signal?: AbortSignal): Promise<AutoHistoryResponse> {
    const q = new URLSearchParams();
    if (opts.symbol) q.set('symbol', opts.symbol);
    if (opts.timeframe) q.set('timeframe', opts.timeframe);
    if (opts.type) q.set('type', opts.type);
    if (opts.minScore != null) q.set('minScore', String(opts.minScore));
    if (opts.from != null) q.set('from', String(opts.from));
    if (opts.to != null) q.set('to', String(opts.to));
    if (opts.fabioOnly === false) q.set('fabioOnly', 'false');
    if (opts.limit != null) q.set('limit', String(opts.limit));
    if (opts.offset != null) q.set('offset', String(opts.offset));
    return fetch(`${BASE}/auto-history?${q}`, { signal }).then(j<AutoHistoryResponse>);
  },
  getAutoScreenshots(opts: { symbol?: string; from?: number } = {}, signal?: AbortSignal): Promise<{ screenshots: AutoZoneScreenshot[] }> {
    const q = new URLSearchParams();
    if (opts.symbol) q.set('symbol', opts.symbol);
    if (opts.from != null) q.set('from', String(opts.from));
    return fetch(`${BASE}/auto-history/screenshots?${q}`, { signal }).then(j<{ screenshots: AutoZoneScreenshot[] }>);
  },
  postAutoScreenshots(shots: AutoZoneScreenshot[]): Promise<{ ok: boolean; saved: number }> {
    return fetch(`${BASE}/auto-history/screenshots`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shots })
    }).then(j<{ ok: boolean; saved: number }>);
  },
  // ==================== الباك تيست (sb — نفس REST) ====================
  getBacktestStatus(signal?: AbortSignal): Promise<BacktestStatus> {
    return fetch(`${BASE}/backtest/status`, { signal }).then(j<BacktestStatus>);
  },
  getBacktestResults(opts: { coin?: string; timeframe?: string } = {}, signal?: AbortSignal): Promise<BacktestResults> {
    const q = new URLSearchParams();
    if (opts.coin) q.set('coin', opts.coin);
    if (opts.timeframe) q.set('timeframe', opts.timeframe);
    return fetch(`${BASE}/backtest/results?${q}`, { signal }).then(j<BacktestResults>);
  },
  runBacktest(): Promise<{ ok: boolean; started: boolean }> {
    return fetch(`${BASE}/backtest/run`, { method: 'POST' }).then(j<{ ok: boolean; started: boolean }>);
  },
  runCustomBacktest(opts: { symbol: string; timeframe: string; fromTs?: number; toTs?: number }): Promise<{ ok: boolean; started: boolean; symbol: string; timeframe: string }> {
    return fetch(`${BASE}/backtest/run-custom`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(opts)
    }).then(j<{ ok: boolean; started: boolean; symbol: string; timeframe: string }>);
  },
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
  getAnalyses: () => fetch(`${BASE}/analyses`).then(j<Analysis[]>),
  createAnalysis: (body: Partial<Analysis> & { symbol: string }) =>
    fetch(`${BASE}/analyses`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(j<Analysis>),
  updateAnalysis: (id: number, body: Partial<Analysis>) =>
    fetch(`${BASE}/analyses/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(j<Analysis>),
  deleteAnalysis: (id: number) =>
    fetch(`${BASE}/analyses/${id}`, { method: 'DELETE' }).then(j<{ ok: boolean }>),
  getBarcodeScans: () => fetch(`${BASE}/barcode-scans`).then(j<BarcodeScan[]>),
  scanBarcode: (symbol: string) =>
    fetch(`${BASE}/barcode-scans/${encodeURIComponent(symbol)}/scan`, { method: 'POST' }).then(j<BarcodeScan>),
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
  getEvents: (opts: { symbol?: string; from?: number; limit?: number; type?: string; offset?: number } = {}) => {
    const q = new URLSearchParams();
    if (opts.symbol) q.set('symbol', opts.symbol);
    if (opts.from) q.set('from', String(opts.from));
    if (opts.limit) q.set('limit', String(opts.limit));
    if (opts.type) q.set('type', opts.type);
    if (opts.offset) q.set('offset', String(opts.offset));
    return fetch(`${BASE}/events?${q}`).then(j<EventLog[]>);
  },
  postEvent: (symbol: string, type: string, message: string, meta?: unknown) =>
    fetch(`${BASE}/events`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ symbol, type, message, meta }) }).then(j<EventLog>),
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
  getCases: (symbol?: string) =>
    fetch(`${BASE}/cases${symbol ? '?symbol=' + encodeURIComponent(symbol) : ''}`).then(j<CaseRow[]>),
  createCase: (body: { symbol: string; actor: CaseActor; decided_at: number; snapshot: unknown }) =>
    fetch(`${BASE}/cases`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(j<{ ok: boolean; id: number | null }>),
  getCase: (id: number) =>
    fetch(`${BASE}/cases/${id}`).then(j<CaseRow & { images: CaseImage[] }>),
  getZonesHistory: (opts: { symbol?: string; limit?: number; offset?: number } = {}) => {
    const q = new URLSearchParams();
    if (opts.symbol) q.set('symbol', opts.symbol);
    if (opts.limit) q.set('limit', String(opts.limit));
    if (opts.offset) q.set('offset', String(opts.offset));
    return fetch(`${BASE}/zones/history?${q}`).then(j<{ events: EventLog[]; groups: ZoneHistoryGroup[]; total: number; limit: number; offset: number }>);
  },
  // السجل التاريخي للتحديد الآلي — التفكيك والفلاتر منطق خادم
  getAutoHistory: (opts: { symbol?: string; timeframe?: string; type?: 'BSL' | 'SSL'; minScore?: number; from?: number; to?: number; fabioOnly?: boolean; limit?: number; offset?: number } = {}, signal?: AbortSignal) => {
    const q = new URLSearchParams();
    if (opts.symbol) q.set('symbol', opts.symbol);
    if (opts.timeframe) q.set('timeframe', opts.timeframe);
    if (opts.type) q.set('type', opts.type);
    if (opts.minScore != null) q.set('minScore', String(opts.minScore));
    if (opts.from != null) q.set('from', String(opts.from));
    if (opts.to != null) q.set('to', String(opts.to));
    if (opts.fabioOnly === false) q.set('fabioOnly', 'false');
    if (opts.limit != null) q.set('limit', String(opts.limit));
    if (opts.offset != null) q.set('offset', String(opts.offset));
    return fetch(`${BASE}/auto-history?${q}`, { signal }).then(j<AutoHistoryResponse>);
  },
  getAutoScreenshots: (opts: { symbol?: string; from?: number } = {}, signal?: AbortSignal) => {
    const q = new URLSearchParams();
    if (opts.symbol) q.set('symbol', opts.symbol);
    if (opts.from != null) q.set('from', String(opts.from));
    return fetch(`${BASE}/auto-history/screenshots?${q}`, { signal }).then(j<{ screenshots: AutoZoneScreenshot[] }>);
  },
  postAutoScreenshots: (shots: AutoZoneScreenshot[]) =>
    fetch(`${BASE}/auto-history/screenshots`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shots })
    }).then(j<{ ok: boolean; saved: number }>),

  // ==================== الباك تيست ====================
  getBacktestStatus: (signal?: AbortSignal) =>
    fetch(`${BASE}/backtest/status`, { signal }).then(j<BacktestStatus>),
  getBacktestResults: (opts: { coin?: string; timeframe?: string } = {}, signal?: AbortSignal) => {
    const q = new URLSearchParams();
    if (opts.coin) q.set('coin', opts.coin);
    if (opts.timeframe) q.set('timeframe', opts.timeframe);
    return fetch(`${BASE}/backtest/results?${q}`, { signal }).then(j<BacktestResults>);
  },
  runBacktest: () =>
    fetch(`${BASE}/backtest/run`, { method: 'POST' }).then(j<{ ok: boolean; started: boolean }>),
  runCustomBacktest: (opts: { symbol: string; timeframe: string; fromTs?: number; toTs?: number }) =>
    fetch(`${BASE}/backtest/run-custom`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(opts)
    }).then(j<{ ok: boolean; started: boolean; symbol: string; timeframe: string }>),
  getLiveOpportunities: (signal?: AbortSignal) =>
    fetch(`${BASE}/live/opportunities`, { signal }).then(j<LiveOpportunitiesResponse>),
  getLiquidityTargets: (signal?: AbortSignal) =>
    fetch(`${BASE}/symbols/targets`, { signal }).then(j<{ targets: string[] }>),
  getMarketRead: (symbol: string, timeframes: string, signal?: AbortSignal) =>
    fetch(`${BASE}/market-read?symbol=${encodeURIComponent(symbol)}&timeframes=${encodeURIComponent(timeframes)}`, { signal }).then(j<MarketReadResponse>),
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
  runBuyScan: () =>
    fetch(`${BASE}/live-opportunities/run`, { method: 'POST' }).then(j<{ ok: boolean; started: boolean }>),
  runBuyCalibration: (body?: { symbols?: string[]; timeframes?: string[] }) =>
    fetch(`${BASE}/live-opportunities/calibrate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) }).then(j<{ ok: boolean; started: boolean; symbols: number | null; timeframes: number | null }>),
  buyOpportunityChartUrl: (id: string) => `${BASE}/live-opportunities/${encodeURIComponent(id)}/screenshot`
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
