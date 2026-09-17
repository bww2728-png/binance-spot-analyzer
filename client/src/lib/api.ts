import { createClient } from '@supabase/supabase-js';
import type { Analysis, BarcodeScan, CoinShariahRow, EventLog, LiquidityZone, Settings, ShariahResearch, ShariahResearchStatus, ZonesAccuracy } from './types';

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
  events_log: 'events_log' as const
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
  async getEvents(opts: { symbol?: string; from?: number; limit?: number } = {}): Promise<EventLog[]> {
    let q = supabase.from(SB.events_log).select('*').order('ts', { ascending: false })
      .limit(Math.min(opts.limit ?? 500, 2000));
    if (opts.symbol) q = q.eq('symbol', opts.symbol.toUpperCase());
    if (opts.from) q = q.gte('ts', opts.from);
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
  getEvents: (opts: { symbol?: string; from?: number; limit?: number } = {}) => {
    const q = new URLSearchParams();
    if (opts.symbol) q.set('symbol', opts.symbol);
    if (opts.from) q.set('from', String(opts.from));
    if (opts.limit) q.set('limit', String(opts.limit));
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
    fetch(`${BASE}/zones/accuracy${symbol ? '?symbol=' + encodeURIComponent(symbol) : ''}`).then(j<ZonesAccuracy>)
};

export const api = useSupabase ? sbApi : restApi;
