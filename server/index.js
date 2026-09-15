import express from 'express';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import db from './db.js';
import { researchSymbol } from './research.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8787;

const ANALYSIS_FIELDS = [
  'trend_lower', 'tf_lower', 'trend_upper', 'tf_upper',
  'ext_bsl_sweep', 'ext_supply_touch', 'int_bsl_sweep', 'sellers_induced',
  'int_ssl_sweep', 'ssl_price', 'bsl_price', 'bsl_touched', 'ssl_touched',
  'passed_bsl_after_ssl', 'choch_up', 'notes', 'notify_enabled'
];

const BOOL_FIELDS = ['ext_bsl_sweep', 'ext_supply_touch', 'int_bsl_sweep', 'sellers_induced', 'int_ssl_sweep',
  'bsl_touched', 'ssl_touched', 'passed_bsl_after_ssl', 'notify_enabled'];

const toBool = (v) => {
  if (v === null || v === undefined || v === '') return null;
  return !!v;
};

const normalizeAnalysis = (body, { forCreate = false } = {}) => {
  const out = {};
  for (const f of ANALYSIS_FIELDS) {
    const v = body[f];
    if (BOOL_FIELDS.includes(f)) {
      out[f] = toBool(v);
    } else if (['ssl_price', 'bsl_price'].includes(f)) {
      out[f] = v === null || v === undefined || v === '' ? null : Number(v);
      if (Number.isNaN(out[f])) out[f] = null;
    } else {
      out[f] = v === undefined ? null : v;
    }
  }
  if (forCreate) {
    // أعمدة NOT NULL: قيم افتراضية عند الإنشاء
    if (out.bsl_touched === null) out.bsl_touched = false;
    if (out.ssl_touched === null) out.ssl_touched = false;
    if (out.passed_bsl_after_ssl === null) out.passed_bsl_after_ssl = false;
    if (out.notify_enabled === null) out.notify_enabled = true;
    if (out.notes === null || out.notes === undefined) out.notes = '';
  }
  return out;
};

const serializeAnalysis = (a) => ({
  ...a,
  ssl_price: a.ssl_price === null || a.ssl_price === undefined ? null : Number(a.ssl_price),
  bsl_price: a.bsl_price === null || a.bsl_price === undefined ? null : Number(a.bsl_price),
  ext_bsl_sweep: a.ext_bsl_sweep === null ? null : (a.ext_bsl_sweep ? 1 : 0),
  ext_supply_touch: a.ext_supply_touch === null ? null : (a.ext_supply_touch ? 1 : 0),
  int_bsl_sweep: a.int_bsl_sweep === null ? null : (a.int_bsl_sweep ? 1 : 0),
  sellers_induced: a.sellers_induced === null ? null : (a.sellers_induced ? 1 : 0),
  int_ssl_sweep: a.int_ssl_sweep === null ? null : (a.int_ssl_sweep ? 1 : 0),
  bsl_touched: a.bsl_touched ? 1 : 0,
  ssl_touched: a.ssl_touched ? 1 : 0,
  passed_bsl_after_ssl: a.passed_bsl_after_ssl ? 1 : 0,
  notify_enabled: a.notify_enabled ? 1 : 0
});

const serializeFlag = (f) => ({
  ...f,
  halal: f.halal ? 1 : 0,
  barcode: f.barcode ? 1 : 0
});

const serializeBarcodeScan = (row) => ({
  ...row,
  score: Number(row.score ?? 0),
  gap_count: Number(row.gap_count ?? 0),
  big_wick_count: Number(row.big_wick_count ?? 0),
  candles_count: Number(row.candles_count ?? 0),
  threshold: Number(row.threshold ?? 35),
  is_barcode: !!row.is_barcode,
  status: row.status || 'success'
});

const serializeSettings = (s) => ({
  ...s,
  sound_enabled: s.sound_enabled ? 1 : 0
});

const handle = (fn) => (req, res) => {
  fn(req, res).catch(e => {
    console.error('[api]', e.message);
    if (String(e.message).includes('duplicate key') || String(e.message).includes('analyses_symbol_key')) {
      return res.status(409).json({ error: 'symbol already exists' });
    }
    res.status(500).json({ error: e.message });
  });
};

// ---- analyses CRUD ----
app.get('/api/analyses', handle(async (_req, res) => {
  const rows = await db.analyses.list();
  res.json(rows.map(serializeAnalysis));
}));

app.post('/api/analyses', handle(async (req, res) => {
  const { symbol } = req.body;
  if (!symbol) return res.status(400).json({ error: 'symbol required' });
  const a = normalizeAnalysis(req.body, { forCreate: true });
  const now = Date.now();
  const rows = await db.analyses.create({ symbol: symbol.toUpperCase(), ...a, created_at: now, updated_at: now });
  res.json(serializeAnalysis(rows[0]));
}));

app.put('/api/analyses/:id', handle(async (req, res) => {
  const id = Number(req.params.id);
  const existing = (await db.analyses.list()).find(r => r.id === id);
  if (!existing) return res.status(404).json({ error: 'not found' });
  const a = normalizeAnalysis({ ...serializeAnalysis(existing), ...req.body });
  const rows = await db.analyses.update(id, a);
  if (!rows.length) return res.status(404).json({ error: 'not found' });
  res.json(serializeAnalysis(rows[0]));
}));

app.delete('/api/analyses/:id', handle(async (req, res) => {
  await db.analyses.remove(Number(req.params.id));
  res.json({ ok: true });
}));

// ---- فحص الباركود الآلي على شموع الدقيقة ----
const analyzeBarcode = (raw, threshold = 35) => {
  let gapCount = 0;
  let bigWick = 0;
  for (let i = 0; i < raw.length; i += 1) {
    const o = Number(raw[i][1]);
    const h = Number(raw[i][2]);
    const l = Number(raw[i][3]);
    const c = Number(raw[i][4]);
    if (i > 0) {
      const prevC = Number(raw[i - 1][4]);
      if (Math.min(o, c) > prevC * 1.001 || Math.max(o, c) < prevC * 0.999) gapCount += 1;
    }
    const range = h - l;
    const body = Math.abs(c - o);
    if (range > 0 && body / range < 0.2) bigWick += 1;
  }
  const candlesCount = raw.length;
  const score = candlesCount
    ? (gapCount / candlesCount) * 60 + (bigWick / candlesCount) * 40
    : 0;
  return {
    is_barcode: score >= threshold,
    score: Math.round(score),
    gap_count: gapCount,
    big_wick_count: bigWick,
    candles_count: candlesCount,
    threshold,
    reason: score >= threshold
      ? 'تكررت فجوات أو ظلال غير طبيعية في شموع الدقيقة'
      : 'شموع الدقيقة ضمن النمط الطبيعي وفق معيار الفحص الحالي'
  };
};

const scanBarcode = async (symbol) => {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const raw = await db.binance.klines(symbol, '1m', 100);
      if (!Array.isArray(raw) || raw.length < 20) throw new Error('بيانات شموع غير كافية');
      return analyzeBarcode(raw);
    } catch (e) {
      lastError = e;
      if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)));
    }
  }
  throw lastError ?? new Error('تعذر فحص الباركود');
};

app.get('/api/barcode-scans', handle(async (_req, res) => {
  const rows = await db.barcodeScans.list();
  res.json(rows.map(serializeBarcodeScan));
}));

app.get('/api/barcode-scans/:symbol', handle(async (req, res) => {
  const rows = await db.barcodeScans.get(req.params.symbol.toUpperCase());
  res.json(rows[0] ? serializeBarcodeScan(rows[0]) : null);
}));

app.post('/api/barcode-scans/:symbol/scan', handle(async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  let row;
  try {
    const result = await scanBarcode(symbol);
    row = {
      symbol,
      ...result,
      status: 'success',
      source: 'Binance REST klines 1m',
      scanned_at: Date.now()
    };
  } catch (error) {
    row = {
      symbol,
      is_barcode: false,
      score: 0,
      gap_count: 0,
      big_wick_count: 0,
      candles_count: 0,
      threshold: 35,
      reason: `تعذر جلب شموع الدقيقة: ${error.message}`,
      status: 'failed',
      source: 'Binance REST klines 1m',
      scanned_at: Date.now()
    };
  }
  const rows = await db.barcodeScans.upsert(row);
  res.json(serializeBarcodeScan(rows[0]));
}));

// ---- coin shariah (التصنيف الشرعي) ----
app.get('/api/shariah', handle(async (_req, res) => {
  const rows = await db.coinShariah.list();
  res.json(rows.map(r => ({
    ...r,
    facts: typeof r.facts === 'string' ? JSON.parse(r.facts || '{}') : (r.facts || {}),
    reasons: typeof r.reasons === 'string' ? JSON.parse(r.reasons || '[]') : (r.reasons || []),
    evidence: typeof r.evidence === 'string' ? JSON.parse(r.evidence || '[]') : (r.evidence || [])
  })));
}));

app.put('/api/shariah/:symbol', handle(async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  const body = {
    verdict: req.body.verdict || 'uncertain',
    facts: req.body.facts !== undefined ? (typeof req.body.facts === 'string' ? req.body.facts : JSON.stringify(req.body.facts)) : '{}',
    reasons: req.body.reasons !== undefined ? (typeof req.body.reasons === 'string' ? req.body.reasons : JSON.stringify(req.body.reasons)) : '[]',
    evidence: req.body.evidence !== undefined ? (typeof req.body.evidence === 'string' ? req.body.evidence : JSON.stringify(req.body.evidence)) : '[]',
    source: req.body.source || null,
    notes: req.body.notes || null,
    updated_at: Date.now()
  };
  const rows = await db.coinShariah.upsert({ symbol, ...body });
  res.json(rows[0]);
}));

app.delete('/api/shariah/:symbol', handle(async (req, res) => {
  await db.coinShariah.remove(req.params.symbol.toUpperCase());
  res.json({ ok: true });
}));

// ---- البحث الآلي عن المشاريع (توثيق من مصادر الإنترنت — حتمي بلا تخمين) ----
const AUTO_SOURCE = 'بحث آلي: CoinGecko';

const persistAutoFacts = async (symbol, research) => {
  const gated = research.gated ?? {};
  const hasAny = Object.values(gated).some(v => v !== null);
  const meta = JSON.stringify({
    confidence: research.confidence,
    sources: research.sources,
    checked_at: Date.now(),
    gecko_id: research.geckoId,
    coin_name: research.coinName,
    message: research.message
  });
  const existing = await db.coinShariah.list();
  const prev = existing.find(r => r.symbol === symbol);
  const row = {
    symbol,
    verdict: hasAny ? 'uncertain' : (prev?.verdict || 'uncertain'),
    facts: JSON.stringify(hasAny ? gated : (prev ? JSON.parse(prev.facts || '{}') : {})),
    reasons: JSON.stringify([hasAny
      ? 'حقائق موثقة آلياً من المصادر — يقيّمها محرك القواعد الحتمي في الواجهة'
      : (research.status === 'not_found'
        ? 'العملة غير موجودة في CoinGecko ولا CoinMarketCap — لا يتوفر بحث آلي لها، والتوثيق اليدوي متاح'
        : 'لا توجد بيانات كافية بثقة مقبولة — تبقى للتحقق وإعادة البحث دورياً')]),
    evidence: '[]',
    source: hasAny
      ? `${AUTO_SOURCE} — ${research.geckoId}`
      : (research.status === 'not_found'
        ? 'بحث آلي: غير موجودة في CoinGecko ولا CoinMarketCap'
        : `${AUTO_SOURCE} (بلا نتيجة كافية)`),
    notes: meta,
    updated_at: Date.now()
  };
  const saved = await db.coinShariah.upsert(row);
  /* سجل تغيير الحكم: عند إعادة بحث صف آلي سابق تختلف نتيجته المحسوبة عن سابقه */
  return { saved: saved[0], previous: prev, hasAny };
};

app.post('/api/shariah-research/changes', handle(async (req, res) => {
  const symbol = String(req.body?.symbol || '').toUpperCase();
  if (!symbol) return res.status(400).json({ error: 'symbol مطلوب' });
  await db.events.create({
    symbol,
    type: 'shariah_auto_change',
    message: String(req.body?.message || ''),
    meta: req.body?.meta ? JSON.stringify(req.body.meta) : null,
    ts: Date.now()
  });
  res.json({ ok: true });
}));

app.post('/api/shariah-research/:symbol', handle(async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  const base = symbol.replace(/USDT$|USDC$|FDUSD$|BTC$|ETH$/, '');
  const research = await researchSymbol(base);
  await persistAutoFacts(symbol, research);
  broadcast({ type: 'shariah_researched', symbol, status: research.status });
  res.json(research);
}));

const lastResearchRunAt = { value: 0 };

app.get('/api/shariah-research/status', handle(async (_req, res) => {
  const [rows, symbolsRows] = await Promise.all([db.coinShariah.list(), db.symbols.list('USDT')]);
  const documented = new Set(rows.map(r => r.symbol));
  const pending = symbolsRows.filter(s => !documented.has(s.symbol));
  const autoRows = rows.filter(r => (r.source || '').startsWith(AUTO_SOURCE));
  const notFound = autoRows.filter(r => (r.source || '').includes('غير موجودة في'));
  const insufficient = autoRows.filter(r => (r.source || '').includes('بلا نتيجة كافية'));
  const events = await db.events.list({ limit: 2000 });
  const changes = events.filter(e => e.type === 'shariah_auto_change').slice(0, 12);
  res.json({
    pending: pending.length,
    documented: rows.length - insufficient.length - notFound.length,
    autoDocumented: autoRows.length - insufficient.length - notFound.length,
    insufficient: insufficient.length,
    notFound: notFound.length,
    lastRunAt: lastResearchRunAt.value,
    changes: changes.map(e => ({
      symbol: e.symbol,
      message: e.message,
      meta: e.meta ? JSON.parse(e.meta) : null,
      ts: e.ts
    }))
  });
}));

// ---- المهمة الدورية: توثيق كل الأزواج غير الموثقة بالتدريج + إعادة بحث العملات غير الكافية ----
const periodicResearch = async () => {
  try {
    const [rows, symbolsRows] = await Promise.all([db.coinShariah.list(), db.symbols.list('USDT')]);
    const documented = new Set(rows.map(r => r.symbol));
    const pending = symbolsRows.filter(s => !documented.has(s.symbol));
    // العملات «غير الكافية» (صف موجود بلا حقائق محسومة): تُعاد دورياً — الأقدم فحصاً أولاً فيدور retrial على الجميع
    const insufficient = rows
      .filter(r => (r.source || '').includes('بلا نتيجة كافية'))
      .sort((a, b) => (a.updated_at ?? 0) - (b.updated_at ?? 0))
      .map(r => ({
        symbol: r.symbol,
        base: r.symbol.replace(/USDT$|USDC$|FDUSD$|BTC$|ETH$/, '')
      }));
    const batch = Number(process.env.RESEARCH_BATCH) || 50;
    // الجديد أولاً (أولوية التوثيق الأول) ثم يكمل الباقي من غير الكافية
    const targets = [
      ...pending.map(s => ({ symbol: s.symbol, base: s.base || s.symbol })),
      ...insufficient
    ].slice(0, batch);
    let done = 0;
    for (const t of targets) {
      const research = await researchSymbol(t.base);
      await persistAutoFacts(t.symbol, research);
      if (research.status === 'documented') done += 1;
      broadcast({ type: 'shariah_researched', symbol: t.symbol, status: research.status });
    }
    lastResearchRunAt.value = Date.now();
    console.log(`[research] batch: ${done} documented of ${targets.length} targets (pending: ${pending.length}, insufficient: ${insufficient.length})`);
  } catch (e) {
    console.error('[research] periodic run failed:', e.message);
  }
};

// ---- settings ----
const ensureSettings = async () => {
  let rows = await db.settings.get();
  if (!rows.length) {
    rows = await db.settings.create({ id: 1, quote: 'USDT', notify_timeout_min: 30, sound_enabled: true, sort_config: '{}' });
  }
  return rows[0];
};

app.get('/api/settings', handle(async (_req, res) => {
  res.json(serializeSettings(await ensureSettings()));
}));

app.put('/api/settings', handle(async (req, res) => {
  await ensureSettings();
  const cur = (await db.settings.get())[0];
  const data = {
    quote: req.body.quote || cur.quote,
    notify_timeout_min: req.body.notify_timeout_min !== undefined ? Number(req.body.notify_timeout_min) : cur.notify_timeout_min,
    sound_enabled: req.body.sound_enabled === undefined ? cur.sound_enabled : !!req.body.sound_enabled,
    sort_config: req.body.sort_config !== undefined ? (typeof req.body.sort_config === 'string' ? req.body.sort_config : JSON.stringify(req.body.sort_config)) : cur.sort_config
  };
  const rows = await db.settings.update(data);
  res.json(serializeSettings(rows[0]));
}));

// ---- events ----
app.get('/api/events', handle(async (req, res) => {
  const rows = await db.events.list(req.query);
  res.json(rows);
}));

app.post('/api/events', handle(async (req, res) => {
  const { symbol, type, message, meta } = req.body;
  if (!symbol || !type || !message) return res.status(400).json({ error: 'symbol, type, message required' });
  const rows = await db.events.create({
    symbol: symbol.toUpperCase(), type, message,
    meta: meta ? JSON.stringify(meta) : null,
    ts: Date.now()
  });
  res.json(rows[0]);
}));

// ---- symbols (قائمة أزواج السبوت المخزنة مسبقاً) ----
const CHUNK = 500;

const syncSymbols = async () => {
  const info = await db.binance.exchangeInfo();
  const now = Date.now();
  const rows = info.symbols
    .filter(s => s.status === 'TRADING' && s.isSpotTradingAllowed)
    .map(s => {
      const pf = s.filters.find(f => f.filterType === 'PRICE_FILTER');
      return {
        symbol: s.symbol,
        base: s.baseAsset,
        quote: s.quoteAsset,
        tick_size: pf?.tickSize ? parseFloat(pf.tickSize) : 0.01,
        status: s.status,
        updated_at: now
      };
    });
  let saved = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    await db.symbols.upsertChunk(rows.slice(i, i + CHUNK));
    saved += Math.min(CHUNK, rows.length - i);
  }
  return { total: rows.length, saved };
};

const isStale = async () => {
  const last = await db.symbols.lastUpdated();
  return Date.now() - last > 24 * 60 * 60 * 1000;
};

app.get('/api/symbols', handle(async (req, res) => {
  const quote = req.query.quote || 'USDT';
  const rows = await db.symbols.list(quote);
  res.json(rows);
}));

app.get('/api/symbols/meta', handle(async (_req, res) => {
  const lastUpdated = await db.symbols.lastUpdated();
  res.json({ last_updated: lastUpdated, stale: await isStale() });
}));

app.post('/api/symbols/sync', handle(async (_req, res) => {
  const r = await syncSymbolsDiff();
  if (r.changed > 0) {
    broadcast({ type: 'symbols_updated', total: r.total, changed: r.changed, new_bases: r.newBases });
  }
  res.json({ total: r.total, changed: r.changed, new_bases: r.newBases.length });
}));

// ---- وكيل شموع بينانس (REST) ----
app.get('/api/klines', handle(async (req, res) => {
  const { symbol, interval, limit, startTime, endTime } = req.query;
  if (!symbol || !interval) return res.status(400).json({ error: 'symbol and interval required' });
  const raw = await db.binance.klines(
    symbol,
    interval,
    Math.min(Number(limit) || 200, 1000),
    startTime ? Number(startTime) : undefined,
    endTime ? Number(endTime) : undefined
  );
  const candles = raw.map(k => ({
    time: Math.floor(Number(k[0]) / 1000),
    open: parseFloat(String(k[1])),
    high: parseFloat(String(k[2])),
    low: parseFloat(String(k[3])),
    close: parseFloat(String(k[4]))
  }));
  res.json(candles);
}));

// في الإنتاج: خدمة الواجهة المبنية (client/dist) من نفس العملية
const distDir = path.join(__dirname, '..', 'client', 'dist');
app.use(express.static(distDir));
app.use((req, res, next) => {
  if (req.method === 'GET' && !req.path.startsWith('/api')) {
    res.sendFile('index.html', { root: distDir });
  } else {
    next();
  }
});

// ---- خادم WebSocket لبث تحديثات قائمة الأزواج لحظياً ----
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

const wsClients = new Set();
const broadcast = (obj) => {
  const payload = JSON.stringify(obj);
  for (const ws of wsClients) {
    if (ws.readyState === 1 /* OPEN */) {
      try { ws.send(payload); } catch { /* تجاهل العميل المفقود */ }
    }
  }
};

wss.on('connection', (ws) => {
  wsClients.add(ws);
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  // ترحيب بالميتا الحالية
  void (async () => {
    try {
      const lastUpdated = await db.symbols.lastUpdated();
      ws.send(JSON.stringify({ type: 'hello', last_updated: lastUpdated }));
    } catch { /* ignore */ }
  })();
  ws.on('close', () => wsClients.delete(ws));
  ws.on('error', () => wsClients.delete(ws));
});

// heartbeat: تنظيف الاتصالات الميتة كل 30 ثانية
setInterval(() => {
  for (const ws of wsClients) {
    if (ws.isAlive === false) { try { ws.terminate(); } catch { /* ignore */ } wsClients.delete(ws); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch { /* ignore */ }
  }
}, 30000);

server.listen(PORT, () => console.log(`[server] listening on http://localhost:${PORT} (+ ws:/ws)`));

// ---- مزامنة دورية بالفرق + بث التغييرات لحظياً ----
const SYNC_MS = (Number(process.env.SYMBOLS_SYNC_MIN) || 30) * 60 * 1000;

const buildRowsFromInfo = (info) => {
  const now = Date.now();
  return info.symbols
    .filter(s => s.status === 'TRADING' && s.isSpotTradingAllowed)
    .map(s => {
      const pf = s.filters.find(f => f.filterType === 'PRICE_FILTER');
      return {
        symbol: s.symbol,
        base: s.baseAsset,
        quote: s.quoteAsset,
        tick_size: pf?.tickSize ? parseFloat(pf.tickSize) : 0.01,
        status: s.status,
        updated_at: now
      };
    });
};

/** مزامنة بالفرق: تحفظ الجديد/المتغير فقط وتُرجع تفاصيل الأزواج الجديدة */
const syncSymbolsDiff = async () => {
  const info = await db.binance.exchangeInfo();
  const fresh = buildRowsFromInfo(info);
  const existing = await db.symbols.list(); // كل الاقتباسات (حد 5000 يغطي القائمة كاملة)
  const existingMap = new Map(existing.map(r => [r.symbol, r]));
  const toSave = fresh.filter(r => {
    const old = existingMap.get(r.symbol);
    return !old || old.tick_size !== r.tick_size || old.status !== r.status;
  });
  const knownBases = new Set(existing.map(r => r.base));
  const newBases = [...new Set(fresh.filter(r => !knownBases.has(r.base)).map(r => r.base))];

  for (let i = 0; i < toSave.length; i += CHUNK) {
    await db.symbols.upsertChunk(toSave.slice(i, i + CHUNK));
  }
  return { total: fresh.length, changed: toSave.length, newBases };
};

const periodicSync = async () => {
  try {
    const r = await syncSymbolsDiff();
    if (r.changed > 0) {
      console.log(`[symbols] periodic sync: ${r.changed} changed of ${r.total}, new bases: ${r.newBases.join(', ') || 'none'}`);
      broadcast({ type: 'symbols_updated', total: r.total, changed: r.changed, new_bases: r.newBases });
    }
  } catch (e) {
    console.error('[symbols] periodic sync failed:', e.message);
  }
};

const periodicBarcodeScan = async () => {
  try {
    const analyses = await db.analyses.list();
    for (const analysis of analyses) {
      try {
        const result = await scanBarcode(analysis.symbol);
        await db.barcodeScans.upsert({
          symbol: analysis.symbol,
          ...result,
          status: 'success',
          source: 'scheduled Binance REST klines 1m',
          scanned_at: Date.now()
        });
      } catch (error) {
        await db.barcodeScans.upsert({
          symbol: analysis.symbol,
          is_barcode: false,
          score: 0,
          gap_count: 0,
          big_wick_count: 0,
          candles_count: 0,
          threshold: 35,
          reason: `تعذر جلب شموع الدقيقة: ${error.message}`,
          status: 'failed',
          source: 'scheduled Binance REST klines 1m',
          scanned_at: Date.now()
        });
      }
    }
  } catch (e) {
    console.error('[barcode] periodic scan failed:', e.message);
  }
};

setInterval(periodicSync, SYNC_MS);
setInterval(periodicBarcodeScan, (Number(process.env.BARCODE_SCAN_HOURS) || 6) * 60 * 60 * 1000);
setInterval(periodicResearch, (Number(process.env.RESEARCH_HOURS) || 4) * 60 * 60 * 1000);
setTimeout(() => void periodicResearch(), 90_000);

// مزامنة تلقائية عند البدء إذا كانت فارغة أو متقادمة + بث فوري لأي جديد
void (async () => {
  try {
    if (await isStale()) {
      console.log('[symbols] syncing (empty or stale >24h)…');
      const r = await syncSymbolsDiff();
      console.log(`[symbols] startup sync: ${r.changed} changed of ${r.total}, new bases: ${r.newBases.join(', ') || 'none'}`);
      if (r.changed > 0) {
        broadcast({ type: 'symbols_updated', total: r.total, changed: r.changed, new_bases: r.newBases });
      }
    }
  } catch (e) {
    console.error('[symbols] startup sync failed:', e.message);
  }
})();
