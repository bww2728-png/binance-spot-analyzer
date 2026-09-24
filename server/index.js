import express from 'express';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import db from './db.js';
import { researchSymbol } from './research.mjs';
import { detectSymbol, buildSnapshot, ALL_TIMEFRAMES, bookSignals } from './liquidity/engine.mjs';
import { matchZones, adaptCalibration, latestCalibration, DEFAULT_CALIBRATION } from './liquidity/calibrate.mjs';
import { runPairBacktest, learnOnTrades, loadKlinesPaginated } from './backtest/engine.mjs';
import { discoverLiveOpportunities } from './backtest/live.mjs';
import { regimeGate } from './backtest/regime.mjs';
import { buildPlan, checkPlan, kellyF, fractionalKelly, positionUnits } from './backtest/risk.mjs';
import { assembleCase, DECISION_ACTORS } from './cases.mjs';
import { groupZoneHistory } from './archive.mjs';
import {
  normalizeCandles,
  detectLiquidityZones,
  scanHistory,
  feedbackToAdjustment,
  adaptiveConfig
} from './liquidity-zones/engine.mjs';
import { renderZoneChart } from './liquidity-zones/chart.mjs';
import { createLiveOpportunityEngine } from './live-opportunities/loop.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();

// نقطة صحّة لمنصات الاستضافة (Railway/…) — بلا مسار /api
app.get('/healthz', (req, res) => res.json({ ok: true, up: Date.now() }));
// ترتيب Express حرج: هذه الوسائط قبل أي مسار وإلا لا تُنفّذ عليه (المسارات المسجلة أولاً تتجاوز المسجلة لاحقاً)
// ترويسات أمنية أساسية — بدون CSP صارم يكسر CDN، وSAMEORIGIN يحفظ الإطارات الداخلية
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (req.secure || req.headers['x-forwarded-proto'] === 'https') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});
// الحlive API لا يُخزَّن أبداً في المتصفح أو الوسطاء
app.use('/api', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});
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
    } else if (typeof v === 'string') {
      // تنقية النصوص الحرة: إزالة أقواس HTML لمنع أي XSS مخزَّن (React يحمي العرض، وهنا ننظف المصدر)
      out[f] = v.replace(/[<>]/g, '');
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

// التحقق من صيغة الرمز: أحرف كبيرة وأرقام فقط (1-20) — يحجب أي حقن عبر حقل symbol
const SYMBOL_RE = /^[A-Z0-9]{1,20}$/;
const assertSymbol = (raw, res) => {
  const s = String(raw || '').toUpperCase();
  if (!SYMBOL_RE.test(s)) {
    res.status(400).json({ error: 'صيغة الرمز غير صالحة — أحرف كبيرة وأرقام فقط (مثال: BTCUSDT)' });
    return null;
  }
  return s;
};

// تنقية النصوص الحرة المركزية: إزالة أقواس HTML من أي نص مخزَّن (ملاحظات/ملاحظات آلي/ملاحظات يدوي)
const sanitizeText = (raw, max = 500) => String(raw ?? '').replace(/[<>]/g, '').slice(0, max);

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
  const symbol = assertSymbol(req.body?.symbol, res);
  if (!symbol) return;
  const a = normalizeAnalysis(req.body, { forCreate: true });
  const now = Date.now();
  const rows = await db.analyses.create({ symbol, ...a, created_at: now, updated_at: now });
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
  const symbol = assertSymbol(req.params.symbol, res);
  if (!symbol) return;
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
  res.json({ ...research, cmcConfigured: Boolean(process.env.CMC_API_KEY) });
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

// ---- مناطق السيولة: CRUD + بث + مراقبة الاقتراب والسحب ----
// كاش 5 ثوانٍ: يمتص انفجارات النداءات عند كل جولة كشف (WS يطلق العدادات لكل عملة)
const zonesCache = { data: null, ts: 0 };
async function zonesCached() {
  const now = Date.now();
  if (zonesCache.data && now - zonesCache.ts < 5000) return zonesCache.data;
  const data = await db.zones.listAll();
  zonesCache.data = data;
  zonesCache.ts = now;
  return data;
}
function invalidateZonesCache() { zonesCache.data = null; zonesCache.ts = 0; }

app.get('/api/zones', handle(async (_req, res) => {
  res.json({ zones: await zonesCached() });
}));

app.get('/api/zones/accuracy', handle(async (req, res) => {
  const all = await zonesCached();
  const symbol = req.query.symbol ? String(req.query.symbol).toUpperCase() : null;
  const scoped = symbol ? all.filter(z => z.symbol === symbol) : all;
  const manual = scoped.filter(z => z.source !== 'auto');
  const auto = scoped.filter(z => z.source === 'auto' && !z.feedback);
  const bySymbol = new Map();
  for (const z of [...manual, ...auto]) {
    const list = bySymbol.get(z.symbol) ?? { manual: [], auto: [] };
    (z.source === 'auto' ? list.auto : list.manual).push(z);
    bySymbol.set(z.symbol, list);
  }
  const details = [];
  let matchedManual = 0;
  let manualTotal = 0;
  let matchedAuto = 0;
  let autoTotal = 0;
  for (const [sym, { manual: m, auto: a }] of bySymbol) {
    const r = matchZones(m, a);
    matchedManual += r.matchedManual;
    manualTotal += r.manualCount;
    matchedAuto += r.matchedAuto;
    autoTotal += r.autoCount;
    details.push({ symbol: sym, ...r });
  }
  res.json({
    symbols: details,
    totals: {
      manualCount: manualTotal,
      autoCount: autoTotal,
      matchedManual,
      matchedAuto,
      precision: autoTotal ? matchedAuto / autoTotal : null,
      recall: manualTotal ? matchedManual / manualTotal : null
    },
    calibration: await readCalibration()
  });
}));

const readCalibration = async () => {
  try {
    const ev = await db.zones.getCalibration();
    return ev ? latestCalibration([ev]) : { ...DEFAULT_CALIBRATION };
  } catch {
    return { ...DEFAULT_CALIBRATION };
  }
};

app.get('/api/zones/:symbol', handle(async (req, res) => {
  res.json({ zones: await db.zones.listAll(req.params.symbol) });
}));

app.post('/api/zones', handle(async (req, res) => {
  const b = req.body ?? {};
  const symbol = assertSymbol(b.symbol, res);
  const price = Number(b.price);
  if (!symbol || !Number.isFinite(price) || price <= 0) {
    return res.status(400).json({ error: 'بيانات منطقة غير صالحة' });
  }
  const zone = {
    id: crypto.randomUUID(),
    symbol,
    type: b.type === 'BSL' ? 'BSL' : 'SSL',
    price,
    timeframe: String(b.timeframe ?? ''),
    note: String(b.note ?? '').slice(0, 500),
    created_at: Date.now(),
    expires_at: Number(b.expires_at) > 0 ? Number(b.expires_at) : null,
    active: true
  };
  await db.zones.append(zone);
  invalidateZonesCache();
  broadcast({ type: 'zones_changed', symbol });
  res.json({ ok: true, zone });
}));

app.patch('/api/zones/:id', handle(async (req, res) => {
  const all = await db.zones.listAll();
  const cur = all.find(z => z.id === req.params.id && z.source !== 'auto');
  if (!cur) return res.status(404).json({ error: 'المنطقة غير موجودة أو ليست يدوية' });
  const b = req.body ?? {};
  const zone = {
    ...cur,
    price: b.price != null && Number(b.price) > 0 ? Number(b.price) : cur.price,
    note: b.note != null ? sanitizeText(b.note) : cur.note,
    type: b.type === 'BSL' || b.type === 'SSL' ? b.type : cur.type,
    active: typeof b.active === 'boolean' ? b.active : cur.active
  };
  await db.zones.append(zone);
  invalidateZonesCache();
  broadcast({ type: 'zones_changed', symbol: zone.symbol });
  res.json({ ok: true, zone });
}));

app.delete('/api/zones/:id', handle(async (req, res) => {
  const all = await db.zones.listAll();
  const cur = all.find(z => z.id === req.params.id && z.source !== 'auto');
  if (!cur) return res.status(404).json({ error: 'المنطقة غير موجودة أو ليست يدوية — استخدم التغذية الراجعة للمناطق الآلية' });
  await db.zones.append({ ...cur, active: false });
  invalidateZonesCache();
  broadcast({ type: 'zones_changed', symbol: cur.symbol });
  res.json({ ok: true });
}));

// ---- الكشف الآلي: تغذية راجعة + ملاحظات + المعايرة ----
const VERDICTS = ['confirm', 'reject', 'clear'];

app.post('/api/zones/:id/feedback', handle(async (req, res) => {
  const all = await db.zones.listAll(req.query.symbol ? String(req.query.symbol).toUpperCase() : undefined);
  const cur = all.find(z => z.id === req.params.id);
  if (!cur) return res.status(404).json({ error: 'المنطقة غير موجودة' });
  const verdict = VERDICTS.includes(req.body?.verdict) ? req.body.verdict : null;
  if (!verdict) return res.status(400).json({ error: 'verdict يجب أن يكون confirm أو reject أو clear' });
  const note = req.body?.note != null ? sanitizeText(req.body.note) : undefined;
  await db.zones.appendFeedback({
    zoneId: cur.id,
    verdict,
    note,
    score: cur.score ?? null,
    timeframe: cur.timeframe,
    symbol: cur.symbol,
    ts: Date.now()
  });
  invalidateZonesCache();
  broadcast({ type: 'zones_changed', symbol: cur.symbol });
  res.json({
    ok: true,
    zone: { ...cur, feedback: verdict === 'clear' ? null : verdict, note: note ?? cur.note }
  });
}));

// ملاحظة على منطقة آلية دون تغيير التغذية الراجعة
app.post('/api/zones/:id/note', handle(async (req, res) => {
  const all = await db.zones.listAll(req.query.symbol ? String(req.query.symbol).toUpperCase() : undefined);
  const cur = all.find(z => z.id === req.params.id);
  if (!cur) return res.status(404).json({ error: 'المنطقة غير موجودة' });
  const note = sanitizeText(req.body?.note);
  await db.zones.appendFeedback({
    zoneId: cur.id,
    verdict: null,
    note,
    score: cur.score ?? null,
    timeframe: cur.timeframe,
    symbol: cur.symbol,
    ts: Date.now()
  });
  invalidateZonesCache();
  broadcast({ type: 'zones_changed', symbol: cur.symbol });
  res.json({ ok: true, zone: { ...cur, note } });
}));

// ==================== الباك تيست + الفرص الحية (walk-forward + حلقة تعلم مستمرة) ====================

// قائمة المستهدفة: الحلال + غير الباركود فقط — بأسماء الأعمدة الفعلية:
// coin_shariah.verdict ('halal' | 'haram')، coin_flags.barcode (bool بأساس بدون لاحقة مثل 'BTC')
const resolveTargets = async (limit = Number.POSITIVE_INFINITY) => {
  const [sh, flags] = await Promise.all([
    db.coinShariah.list().catch(() => []),
    db.coinFlags.list().catch(() => [])
  ]);
  const barcode = new Set();
  for (const f of (flags || [])) {
    if (f.barcode === true || f.is_barcode === true) {
      const base = String(f.symbol || '').toUpperCase().trim();
      if (!base) continue;
      barcode.add(base);            // أساس
      barcode.add(base + 'USDT');   // زوج يوسدت
      barcode.add(base + 'FDUSD');  // زدوج فيديوسدت
    }
  }
  const halal = (sh || [])
    .filter(r => {
      const verdict = String(r.verdict ?? '').toLowerCase().trim();
      if (verdict) return verdict === 'halal';
      return r.is_halal !== false; // احتياطي فقط لو تغيّر المخطط
    })
    .map(r => r.symbol)
    .filter(s => /^[A-Z0-9]+USDT$/.test(s)); // زوج يوسدت حقيقي
  const seen = new Set();
  return halal.filter(s => {
    if (seen.has(s) || barcode.has(s)) return false;
    seen.add(s);
    return true;
  }).slice(0, limit === Number.POSITIVE_INFINITY ? undefined : limit);
};

// محرك مناطق السيولة مستقل: لا يستخدم backtestState أو liveState ولا يقفل أياً منهما.
const liquidityState = {
  liveBusy: false,
  liveRotation: 0,
  livePairsDone: 0,
  livePairsTotal: 0,
  liveResults: [],
  historyBusy: false,
  historyRotation: 0,
  historyPairsDone: 0,
  historyPairsTotal: 0,
  historyResults: [],
  feedback: [],
  adjustment: { tolerancePct: 0.002, examples: 0, visualBias: {} },
  updatedAt: null,
  error: null
};

// الشموع حول لحظة معينة: نافذة قبل/بعد المؤشر
const zoneCandlesWindow = async (zone, phase) => {
  const tfMs = tfToMs(zone.timeframe);
  const anchorSec = Math.max(Math.max(Number(zone.confirmedAt) || 0, Number(zone.createdAt) || 0), Number(zone.detectedAt) > 1e12 ? Number(zone.detectedAt) / 1000 : Number(zone.detectedAt) || 0) || 0;
  if (!anchorSec) return [];
  const before = 60;
  const after = phase === 'after' ? 80 : 2;
  const startTime = (anchorSec - before * tfMs / 1000) * 1000;
  const endTime = (anchorSec + after * tfMs / 1000) * 1000;
  const raw = await db.binance.klines(zone.symbol, zone.timeframe, before + after + 10, startTime, endTime);
  return normalizeCandles(raw);
};

const tfToMs = (tf) => {
  const n = parseInt(tf, 10) || 1;
  const unit = tf.replace(/[0-9]/g, '');
  const mult = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[unit] || 3_600_000;
  return n * mult;
};

const zoneScreenshotAt = async (zone, phase) => {
  const candles = await zoneCandlesWindow(zone, phase);
  if (!candles.length) return renderZoneChart(zone, [], null);
  // مؤشر الكشف: أقرب شمعة إلى لحظة الإنشاء
  const anchorMs = (Math.max(Number(zone.confirmedAt) || 0, Number(zone.createdAt) || 0) || (Number(zone.detectedAt) > 1e12 ? Number(zone.detectedAt) / 1000 : Number(zone.detectedAt) || 0)) * 1000;
  let markerIndex = null;
  if (anchorMs) {
    let best = Infinity;
    for (let i = 0; i < candles.length; i += 1) {
      const d = Math.abs(candles[i].time * 1000 - anchorMs);
      if (d < best) { best = d; markerIndex = i; }
    }
  }
  return renderZoneChart(zone, candles, markerIndex);
};

const saveLiquidityEvent = async (type, zone, message, meta = {}) => {
  try {
    await db.events.create({
      symbol: String(zone?.symbol || 'GLOBAL').toUpperCase(),
      type,
      message,
      meta: JSON.stringify({ ...meta, zone }),
      ts: Date.now()
    });
  } catch (e) {
    console.error('[liquidity-zones] event save failed:', e.message);
  }
};

const mergeLiquidityResults = (rows, incoming) => {
  const map = new Map(rows.map(r => [`${r.symbol}|${r.timeframe}|${r.id}`, r]));
  for (const zone of incoming) map.set(`${zone.symbol}|${zone.timeframe}|${zone.id}`, zone);
  return [...map.values()].sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));
};

const runLiquidityLiveRotation = async () => {
  if (liquidityState.liveBusy) return;
  liquidityState.liveBusy = true;
  try {
    const targets = await resolveTargets();
    const allowed = new Set(targets);
    liquidityState.liveResults = liquidityState.liveResults.filter(z => allowed.has(z.symbol)); // تطهير عملات الخرج
    liquidityState.liveRotation += 1;
    liquidityState.livePairsDone = 0;
    liquidityState.livePairsTotal = targets.length;
    liquidityState.error = null;
    const rotation = liquidityState.liveRotation;
    for (let symbolIndex = 0; symbolIndex < targets.length; symbolIndex += 1) {
      const symbol = targets[symbolIndex];
      for (let timeframeIndex = 0; timeframeIndex < ALL_TIMEFRAMES.length; timeframeIndex += 1) {
        const timeframe = ALL_TIMEFRAMES[timeframeIndex];
        try {
          const raw = await db.binance.klines(symbol, timeframe, 500);
          const candles = normalizeCandles(raw);
          const zones = detectLiquidityZones({
            symbol,
            timeframe,
            candles,
            tolerancePct: liquidityState.adjustment.tolerancePct,
            biasPerKind: liquidityState.adjustment.visualBias || {}
          }).map(zone => ({ ...zone, rotation, mode: 'live', workOrder: symbolIndex * ALL_TIMEFRAMES.length + timeframeIndex }));
          liquidityState.liveResults = mergeLiquidityResults(liquidityState.liveResults, zones);
        } catch { /* زوج/فريم فاشل لا يوقف المحرك المستقل */ }
      }
      liquidityState.livePairsDone += 1;
      liquidityState.updatedAt = Date.now();
      broadcast({ type: 'liquidity_zones_live_progress', symbol, rotation });
    }
    broadcast({ type: 'liquidity_zones_live_done', rotation });
  } catch (e) {
    liquidityState.error = e.message;
  } finally {
    liquidityState.liveBusy = false;
  }
};

const runLiquidityHistoryRotation = async () => {
  if (liquidityState.historyBusy) return;
  liquidityState.historyBusy = true;
  try {
    const targets = await resolveTargets();
    const allowed = new Set(targets);
    liquidityState.historyResults = liquidityState.historyResults.filter(z => allowed.has(z.symbol)); // تطهير عملات الخرج
    liquidityState.historyRotation += 1;
    liquidityState.historyPairsDone = 0;
    liquidityState.historyPairsTotal = targets.length;
    for (let symbolIndex = 0; symbolIndex < targets.length; symbolIndex += 1) {
      const symbol = targets[symbolIndex];
      for (let timeframeIndex = 0; timeframeIndex < ALL_TIMEFRAMES.length; timeframeIndex += 1) {
        const timeframe = ALL_TIMEFRAMES[timeframeIndex];
        try {
          const raw = await db.binance.klines(symbol, timeframe, 1000);
          const candles = normalizeCandles(raw);
          const zones = scanHistory({ symbol, timeframe, candles, step: Math.max(1, Math.floor(candles.length / 120)), maxZones: 200, biasPerKind: liquidityState.adjustment.visualBias || {} });
          liquidityState.historyResults = mergeLiquidityResults(liquidityState.historyResults, zones.map(zone => ({ ...zone, mode: 'history', workOrder: symbolIndex * ALL_TIMEFRAMES.length + timeframeIndex })));
        } catch { /* مستقل */ }
      }
      liquidityState.historyPairsDone += 1;
      broadcast({ type: 'liquidity_zones_history_progress', symbol, rotation: liquidityState.historyRotation });
    }
    broadcast({ type: 'liquidity_zones_history_done', rotation: liquidityState.historyRotation });
  } catch (e) {
    liquidityState.error = e.message;
  } finally {
    liquidityState.historyBusy = false;
  }
};

const runLiquidityLoops = async () => {
  for (;;) {
    void runLiquidityLiveRotation();
    void runLiquidityHistoryRotation();
    await new Promise(r => setTimeout(r, 5000));
    if (!liquidityState.liveBusy && !liquidityState.historyBusy) continue;
    await new Promise(r => setTimeout(r, 1000));
  }
};
setTimeout(() => void runLiquidityLoops(), 60_000);

app.get('/api/liquidity-zones/status', handle(async (_req, res) => {
  res.json({
    live: {
      busy: liquidityState.liveBusy,
      rotation: liquidityState.liveRotation,
      pairsDone: liquidityState.livePairsDone,
      pairsTotal: liquidityState.livePairsTotal,
      total: liquidityState.liveResults.length
    },
    history: {
      busy: liquidityState.historyBusy,
      rotation: liquidityState.historyRotation,
      pairsDone: liquidityState.historyPairsDone,
      pairsTotal: liquidityState.historyPairsTotal,
      total: liquidityState.historyResults.length
    },
    adjustment: liquidityState.adjustment,
    updatedAt: liquidityState.updatedAt,
    error: liquidityState.error
  });
}));

app.get('/api/liquidity-zones/live', handle(async (req, res) => {
  let rows = liquidityState.liveResults;
  if (req.query.symbol) rows = rows.filter(x => x.symbol === String(req.query.symbol).toUpperCase());
  if (req.query.timeframe) rows = rows.filter(x => x.timeframe === req.query.timeframe);
  if (req.query.kind) rows = rows.filter(x => x.kind === req.query.kind);
  res.json({ results: rows.slice(0, 500), total: rows.length, rotation: liquidityState.liveRotation, updatedAt: liquidityState.updatedAt });
}));

app.get('/api/liquidity-zones/history', handle(async (req, res) => {
  let rows = liquidityState.historyResults;
  if (req.query.symbol) rows = rows.filter(x => x.symbol === String(req.query.symbol).toUpperCase());
  if (req.query.timeframe) rows = rows.filter(x => x.timeframe === req.query.timeframe);
  if (req.query.kind) rows = rows.filter(x => x.kind === req.query.kind);
  const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  res.json({ results: rows.slice(offset, offset + limit), total: rows.length, rotation: liquidityState.historyRotation });
}));

app.get('/api/liquidity-zones/:id', handle(async (req, res) => {
  const id = String(req.params.id);
  const zone = [...liquidityState.liveResults, ...liquidityState.historyResults].find(x => x.id === id);
  if (!zone) return res.status(404).json({ error: 'التحديد غير موجود' });
  const [at, after] = await Promise.all([zoneScreenshotAt(zone, 'at'), zoneScreenshotAt(zone, 'after')]);
  res.json({ zone, screenshotAt: at, screenshotAfter: after });
}));

app.get('/api/liquidity-zones/:id/screenshot', handle(async (req, res) => {
  const id = String(req.params.id);
  const zone = [...liquidityState.liveResults, ...liquidityState.historyResults].find(x => x.id === id);
  if (!zone) return res.status(404).json({ error: 'التحديد غير موجود' });
  const phase = req.query.phase === 'after' ? 'after' : 'at';
  res.type('image/svg+xml').send(await zoneScreenshotAt(zone, phase));
}));

app.post('/api/liquidity-zones/:id/review', handle(async (req, res) => {
  const id = String(req.params.id);
  const zone = [...liquidityState.liveResults, ...liquidityState.historyResults].find(x => x.id === id);
  if (!zone) return res.status(404).json({ error: 'التحديد غير موجود' });
  const verdict = String(req.body?.verdict || '').toLowerCase();
  if (!['accept', 'reject', 'confirm', 'clear'].includes(verdict)) return res.status(400).json({ error: 'قرار غير صالح' });
  const feedback = { zoneId: id, symbol: zone.symbol, verdict, note: String(req.body?.note || ''), correction: req.body?.correction ?? null, ts: Date.now() };
  liquidityState.feedback.push(feedback);
  liquidityState.adjustment = feedbackToAdjustment(liquidityState.feedback, liquidityState.adjustment);
  // تعلّم فعّال من عين المستخدم: كل قبول يرفع انحياز نوع المقطع (+0.03) وكل رفض يخفضه (-0.05) — محدود [0, 1.5]
  const bias = { ...(liquidityState.adjustment.visualBias || {}) };
  const kindKey = String(zone.kind || 'horizontal_bsl');
  const delta = verdict === 'accept' ? 0.03 : verdict === 'reject' ? -0.05 : 0;
  if (delta) bias[kindKey] = Math.max(0, Math.min(1.5, (bias[kindKey] ?? 0) + delta));
  liquidityState.adjustment = { ...liquidityState.adjustment, visualBias: bias };
  const updated = { ...zone, review: feedback, reviewVersion: (zone.reviewVersion || 0) + 1 };
  liquidityState.liveResults = liquidityState.liveResults.map(x => x.id === id ? updated : x);
  liquidityState.historyResults = liquidityState.historyResults.map(x => x.id === id ? updated : x);
  await saveLiquidityEvent('liquidity_zone_reviewed', updated, `مراجعة ${verdict}`, feedback);
  await saveLiquidityEvent('liquidity_rules_updated', updated, 'تحديث قواعد محرك السيولة', { adjustment: liquidityState.adjustment });
  broadcast({ type: 'liquidity_zone_reviewed', zone: updated });
  res.json({ ok: true, zone: updated, adjustment: liquidityState.adjustment });
}));

app.post('/api/liquidity-zones/run', handle(async (_req, res) => {
  void runLiquidityLiveRotation();
  void runLiquidityHistoryRotation();
  res.json({ ok: true, started: true });
}));

app.post('/api/liquidity-zones/run-custom', handle(async (req, res) => {
  const symbol = String(req.body?.symbol || '').toUpperCase().trim();
  const timeframe = String(req.body?.timeframe || '').toLowerCase().trim();
  const fromTs = Number(req.body?.fromTs);
  const toTs = Number(req.body?.toTs);
  if (!/^[A-Z0-9]{4,20}$/.test(symbol)) return res.status(400).json({ error: 'رمز غير صالح' });
  if (!ALL_TIMEFRAMES.includes(timeframe)) return res.status(400).json({ error: 'فريم غير صالح' });
  if (!Number.isFinite(fromTs) || !Number.isFinite(toTs) || toTs <= fromTs) return res.status(400).json({ error: 'مدى زمني غير صالح' });
  const raw = await loadKlinesPaginated(db, symbol, timeframe, 5000, { startTime: fromTs, endTime: toTs, maxPages: 8 });
  const candles = normalizeCandles(raw);
  const results = scanHistory({ symbol, timeframe, candles, step: 1, maxZones: 1000 });
  // شموع نفس النافذة (مضغوطة) للشارت المستقل — بلا إعادة جلب من العميل
  const candlesCompact = candles.map(c => [c.time, c.open, c.high, c.low, c.close]);
  res.json({ ok: true, symbol, timeframe, fromTs, toTs, results, candles: candlesCompact });
}));

// العملات الحلال غير الباركود (أهداف الدوران) لملء قائمة اختيار العملة في الجولة المخصصة
app.get('/api/symbols/targets', handle(async (_req, res) => {
  const targets = await resolveTargets();
  res.json({ targets });
}));

// ═══ مساعد قراءة السوق — حتمي بالكامل من أرقام محرك مناطق السيولة (بلا أي توليد حر) ═══

function findStructure(candles) {
  const highs = [], lows = [];
  for (let i = 2; i < candles.length - 2; i += 1) {
    const c = candles[i];
    if (c.high > candles[i - 1].high && c.high > candles[i - 2].high && c.high >= candles[i + 1].high && c.high >= candles[i + 2].high) highs.push(c);
    if (c.low < candles[i - 1].low && c.low < candles[i - 2].low && c.low <= candles[i + 1].low && c.low <= candles[i + 2].low) lows.push(c);
  }
  let direction = 'محايد';
  const steps = [];
  if (highs.length >= 2 && lows.length >= 2) {
    const hUp = highs[highs.length - 1].high > highs[highs.length - 2].high;
    const lUp = lows[lows.length - 1].low > lows[lows.length - 2].low;
    direction = hUp && lUp ? 'صاعد' : !hUp && !lUp ? 'هابط' : 'عرضي';
    steps.push(`آخر قمتين: ${highs[highs.length - 2].high.toPrecision(7)} ثم ${highs[highs.length - 1].high.toPrecision(7)} (${hUp ? 'صاعدتان' : 'هابطتان'})`);
    steps.push(`آخر قاعين: ${lows[lows.length - 2].low.toPrecision(7)} ثم ${lows[lows.length - 1].low.toPrecision(7)} (${lUp ? 'صاعدان' : 'هابطان'})`);
  } else {
    steps.push(`الشموع غير كافية لهيكلة واضحة (لدينا ${candles.length} شمعة)`);
  }
  // آخر كسر بنيوي: إغلاق فوق آخر قمة مسجلة أو تحت آخر قاع مسجل بعدها
  let lastBreak = null;
  if (highs.length && lows.length) {
    const lastPivotTime = Math.max(highs[highs.length - 1].time, lows[lows.length - 1].time);
    for (let i = candles.length - 1; i >= 0; i -= 1) {
      const c = candles[i];
      if (c.time <= lastPivotTime) break;
      if (c.close > highs[highs.length - 1].high) { lastBreak = `إغلاق فوق آخر قمة (${highs[highs.length - 1].high.toPrecision(7)})`; break; }
      if (c.close < lows[lows.length - 1].low) { lastBreak = `إغلاق تحت آخر قاع (${lows[lows.length - 1].low.toPrecision(7)})`; break; }
    }
  }
  return { direction, lastBreak, steps };
}

function activeZonesMap(zones, lastPrice) {
  const active = zones.filter(z => z.state !== 'swept' && Number.isFinite(z.liquidityLevel));
  const above = active.filter(z => z.liquidityLevel > lastPrice).sort((a, b) => a.liquidityLevel - b.liquidityLevel);
  const below = active.filter(z => z.liquidityLevel < lastPrice).sort((a, b) => b.liquidityLevel - a.liquidityLevel);
  const sweptRecent = zones.filter(z => z.state === 'swept');
  const rejections = zones.reduce((n, z) => n + (z.touches || 0), 0);
  return { above, below, sweptRecent, rejections };
}

function baseCaseRange(candles, direction, nearestLevel) {
  const last = candles[candles.length - 1];
  const s14 = candles.slice(-14);
  const atr = s14.reduce((n, c) => n + (c.high - c.low), 0) / s14.length;
  const dirSign = direction === 'صاعد' ? 1 : direction === 'هابط' ? -1 : 0;
  let low = last.close - Math.max(0.2, 0.5 - 0.5 * dirSign) * atr;
  let high = last.close + Math.max(0.2, 0.5 + 0.5 * dirSign) * atr;
  // القيد بالمنطقة النشطة: النطاق لا يتجاوز أقرب مستوى سيولة في اتجاه القراءة
  let capped = null;
  if (Number.isFinite(nearestLevel)) {
    if (dirSign >= 0 && nearestLevel > last.close && nearestLevel < high) { high = nearestLevel; capped = nearestLevel; }
    if (dirSign <= 0 && nearestLevel < last.close && nearestLevel > low) { low = nearestLevel; capped = nearestLevel; }
  }
  return { low, high, atr, capped };
}

app.get('/api/market-read', handle(async (req, res) => {
  const symbol = String(req.query.symbol || '').toUpperCase().trim();
  const timeframes = String(req.query.timeframes || '15m,1h,4h').split(',').map(t => t.toLowerCase().trim()).filter(t => ALL_TIMEFRAMES.includes(t)).slice(0, 6);
  if (!/^[A-Z0-9]{4,20}$/.test(symbol)) return res.status(400).json({ error: 'رمز غير صالح' });
  if (!timeframes.length) return res.status(400).json({ error: 'فريمات غير صالحة' });
  const reads = [];
  for (const timeframe of timeframes) {
    try {
      const raw = await loadKlinesPaginated(db, symbol, timeframe, 300, { maxPages: 2 });
      const candles = normalizeCandles(raw);
      if (candles.length < 30) continue;
      const zones = scanHistory({ symbol, timeframe, candles, step: Math.max(1, Math.floor(candles.length / 120)), maxZones: 200 });
      const lastPrice = candles[candles.length - 1].close;
      const structure = findStructure(candles);
      const map = activeZonesMap(zones, lastPrice);
      const nearest = map.above[0] || map.below[0] || null;
      const nearestLevel = nearest ? nearest.liquidityLevel : null;
      const baseCase = baseCaseRange(candles, structure.direction, nearestLevel);
      const steps = [...structure.steps];
      if (structure.lastBreak) steps.push(`آخر كسر بنيوي: ${structure.lastBreak}`);
      steps.push(`مناطق نشطة فوق السعر: ${map.above.length}${map.above[0] ? ` (أقربها ${map.above[0].liquidityLevel.toPrecision(7)} — ${map.above[0].kind})` : ''}`);
      steps.push(`مناطق نشطة تحت السعر: ${map.below.length}${map.below[0] ? ` (أقربها ${map.below[0].liquidityLevel.toPrecision(7)} — ${map.below[0].kind})` : ''}`);
      steps.push(`انزلاقات مسحوبة حديثاً: ${map.sweptRecent.length} | إجمالي لمسات المناطق: ${map.rejections}`);
      steps.push(`السلوك المرجعي للإغلاق الحالي: ${baseCase.low.toPrecision(7)} ← ${baseCase.high.toPrecision(7)}${baseCase.capped != null ? ' (مقيّد بأقرب سيولة)' : ''} | ATR≈${baseCase.atr.toPrecision(4)}`);
      const biasScore = map.below.reduce((n, z) => n + z.confidence, 0) - map.above.reduce((n, z) => n + z.confidence, 0);
      reads.push({
        symbol, timeframe, lastPrice,
        direction: structure.direction, lastBreak: structure.lastBreak,
        above: map.above.slice(0, 3).map(z => ({ id: z.id, kind: z.kind, level: z.liquidityLevel, confidence: z.confidence, touches: z.touches, state: z.state })),
        below: map.below.slice(0, 3).map(z => ({ id: z.id, kind: z.kind, level: z.liquidityLevel, confidence: z.confidence, touches: z.touches, state: z.state })),
        sweptCount: map.sweptRecent.length, rejections: map.rejections,
        baseCase: { low: baseCase.low, high: baseCase.high, atr: baseCase.atr, capped: baseCase.capped },
        biasScore, steps
      });
    } catch { /* فريم غير متاح لهذه العملة — يُتخطى */ }
  }
  if (!reads.length) return res.status(404).json({ error: 'لا بيانات كافية لهذه العملة/الفريمات' });
  const bullish = reads.filter(r => r.direction === 'صاعد').length;
  const bearish = reads.filter(r => r.direction === 'هابط').length;
  const zonesBelow = reads.reduce((n, r) => n + r.below.reduce((m, z) => m + z.confidence, 0), 0);
  const zonesAbove = reads.reduce((n, r) => n + r.above.reduce((m, z) => m + z.confidence, 0), 0);
  const net = zonesBelow - zonesAbove + (bullish - bearish) * 0.5;
  const bias = net > 1 ? 'شرائي' : net < -1 ? 'بيعي' : 'محايد';
  res.json({
    ok: true, symbol, bias, net: Number(net.toFixed(2)),
    summary: `تحيّز ${bias} — هيكلة ${reads.filter(r => r.direction !== 'محايد').map(r => `${r.timeframe}: ${r.direction}`).join(' · ') || 'غير محسومة'}`,
    reads
  });
}));

// حالة الباك تيست في الذاكرة (النمط نفسه: حالة خادم بسيطة)
const backtestState = {
  busy: false, startedAt: null, lastRunAt: null, pairsDone: 0, pairsTotal: 0,
  lastRun: null, error: null, cycle: 0,
  customBusy: false, customRun: null, customError: null
};

app.get('/api/backtest/status', handle(async (_req, res) => {
  const targets = await resolveTargets();
  res.json({
    busy: backtestState.busy,
    continuous: true,
    cycle: backtestState.cycle,
    startedAt: backtestState.startedAt,
    lastRunAt: backtestState.lastRunAt,
    pairsDone: backtestState.pairsDone,
    pairsTotal: backtestState.pairsTotal,
    targetsCount: targets.length,
    targets: targets.slice(0, 20),
    customBusy: backtestState.customBusy,
    error: backtestState.error,
    liveRotation: liveState.rotation,
    livePairsDone: liveState.pairsDone,
    livePairsTotal: liveState.pairsTotal
  });
}));

// مجموع + تقسيم كل فريم محسوب على الخادم (النتائج كاملة قد تصل عشرات الميغابايت — الأداء أولاً)
const summarizeResults = (rows) => {
  const all = rows.flatMap(r => r.trades ?? []);
  const decided = all.filter(t => t.win === 0 || t.win === 1);
  const wins = decided.filter(t => t.win === 1).length;
  const rrRatios = decided.filter(t => Number.isFinite(t.rr));
  const frames = new Map();
  for (const pair of rows) {
    for (const t of pair.trades ?? []) {
      if (t.win !== 0 && t.win !== 1) continue;
      const m = frames.get(pair.timeframe) || { decided: 0, wins: 0 };
      m.decided += 1;
      if (t.win === 1) m.wins += 1;
      frames.set(pair.timeframe, m);
    }
  }
  return {
    total: all.length,
    decided: decided.length,
    wins,
    winRate: decided.length ? wins / decided.length : null,
    avgRR: rrRatios.length ? rrRatios.reduce((a, t) => a + t.rr, 0) / rrRatios.length : null,
    avgBars: decided.length ? decided.reduce((a, t) => a + (t.bars || 0), 0) / decided.length : null,
    perFrame: [...frames.entries()].map(([tf, m]) => ({ timeframe: tf, ...m })).sort((a, b) => a.timeframe.localeCompare(b.timeframe))
  };
};

app.get('/api/backtest/results', handle(async (req, res) => {
  const run = backtestState.lastRun;
  if (!run) return res.json({ exists: false, message: 'الحلقة المستمرة تعمل — بانتظار اكتمال أول دورة', custom: backtestState.customRun });
  let rows = run.results ?? [];
  const coin = req.query.coin ? String(req.query.coin).toUpperCase() : undefined;
  const timeframe = req.query.timeframe ? String(req.query.timeframe) : undefined;
  if (coin) rows = rows.filter(r => r.symbol === coin);
  if (timeframe) rows = rows.filter(r => r.timeframe === timeframe);
  // ترقيم صفحات الأزواج: الأزواج الكاملة ثقيلة — الافتراضي 400 (بحد أقصى 2000)
  const limit = Math.min(Math.max(Number(req.query.limit) || 400, 1), 2000);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  res.json({
    exists: true,
    cycle: backtestState.cycle,
    startedAt: run.startedAt,
    lastRunAt: run.lastRunAt,
    total: rows.length,
    results: rows.slice(offset, offset + limit),
    summary: summarizeResults(rows),
    learn: run.learn ?? null,
    custom: backtestState.customRun
  });
}));

// الدورة: كل المستهدفات × كل الفريمات — نفس خطوات الكشف الحي حرفياً (صفر تعديل على منطق التداول)
const runCycle = async () => {
  if (backtestState.busy) return;
  backtestState.busy = true;
  const results = [];
  try {
    const targets = await resolveTargets();
    if (!targets.length) { backtestState.error = 'لا مستهدفات (لاحلال/لا غير-باركود)'; return; }
    backtestState.startedAt = Date.now();
    backtestState.pairsDone = 0;
    backtestState.pairsTotal = targets.length;
    backtestState.cycle += 1; // الدورة الجانية: التالية تبدأ فور اكتمال هذه
    const cycleNo = backtestState.cycle;
    backtestState.error = null;
    const calibration = await readCalibration();
    for (const symbol of targets) {
      for (const tf of ALL_TIMEFRAMES) {
        try {
          results.push(await runPairBacktest(db, { symbol, timeframe: tf, calibration, capital: 10000 }));
        } catch (e) {
          results.push({ symbol, timeframe: tf, trades: [], reason: e.message });
        }
        await new Promise(r => setTimeout(r, 300));
      }
      backtestState.pairsDone += 1;
      await new Promise(r => setTimeout(r, 100));
    }
    // حلقة التعلم المستمرة: على دورة كاملة
    let learn = null;
    try {
      learn = learnOnTrades(results, { targetWinRate: 0.7 });
    } catch (e) {
      console.error('[backtest] learning failed:', e.message);
    }
    backtestState.lastRun = { startedAt: backtestState.startedAt, lastRunAt: Date.now(), results, learn };
    backtestState.lastRunAt = Date.now();
    console.log(`[backtest] cycle ${cycleNo} done: pairs ${backtestState.pairsDone}/${backtestState.pairsTotal} | learn: ${learn?.enough ? `winRate ${learn.winRate}` : 'غير كافية'}`);
    broadcast({ type: 'backtest_done' });
  } catch (e) {
    backtestState.error = e.message;
    console.error('[backtest] cycle failed:', e.message);
  } finally {
    backtestState.busy = false;
  }
};

// الحلقة الدورية المستمرة: تنتهي دورة → تبدأ التالية فوراً (لا انتظار ضغط — مهلة 5 ثوانٍ فقط بين اللفات)
const runBacktestLoop = async () => {
  for (;;) {
    await runCycle();
    await new Promise(r => setTimeout(r, 5000));
  }
};
setTimeout(() => void runBacktestLoop(), 30_000); // تبدأ تلقائياً بعد مزامنة العملات

app.post('/api/backtest/run', handle(async (_req, res) => {
  if (backtestState.busy) return res.status(409).json({ error: 'دورة قيد التنفيذ بالفعل — الحلقة مستمرة تلقائياً' });
  res.json({ ok: true, started: true });
  void runCycle();
}));

// جولة مخصصة: عملة محددة + فريمها + مدى زمني (من — إلى) — منفصلة عن الدوري ولا تعيق الحلقة
app.post('/api/backtest/run-custom', handle(async (req, res) => {
  const symbol = String(req.body?.symbol || '').toUpperCase().trim();
  const timeframe = String(req.body?.timeframe || '1h').toLowerCase().trim();
  // قبول أرقام epoch أو صيغ تاريخ (ISO) — أكثر مرونة
  const parseTs = (v) => {
    if (v == null || v === '') return undefined;
    const n = Number(v);
    if (Number.isFinite(n)) return n;
    const d = Date.parse(v);
    return Number.isNaN(d) ? undefined : d;
  };
  const fromTs = parseTs(req.body?.fromTs);
  const toTs = parseTs(req.body?.toTs);
  const tsGiven = (v) => v != null && v !== '';
  if ((tsGiven(req.body?.fromTs) && fromTs === undefined) || (tsGiven(req.body?.toTs) && toTs === undefined)) return res.status(400).json({ error: 'مدى زمني غير صالح' });
  backtestState.customBusy = true;
  backtestState.customError = null;
  res.json({ ok: true, started: true, symbol, timeframe });
  void (async () => {
    try {
      const result = await runPairBacktest(db, {
        symbol, timeframe, calibration: await readCalibration(), capital: 10000,
        startTime: fromTs, endTime: toTs, bars: 20000
      });
      backtestState.customRun = { symbol, timeframe, fromTs: fromTs ?? null, toTs: toTs ?? null, at: Date.now(), result };
      console.log(`[backtest] custom done: ${symbol} ${timeframe}`);
      broadcast({ type: 'backtest_custom_done' });
    } catch (e) {
      backtestState.customError = e.message;
      console.error('[backtest] custom failed:', e.message);
    } finally {
      backtestState.customBusy = false;
    }
  })();
}));

// ==================== محرك الفرص الحية المستقل (يلف بالتوازي — لا يعيق المحركات الأخرى) ====================

const liveState = { busy: false, rotation: 0, pairsDone: 0, pairsTotal: 0, opportunities: [], updatedAt: null, error: null };

// اللفة: كل المستهدفات × كل الفريمات — نفس الوحدات الحية حرفياً (profile + location + candidates + score)
const runLiveRotation = async () => {
  if (liveState.busy) return;
  liveState.busy = true;
  const liveOut = new Map(); // (رمز|فريم) -> فرق العملة — البناء يُجري تلفزيياً
  // الترتيب: بترتيب العمل — أول عملة تم العمل عليها أولاً (Map يحترم ترتيب الإلحاق = ترتيب التنفيذ)
  const rebuild = () => [...liveOut.values()].flat();
  try {
    const targets = await resolveTargets();
    if (!targets.length) { liveState.error = 'لا مستهدفات (لاحلال/لا غير-باركود)'; return; }
    liveState.rotation += 1;
    const rotNo = liveState.rotation;
    liveState.pairsDone = 0;
    liveState.pairsTotal = targets.length;
    liveState.error = null;
    const calibration = await readCalibration();
    const learnedRules = backtestState.lastRun?.learn?.rules ?? null;
    // الأسعار الحالية لكل الرموز (نداء واحد) — المسافة الحية من منطقة
    const prices = await db.binance.tickerPrices(targets).catch(() => ({}));
    for (const symbol of targets) {
      for (const tf of ALL_TIMEFRAMES) {
        try {
          const r = await discoverLiveOpportunities(db, { symbol, timeframe: tf, calibration, learnedRules, price: prices[symbol] ?? null, capital: 10000 });
          liveOut.set(`${symbol}|${tf}`, (r.opportunities || []).map(o => ({ ...o, rotation: rotNo })));
        } catch { /* زوج فاشل لا يوقف اللَّفة */ }
        await new Promise(r => setTimeout(r, 300));
      }
      // تحديث تلفزي: الفرص تظهر فور اكتمال كل عملة (لا انتظار نهاية اللفة)
      liveState.opportunities = rebuild();
      liveState.updatedAt = Date.now();
      liveState.pairsDone += 1;
      await new Promise(r => setTimeout(r, 100));
    }
    liveState.opportunities = rebuild();
    liveState.updatedAt = Date.now();
    console.log(`[live] rotation ${rotNo} done: ${liveState.opportunities.length} opportunities | pairs ${liveState.pairsDone}/${liveState.pairsTotal}`);
    broadcast({ type: 'live_opportunities' });
    broadcast({ type: 'live_opportunities' });
  } catch (e) {
    liveState.error = e.message;
    console.error('[live] rotation failed:', e.message);
  } finally {
    liveState.busy = false;
  }
};

// الحلقة المستمرة: تنتهي لفَّة → التالية فوراً (مهلة 5 ثوانٍ فقط — لا مدة زمنية معتبرة)
const runLiveLoop = async () => {
  for (;;) {
    await runLiveRotation();
    await new Promise(r => setTimeout(r, 5000));
  }
};
setTimeout(() => void runLiveLoop(), 45_000); // يلف بالتوازي مع المحركات الأخرى — ينطلق عند بدء الخادم

app.get('/api/live/opportunities', handle(async (_req, res) => {
  res.json({
    busy: liveState.busy,
    rotation: liveState.rotation,
    pairsDone: liveState.pairsDone,
    pairsTotal: liveState.pairsTotal,
    opportunities: liveState.opportunities.slice(0, 120),
    total: liveState.opportunities.length,
    updatedAt: liveState.updatedAt,
    error: liveState.error
  });
}));

// ═══ محرك «الفرص الحية» — دخول شراء عبر سويب مناطق SSL + أدوات الأوردر فلو ═══
// مصدر المناطق: مخزون محرك مناطق السيولة الحي (بلا إعادة كشف). التتبع مستمر بلا انقطاع،
// والترتيب من الفريم الأدق (1m) صعوداً — عرض أولاً بأول. البوابة الأخيرة: شريحة معايرة ≥ 60%.

const readLiveCalibration = async () => {
  try {
    const rows = await db.events.list({ type: 'live_calibration', limit: 1 });
    const row = rows?.[0];
    if (!row) return null;
    const meta = typeof row.meta === 'string' ? JSON.parse(row.meta) : row.meta;
    return { at: Number(row.ts) || null, trades: meta?.trades ?? 0, segments: meta?.segments ?? [] };
  } catch {
    return null;
  }
};

const liveOppEngine = createLiveOpportunityEngine({
  // نداء واحد لكل أسعار السوق ثم فلترة محلية: طلب الأزواج دفعةً واحدة يفشل بسبب
  // رموز غير مدعومة على المضيف المتاح (HTTP 400)، بينما النداء الشامل ينجح دائماً.
  fetchPrices: async (symbols) => {
    const all = await db.binance.allTickerPrices().catch(() => null);
    if (all && Object.keys(all).length) {
      const out = {};
      for (const s of symbols) if (Number.isFinite(all[s])) out[s] = all[s];
      return out;
    }
    return db.binance.tickerPrices(symbols).catch(() => ({}));
  },
  fetchRawKlines: (symbol, timeframe, limit) => db.binance.klines(symbol, timeframe, limit),
  fetchBookSignals: (symbol) => bookSignals(symbol),
  zoneSource: () => liquidityState.liveResults,
  resolveTargets: () => resolveTargets(),
  readCalibration: readLiveCalibration,
  broadcast: (msg) => broadcast(msg),
  persist: (row) => saveLiquidityEvent(
    row?.closed ? 'live_opportunity_closed' : row?.type === 'live_calibration' ? 'live_calibration' : 'live_opportunity',
    { symbol: row?.symbol || 'GLOBAL' },
    row?.type === 'live_calibration'
      ? `معايرة الفرص الحية: ${row.segments?.length ?? 0} شريحة / ${row.trades ?? 0} صفقة`
      : row?.closed
        ? `نتيجة فرصة ${row.symbol} ${row.timeframe}: ${row.outcome === 'target' ? 'وصل الهدف' : 'ضرب الوقف'}`
        : `فرصة شراء ${row.symbol} ${row.timeframe} — درجة ${row.composite} / R:R ${row.rr}`,
    { opportunity: row }
  ),
  log: console
});
setTimeout(() => liveOppEngine.start(), 75_000); // يبدأ بعد استقرار اللفّات القائمة (مناطق السيولة + الفرص + الباك تيست)

app.get('/api/live-opportunities', handle(async (req, res) => {
  const scope = String(req.query.scope || '').trim();
  const tf = String(req.query.timeframe || '').trim();
  const feed = liveOppEngine.getFeed();
  const filter = (list) => list.filter(o => (!tf || o.timeframe === tf));
  res.json({
    ...feed,
    scope: scope || feed.scope,
    opportunities: filter(feed.opportunities),
    total: filter(feed.opportunities).length,
    watching: filter(feed.watching),
    watchingTotal: filter(feed.watching).length
  });
}));

app.get('/api/live-opportunities/status', handle(async (_req, res) => {
  res.json(liveOppEngine.getStatus());
}));

app.get('/api/live-opportunities/calibration', handle(async (_req, res) => {
  res.json(liveOppEngine.getCalibration());
}));

app.get('/api/live-opportunities/history', handle(async (_req, res) => {
  res.json(liveOppEngine.getHistory());
}));

app.post('/api/live-opportunities/run', handle(async (_req, res) => {
  res.json({ ok: true, started: true });
  void liveOppEngine.runCycle().catch(() => undefined);
}));

app.post('/api/live-opportunities/calibrate', handle(async (req, res) => {
  const symbols = Array.isArray(req.body?.symbols) && req.body.symbols.length
    ? req.body.symbols.map(s => String(s).toUpperCase().trim()).filter(s => /^[A-Z0-9]{4,20}$/.test(s))
    : null;
  const timeframes = Array.isArray(req.body?.timeframes) && req.body.timeframes.length
    ? req.body.timeframes.map(t => String(t).toLowerCase().trim()).filter(t => ALL_TIMEFRAMES.includes(t))
    : null;
  res.json({ ok: true, started: true, symbols: symbols?.length ?? null, timeframes: timeframes?.length ?? null });
  void liveOppEngine.runCalibration({ symbols, timeframes }).catch(() => undefined);
}));

// شارت بصري لفرصة: الشموع الحقيقية + خط الدخول/الوقف/الهدف + نقطة السويب
app.get('/api/live-opportunities/:id/screenshot', handle(async (req, res) => {
  const op = liveOppEngine.findOpportunity(String(req.params.id));
  if (!op) return res.status(404).json({ error: 'فرصة غير موجودة' });
  const raw = await db.binance.klines(op.symbol, op.timeframe, 160);
  const candles = normalizeCandles(raw);
  const zoneLike = {
    symbol: op.symbol,
    timeframe: op.timeframe,
    kind: op.kind,
    state: `فرصة حية · درجة ${op.composite} · R:R ${op.rr}`,
    referenceLevel: op.referenceLevel,
    liquidityLevel: op.liquidityLevel,
    detectedAt: op.detectedAt,
    extraLevels: [
      { price: op.entry, label: 'الدخول', color: '#0ea5e9' },
      { price: op.stop, label: 'الوقف', color: '#dc2626' },
      { price: op.tp, label: 'الهدف', color: '#16a34a' },
      { price: op.sweepLow, label: 'قاع السويب', color: '#7c3aed', dash: 'stroke-dasharray="2 6"' }
    ],
    reasons: [
      `دخول ${op.entry} · وقف ${op.stop} · هدف ${op.tp} · R:R ${op.rr}`,
      `تدفق ${op.flowScore} (${op.flowTier}) · ثقة الشريحة ${(op.calibratedWinRate * 100).toFixed(1)}% من ${op.segmentTrades} صفقة`,
      ...(op.flowReasons || []).slice(0, 2)
    ]
  };
  res.type('image/svg+xml').send(renderZoneChart(zoneLike, candles, candles.length - 1));
}));

// جدولة الكشف الآلي: كل عملات لوحة التحليل × كل الفريمات
const detectRunBusy = { value: false };

const periodicDetection = async () => {
  if (detectRunBusy.value) return;
  detectRunBusy.value = true;
  try {
    const analyses = await db.analyses.list();
    if (!analyses.length) return;
    const calibration = await readCalibration();
    const allZones = await db.zones.listAll();
    for (const a of analyses) {
      try {
        const { perTf } = await detectSymbol({
          symbol: a.symbol,
          timeframes: ALL_TIMEFRAMES,
          fetchKlines: (sym, tf, limit) => db.binance.klines(sym, tf, limit),
          calibration
        });
        const existingAuto = allZones.filter(z => z.source === 'auto' && z.symbol === a.symbol);
        // لقطة واحدة لكل رمز: تحل محل مئات الإلحاقات الفردية وتحمي سجل الأحداث من الغرق
        const snap = buildSnapshot({
          symbol: a.symbol,
          perTf,
          existingAuto,
          matchTolerancePct: calibration.matchTolerancePct
        });
        const prevSnap = allZones.filter(z => z.source === 'auto' && z.symbol === a.symbol && z.feedback !== 'reject');
        const changed = snap.zones.length !== prevSnap.length ||
          snap.zones.some(z => {
            const p = prevSnap.find(e => e.id === z.id);
            return !p || p.score !== z.score || Boolean(p.swept) !== Boolean(z.swept);
          });
        if (snap.zones.length || prevSnap.length) {
          await db.zones.appendAutoSnapshot(snap);
          broadcast({ type: 'zones_changed', symbol: a.symbol });
          broadcast({ type: 'zones_auto_updated', symbol: a.symbol, added: snap.zones.length, removed: Math.max(0, prevSnap.length - snap.zones.length) });
          void changed;
        }
      } catch (e) {
        console.error(`[zones] detection failed for ${a.symbol}:`, e.message);
      }
      await new Promise(r => setTimeout(r, 500));
    }
    // المعايرة التكيفية: بعد الجولة — إن وُجدت مناطق يدوية مرجعية
    try {
      const fresh = await db.zones.listAll();
      const manual = fresh.filter(z => z.source !== 'auto');
      const auto = fresh.filter(z => z.source === 'auto' && !z.feedback);
      if (manual.length >= 3) {
        const report = matchZones(manual, auto);
        const next = adaptCalibration(calibration, report);
        if (next.minScore !== calibration.minScore) {
          await db.zones.appendCalibration(next);
          console.log(`[zones] calibration adapted: minScore ${calibration.minScore} → ${next.minScore} (precision ${report.precision?.toFixed(2)}, recall ${report.recall?.toFixed(2)})`);
        }
      }
    } catch { /* المعايرة لا تعطل الجولة */ }
  } catch (e) {
    console.error('[zones] detection cycle failed:', e.message);
  } finally {
    detectRunBusy.value = false;
  }
};

setInterval(() => void periodicDetection(), (Number(process.env.DETECT_MIN) || 5) * 60 * 1000);
setTimeout(() => void periodicDetection(), 60_000);

// مراقبة المناطق: اقتراب السعر (≤0.2%) وسحب السيولة (عبور السعر للمنطقة)
const zoneNotify = new Map();
setInterval(() => {
  void (async () => {
    try {
      const zones = await db.zones.listAll();
      const now = Date.now();
      const live = zones.filter(z => z.active && z.feedback !== 'reject' && (!z.expires_at || z.expires_at > now));
      if (!live.length) return;
      const symbols = [...new Set(live.map(z => z.symbol))];
      const prices = await db.binance.tickerPrices(symbols);
      for (const z of live) {
        const p = prices[z.symbol];
        if (!p) continue;
        const st = zoneNotify.get(z.id) ?? { near: false, swept: false };
        if (!st.swept) {
          const dist = Math.abs(p - z.price) / z.price;
          if (dist <= 0.002 && !st.near) {
            st.near = true;
            broadcast({ type: 'zone_near', symbol: z.symbol, zone: z, price: p });
          } else if (dist > 0.005 && st.near) {
            st.near = false;
          }
          const crossed = z.type === 'BSL' ? p >= z.price : p <= z.price;
          if (crossed) {
            st.swept = true;
            broadcast({ type: 'zone_swept', symbol: z.symbol, zone: z, price: p });
          }
          zoneNotify.set(z.id, st);
        }
      }
    } catch { /* أخطاء المراقبة لا تعطل الخدمة */ }
  })();
}, 30000);

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

// ---- سجل القرارات (Case Ledger): لقطة مصنّفة لكل قرار تحليل ----
app.get('/api/cases', handle(async (req, res) => {
  const symbol = req.query.symbol ? String(req.query.symbol).toUpperCase() : undefined;
  const rows = await db.cases.list({ symbol });
  res.json(rows);
}));

app.get('/api/cases/:id', handle(async (req, res) => {
  const row = await db.cases.get(req.params.id);
  if (!row) return res.status(404).json({ error: 'القرار غير موجود' });
  const images = await db.cases.imagesList(row.id);
  res.json({ ...row, images });
}));

app.post('/api/cases', handle(async (req, res) => {
  const symbol = assertSymbol(req.body?.symbol, res);
  if (!symbol) return;
  const actor = DECISION_ACTORS.includes(req.body?.actor) ? req.body.actor : null;
  if (!actor) return res.status(400).json({ error: 'actor يجب أن يكون من أنواع القرار المعروفة' });
  const decidedAt = Number.isFinite(Number(req.body?.decided_at)) && Number(req.body.decided_at) > 0
    ? Number(req.body.decided_at)
    : Date.now();
  const payload = await assembleCase({ symbol, actor, decidedAt, snapshot: req.body?.snapshot ?? {}, db });
  const rows = await db.cases.save({ symbol, actor, decided_at: decidedAt, payload: JSON.stringify(payload) });
  const id = rows?.[0]?.id ?? null;
  // صور الشارت لحظة القرار — منفصلة عن payload، فشلها لا يفشل حفظ القرار
  if (id) {
    try {
      const images = (req.body?.snapshot?.screenshots ?? [])
        .slice(0, 4)
        .filter(s => typeof s?.dataUrl === 'string' && s.dataUrl.startsWith('data:image/'))
        .map(s => ({
          case_id: id,
          symbol,
          tf: String(s.tf ?? '').slice(0, 16),
          data_url: s.dataUrl.slice(0, 1_000_000),
          captured_at: decidedAt
        }));
      if (images.length) await db.cases.imagesSave(images);
    } catch (e) {
      console.error('[cases] screenshot persist failed:', e?.message ?? e);
    }
  }
  res.json({ ok: true, id });
}));

// ---- أرشيف المناطق: كل نسخ التحديد اليدوي (شاملة المحذوف) ----
app.get('/api/zones/history', handle(async (req, res) => {
  const symbol = req.query.symbol ? String(req.query.symbol).toUpperCase() : undefined;
  const limit = Math.min(Number(req.query.limit) || 2000, 5000);
  const offset = Math.max(0, Number(req.query.offset) || 0);
  const raw = await db.zones.history({ symbol, limit, offset });
  res.json({ events: raw, groups: groupZoneHistory(raw), total: raw.length, limit, offset });
}));

// ---- السجل التاريخي للتحديد الآلي (منطق فابيو) ----
// دمج حسب المنطقة + ترقيم على مستوى الصفوف: يخفض الحمولة من ميغابايتات إلى كيلوبايتات
const autoSnapCache = new Map();
app.get('/api/auto-history', handle(async (req, res) => {
  const { clampPage, flattenSnapshots, dedupeByZoneKey } = await import('./liquidity/autoHistory.mjs');
  const { limit, offset } = clampPage(req.query.limit, req.query.offset);
  const filters = {
    symbol: req.query.symbol ? String(req.query.symbol).toUpperCase() : undefined,
    timeframe: req.query.timeframe ? String(req.query.timeframe) : undefined,
    type: req.query.type === 'BSL' || req.query.type === 'SSL' ? req.query.type : undefined,
    minScore: req.query.minScore != null && req.query.minScore !== '' ? Number(req.query.minScore) : undefined,
    from: req.query.from ? Number(req.query.from) : undefined,
    to: req.query.to ? Number(req.query.to) : undefined,
    fabioOnly: req.query.fabioOnly === 'false' ? false : true
  };
  // تفصيل منطقة واحدة: كل لقطات zoneKey محدد (يُستخدم عند توسيع صف)
  if (req.query.zoneKey) {
    const raw = await db.zones.autoHistory({ symbol: filters.symbol, from: filters.from, to: filters.to, limit: 500, offset: 0 });
    const all = flattenSnapshots(raw, { ...filters, fabioOnly: false }).filter(r => r.zoneKey === String(req.query.zoneKey).slice(0, 200));
    return res.json({ rows: all, total: all.length, limit: all.length, offset: 0, fabioOnly: false });
  }
  // كاش 15 ثانية للجلب الخام (مفتاح: symbol|from|to) — الافتتاح المتكرر للتبويب يصبح فورياً
  const snapKey = `${filters.symbol ?? ''}|${filters.from ?? ''}|${filters.to ?? ''}`;
  const cached = autoSnapCache.get(snapKey);
  let raw;
  if (cached && Date.now() - cached.ts < 15000) {
    raw = cached.data;
  } else {
    raw = await db.zones.autoHistory({ symbol: filters.symbol, from: filters.from, to: filters.to, limit: 500, offset: 0 });
    if (autoSnapCache.size > 8) autoSnapCache.clear();
    autoSnapCache.set(snapKey, { data: raw, ts: Date.now() });
  }
  const flat = dedupeByZoneKey(flattenSnapshots(raw, filters));
  const total = flat.length;
  const rows = flat.slice(offset, offset + limit);
  res.set('X-Total-Count', String(total));
  res.json({ rows, total, limit, offset, fabioOnly: filters.fabioOnly });
}));

// صور الشارت المحفوظة لحظة التحديد الآلي: إلحاق + قراءة
app.post('/api/auto-history/screenshots', handle(async (req, res) => {
  const shots = (Array.isArray(req.body?.shots) ? req.body.shots : [])
    .slice(0, 8)
    .filter(s => typeof s?.zoneKey === 'string' && s.zoneKey.length <= 200
      && typeof s?.dataUrl === 'string' && s.dataUrl.startsWith('data:image/'))
    .map(s => ({
      zoneKey: s.zoneKey.slice(0, 200),
      symbol: String(s.symbol ?? s.zoneKey.split('|')[0] ?? '').toUpperCase().slice(0, 32),
      timeframe: String(s.timeframe ?? s.zoneKey.split('|')[1] ?? '').slice(0, 16),
      type: s.type === 'SSL' ? 'SSL' : 'BSL',
      price: Number.isFinite(Number(s.price)) ? Number(s.price) : null,
      dataUrl: s.dataUrl.slice(0, 1_000_000),
      capturedAt: Number(s.capturedAt) || Date.now()
    }));
  if (!shots.length) return res.status(400).json({ error: 'لا توجد صور صالحة' });
  for (const shot of shots) await db.zones.appendZoneScreenshot(shot);
  broadcast({ type: 'auto_screenshots_saved', count: shots.length });
  res.json({ ok: true, saved: shots.length });
}));

app.get('/api/auto-history/screenshots', handle(async (req, res) => {
  const symbol = req.query.symbol ? String(req.query.symbol).toUpperCase() : undefined;
  const from = req.query.from ? Number(req.query.from) : undefined;
  const events = await db.zones.listZoneScreenshots({ symbol, from });
  const latest = new Map();
  for (const e of events) {
    const shot = (() => { try { return JSON.parse(e.meta || 'null'); } catch { return null; } })();
    if (!shot?.zoneKey || latest.has(shot.zoneKey)) continue;
    latest.set(shot.zoneKey, { ...shot, ts: Number(e.ts ?? 0) });
  }
  res.json({ screenshots: [...latest.values()] });
}));

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
// قائمة خفيفة: بدون meta (meta الضخم يُجلب عند التوسيع فقط) — يخفض النقل من ميغابايتات إلى كيلوبايتات
app.get('/api/events', handle(async (req, res) => {
  const rows = await db.events.list(req.query);
  res.json(rows.map(r => ({ ...r, meta: null })));
}));

// تفصيل حدث واحد بmeta الكامل — يُستدعى عند توسيع صف في سجل الأحداث
app.get('/api/events/:id', handle(async (req, res) => {
  const row = await db.events.get(Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'الحدث غير موجود' });
  res.json(row);
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
  const s = String(symbol).toUpperCase();
  if (!SYMBOL_RE.test(s)) return res.status(400).json({ error: 'صيغة الرمز غير صالحة' });
  if (!/^(\d+)(m|h|d|w|M)$/.test(String(interval))) return res.status(400).json({ error: 'فريم غير مدعوم' });
  let raw;
  try {
    raw = await db.binance.klines(
      s,
      interval,
      Math.min(Number(limit) || 200, 1000),
      startTime ? Number(startTime) : undefined,
      endTime ? Number(endTime) : undefined
    );
  } catch (error) {
    // الرمز غير متاح/مغلق أو الفريم غير صالح — رسالة نظيفة بدل خطأ upstream المربك
    const upstream = String(error?.message || '');
    if (/HTTP (400|404|451)/.test(upstream)) {
      return res.status(404).json({ error: 'الرمز غير متاح في بينانس — قد يكون مغلقاً أو غير موجود' });
    }
    throw error;
  }
  if (!Array.isArray(raw) || raw.length === 0) {
    return res.status(404).json({ error: 'لا شموع متاحة لهذا الرمز والفريم' });
  }
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
// الأصول الثابتة بأسماء Vite المبقعة → تخزين مؤقت طويل، وindex.html دائماً حديث
app.use(express.static(distDir, { index: false, setHeaders: (res, filePath) => {
  if (filePath.includes(`${path.sep}assets${path.sep}`)) {
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  }
} }));
app.use((req, res, next) => {
  if (req.method === 'GET' && !req.path.startsWith('/api')) {
    res.setHeader('Cache-Control', 'no-cache, must-revalidate');
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
