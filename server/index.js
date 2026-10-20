import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import db from './db.js';
import { researchSymbol } from './research.mjs';
import { detectSymbol, buildSnapshot, ALL_TIMEFRAMES, bookSignals } from './liquidity/engine.mjs';
import { matchZones, adaptCalibration, latestCalibration, DEFAULT_CALIBRATION } from './liquidity/calibrate.mjs';
import { runPairBacktest, learnOnTrades, loadKlinesPaginated } from './backtest/engine.mjs';
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
import { createStrategyEngine } from './strategy2/loop.mjs';
import { createMarketStreams } from './market/streams.mjs';
import { createHealth } from './health.mjs';
import { cpus } from 'node:os';
import { createRateLimiter } from './net/limiter.mjs';
import { setRateLimiter } from './db.js';
import { buildVerdictRow, builtinBases } from './shariah.mjs';
import { createWorkerPool } from './services/workerPool.mjs';
import { startRetention } from './services/retention.mjs';
import { createShadow } from './services/shadow.mjs';
import {
  mergeZones, replaceSymbolScan, boundByNewest, shouldStartRotation, capState,
  DEFAULT_HISTORY_MAX_ZONES, DEFAULT_LIVE_MAX_ZONES
} from './services/zoneStore.mjs';
import { reviveDecision, REVIVE_COOLDOWN_MS, REVIVE_MAX } from './services/revive.mjs';
import { measureIdentityStability, createIdentityCollector } from './services/zoneIdentityShadow.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const STARTED_AT = Date.now();
/** قياس صحة النظام من داخل العملية (ذاكرة/تأخر حلقة/دورات المحركات) */
const health = createHealth({ startedAt: STARTED_AT });

const app = express();

/**
 * مُجمّع عمال للأعمال الثقيلة (فحص السيولة التاريخي).
 * العلة المُصلَحة (مقيسة بالتنميط): scanHistory يشتغل مرة لكل شمعة (O(n²)) ومعماريته
 * البصرية استهلكت 59% من زمن المعالج بشكل متزامن، فجمّدت معالجة البث حتى 3.9 ثانية
 * وتأخّرت طلبات HTTP. هنا يُنفَّذ في خيوط منفصلة بنتيجة مطابقة حرفياً.
 * الحجم محدود بحصة المعالج المعلنة في الحاوية، مع عامل احتياطي للتزامن.
 */
// لا يزيد العمال على حصة المعالج المتاحة: نواة واحدة = عامل واحد (منع التنافس على الحلقة)
/**
 * محدّد معدل بينانس الموحّد (إصلاح B6): كان المكتوب في net/limiter.mjs غير موصول
 * بأي مكان، فطلبات المحركات تتصادم بلا تنظيم وتردّ 429/418. الآن كل نداء REST يمر
 * عبره بأولويات: حي > معايرة > تاريخي، مع احترام Retry-After.
 */
const rateLimiter = createRateLimiter({
  minuteBudget: Number(process.env.BINANCE_MINUTE_BUDGET) || 4200,
  log: console
});
setRateLimiter(rateLimiter);

/**
 * وضع الظل (★): يقيس الإصلاحات التي تُغيّر الفرص **بلا تفعيلها**.
 * المبدأ الملزم: المنطق المنشور لا يتغير؛ الجديد يعمل بالتوازي للقياس فقط،
 * ويُعرض على المستخدم بالدليل قبل أي تفعيل.
 */
const shadow = createShadow({ dir: process.env.SHADOW_DIR || '/tmp/shadow', log: console });
shadow.load();

const HEAVY_WORKERS = Math.max(1, Math.min(4, Number(process.env.HEAVY_WORKERS) || Math.max(1, Math.min(2, cpus().length - 1 || 1))));
const workerPool = createWorkerPool({
  size: HEAVY_WORKERS,
  taskTimeoutMs: Number(process.env.WORKER_TASK_TIMEOUT_MS) || 180_000,
  log: console
});
/** تنفيذ فحص السيولة خارج حلقة الأحداث مع احتياطي متزامن عند غياب العمال */
const scanHistoryAsync = async (args, timeoutMs = Number(process.env.WORKER_TASK_TIMEOUT_MS) || 180_000) => {
  try {
    return await workerPool.run('scanHistory', args, { timeoutMs });
  } catch (e) {
    health.notePersist({ ok: false, error: `worker: ${e.message}` });
    console.error('[workers] تعذّر الفحص خارج الحلقة — تحويل للمسار المتزامن:', e.message);
    return scanHistory(args);
  }
};

/**
 * دليل استعادة الحالة بعد إعادة التشغيل (يُملأ بعد الإقلاع ويُقرأ من الفحص العميق).
 * معرّف قبل `runtime` تفادياً لأي وصول قبل التهيئة.
 */
let stateRestoreInfo = null;

/** حالة تشغيل مشتركة تُبلّغ عنها المحركات (تُقرأ في /api/health/deep) */
const runtime = {
  marketStats: () => null,
  targets: () => ({ count: null, at: 0 }),
  targetsSource: () => null,
  shariahVerdicts: () => ({ count: null, at: 0 }),
  dataFresh: () => ({ ok: null, reason: 'غير مُهيّأ' }),
  /** مخزون المناطق (أكبر مخزن في الذاكرة) — يُقاس لحظياً في الفحص العميق */
  zones: () => null,
  /** دليل الاستعادة بعد إعادة التشغيل: عدد المراجعات المستعادة ومفاتيح الظل */
  stateRestore: () => null,
};
// نقطة صحّة لمنصات الاستضافة (Railway/…) — بلا مسار /api
app.get('/healthz', (req, res) => res.json({ ok: true, up: Date.now() }));
// نقطة جاهزية غير حاجبة: لا تنتظر Supabase/Binance أبداً (تشخيص سريع دون تعليق healthcheck)
// يتحقق الـ deploy منها يدوياً بعد الإقلاع: /readyz → {ok, dist, uptime}
app.get('/readyz', (req, res) => {
  const distDir = path.join(__dirname, '..', 'client', 'dist');
  const dist = fs.existsSync(path.join(distDir, 'index.html'));
  res.status(dist ? 200 : 503).json({ ok: dist, dist, up: Date.now(), uptime: process.uptime() });
});

/**
 * صفحة الصحة العميقة — الحالة الحقيقية للنظام في نداء واحد:
 * الذاكرة وحدّ الحاوية، تأخر حلقة الأحداث، حداثة بيانات السوق، دورات كل محرك،
 * وأعطال الحفظ. تُقرأ آلياً ومن لوحة التحكم. لا تعتمد على أي خدمة خارجية.
 */
/**
 * تقرير وضع الظل — دليل الفروق للإصلاحات ★ قبل طلب الموافقة على تفعيلها.
 * للقراءة فقط: لا يغيّر أي قرار منشور.
 */
app.get('/api/shadow/report', (_req, res) => {
  try { res.json(shadow.summary()); }
  catch (e) { res.status(500).json({ error: String(e?.message ?? e) }); }
});

app.get('/api/health/deep', (req, res) => {
  const snap = health.snapshot();
  let fresh = { ok: null, reason: 'غير مُهيّأ' };
  try { fresh = runtime.dataFresh() ?? fresh; } catch (e) { fresh = { ok: false, reason: `فشل القياس: ${e.message}` }; }
  res.json({
    ...snap,
    market: (() => { try { return runtime.marketStats(); } catch { return null; } })(),
    workers: (() => { try { return runtime.workers?.() ?? null; } catch { return null; } })(),
    rateLimiter: (() => { try { return runtime.rateLimiter?.() ?? null; } catch { return null; } })(),
    shadow: (() => { try { const s = runtime.shadow?.(); return s ? { enabled: s.enabled, fixes: Object.keys(s.fixes ?? {}).length, records: s.records.map(r => ({ key: r.key, samples: r.samples, diff: r.diff, diffRate: r.diffRate })) } : null; } catch { return null; } })(),
    targets: (() => { try { return { ...runtime.targets(), source: runtime.targetsSource() }; } catch { return null; } })(),
    shariah: (() => { try { return runtime.shariahVerdicts(); } catch { return null; } })(),
    /**
     * مخزون المناطق: كان يُسجَّل في العيّنات المحفوظة فقط، فلا يظهر في الفحص اللحظي —
     * وهو أكبر مخزن في الذاكرة، فلا يُقبل أن يُقاس كل 5 دقائق فقط.
     */
    zones: (() => { try { return runtime.zones?.() ?? null; } catch { return null; } })(),
    /** دليل بقاء الحالة عبر إعادات التشغيل (تعلّم المراجعات + قياس ★) */
    stateRestore: (() => { try { return runtime.stateRestore?.() ?? null; } catch { return null; } })(),
    /** ★2 قياس: نسبة دوران هوية المنطقة (مرجّحة بعدد المناطق) — قياس فقط بلا أثر */
    zoneIdentity: (() => { try { return zoneIdentityCollector.summary(); } catch { return null; } })(),
    dataFresh: fresh
  });
});
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
// حد الجسم: 1mb عموماً (حماية DoS) — مسارا الرفع المشروعان (لقطات حتى 8×1MB) لهما 10mb صريحاً
// (الخادم يقص كل dataUrl عند 1_000_000 حرف والعدد عند 8 — السقف الكلي ~8MB)
const json1mb = express.json({ limit: '1mb' });
const json10mb = express.json({ limit: '10mb' });
const UPLOAD_PATHS = new Set(['/api/auto-history/screenshots', '/api/cases']);
app.use((req, res, next) => {
  if (req.method === 'POST' && UPLOAD_PATHS.has(req.path)) return json10mb(req, res, next);
  return json1mb(req, res, next);
});

// تحذير بدء التشغيل: القيم المدمجة احتياطية — اضبط SUPABASE_URL/ANON_KEY في بيئة الاستضافة (لا تُطبع القيم أبداً)
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) {
  console.warn('[config] using baked-in Supabase defaults (set SUPABASE_URL/SUPABASE_ANON_KEY to override)');
}

// رفضوع وعود مرفوضة في الحلقات الخلفية يجب ألا تُسقط healthz بصمت
/**
 * مسار الإغلاق السليم يُسجَّل هنا لاحقاً (بعد تعريفه) حتى يستخدمه الخطأ القاتل أيضاً:
 * الخروج بلا حفظ يُفقد آخر نبضة وحالة العمال، وحفظها هو ما يميّز «إعادة تشغيل نظيفة»
 * من «مجهول السبب».
 */
let onFatalShutdown = null;
process.on('unhandledRejection', (reason) => {
  console.error('[fatal] unhandledRejection:', reason instanceof Error ? reason.message : reason);
});
process.on('uncaughtException', (err) => {
  console.error('[fatal] uncaughtException:', err instanceof Error ? err.message : err);
  // خروج نظيف لتُعيد منصة الاستضافة التشغيل بدل حالة عالقة — مع حفظ الحالة أولاً
  const done = () => process.exit(1);
  if (onFatalShutdown) {
    Promise.resolve(onFatalShutdown('uncaughtException')).finally(done);
    setTimeout(done, 3000).unref?.();
    return;
  }
  done();
});

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

/**
 * حقول الحقائق الشرعية المسموح بتوثيقها — قائمة بيضاء صريحة.
 * إصلاح C1: كان المسار يقبل أي جسم بلا تحقق، فيمكن حقن حقائق مشوّهة أو حقول غريبة
 * تُحفظ كما هي (رأينا فعلاً مفتاحاً غريباً PYUSDT_BASE في البيانات) وتؤثر على الحكم
 * الذي تبني عليه المحركات قراراتها. التحقق هنا شكلٌ لا يغيّر أي قيمة شرعية.
 */
const SHARIAH_FACT_KEYS = new Set([
  'has_utility', 'is_memecoin', 'has_lending_interest', 'has_fixed_yield',
  'linked_haram_activity', 'is_asset_backed', 'pure_speculation', 'privacy_concern'
]);
const SHARIAH_VERDICTS = new Set(['halal', 'haram', 'uncertain']);
const MAX_TEXT = 8000;

/** تطبيع حقائق واردة من الواجهة: المفاتيح المعروفة فقط، والقيم true/false/null فقط */
function sanitizeFacts(input) {
  let raw = input;
  if (typeof raw === 'string') { try { raw = JSON.parse(raw); } catch { return {}; } }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!SHARIAH_FACT_KEYS.has(k)) continue;   // يمنع إدخال حقول غريبة
    out[k] = v === true ? true : v === false ? false : null;
  }
  return out;
}

/** تطبيع مصفوفة JSON بحد أقصى للطول (منع تضخيم الصفوف) */
function sanitizeJsonArray(input, max = MAX_TEXT) {
  let raw = input;
  if (typeof raw === 'string') { try { raw = JSON.parse(raw); } catch { return '[]'; } }
  if (!Array.isArray(raw)) return '[]';
  return JSON.stringify(raw).slice(0, max);
}

app.put('/api/shariah/:symbol', handle(async (req, res) => {
  const symbol = String(req.params.symbol ?? '').toUpperCase().trim();
  if (!/^[A-Z0-9_]{2,24}$/.test(symbol)) return res.status(400).json({ error: 'رمز غير صالح' });
  const verdict = String(req.body?.verdict ?? 'uncertain').toLowerCase();
  if (!SHARIAH_VERDICTS.has(verdict)) {
    return res.status(400).json({ error: 'حكم غير صالح', allowed: [...SHARIAH_VERDICTS] });
  }
  const body = {
    verdict,
    facts: JSON.stringify(sanitizeFacts(req.body?.facts)),
    reasons: sanitizeJsonArray(req.body?.reasons),
    evidence: sanitizeJsonArray(req.body?.evidence),
    source: req.body?.source ? String(req.body.source).slice(0, 300) : null,
    notes: req.body?.notes ? String(req.body.notes).slice(0, MAX_TEXT) : null,
    updated_at: Date.now()
  };
  const rows = await db.coinShariah.upsert({ symbol, ...body });
  invalidateTargets();   // الحكم تغيّر → أعد حساب المستهدفة فوراً
  res.json(rows[0]);
}));

app.delete('/api/shariah/:symbol', handle(async (req, res) => {
  const symbol = String(req.params.symbol ?? '').toUpperCase().trim();
  if (!/^[A-Z0-9_]{2,24}$/.test(symbol)) return res.status(400).json({ error: 'رمز غير صالح' });
  await db.coinShariah.remove(symbol);
  invalidateTargets();
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
  const factsObj = hasAny ? gated : (prev ? JSON.parse(prev.facts || '{}') : {});
  // الحكم يُحسب على الخادم (المنطق الحتمي نفسه) بدل تثبيته "غير محسوم" انتظاراً للمتصفح.
  // قبل الإصلاح: كل صف آلي كان يبقى uncertain فلا يدخل أي محرك التحليل بلا فتح التطبيق.
  const computed = buildVerdictRow(symbol, { ...(prev || {}), facts: JSON.stringify(factsObj) }, {
    previous: prev?.verdict ?? null
  });
  const row = {
    symbol,
    verdict: computed.verdict,
    facts: JSON.stringify(factsObj),
    reasons: hasAny
      ? JSON.stringify(computed.reasons)
      : JSON.stringify([research.status === 'not_found'
        ? 'العملة غير موجودة في CoinGecko ولا CoinMarketCap — لا يتوفر بحث آلي لها، والتوثيق اليدوي متاح'
        : 'لا توجد بيانات كافية بثقة مقبولة — تبقى للتحقق وإعادة البحث دورياً']),
    evidence: JSON.stringify(computed.evidence ?? []),
    source: hasAny ? `${AUTO_SOURCE} — ${computed.source || ''} (${research.geckoId ?? '-'})` : `${AUTO_SOURCE} (بلا نتيجة كافية)`,
    notes: meta,
    updated_at: Date.now()
  };
  const saved = await db.coinShariah.upsert(row);
  invalidateTargets(); // الحكم تغيّر → أعد حساب المستهدفة فوراً
  return { saved: saved[0], previous: prev, hasAny, verdict: computed.verdict };
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

// ---- أرشيف المناطق: يجب قبل /:symbol وإلا يبتلعه Express كرمز history (إصلاح ظل التوجيه) ----
app.get('/api/zones/history', handle(async (req, res) => {
  const symbol = req.query.symbol ? String(req.query.symbol).toUpperCase() : undefined;
  const limit = Math.min(Number(req.query.limit) || 2000, 5000);
  const offset = Math.max(0, Number(req.query.offset) || 0);
  const raw = await db.zones.history({ symbol, limit, offset });
  res.json({ events: raw, groups: groupZoneHistory(raw), total: raw.length, limit, offset });
}));

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

// قائمة المستهدفة: العملات التي حكمها «حلال» بصيغة زوج USDT حقيقي.
// التغيير الجوهري عن السابق:
//  1) الحكم يُحسب على الخادم (server/shariah.mjs) فلا يتوقف النظام على فتح المتصفح.
//  2) جدول التصنيف يُقرأ مرة كل دقيقة ويُخزَّن كأسماء فقط (بلا نصوص الأدلة الضخمة)
//     بدل جلبه كاملاً في كل نداء من كل محرك.
//  3) الباركود لم يُعد مُستبعِداً: صار وسم تحذيري يُمرَّر مع الفرصة (التعليم لا الإخفاء)،
//     وفق القرار المعتمد.
const TARGETS_TTL_MS = Number(process.env.TARGETS_CACHE_MS) || 60_000;
let targetsCache = { at: 0, list: [], source: 'غير محسوبة', halal: 0, haram: 0, uncertain: 0 };

/** إبطال فوري لكاش المستهدفات بعد أي تغيير في التصنيف */
const invalidateTargets = () => { targetsCache = { ...targetsCache, at: 0 }; };

/**
 * قائمة المستهدفة = الحلال ∩ القابل للتداول فعلاً في السبوت.
 * سبب التقاطع: 43 رمزاً محكوماً «حلال» بلا سوق على بينانس (رموز مسحوبة أو مفاتيح
 * مشوّهة مثل PYUSDT_BASEUSDT وUSDTUSDT). إبقاؤها كان يجعل المحركات تجلب لبيانات
 * معدومة في كل دورة بلا نتيجة، ويسهّل تفسير «فرص» لا حقيقة لها.
 * هذا ليس تخفيفاً لشرط استراتيجية: الرمز بلا سوق لا يمكن أن يعطي فرصة صحيحة.
 */
const computeTargets = async () => {
  const rows = await db.coinShariah.list().catch(() => []);
  const counts = { halal: 0, haram: 0, uncertain: 0 };
  const halalAll = [];
  const seen = new Set();
  for (const r of rows || []) {
    const verdict = String(r?.verdict ?? '').toLowerCase().trim();
    if (counts[verdict] !== undefined) counts[verdict] += 1;
    if (verdict !== 'halal') continue;
    const symbol = String(r?.symbol ?? '').toUpperCase().trim();
    if (!symbol) continue;
    if (!/^[A-Z0-9]+USDT$/.test(symbol)) continue;   // يمنع USDTUSDT و PYUSDT_BASEUSDT
    if (seen.has(symbol)) continue;
    seen.add(symbol);
    halalAll.push(symbol);
  }
  // القابل للتداول: له سعر حي — مصدر الحقيقة هو سوق بينانس نفسه
  let tradable = null;
  try {
    const prices = await db.binance.allTickerPrices();
    tradable = new Set(Object.keys(prices || {}));
  } catch { /* تعذّر الجلب: لا نستبعد شيئاً هذه الدورة (احتياط محافظ) */ }
  const list = tradable ? halalAll.filter(sym => tradable.has(sym)) : halalAll;
  return {
    list, counts, total: (rows || []).length,
    halalAll: halalAll.length,
    excluded: halalAll.length - list.length
  };
};

const resolveTargets = async (limit = Number.POSITIVE_INFINITY) => {
  if (Date.now() - targetsCache.at > TARGETS_TTL_MS) {
    const { list, counts, total, halalAll, excluded } = await computeTargets();
    targetsCache = {
      at: Date.now(), list, halal: counts.halal, haram: counts.haram,
      uncertain: counts.uncertain, total, halalAll, excluded,
      source: 'coin_shariah ∩ سوق بينانس'
    };
  }
  const out = targetsCache.list;
  return limit === Number.POSITIVE_INFINITY ? out : out.slice(0, limit);
};

/** آخر قائمة مستهدفات محسوبة (للتشخيص بلا إعادة حساب) */
const targetsSnapshot = () => targetsCache;

// ربط التشخيص بالحالة الفعلية
runtime.targets = () => ({
  count: targetsCache.list.length,
  at: targetsCache.at,
  halal: targetsCache.halal,
  excludedNotTradable: targetsCache.excluded ?? null,
  excludedBarcode: 0   // الباركود لم يعد مُستبعِداً — وسم تحذيري فقط
});
runtime.targetsSource = () => targetsCache.source;
runtime.shariahVerdicts = () => ({
  at: shariahState.lastRunAt,
  computed: shariahState.computed,
  total: shariahState.total ?? null,
  changed: shariahState.changed,
  errors: shariahState.errors,
  lastError: shariahState.lastError
});

/**
 * حساب الحكم الشرعي للمشاريع المعروفة على الخادم (بلا متصفح).
 * يعمل عند الإقلاع ثم دورياً، ويكتب فقط عند تغيّر الحكم (سجل نظيف بلا إغراق).
 * لا يمسّ أي حكم وثّقه المستخدم يدوياً: حقائقه المحفوظة لها الأولوية دائماً.
 */
const shariahState = { lastRunAt: 0, computed: 0, changed: 0, errors: 0, lastError: null };

const resolveShariahOnServer = async ({ onlyMissing = false } = {}) => {
  const symbols = builtinBases().map(b => `${b}USDT`);
  const existing = await db.coinShariah.list().catch(() => []);
  const bySymbol = new Map((existing || []).map(r => [String(r.symbol).toUpperCase(), r]));
  const rows = [];
  const changes = [];
  for (const symbol of symbols) {
    const prior = bySymbol.get(symbol) ?? null;
    if (onlyMissing && prior) continue;
    try {
      const row = buildVerdictRow(symbol, prior, { previous: prior?.verdict ?? null });
      const { _changed, _from, _factsSource, ...clean } = row;
      // لا نكتب إلا ما تغيّر فعلاً أو ما لم يكن محفوظاً — يمنع 1000 كتابة كل دورة
      if (!prior || prior.verdict !== clean.verdict || prior.source !== clean.source) rows.push(clean);
      if (prior && prior.verdict !== clean.verdict) {
        changes.push({ symbol, from: prior.verdict, to: clean.verdict, factsSource: _factsSource });
      }
    } catch (e) {
      shariahState.errors += 1;
      shariahState.lastError = String(e?.message ?? e).slice(0, 200);
    }
  }
  const chunk = 200;
  for (let i = 0; i < rows.length; i += chunk) {
    await db.coinShariah.upsertChunk(rows.slice(i, i + chunk)).catch((e) => {
      shariahState.errors += 1;
      shariahState.lastError = String(e?.message ?? e).slice(0, 200);
    });
  }
  for (const c of changes) {
    await db.events.append({
      symbol: c.symbol,
      type: 'shariah_auto_change',
      message: `تغيّر الحكم الآلي: ${c.from} ← ${c.to}`,
      meta: JSON.stringify(c),
      ts: Date.now()
    }).catch(() => undefined);
  }
  shariahState.lastRunAt = Date.now();
  shariahState.computed = rows.length;
  shariahState.changed = changes.length;
  shariahState.total = symbols.length;
  if (changes.length || rows.length) invalidateTargets();
  return { computed: rows.length, changed: changes.length, total: symbols.length };
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

/** الحد الذي يبقى محفوظاً من تغذية المراجعة الراجعة (لا نحتاج أكثر للحساب) */
const FEEDBACK_KEEP = 500;
/**
 * حفظ تعلّمك من مراجعات المناطق (B11): كان `feedback` و`visualBias` في الذاكرة فقط،
 * فيبدأ النظام بعد كل إعادة تشغيل بتعلّم صفري وكأن مراجعاتك لم تحدث.
 */
async function persistLearning() {
  try {
    liquidityState.feedback = liquidityState.feedback.slice(-FEEDBACK_KEEP);
    await db.engineState.put('liquidity_learning', {
      feedback: liquidityState.feedback,
      adjustment: liquidityState.adjustment
    });
  } catch (e) { console.warn('[learning] تعذّر الحفظ:', e.message); }
}

async function restoreLearning() {
  try {
    const state = await db.engineState.get('liquidity_learning');
    if (!state?.feedback?.length) return { restored: 0, bias: {} };
    liquidityState.feedback = state.feedback.slice(-FEEDBACK_KEEP);
    liquidityState.adjustment = { ...liquidityState.adjustment, ...(state.adjustment || {}) };
    // إعادة الحساب من التغذية نفسها بدل الثقة بالملخص المحفوظ
    liquidityState.adjustment = feedbackToAdjustment(liquidityState.feedback, liquidityState.adjustment);
    console.log(`[learning] استُعيد ${liquidityState.feedback.length} مراجعة، وانحياز ${Object.keys(liquidityState.adjustment.visualBias || {}).length} نوع`);
    return { restored: liquidityState.feedback.length, bias: liquidityState.adjustment.visualBias || {} };
  } catch (e) {
    console.warn('[learning] تعذّر الاسترجاع:', e.message);
    return { restored: 0, bias: {} };
  }
}

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

/**
 * مخزون المناطق: للأمانة، `mergeLiquidityResults` تُبقي كل معرّف رأته في أي دورة،
 * والمعرّفات تتغيّر كل مسح، فيتراكم المخزون بلا حد حتى يقتل الحاوية (~700MB/دورة
 * تاريخية كاملة بالقياس). السياسة مطبّقة في `services/zoneStore.mjs`.
 */
const HISTORY_MAX_ZONES = Number(process.env.LIQUIDITY_HISTORY_MAX_ZONES || DEFAULT_HISTORY_MAX_ZONES);
const LIVE_MAX_ZONES = Number(process.env.LIQUIDITY_LIVE_MAX_ZONES || DEFAULT_LIVE_MAX_ZONES);

/**
 * ★2: كل كم عمل نفحص ثبات هوية المنطقة. 6006 عملية لكل دورة، وعيّنة كل 120 تعني ~50
 * عيّنة في الدورة (‎+0.8% كلفة CPU) وهو ما يكفي لتجمّع دليل حقيقي في ساعات.
 */
const ZONE_ID_SHADOW_STRIDE = Math.max(10, Number(process.env.ZONE_ID_SHADOW_STRIDE || 120));
const zoneIdentityCollector = createIdentityCollector();

/**
 * ★2: تغذية مجمّع الظل بمقارنة **لكل منطقة** لا لكل عيّنة. الحبيبة الصحيحة هي المنطقة:
 * نسبة دوران مرجّحة بعدد المناطق هي الجواب، ومتوسط نسب العيّنات يُخفي الفرق.
 * لكل منطقة مُطابَقة مقارنة واحدة: اتفاق إن ثبت المعرّف، وفرق إن تغيّر.
 */
const shadowCompareIdentitySamples = (sample) => {
  if (!shadow || !sample) return;
  for (const pair of sample.pairs ?? []) {
    shadow.compare(
      'liquidity-stable-zone-id',
      { id: pair.before },
      { id: pair.after },
      (a, b) => a?.id != null && a.id === b?.id,
      { symbol: sample.symbol, timeframe: sample.timeframe }
    );
  }
};

const mergeLiquidityResults = (rows, incoming) => mergeZones(rows, incoming);

const runLiquidityLiveRotation = async () => {
  if (liquidityState.liveBusy) return;
  /**
   * المخزون الحي يقرأه محرك الفرص، فلا يُحذف منه شيء. الحماية: عند بلوغ السقف لا نبدأ
   * دورة جديدة (المخزون يبقى كما هو ويعمل المحرك عليه) بدل النمو حتى قتل الحاوية.
   * الحالة تُصرَّح في الصحة وفي عيّنات `health_samples` وليست صامتة.
   */
  const liveCap = capState(liquidityState.liveResults.length, LIVE_MAX_ZONES);
  liquidityState.liveCap = liveCap;
  if (!shouldStartRotation(liquidityState.liveResults.length, LIVE_MAX_ZONES)) {
    liquidityState.liveSkipReason = `مخزون المناطق الحيّة بلغ السقف (${liveCap.count}/${liveCap.cap}) — الدورة الجديدة مؤجلة`;
    liquidityJob.set({ capped: true, cap: liveCap.cap, zones: liveCap.count, skipReason: liquidityState.liveSkipReason });
    return;
  }
  liquidityState.liveCap = null;
  liquidityState.liveSkipReason = null;
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
          /**
           * ★2 قياس فقط: يُشغَّل الكشف مرة ثانية بنفس الشموع وبفارق شمعة واحدة، وكل منطقة
           * مُطابَقة هي نفس المنطقة — فإن اختلف معرّفها فذلك عدم ثبات خالص يُفسّر ضياع
           * حالة السويب في محرك Fabio والتراكم في المخزون. العيّنة مقيّدة بـ`stride` كي
           * تبقى الكلفة أقل من 1% من الفحص، ولا يقرأ الناتج أي قرار منشور.
           */
          const workOrder = symbolIndex * ALL_TIMEFRAMES.length + timeframeIndex;
          if (shadow && workOrder % ZONE_ID_SHADOW_STRIDE === 0) {
            const sample = measureIdentityStability({
              detect: ({ endIndex }) => detectLiquidityZones({
                symbol,
                timeframe,
                candles,
                endIndex,
                tolerancePct: liquidityState.adjustment.tolerancePct,
                biasPerKind: liquidityState.adjustment.visualBias || {}
              }),
              symbol,
              timeframe,
              endIndex: candles.length - 1,
              tolerancePct: liquidityState.adjustment.tolerancePct
            });
            zoneIdentityCollector.add(sample);
            shadowCompareIdentitySamples(sample);
          }
        } catch { /* زوج/فريم فاشل لا يوقف المحرك المستقل */ }
      }
      liquidityState.livePairsDone += 1;
      liquidityState.updatedAt = Date.now();
      /**
       * الدورة الكاملة تمتد أكثر من ساعة (429 زوجاً × 14 فريماً على نواة واحدة)، فنبضة
       * واحدة في نهاية الدورة تجعل كاشف التعليق يعلن «متعطل» بعد 30 دقيقة وهي تعمل.
       * لذلك النبض لكل زوج: يمنع الإنذار الكاذب، ويعرض التقدم الحقيقي (المستهلك/الإجمالي).
       */
      liquidityJob.beat({
        extra: {
          mode: 'live',
          rotation,
          pairsDone: liquidityState.livePairsDone,
          pairsTotal: liquidityState.livePairsTotal,
          results: liquidityState.liveResults.length
        }
      });
      broadcast({ type: 'liquidity_zones_live_progress', symbol, rotation });
    }
    broadcast({ type: 'liquidity_zones_live_done', rotation });
  } catch (e) {
    liquidityState.error = e.message;
  } finally {
    liquidityState.liveBusy = false;
    liquidityJob.beat({ extra: { pairsDone: liquidityState.livePairsDone, pairsTotal: liquidityState.livePairsTotal, results: liquidityState.liveResults.length } });
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
      /**
       * تُجمع مناطق كل فريمات الرمز ثم تُكتب دفعة واحدة: الاستبدال لكل فريم كان يعني
       * فرز/تصفية 40 ألف صف 6006 مرة في الدورة. الناتج نفسه بكلفة أقل بمرتبة.
       */
      const pairZones = [];
      for (let timeframeIndex = 0; timeframeIndex < ALL_TIMEFRAMES.length; timeframeIndex += 1) {
        const timeframe = ALL_TIMEFRAMES[timeframeIndex];
        try {
          const raw = await db.binance.klines(symbol, timeframe, 1000);
          const candles = normalizeCandles(raw);
          const zones = await scanHistoryAsync({ symbol, timeframe, candles, step: Math.max(1, Math.floor(candles.length / 120)), maxZones: 200, biasPerKind: liquidityState.adjustment.visualBias || {} });
          for (const zone of zones) {
            pairZones.push({ ...zone, mode: 'history', workOrder: symbolIndex * ALL_TIMEFRAMES.length + timeframeIndex });
          }
        } catch { /* مستقل */ }
      }
      /**
       * استبدال مسح هذا الرمز بدل تراكمه: هذا المخزون للعرض والمراجعة فقط (لا محرك قرار
       * يقرأه)، وتراكم المسح القديم بجانب الجديد كان يُنتج ~833 منطقة لكل زوج أي
       * ~700MB للدورة الواحدة على حاوية حدّها 1GB — وهو سبب موت الحاوية.
       */
      liquidityState.historyResults = boundByNewest(
        replaceSymbolScan(liquidityState.historyResults, symbol, ALL_TIMEFRAMES, pairZones),
        HISTORY_MAX_ZONES
      );
      liquidityState.historyPairsDone += 1;
      /**
       * مخزون المناطق التاريخية هو أكبر مخزن في الذاكرة: `mergeLiquidityResults` يراكم
       * ولا يحذف، فالنمو بلا سقف. القياس هنا هو الدليل اللازم لقرار معالجة التراكم.
       */
      liquidityJob.beat({
        extra: {
          historyMode: true,
          historyRotation: liquidityState.historyRotation,
          historyDone: liquidityState.historyPairsDone,
          historyTotal: liquidityState.historyPairsTotal,
          historyResults: liquidityState.historyResults.length
        }
      });
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
      total: liquidityState.liveResults.length,
      cap: liquidityState.liveCap,
      skipReason: liquidityState.liveSkipReason ?? null
    },
    history: {
      busy: liquidityState.historyBusy,
      rotation: liquidityState.historyRotation,
      pairsDone: liquidityState.historyPairsDone,
      pairsTotal: liquidityState.historyPairsTotal,
      total: liquidityState.historyResults.length,
      maxZones: HISTORY_MAX_ZONES
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
  // حفظ التعلّم فور كل مراجعة: إعادة التشغيل التالية لن تبدأ من صفر (B11)
  void persistLearning();
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
  // كانت تُنفَّذ في حلقة الأحداث داخل الطلب فتجمّد الخادم دقائق (step:1 = فحص لكل شمعة)
  const results = await scanHistoryAsync({ symbol, timeframe, candles, step: 1, maxZones: 1000 });
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
      const zones = await scanHistoryAsync({ symbol, timeframe, candles, step: Math.max(1, Math.floor(candles.length / 120)), maxZones: 200 });
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
    // اللفة القديمة أُزيلت — المحرك الحي البديل هو liveOppEngine (إصلاح عطل liveState 500)
    liveRotation: liveOppEngine?.getStatus?.().cycle ?? null,
    livePairsDone: liveOppEngine?.getFeed?.().pairsTotal ?? null,
    livePairsTotal: liveOppEngine?.getFeed?.().pairsTotal ?? null
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
    backtestJob.beat({ extra: { cycles: backtestState.cycles ?? null } });
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

// ═══ طبقة بيانات السوق الحية (WebSocket) — أسعار كل السوق + شموع + تدفق صفقات ═══
// مصدر واحد لكل المستهلكين: صفر نداءات REST للأسعار، شموع حية، CVD/فقاعات لحظية.
// حدود الذاكرة (إصلاح OOM الإنتاج): بذر 250 شمعة + سقف 400/مفتاح + 1500 صفقة/رمز + 6 اتصالات.
const marketStreams = createMarketStreams({
  seedKlines: (symbol, timeframe, limit) => db.binance.klines(symbol, timeframe, limit),
  log: console,
  config: {
    seedLimit: Number(process.env.MARKET_SEED_LIMIT) || 250,
    maxBarsKept: Number(process.env.MARKET_MAX_BARS) || 400,
    maxTradesPerSymbol: Number(process.env.MARKET_MAX_TRADES) || 1500,
    maxConns: Number(process.env.MARKET_MAX_CONNS) || 6
  },
  fetchAllPrices: () => db.binance.allTickerPrices()
});
setTimeout(() => marketStreams.start(), 20_000); // ينطلق مع استقرار الخادم
// ربط حالة السوق بصفحة الصحة العميقة
runtime.marketStats = () => marketStreams.stats();
// ربط المحدد ووضع الظل بالتشخيص (بعد تهيئة runtime — منع TDZ)
runtime.rateLimiter = () => rateLimiter.stats();
runtime.shadow = () => shadow.summary();
/** دليل الاستعادة من المخزن الدائم (يُملأ بعد الإقلاع، فالقراءة عبر دالة) */
runtime.stateRestore = () => stateRestoreInfo;
/** مخزون المناطق لحظياً — يُقرأ في الفحص العميق ويُسجَّل في العيّنات */
runtime.zones = () => {
  const live = capState(liquidityState.liveResults.length, LIVE_MAX_ZONES);
  const history = capState(liquidityState.historyResults.length, HISTORY_MAX_ZONES);
  return {
    live: { ...live, rotation: liquidityState.liveRotation, pairsDone: liquidityState.livePairsDone, pairsTotal: liquidityState.livePairsTotal, skipReason: liquidityState.liveSkipReason ?? null },
    history: { ...history, rotation: liquidityState.historyRotation, pairsDone: liquidityState.historyPairsDone, pairsTotal: liquidityState.historyPairsTotal }
  };
};
runtime.dataFresh = () => {
  const s = marketStreams.stats();
  const problems = [];
  const cfg = marketStreams.config ?? {};
  if (!s.connected) problems.push('بث السوق غير متصل');
  if (s.priceAgeMs === null) problems.push('لا أسعار بعد');
  else if (s.priceAgeMs > marketStreams.priceStaleMs) problems.push(`آخر سعر عمره ${Math.round(s.priceAgeMs / 1000)}ث`);
  if (s.silentConns > 0) problems.push(`${s.silentConns} اتصال صامت`);
  // نقيس *نسبة* العملات المتقادمة لا «أحدث سعر في السوق» فقط:
  // وجود سعر واحد حديث لا يعني أن السوق متابَع — 39% من الرموز قد تكون مجمّدة.
  const maxStaleRatio = Number(process.env.STALE_PRICE_RATIO_MAX || 0.05);
  if (s.stalePriceRatio !== null && s.stalePriceRatio > maxStaleRatio) {
    problems.push(`${s.stalePrices} رمزاً سعره متقادم (${Math.round(s.stalePriceRatio * 100)}%)`);
  }
  /**
   * «مفتاح شموع متأخر» على كل الاشتراكات ليس عيباً بذاته: بينانس لا تدفع تحديث شمعة
   * لرمز بلا صفقات. العيب الحقيقي أن يكون الرمز قد تداول فعلاً ولم تُدفع شمعته —
   * وهذا ما يقيسه `tradingStaleCandles`. الأول يُعرض للعلم، والثاني هو إشارة الجاهزية.
   */
  const maxSilentKeys = Number(process.env.STALE_CANDLE_KEYS_MAX || 0);
  if (s.tradingStaleCandles > maxSilentKeys) {
    problems.push(`${s.tradingStaleCandles} مفتاح شموع صامت لرموز تداولت خلال آخر دقيقة`);
  }
  if (!s.klineSubs) problems.push('لا شموع مشتركة بعد');
  return {
    ok: problems.length === 0,
    reason: problems.join(' · ') || 'البيانات حديثة',
    stalePriceRatioMax: maxStaleRatio,
    stats: s
  };
};

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
  // الأولوية للبث الحي (!miniTicker يغذي كل السوق بلا REST) — يوفر معظم egress ويتجاوز حجب 451.
  fetchPrices: async (symbols) => {
    try {
      if (marketStreams.connected()) {
        const live = marketStreams.getPrices(symbols);
        if (symbols.every(s => Number.isFinite(live[s]))) return live;
      }
    } catch { /* سقط للاحتياطي REST */ }
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
  market: marketStreams,
  readCalibration: readLiveCalibration,
  broadcast: (msg) => broadcast(msg),
  persist: (row) => saveLiquidityEvent(
    row?.closed ? 'live_opportunity_closed' : row?.type === 'live_calibration' ? 'live_calibration' : row?.type === 'live_rejected' ? 'live_opportunity_rejected' : row?.type === 'live_lifecycle' ? 'live_lifecycle' : 'live_opportunity',
    { symbol: row?.symbol || 'GLOBAL' },
    row?.type === 'live_calibration'
      ? `معايرة الفرص الحية: ${row.segments?.length ?? 0} شريحة / ${row.trades ?? 0} صفقة`
      : row?.closed
        ? `نتيجة فرصة ${row.symbol} ${row.timeframe}: ${row.outcome === 'target' ? 'وصل الهدف' : 'ضرب الوقف'}`
        : row?.type === 'live_rejected'
          ? `رفض ما بعد السويب ${row.symbol} ${row.timeframe}: ${row.reason}`
          : row?.type === 'live_lifecycle'
            ? `دورة حياة ${row.kind} ${row.symbol} ${row.timeframe ?? ''}`
            : `فرصة شراء ${row.symbol} ${row.timeframe} — درجة ${row.composite} / R:R ${row.rr}`,
    row?.type === 'live_lifecycle' ? row : { opportunity: row }
  ),
  log: console,
  config: {
    maxKlineSubs: Number(process.env.LIVE_MAX_KLINE_SUBS) || 600,
    maxFlowSubs: Number(process.env.LIVE_MAX_FLOW_SUBS) || 60,
    calibration: {
      symbols: Number(process.env.LIVE_CALIB_SYMBOLS) || 48,
      bars: Number(process.env.LIVE_CALIB_BARS) || 1000,
      concurrency: Number(process.env.LIVE_CALIB_CONC) || 2
    }
  },
  workers: workerPool,
  shadow
});
setTimeout(() => {
  // استعادة الحالات النشطة قبل بدء الدورات (عقيدة §12): إغلاق النظام لا يقتل التتبع
  void (async () => {
    try {
      const day = 86_400_000;
      const [lc, ops] = await Promise.all([
        db.events.liveLifecycle(Date.now() - day).catch(() => []),
        db.events.liveOppEvents(Date.now() - 7 * day).catch(() => [])
      ]);
      liveOppEngine.rehydrate([...(lc || []), ...(ops || [])]);
    } catch (e) {
      console.error('[live-opp] rehydrate failed:', e.message);
    } finally {
      liveOppEngine.start();
    }
  })();
}, 75_000); // يبدأ بعد استقرار اللفّات القائمة (مناطق السيولة + الفرص + الباك تيست)

// ═══ محرك «الفرص الحية — استراتيجيتي» — SMC كامل: قمم/قيعان محمية بخطواتها الخمس ═══
// هيكل خارجي/داخلي · بريميوم/ديسكاونت · choch up · نموذجا دخول · نقاط فشل موثقة.
// يشارك طبقة البيانات الحية (tenant مستقل) ويحترم محدد الطلبات الموحد.

const readStrategy2Calibration = async () => {
  try {
    const row = await db.events.strategy2Calibration().catch(() => null);
    if (!row) return null;
    const meta = typeof row.meta === 'string' ? JSON.parse(row.meta) : row.meta;
    const data = meta?.opportunity ?? meta ?? {};
    return { at: Number(row.ts) || null, trades: data.trades ?? 0, segments: data.segments ?? [] };
  } catch {
    return null;
  }
};

const readStrategy2PublishedEvents = async () => {
  try {
    const rows = await db.events.strategy2Events(0, 2000);
    return rows.map(r => {
      let meta = {};
      try { meta = JSON.parse(r.meta ?? '{}'); } catch { /* meta تالفة تُتجاهل */ }
      const o = meta.opportunity ?? {};
      return {
        kind: r.type === 'strategy2_published' ? 'published' : 'resolved',
        id: o.id ?? null, ts: r.ts, ...o
      };
    }).filter(e => e.id);
  } catch {
    return [];
  }
};

const strategy2Engine = createStrategyEngine({
  resolveTargets: () => resolveTargets(),
  fetchRawKlines: (symbol, timeframe, limit, startTime) => db.binance.klines(symbol, timeframe, limit, startTime),
  fetchPrices: async (symbols) => {
    try {
      if (marketStreams.connected()) {
        const live = marketStreams.getPrices(symbols);
        if (symbols.every(s => Number.isFinite(live[s]))) return live;
      }
    } catch { /* سقط للاحتياطي REST */ }
    const all = await db.binance.allTickerPrices().catch(() => null);
    if (all && Object.keys(all).length) {
      const out = {};
      for (const s of symbols) if (Number.isFinite(all[s])) out[s] = all[s];
      return out;
    }
    return db.binance.tickerPrices(symbols).catch(() => ({}));
  },
  market: marketStreams,
  readCalibration: readStrategy2Calibration,
  readPublishedEvents: readStrategy2PublishedEvents,
  readFeedbackEvents: () => db.events.strategy2FeedbackEvents(0, 2000).catch(() => []),
  readDirectionEvents: async () => {
    try {
      const rows = await db.events.strategy2DirectionEvents(0, 2000);
      return rows.map(r => {
        let meta = {};
        try { meta = JSON.parse(r.meta ?? '{}'); } catch { /* meta تالفة تُتجاهل */ }
        const o = meta.opportunity ?? {};
        return { ...o, symbol: o.symbol || r.symbol, at: o.at ?? r.ts };
      }).filter(e => e.symbol);
    } catch {
      return [];
    }
  },
  broadcast: (msg) => broadcast(msg),
  persist: (row) => {
    if (row?.directionEvent) {
      return saveLiquidityEvent(
        'strategy2_direction',
        { symbol: row.symbol },
        `${row.symbol}: ${row.label} — المرحلة: ${row.stage}`,
        { opportunity: row }
      );
    }
    return saveLiquidityEvent(
      row?.closed ? 'strategy2_resolved' : row?.type === 'strategy2_calibration' ? 'strategy2_calibration' : 'strategy2_published',
      { symbol: row?.symbol || 'GLOBAL' },
      row?.type === 'strategy2_calibration'
        ? `معايرة استراتيجيتي: ${row.segments?.length ?? 0} شريحة / ${row.trades ?? 0} صفقة`
        : row?.closed
          ? `نتيجة فرصة ${row.symbol} ${row.tf}: ${row.outcome === 'target' ? 'وصل الهدف' : row.outcome === 'target2' ? 'وصل الهدف الثاني' : row.outcome === 'invalidated' ? 'فشل نقطة الدخول' : row.outcome === 'legDead' ? 'موت المشوار — بلوغ العرض الخارجي' : 'ضرب الوقف'}`
          : `فرصة استراتيجيتي ${row.symbol} ${row.tf} — نموذج ${row.model} / R:R ${row.rr}`,
      { opportunity: row }
    );
  },
  log: console,
  config: {
    // إصلاح OOM: 462 رمز × 3 فريمات × 500 شمعة كان يقتل الحاوية (heap 455MB).
    // 180 رمز × 3 × 250 = ~135k شمعة بدل ~693k (خفض ~80%).
    maxSymbols: Number(process.env.STRATEGY2_MAX_SYMBOLS) || 180,
    analysisWindow: Number(process.env.STRATEGY2_WINDOW) || 400,
    warmupBars: Number(process.env.STRATEGY2_WARMUP) || 200,
    // فريمات الدخول (والأكبر ×8 تلقائياً): افتراضياً من الدقيقة — قابلة للضبط عبر البيئة
    entryTfs: (() => {
      const list = (process.env.STRATEGY2_ENTRY_TFS || '1m,5m,15m').split(',')
        .map(s => s.trim().toLowerCase()).filter(s => /^(\d+)(m|h|d|w)$/.test(s));
      return list.length ? list : ['1m', '5m', '15m'];
    })(),
    calibration: {
      symbols: Number(process.env.STRATEGY2_CALIB_SYMBOLS) || 48,
      bars: Number(process.env.STRATEGY2_CALIB_BARS) || 1500,
      concurrency: Number(process.env.STRATEGY2_CALIB_CONC) || 2
    }
  },
  shadow
});
setTimeout(() => strategy2Engine.start(), 95_000); // بعد محرك الفرص الأول (اشتراكات WS متسلسلة)

app.get('/api/strategy2/feed', handle(async (req, res) => {
  const feed = strategy2Engine.getFeed();
  const q = {
    symbol: req.query.symbol, tf: req.query.tf, model: req.query.model,
    tier: req.query.tier, htfDir: req.query.htfDir,
    sort: req.query.sort, limit: req.query.limit, offset: req.query.offset
  };
  const { rows, total } = strategy2Engine.queryFeed(q);
  res.json({ ...feed, opportunities: rows, total, filtered: total !== feed.total });
}));

app.get('/api/strategy2/status', handle(async (_req, res) => {
  res.json(strategy2Engine.getStatus());
}));

// سجل الاتجاهات الحي لكل العملات — فلترة وترتيب على الخادم قبل أي قص
app.get('/api/strategy2/directions', handle(async (req, res) => {
  const q = {
    symbol: req.query.symbol, tf: req.query.tf, dir: req.query.dir, stage: req.query.stage,
    dead: req.query.dead, agreement: req.query.agreement,
    sort: req.query.sort, limit: req.query.limit, offset: req.query.offset
  };
  const { rows, total } = strategy2Engine.queryDirections(q);
  // «مفلترة» تعني فلاتر فعلية من المستخدم — لا مجرد قص الصفحة
  const hasFilter = ['symbol', 'tf', 'dir', 'stage', 'dead', 'agreement'].some(k => req.query[k] != null && String(req.query[k]).trim() !== '');
  res.json({
    summary: strategy2Engine.getDirectionsSummary(q.tf),
    directions: rows,
    total,
    filtered: hasFilter,
    updatedAt: Date.now()
  });
}));

app.get('/api/strategy2/calibration', handle(async (_req, res) => {
  res.json(strategy2Engine.getCalibration());
}));

app.get('/api/strategy2/history', handle(async (req, res) => {
  const days = Math.min(Math.max(Number(req.query.days) || 90, 1), 365);
  const sinceTs = Date.now() - days * 86_400_000;
  const rows = await db.events.strategy2Events(sinceTs).catch(() => []);
  const events = [];
  for (const r of rows) {
    let meta = {};
    try { meta = JSON.parse(r.meta ?? '{}'); } catch { /* meta تالفة تُتجاهل */ }
    const o = meta.opportunity ?? {};
    events.push({
      kind: r.type === 'strategy2_published' ? 'published' : 'resolved',
      ts: r.ts, id: o.id ?? null,
      symbol: o.symbol ?? r.symbol, tf: o.tf ?? null,
      model: o.model ?? null, htfDirection: o.htfDirection ?? null,
      afterPremium: o.afterPremium ?? null,
      tier: o.tier ?? null, segmentKey: o.segmentKey ?? null,
      entry: o.entry ?? null, stop: o.stop ?? null, tp1: o.tp1 ?? null, tp2: o.tp2 ?? null,
      rr: o.rr ?? null,
      detectedAt: o.detectedAt ?? (r.type === 'strategy2_published' ? r.ts : null),
      outcome: r.type === 'strategy2_resolved' ? (o.outcome ?? null) : null,
      resolvedAt: r.type === 'strategy2_resolved' ? (o.outcomeAt ?? r.ts) : null,
      durationMs: r.type === 'strategy2_resolved' && o.outcomeAt && o.detectedAt
        ? Math.max(0, o.outcomeAt - o.detectedAt) : null,
      mfeR: o.mfeR ?? null, maeR: o.maeR ?? null
    });
  }
  const resolvedById = new Map(events.filter(e => e.kind === 'resolved' && e.id).map(e => [e.id, e]));
  const timeline = [];
  for (const e of events) {
    if (e.kind !== 'published') continue;
    const r = resolvedById.get(e.id);
    timeline.push({
      ...e,
      outcome: r?.outcome ?? null,
      resolvedAt: r?.resolvedAt ?? null,
      durationMs: r?.durationMs ?? null,
      mfeR: Math.max(e.mfeR ?? 0, r?.mfeR ?? 0) || null,
      maeR: Math.min(e.maeR ?? 0, r?.maeR ?? 0) || null
    });
  }
  timeline.sort((a, b) => b.ts - a.ts);
  res.json({
    days,
    timeline,
    active: strategy2Engine.getFeed().opportunities.map(o => ({
      id: o.id, symbol: o.symbol, tf: o.tf, tier: o.tier ?? null, detectedAt: o.detectedAt
    })),
    generatedAt: Date.now()
  });
}));

// ---- ذاكرة الشارت المستمرة CSSE: حالة (رمز|فريم) + عناصر + أحداث + علاقات ----
app.get('/api/strategy2/csse', handle(async (req, res) => {
  res.json(strategy2Engine.getCsse(
    req.query.symbol ? String(req.query.symbol) : undefined,
    req.query.tf ? String(req.query.tf) : undefined
  ) ?? { version: 'csse-v1', empty: true });
}));

// ---- التصحيح البشري: تعليق مُصدَر قابل للعكس على عنصر (لا يمس قواعد النواة) ----
const FEEDBACK_VERDICTS = ['valid', 'invalid', 'note'];
app.get('/api/strategy2/feedback', handle(async (req, res) => {
  res.json(strategy2Engine.listFeedback({ limit: req.query.limit }));
}));

app.post('/api/strategy2/feedback', handle(async (req, res) => {
  const symbol = assertSymbol(req.body?.symbol, res);
  if (!symbol) return;
  const verdict = FEEDBACK_VERDICTS.includes(req.body?.verdict) ? req.body.verdict : null;
  if (!verdict) return res.status(400).json({ error: 'verdict يجب أن يكون valid أو invalid أو note' });
  const elementId = sanitizeText(req.body?.elementId, 200);
  if (!elementId) return res.status(400).json({ error: 'elementId مطلوب' });
  const reason = sanitizeText(req.body?.reason, 500);
  const revokes = req.body?.revokes != null ? sanitizeText(req.body.revokes, 100) : null;
  const tf = String(req.body?.tf ?? '').slice(0, 8);
  if (tf && !/^(\d+)(m|h|d|w|M)$/.test(tf)) return res.status(400).json({ error: 'فريم غير مدعوم' });
  const fb = strategy2Engine.addFeedback({ elementId, symbol, tf, verdict, reason, revokes });
  await db.events.strategy2FeedbackSave(fb).catch(() => undefined);
  broadcast({ type: 'strategy2_feedback', feedback: fb });
  res.json({ ok: true, feedback: fb });
}));

app.post('/api/strategy2/run', handle(async (_req, res) => {
  res.json({ ok: true, started: true });
  void strategy2Engine.runCycle().catch(() => undefined);
}));

app.post('/api/strategy2/calibrate', handle(async (req, res) => {
  const symbols = Array.isArray(req.body?.symbols) && req.body.symbols.length
    ? req.body.symbols.map(s => String(s).toUpperCase().trim()).filter(s => /^[A-Z0-9]{4,20}$/.test(s))
    : null;
  res.json({ ok: true, started: true, symbols: symbols?.length ?? null });
  void strategy2Engine.runCalibration({ symbols }).catch(() => undefined);
}));

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

// المسار القديم (كان يخدم اللفة القديمة) — يوجَّه الآن لمخزن المحرك الحي نفسه
app.get('/api/live/opportunities', handle(async (_req, res) => {
  const feed = liveOppEngine.getFeed();
  res.json({
    busy: feed.busy,
    rotation: feed.cycle,
    pairsDone: feed.pairsTotal,
    pairsTotal: feed.pairsTotal,
    opportunities: feed.opportunities,
    total: feed.total,
    updatedAt: feed.updatedAt,
    error: feed.error
  });
}));

app.get('/api/live-opportunities/status', handle(async (_req, res) => {
  res.json(liveOppEngine.getStatus());
}));

app.get('/api/live-opportunities/calibration', handle(async (_req, res) => {
  res.json(liveOppEngine.getCalibration());
}));

// السجل التاريخي: بلا days → الذاكرة (توافق قديم)؛ مع days → الأحداث الدائمة من events_log
// (يغذي لوحة التحكم: تقويم/ساعات/KPIs/جدول — والنتائج تُدمج على أحداث النشر)
app.get('/api/live-opportunities/history', handle(async (req, res) => {
  if (req.query.days === undefined) {
    res.json(liveOppEngine.getHistory());
    return;
  }
  const days = Math.min(Math.max(Number(req.query.days) || 90, 1), 365);
  const sinceTs = Date.now() - days * 86_400_000;
  const rows = await db.events.liveOppEvents(sinceTs).catch(() => []);
  const events = [];
  for (const r of rows) {
    let meta = {};
    try { meta = JSON.parse(r.meta ?? '{}'); } catch { /* meta تالفة تُتجاهل */ }
    const o = meta.opportunity ?? {};
    events.push({
      kind: r.type === 'live_opportunity' ? 'published' : 'resolved',
      ts: r.ts, id: o.id ?? null,
      symbol: o.symbol ?? r.symbol, timeframe: o.timeframe ?? null,
      tier: o.tier ?? null, segmentKey: o.segmentKey ?? null,
      entry: o.entry ?? null, stop: o.stop ?? null, tp: o.tp ?? null,
      rr: o.rr ?? null, composite: o.composite ?? null,
      calibratedWinRate: o.calibratedWinRate ?? null,
      detectedAt: o.detectedAt ?? (r.type === 'live_opportunity' ? r.ts : null),
      outcome: r.type === 'live_opportunity_closed' ? (o.outcome ?? null) : null,
      resolvedAt: r.type === 'live_opportunity_closed' ? (o.outcomeAt ?? r.ts) : null,
      durationMs: r.type === 'live_opportunity_closed' && o.outcomeAt && o.detectedAt
        ? Math.max(0, o.outcomeAt - o.detectedAt) : null,
      mfeR: o.mfeR ?? null, maeR: o.maeR ?? null
    });
  }
  const resolvedById = new Map(events.filter(e => e.kind === 'resolved' && e.id).map(e => [e.id, e]));
  const timeline = [];
  for (const e of events) {
    if (e.kind !== 'published') continue;
    const r = resolvedById.get(e.id);
    timeline.push({
      ...e,
      outcome: r?.outcome ?? null,
      resolvedAt: r?.resolvedAt ?? null,
      durationMs: r?.durationMs ?? null,
      mfeR: Math.max(e.mfeR ?? 0, r?.mfeR ?? 0) || null,
      maeR: Math.min(e.maeR ?? 0, r?.maeR ?? 0) || null
    });
  }
  timeline.sort((a, b) => b.ts - a.ts);
  res.json({
    days,
    timeline,
    active: liveOppEngine.getFeed().opportunities.map(o => ({
      id: o.id, symbol: o.symbol, timeframe: o.timeframe, tier: o.tier ?? null, detectedAt: o.detectedAt
    })),
    generatedAt: Date.now()
  });
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

// شارت بصري لمنطقة قيد المراقبة: نفس محرك الرسم — المرجع/السيولة فقط (بلا خطة بعد)
app.get('/api/live-opportunities/watch/:symbol/:timeframe/:zoneId/screenshot', handle(async (req, res) => {
  const symbol = String(req.params.symbol || '').toUpperCase();
  const timeframe = String(req.params.timeframe || '').toLowerCase();
  const zoneId = String(req.params.zoneId || '');
  const zone = (liquidityState.liveResults ?? []).find(z =>
    String(z?.symbol).toUpperCase() === symbol && String(z?.timeframe).toLowerCase() === timeframe && String(z?.id) === zoneId);
  if (!zone || !Number.isFinite(Number(zone.referenceLevel))) return res.status(404).json({ error: 'منطقة غير موجودة في المخزون الحي' });
  const raw = await db.binance.klines(symbol, timeframe, 160);
  const candles = normalizeCandles(raw);
  const zoneLike = {
    symbol, timeframe, kind: zone.kind ?? 'ssl',
    state: `مراقبة · ثقة ${zone.confidence ?? '?'} · لمسات ${zone.touches ?? '?'}`,
    referenceLevel: Number(zone.referenceLevel),
    liquidityLevel: Number(zone.liquidityLevel ?? zone.referenceLevel),
    detectedAt: Date.now(),
    extraLevels: [],
    reasons: [`مرجع ${zone.referenceLevel} · سيولة ${zone.liquidityLevel ?? '—'}`]
  };
  res.type('image/svg+xml').send(renderZoneChart(zoneLike, candles, candles.length - 1));
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
      /**
       * الأسعار من البث الحي أولاً (بلا شبكة ولا كلفة)، وREST فقط للرموز التي لا سعر
       * حي لها. السبب المقيس: كان الطلب عبر REST لكل الرموز كل 30 ثانية، وفيه كلفة
       * وحجب على محدّد المعدل، مع أن السعر نفسه موجود في الذاكرة لحظياً.
       */
      const prices = {};
      const missing = [];
      for (const sym of symbols) {
        const p = marketStreams.getFreshPrice(sym);
        if (Number.isFinite(p) && p > 0) prices[sym] = p;
        else missing.push(sym);
      }
      if (missing.length) {
        const fetched = await db.binance.tickerPrices(missing);
        Object.assign(prices, fetched);
      }
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

// (نُقل إلى أعلى قبل /:symbol — إصلاح ظل التوجيه)

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

/**
 * الأنواع المسموح بكتابتها من الواجهة — قائمة بيضاء صريحة.
 * العلة (C1): كان المسار يقبل أي نوع حدث، فيمكن حقن «فرصة» أو «نتيجة» مزيفة تُستعاد
 * بعد إعادة التشغيل كأنها حقيقية، وتُفسد إحصاءات الأداء وسجل القرارات. الأنواع
 * التشخيصية التي يكتبها الخادم نفسه لم تعد قابلة للكتابة من الخارج إطلاقاً.
 */
const CLIENT_WRITABLE_EVENT_TYPES = new Set([
  'decision_analysis', 'decision_analysis_edit', 'decision_entry', 'decision_no_entry',
  'decision_exit', 'decision_note', 'zone_reviewed', 'zone_feedback',
  'strategy2_feedback', 'manual_note', 'central_notification', 'choch_check'
]);
const MAX_EVENT_TEXT = 4000;

app.post('/api/events', handle(async (req, res) => {
  const { symbol, type, message, meta } = req.body ?? {};
  if (!symbol || !type || !message) return res.status(400).json({ error: 'symbol, type, message required' });
  if (!CLIENT_WRITABLE_EVENT_TYPES.has(String(type))) {
    return res.status(400).json({ error: 'نوع الحدث غير مسموح من الواجهة', allowed: [...CLIENT_WRITABLE_EVENT_TYPES] });
  }
  const sym = String(symbol).toUpperCase().slice(0, 24);
  if (!/^[A-Z0-9_]{2,24}$/.test(sym)) return res.status(400).json({ error: 'رمز غير صالح' });
  const rows = await db.events.create({
    symbol: sym,
    type: String(type),
    // تقليم النصوص: يمنع تضخيم السجل ومحتوى ضار
    message: String(message).slice(0, MAX_EVENT_TEXT),
    meta: meta ? String(typeof meta === 'string' ? meta : JSON.stringify(meta)).slice(0, 20000) : null,
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
// robots.txt صريح — كان يسقط في fallback الـSPA ويعيد index.html بـ200 (مضلل للزحف)
app.get('/robots.txt', (_req, res) => {
  res.type('text/plain').send('User-agent: *\nAllow: /\nDisallow: /api/\n');
});
// favicon صامت (204) — يمنع ضجيج 404 في كونسول المتصفح بلا أيقونة وهمية
app.get('/favicon.ico', (_req, res) => res.status(204).end());
app.use((req, res, next) => {
  if (req.method === 'GET' && !req.path.startsWith('/api')) {
    // ملفات ستاتيكية مفقودة (أيقونات/خرائط/نصوص) → 404 بدل صفحة SPA
    if (/\.(ico|png|jpe?g|svg|txt|xml|map|json|webmanifest)$/i.test(req.path) && req.path !== '/') {
      return res.status(404).type('text/plain').send('not found');
    }
    // البناء ناقص (client/dist بلا index.html) → 503 صريح بدل كراش sendFile — يُرى في سجلات Railway مباشرة
    if (!fs.existsSync(path.join(distDir, 'index.html'))) {
      return res.status(503).json({ error: 'client build missing (client/dist/index.html not found)' });
    }
    res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    res.sendFile('index.html', { root: distDir }, (err) => { if (err) next(err); });
  } else {
    next();
  }
});
// معالج أخطاء عام أخير: JSON نظيف دائماً بدل صفحة HTML — يمنع تسرب stack للإنتاج
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[http]', req.method, req.path, err instanceof Error ? err.message : err);
  if (res.headersSent) return next(err);
  const status = err && typeof err.status === 'number' ? err.status : 500;
  res.status(status).json({ error: status === 413 ? 'payload too large (max 1mb)' : 'internal error' });
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

server.listen(PORT, () => {
  const distOk = fs.existsSync(path.join(distDir, 'index.html'));
  console.log(`[server] listening on http://localhost:${PORT} (+ ws:/ws) dist=${distOk ? 'ok' : 'MISSING'}`);
});

// عدّاد الأعمال الثقيلة في صفحة الصحة (طابور العمال ومهلهم وأعطالهم)
runtime.workers = () => workerPool.snapshot();
runtime.marketStatsRaw = runtime.marketStats;

/**
 * إغلاق سليم: يحفظ نبضة أخيرة ثم يوقف العمال.
 * عند أي خطأ قاتل يخرج الخادم فوراً بلا حفظ — وهذا يُصلحه.
 */
let shuttingDown = false;
const shutdown = async (signal) => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[server] إغلاق سليم (${signal})…`);
  try { await healthSampler.write(); } catch { /* نبضة أخيرة اختيارية */ }
  try { await workerPool.close(); } catch { /* ignore */ }
  try { marketStreams.stop(); } catch { /* ignore */ }
  try { server.close(); } catch { /* ignore */ }
  // مهلة قصوى للإغلاق ثم خروج إجباري
  setTimeout(() => process.exit(0), 3000).unref?.();
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
onFatalShutdown = shutdown; // الخطأ القاتل يستخدم نفس المسار فيحفظ الحالة قبل الخروج

// ربط أقسام الجاهزية بالعيّنات المحفوظة (دليل الحكم على 72 ساعة)
health.addSection('market', () => { try { return runtime.marketStats(); } catch { return null; } });
health.addSection('targets', () => { try { return { ...runtime.targets(), source: runtime.targetsSource() }; } catch { return null; } });
health.addSection('shariah', () => { try { return runtime.shariahVerdicts(); } catch { return null; } });
health.addSection('dataFresh', () => { try { return runtime.dataFresh(); } catch { return null; } });
health.addSection('workers', () => { try { return runtime.workers?.() ?? null; } catch { return null; } });
health.addSection('rateLimiter', () => { try { return runtime.rateLimiter?.() ?? null; } catch { return null; } });
/**
 * مخزون المناطق في العيّنات: بلا هذا لا يُرى نمو الذاكرة إلا بعد موت الحاوية.
 * يُعرض كمّ المناطق وسقف كل مخزون ونسبة الاستهلاك.
 */
health.addSection('zones', () => { try { return runtime.zones(); } catch { return null; } });
/**
 * دليل بقاء الحالة عبر إعادات التشغيل (تعلّم المراجعات + قياس ★) — يُسجَّل في العيّنات
 * حتى يُرى بعد كل نشر أن الحالة عادت فعلاً، لا أن تُفترض.
 */
health.addSection('stateRestore', () => { try { return runtime.stateRestore?.() ?? null; } catch { return null; } });
health.addSection('shadow', () => { try { return runtime.shadow?.() ?? null; } catch { return null; } });
/** ★2 قياس: نسبة دوران هوية المنطقة تتراكم في العيّنات فيصير للقرار دليل رقمي */
health.addSection('zoneIdentity', () => { try { return zoneIdentityCollector.summary(); } catch { return null; } });

// عيّنات الصحة الدورية — دليل التشغيل المستمر يُكتب في القاعدة كل 5 دقائق
const healthSampler = health.startSampler({
  db,
  intervalMs: Number(process.env.HEALTH_SAMPLE_MIN || 5) * 60 * 1000,
  log: console
});

// مراقب دوري لحداثة بيانات السوق: يحاول إصلاح فجوات الشموع ويُظهر الحالة
setInterval(() => {
  try {
    const r = marketStreams.refreshStaleKlines({ maxKeys: 30 });
    if (r > 0) console.log(`[market-streams] re-seeded ${r} stale kline keys`);
  } catch (e) {
    console.error('[market-streams] stale repair failed:', e.message);
  }
}, 60_000);

// ——— الحكم الشرعي على الخادم: النظام يعمل بلا متصفح ———
// الإصلاح الجوهري: كانت الأحكام تُحسب في المتصفح فقط، فتبقى كل العملات «غير محسومة»
// حتى يفتح أحدٌ التطبيق، فترفض المحركات كل المستهدفات وتتوقف عن العمل.
const shariahJob = health.register('shariah-resolver', { stallMs: 30 * 60 * 1000 });

/**
 * نبضات المحركات الخلفية — أساس كشف التعليق في التشغيل المستمر.
 * مُهل التعليق مشتقة من دورة كل محرك الفعلية (لا أرقام عشوائية).
 */
const liquidityJob = health.register('liquidity-zones', { stallMs: 1_800_000 });   // كل 5 دقائق
const liveJob = health.register('live-opportunities', { stallMs: 900_000 });        // كل 5 ثوان
const backtestJob = health.register('backtest', { stallMs: 1_800_000 });            // كل 5 دقائق
const strategy2Job = health.register('strategy2', { stallMs: 900_000 });            // كل 15 ثانية
const marketJob = health.register('market-streams', { stallMs: 300_000 });          // دورية دقيقة

/**
 * نبضات محركات الفرص واستراتيجيتي: تُقرأ حالتهما المعلنة دورياً.
 * إن توقف العدّاد (cycle) عن التقدّم فالتقرير يكشف التعليق قبل تراكم الأثر.
 */
let lastLiveCycle = -1;
let lastS2Cycle = -1;
setInterval(() => {
  try {
    const st = liveOppEngine.getStatus?.();
    if (st) {
      const advanced = st.cycle !== lastLiveCycle;
      lastLiveCycle = st.cycle;
      /**
       * الحقول هنا هي أسماء `getStatus()` الفعلية. سابقاً كانت تُقرأ أسماء غير موجودة
       * (`tracked`, `lastRunMs`) فتظهر في عيّنات الصحة `null` دائماً — أي أن المحرك كان
       * يعمل ولا يُقاس شيء منه، وهذا أسوأ من غياب القياس.
       */
      liveJob.beat({
        extra: {
          cycle: st.cycle,
          zonesTracked: st.zonesTracked ?? null,
          pairsTotal: st.pairsTotal ?? null,
          deepScans: st.deepScans ?? null,
          bookCalls: st.bookCalls ?? null,
          updatedAt: st.updatedAt ?? null,
          /** ★3: فرق العدّ المنشور عن العدّ عند الحسم فقط */
          segmentsShadow: st.segmentsShadow ?? null
        }
      });
      /**
       * ★3 قياس: يُغذّى مجمّع الظل بتقرير مقارنة العدّ كل دورة، فتكفي عيّنات قليلة
       * لإظهار حجم التضخّم وعدد الشرائح التي يتغيّر حكم تأهيلها. القياس لا يقرأه أي قرار.
       */
      try {
        const seg = st.segmentsShadow;
        if (seg && seg.keys > 0 && shadow) {
          shadow.compare(
            'segments-decided-only',
            { qualified: seg.qualifiedPublished, total: seg.publishedTotal, min: seg.minSegmentTrades },
            { qualified: seg.qualifiedDecided, total: seg.decidedTotal, min: seg.minSegmentTrades },
            (a, b) => a?.qualified === b?.qualified,
            { inflation: seg.inflation }
          );
        }
      } catch { /* القياس لا يعطّل المحرك */ }
      if (!advanced && st.busy) liveJob.set({ busy: true });
    }
  } catch (e) { liveJob.fail(e); }
  try {
    const st2 = strategy2Engine.getStatus?.();
    if (st2) {
      lastS2Cycle = st2.cycle;
      strategy2Job.beat({
        extra: {
          cycle: st2.cycle,
          scope: st2.scope,
          busy: st2.busy,
          pairsTotal: st2.pairsTotal ?? null,
          waitingPhases: st2.waitingPhases ?? null,
          calibration: st2.calibration ? { trades: st2.calibration.trades, busy: st2.calibration.busy, segments: st2.calibration.segments, error: st2.calibration.error } : null,
          failures: (st2.failures ?? []).length
        }
      });
    }
  } catch (e) { strategy2Job.fail(e); }
}, 30_000);
/**
 * مراقب الإحياء: الكشف وحده لا يكفي لتشغيل 24 ساعة والجهاز مغلق. إذا ثبت تعليق
 * محرك (لا دورة منذ مهلة التعليق) تُستأنف الحلقة — إعادة تشغيل الحلقة لا تُفقد حالة:
 * الفرص والمناطق محفوظة، والدورة التالية تتكامل مع الموجود.
 * الحد: محاولة واحدة كل 10 دقائق لكل محرك، وبسقف 5 محاولات، ثم تحذير صريح بلا إصرار
 * عنيد (إعادة التشغيل المتكررة بلا فائدة مؤشر عطل عميق يستحق ظهوراً لا إخفاءً).
 */
const revivals = new Map(); // name → { at, count }
const reviveCandidates = [
  { name: 'live-opportunities', revive: () => { liveOppEngine.stop?.(); liveOppEngine.start?.(); }, enabled: () => Number(process.env.AUTO_REVIVE ?? 1) === 1 },
  { name: 'strategy2', revive: () => { strategy2Engine.stop?.(); strategy2Engine.start?.(); }, enabled: () => Number(process.env.AUTO_REVIVE ?? 1) === 1 }
];
setInterval(() => {
  for (const cand of reviveCandidates) {
    try {
      const snap = health.snapshot().engines.find(e => e.name === cand.name);
      const live = Number(process.env.AUTO_REVIVE ?? 1) === 1;
      const { action, record, warn } = reviveDecision(snap, revivals.get(cand.name), Date.now(), { enabled: live });
      if (action === 'idle') { revivals.delete(cand.name); liveJob.set({ revivals: Object.fromEntries([...revivals].map(([k, v]) => [k, v.count])) }); continue; }
      if (action === 'exhausted') {
        if (warn) console.error(`[revive] ${cand.name} متوقف ${Math.round((snap.sinceCycleMs ?? 0) / 1000)}ث، وتجاوز ${REVIVE_MAX} محاولات — يحتاج تدخلاً`);
        continue;
      }
      if (action !== 'revive') continue;
      revivals.set(cand.name, record);
      console.error(`[revive] إحياء ${cand.name} (متوقف ${Math.round((snap.sinceCycleMs ?? 0) / 1000)}ث، محاولة ${record.count})`);
      cand.revive();
      liveJob.set({ revivals: Object.fromEntries([...revivals].map(([k, v]) => [k, v.count])) });
    } catch (e) { console.error(`[revive] فشل إحياء ${cand.name}: ${e.message}`); }
  }
}, 60_000);
/** الإبلاغ عن التعليق من قراءة الحالة لا من الدورة نفسها */
setInterval(() => {
  for (const [job, name] of [[liveJob, 'live-opportunities'], [strategy2Job, 'strategy2']]) {
    const snap = health.snapshot().engines.find(e => e.name === name);
    if (snap?.stalled) console.error(`[health] تحذير: المحرك ${name} متوقف منذ ${Math.round(snap.sinceCycleMs / 1000)}ث`);
  }
}, 120_000);

/** نبضة دورية للسوق: تُسجّل حالة الاتصال والتقادم فلا تبدو الحلقة ميتة */
setInterval(() => {
  try {
    const st = marketStreams.stats();
    marketJob.beat({ extra: {
      connected: st.connected, streams: st.streams,
      stalePriceRatio: st.stalePriceRatio, staleCandles: st.staleCandles,
      quarantined: st.quarantinedKeys
    } });
  } catch (e) { marketJob.fail(e); }
}, 60_000);

const runShariahJob = async (label) => {
  const t0 = Date.now();
  try {
    const r = await resolveShariahOnServer();
    shariahJob.beat({ ms: Date.now() - t0, extra: { computed: r.computed, changed: r.changed, total: r.total } });
    if (r.computed || r.changed) {
      console.log(`[shariah] ${label}: حُسب ${r.computed} من ${r.total} — تغيّر ${r.changed}`);
    }
  } catch (e) {
    shariahJob.fail(e);
    console.error(`[shariah] ${label} فشل:`, e.message);
  }
};
setTimeout(() => void runShariahJob('إقلاع'), 12_000);
setInterval(() => void runShariahJob('دوري'), 30 * 60 * 1000);

/**
 * سياسة الاحتفاظ بالبيانات — تمنع امتلاء القاعدة بتشخيصات متكررة.
 * القواعد المحمية (النتائج، القرارات، المعايرات، التحليلات، الأحكام) لا تُمس.
 */
const retention = startRetention({
  db,
  intervalMs: Number(process.env.RETENTION_HOURS || 12) * 3600_000,
  log: console
});
const retentionJob = health.register('retention', { stallMs: 26 * 3600_000 });

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

/**
 * الاستعادة من المخزن الدائم بعد إعادة التشغيل (B11) + حفظ دوري.
 * تقرير وضع الظل مع حفظه دورياً: بلا هذا يبدأ قياس ★ من صفر مع كل نشر، فيستحيل
 * بلوغ عيّنات كافية للحكم، ويضيع تعلّم السيولة من مراجعاتك.
 */
const runStateRestore = async () => {
  const learning = await restoreLearning();
  const shadowReport = await shadow.loadDb(db);
  /**
   * يُحفظ في متغير ثم يُعرض بدالة: واجهة `runtime` كلها دوال، وتخصيص قيمة مكانها
   * يجعل القراءة تفشل بصمت (كانت تُرجع null دائماً بلا أي أثر للاستعادة).
   */
  stateRestoreInfo = {
    at: Date.now(),
    learningRestored: learning.restored,
    shadowRecords: shadowReport?.records?.length ?? 0
  };
  console.log(`[state] استعادة: مراجعات ${learning.restored}، مفاتيح ظل ${stateRestoreInfo.shadowRecords}`);
};
void runStateRestore();
setInterval(() => {
  shadow.persist();
  void shadow.persistDb(db);
  void persistLearning();
}, 5 * 60 * 1000);

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
