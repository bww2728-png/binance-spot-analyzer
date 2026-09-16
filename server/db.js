const SUPABASE_URL = process.env.SUPABASE_URL || 'https://supabase-api-prod.verdent.ai/p/pfb660a6a9d32c0417a38';
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJhdWQiOiJhdXRoZW50aWNhdGVkIiwiZXhwIjoyMTA0Njg2NzkxLCJpYXQiOjE3ODkwNjc1OTEsImlzcyI6InN1cGFiYXNlIiwicHJvamVjdF9yZWYiOiJwZmI2NjBhNmE5ZDMyYzA0MTdhMzgiLCJyb2xlIjoiYW5vbiJ9.alrTK9tAI5EqmkVr05n2ClNFwuufhCB5_bEEMAe48l4';

const baseHeaders = {
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  'Content-Type': 'application/json'
};

async function rest(path, { method = 'GET', body, prefer } = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    method,
    headers: { ...baseHeaders, ...(prefer ? { Prefer: prefer } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  if (!res.ok) {
    const text = await res.text();
    const err = new Error(`Supabase REST ${res.status}: ${text}`);
    err.status = res.status;
    throw err;
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

const BINANCE_HOSTS = [
  'https://data-api.binance.vision',
  'https://api1.binance.com',
  'https://api-gcp.binance.com'
];

async function fetchBinanceJson(path, timeoutMs = 30000) {
  let lastErr;
  for (const host of BINANCE_HOSTS) {
    try {
      const res = await fetch(`${host}${path}`, { signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) { lastErr = new Error(`HTTP ${res.status} from ${host}`); continue; }
      return await res.json();
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr ?? new Error('all Binance hosts failed');
}

export default {
  binance: {
    exchangeInfo: () => fetchBinanceJson('/api/v3/exchangeInfo', 30000),
    klines: (symbol, interval, limit, startTime, endTime) => {
      const params = new URLSearchParams({ symbol, interval, limit: String(limit) });
      if (startTime) params.set('startTime', String(startTime));
      if (endTime) params.set('endTime', String(endTime));
      return fetchBinanceJson(`/api/v3/klines?${params.toString()}`, 15000);
    },
    tickerPrices: async (symbols) => {
      const q = encodeURIComponent(JSON.stringify(symbols));
      const rows = await fetchBinanceJson(`/api/v3/ticker/price?symbols=${q}`, 10000);
      const out = {};
      for (const r of rows) out[r.symbol] = Number(r.price);
      return out;
    },
  },
  zones: {
    /** أحدث حالة لكل منطقة (id) — منطقة محفوظة كحدث نوع liquidity_zone في events_log */
    list: async (symbol) => {
      const q = new URLSearchParams({ type: 'eq.liquidity_zone', select: '*', order: 'ts.asc', limit: '2000' });
      if (symbol) q.set('symbol', `eq.${symbol.toUpperCase()}`);
      const events = await rest(`/events_log?${q}`);
      const latest = new Map();
      for (const e of events) {
        try {
          const z = JSON.parse(e.meta || 'null');
          if (z?.id) latest.set(z.id, z);
        } catch { /* تجاهل السجلات التالفة */ }
      }
      return [...latest.values()].filter(z => z.active !== false);
    },
    append: (zone) => rest('/events_log?select=*', {
      method: 'POST',
      body: {
        symbol: String(zone.symbol).toUpperCase(),
        type: 'liquidity_zone',
        message: zone.note || zone.type,
        meta: JSON.stringify(zone),
        ts: Date.now()
      },
      prefer: 'return=representation'
    }),
    /** أحدث معايرة محفوظة (حدث zone_calibration — الأحدث يفوز) */
    getCalibration: async () => {
      const events = await rest('/events_log?type=eq.zone_calibration&select=*&order=ts.desc&limit=1');
      return events.length ? events[0] : null;
    },
    appendCalibration: (cal) => rest('/events_log?select=*', {
      method: 'POST',
      body: {
        symbol: 'GLOBAL',
        type: 'zone_calibration',
        message: `معايرة: حد الدني ${cal.minScore}`,
        meta: JSON.stringify(cal),
        ts: Date.now()
      },
      prefer: 'return=representation'
    })
  },
  symbols: {
    list: (quote) => {
      const q = new URLSearchParams({ select: '*' });
      if (quote) q.set('quote', `eq.${quote}`);
      q.set('order', 'base.asc,symbol.asc');
      q.set('limit', '5000');
      return rest(`/symbols?${q}`);
    },
    lastUpdated: async () => {
      const rows = await rest('/symbols?select=updated_at&order=updated_at.desc&limit=1');
      return rows.length ? rows[0].updated_at : 0;
    },
    upsertChunk: (rows) => rest('/symbols?on_conflict=symbol&select=*', { method: 'POST', body: rows, prefer: 'resolution=merge-duplicates,return=representation' })
  },
  analyses: {
    list: () => rest('/analyses?select=*'),
    create: (row) => rest('/analyses?select=*', { method: 'POST', body: row, prefer: 'return=representation' }),
    update: (id, row) => rest(`/analyses?id=eq.${id}&select=*`, { method: 'PATCH', body: row, prefer: 'return=representation' }),
    remove: (id) => rest(`/analyses?id=eq.${id}`, { method: 'DELETE' })
  },
  coinFlags: {
    list: () => rest('/coin_flags?select=*'),
    upsert: (row) => rest('/coin_flags?on_conflict=symbol&select=*', { method: 'POST', body: row, prefer: 'resolution=merge-duplicates,return=representation' })
  },
  barcodeScans: {
    list: async () => {
      try {
        return await rest('/barcode_scans?select=*&order=scanned_at.desc');
      } catch (error) {
        if (error.status !== 404) throw error;
        const events = await rest('/events_log?type=eq.barcode_scan&select=*&order=ts.desc');
        const latest = new Map();
        for (const event of events) {
          if (latest.has(event.symbol)) continue;
          try {
            latest.set(event.symbol, JSON.parse(event.meta || '{}'));
          } catch { /* ignore malformed compatibility records */ }
        }
        const flags = await rest('/coin_flags?select=*');
        const legacy = flags.map((f) => ({
          symbol: f.symbol,
          is_barcode: !!f.barcode,
          score: 0,
          gap_count: 0,
          big_wick_count: 0,
          candles_count: 0,
          threshold: 35,
          reason: 'نتيجة توافق قديمة — أعد الفحص لتفاصيل أحدث',
          status: 'success',
          source: 'coin_flags compatibility',
          scanned_at: f.updated_at
        }));
        return [...latest.values(), ...legacy.filter(row => !latest.has(row.symbol))];
      }
    },
    get: async (symbol) => {
      try {
        return await rest(`/barcode_scans?symbol=eq.${encodeURIComponent(symbol)}&select=*`);
      } catch (error) {
        if (error.status !== 404) throw error;
        const events = await rest(`/events_log?type=eq.barcode_scan&symbol=eq.${encodeURIComponent(symbol)}&select=*&order=ts.desc&limit=1`);
        if (events[0]?.meta) {
          try { return [JSON.parse(events[0].meta)]; } catch { /* fall through */ }
        }
        const flags = await rest(`/coin_flags?symbol=eq.${encodeURIComponent(symbol)}&select=*`);
        return flags.map((f) => ({
          symbol: f.symbol,
          is_barcode: !!f.barcode,
          score: 0,
          gap_count: 0,
          big_wick_count: 0,
          candles_count: 0,
          threshold: 35,
          reason: 'نتيجة توافق قديمة — أعد الفحص لتفاصيل أحدث',
          status: 'success',
          source: 'coin_flags compatibility',
          scanned_at: f.updated_at
        }));
      }
    },
    upsert: async (row) => {
      try {
        return await rest('/barcode_scans?on_conflict=symbol&select=*', {
          method: 'POST',
          body: row,
          prefer: 'resolution=merge-duplicates,return=representation'
        });
      } catch (error) {
        if (error.status !== 404) throw error;
        const compat = { ...row, scanned_at: row.scanned_at };
        return rest('/events_log?select=*', {
          method: 'POST',
          body: {
            symbol: row.symbol,
            type: 'barcode_scan',
            message: row.reason,
            meta: JSON.stringify(compat),
            ts: row.scanned_at
          },
          prefer: 'return=representation'
        }).then(() => [row]);
      }
    }
  },
  coinShariah: {
    list: () => rest('/coin_shariah?select=*'),
    upsert: (row) => rest('/coin_shariah?on_conflict=symbol&select=*', { method: 'POST', body: row, prefer: 'resolution=merge-duplicates,return=representation' }),
    remove: (symbol) => rest(`/coin_shariah?symbol=eq.${encodeURIComponent(symbol)}`, { method: 'DELETE' })
  },
  settings: {
    get: () => rest('/settings?select=*&id=eq.1'),
    create: (row) => rest('/settings?select=*', { method: 'POST', body: row, prefer: 'return=representation' }),
    update: (row) => rest('/settings?id=eq.1&select=*', { method: 'PATCH', body: row, prefer: 'return=representation' })
  },
  events: {
    list: ({ symbol, from, limit }) => {
      const q = new URLSearchParams({ select: '*' });
      if (symbol) q.set('symbol', `eq.${symbol.toUpperCase()}`);
      if (from) q.set('ts', `gte.${Number(from)}`);
      q.set('order', 'ts.desc,id.desc');
      q.set('limit', String(Math.min(Number(limit) || 500, 2000)));
      return rest(`/events_log?${q}`);
    },
    create: (row) => rest('/events_log?select=*', { method: 'POST', body: row, prefer: 'return=representation' })
  }
};
