import { applyFeedback } from './liquidity/engine.mjs';
import { gate, reportRateLimit, sleep, RATE_WAIT_CAP_MS } from './net/gate.mjs';
import { compactSnapshot, expandSnapshotMeta } from './services/snapshotCodec.mjs';
import { readAllPages } from './services/readAllPages.mjs';
import { summarizeOpportunityHistory } from './services/opportunityHistorySummary.mjs';

/**
 * المحدد الموحّد يُحقن من الخادم (أو من الاختبارات) عبر `setRateLimiter`.
 * إعادة التصدير هنا مقصودة: نقطة الحقن الفعلية هي `net/gate.mjs` لتفادي دورة الاستيراد
 * (orderbook ← gate) لكن مستهلكي `db.js` القائمين يبقون بلا تغيير.
 */
export { setRateLimiter, getRateLimiter } from './net/gate.mjs';

// تُحقن من بيئة الاستضافة (Verdent/Railway) — لا قيم مدمجة في الكود
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_PUBLISHABLE_KEY || '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

const keyAuthHeaders = (key) => key.split('.').length === 3 ? { Authorization: `Bearer ${key}` } : {};
const baseHeaders = {
  apikey: SUPABASE_KEY,
  ...keyAuthHeaders(SUPABASE_KEY),
  'Content-Type': 'application/json'
};

const opportunityHistorySummaryCache = new Map();

async function rest(path, { method = 'GET', body, prefer } = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    method,
    headers: { ...baseHeaders, ...(prefer ? { Prefer: prefer } : {}) },
    signal: AbortSignal.timeout(20000), // منع تعليق الدورات الحية عند توقف الاتصال
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

async function restWorkbench(path, { method = 'GET', body, prefer } = {}) {
  const readOnly = method === 'GET' || method === 'HEAD';
  if (!readOnly && !SUPABASE_SERVICE_ROLE_KEY) {
    const error = new Error('SUPABASE_SERVICE_ROLE_KEY is required for Liquidity Workbench writes');
    error.status = 503;
    throw error;
  }
  const key = readOnly ? SUPABASE_KEY : SUPABASE_SERVICE_ROLE_KEY;
  const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    method,
    headers: {
      apikey: key,
      ...keyAuthHeaders(key),
      'Content-Type': 'application/json',
      ...(prefer ? { Prefer: prefer } : {})
    },
    signal: AbortSignal.timeout(20000),
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  if (!res.ok) {
    const text = await res.text();
    const error = new Error(`Supabase REST ${res.status}: ${text}`);
    error.status = res.status;
    throw error;
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

const BINANCE_HOSTS = [
  'https://data-api.binance.vision',
  'https://api1.binance.com',
  'https://api-gcp.binance.com'
];

/**
 * عدد مرات إعادة النداء على **نفس المضيف** بعد 429/418 قبل تجربة مضيف آخر.
 * 1 = إعادة واحدة بعد انتظار محدود: تكفي لامتصاص الرفض العابر بلا تعليق الدورة،
 * وأكثر منها يعني حجز خيط المحرك في انتظار طويل بلا فائدة (المحدد يحظر البقية أصلاً).
 */
const RATE_RETRY_ATTEMPTS = Math.max(0, Number(process.env.BINANCE_RATE_RETRIES ?? 1));

/**
 * محدّد معدل موحّد لكل نداءات بينانس REST (إصلاح B6).
 * قبل التوصيل: كل محرك كان يطلق طلباته بلا تنظيم مشترك، وعند 429/418 كان الكود
 * ينتقل لمضيف آخر — وهو ما يزيد خطر الحظر الفعلي لعنوان الخادم لأن الرفض بسبب
 * المعدل لا المضيف. الآن: دلو أوزان بأولويات (حي > معايرة > تاريخي)، واحترام
 * Retry-After، وتهدئة إجبارية عند الرفض.
 */

function pathWeightOf(path) {
  const p = String(path).split('?')[0];
  const W = {
    '/api/v3/klines': 2,
    '/api/v3/ticker/price': 2,
    '/api/v3/exchangeInfo': 20,
    '/api/v3/depth': 5,
    '/api/v3/aggTrades': 2
  };
  return W[p] ?? 2;
}

/** أولوية الطلب مشتقة من مساره: الاستطلاع الحي أولى، والبيانات العميقة أخيراً */
function priorityOf(path, explicit) {
  if (explicit) return explicit;
  if (String(path).includes('/ticker/price')) return 'live';
  if (String(path).includes('/klines')) return 'calibration';
  return 'history';
}

async function fetchBinanceJson(path, timeoutMs = 30000, { priority, weight } = {}) {
  // الحصول على دور قبل أي نداء — نقطة الاختناق الوحيدة
  await gate(priorityOf(path, priority), weight ?? pathWeightOf(path));
  let lastErr;
  for (const host of BINANCE_HOSTS) {
    /**
     * 429/418 سببها المعدل لا المضيف (إصلاح B6 — الجزء الثاني): كان الكود ينتقل
     * للمضيف التالي فوراً، فيكرّر المخالفة نفسها من العنوان نفسه ويقرّب الحظر الكامل.
     * الصواب: يُبلَّغ المحدد بالحظر، ثم يُعاد النداء **على نفس المضيف** بعد انتظار
     * محدود بسقف، ومضيف آخر لا يُجرَّب إلا كملاذ أخير بعد فشل الإعادة.
     */
    for (let attempt = 0; attempt <= RATE_RETRY_ATTEMPTS; attempt += 1) {
      try {
        const res = await fetch(`${host}${path}`, { signal: AbortSignal.timeout(timeoutMs) });
        if (!res.ok) {
          const status = res.status;
          if (status === 429 || status === 418) {
            const retryAfter = Number(res.headers.get('retry-after'));
            const declared = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 0;
            reportRateLimit(status, declared);
            lastErr = new Error(`HTTP ${status} (rate limited) from ${host}`);
            const waitMs = Math.min(declared || (status === 418 ? 120_000 : 20_000), RATE_WAIT_CAP_MS);
            const canRetry = attempt < RATE_RETRY_ATTEMPTS && waitMs > 0;
            if (canRetry) {
              await sleep(waitMs);
              continue; // نفس المضيف — لا تبديل
            }
            break; // سقف الانتظار انتهى: مضيف آخر كملاذ أخير
          }
          lastErr = new Error(`HTTP ${status} from ${host}`);
          break; // خطأ غير متعلق بالمعدل: لا معنى لإعادة المحاولة على نفس المضيف
        }
        return await res.json();
      } catch (e) {
        lastErr = e;
        break; // فشل شبكة/مهلة: المضيف التالي أنسب من إعادة المحاولة
      }
    }
  }
  throw lastErr ?? new Error('all Binance hosts failed');
}

// سجل القرارات على events_log — تحويل شكل الحدث إلى صف القرار القياسي
const toCardRow = (row) => ({
  id: row.id,
  symbol: row.symbol,
  actor: String(row.type || '').replace(/^decision_/, ''),
  decided_at: Number(row.ts),
  payload: row.meta ? JSON.parse(row.meta) : {}
});

const toImageEvent = (row) => ({
  symbol: String(row.symbol || 'GLOBAL').toUpperCase(),
  type: 'decision_image',
  message: `#${row.case_id}`,
  meta: JSON.stringify({ tf: row.tf ?? '', data_url: row.data_url ?? '', captured_at: Number(row.captured_at) || Date.now() }),
  ts: Number(row.captured_at) || Date.now()
});

const toImageRow = (row) => {
  const m = row.meta ? JSON.parse(row.meta) : {};
  return {
    id: row.id,
    case_id: Number(String(row.message || '').replace(/^#/, '')) || 0,
    tf: m.tf ?? '',
    data_url: m.data_url ?? '',
    captured_at: Number(m.captured_at ?? row.ts)
  };
};

const db = {
  binance: {
    exchangeInfo: () => fetchBinanceJson('/api/v3/exchangeInfo', 30000),
    klines: (symbol, interval, limit, startTime, endTime) => {
      const params = new URLSearchParams({ symbol, interval, limit: String(limit) });
      if (startTime) params.set('startTime', String(startTime));
      if (endTime) params.set('endTime', String(endTime));
      return fetchBinanceJson(`/api/v3/klines?${params.toString()}`, 15000);
    },
    depth: (symbol, limit = 20) => fetchBinanceJson(`/api/v3/depth?symbol=${encodeURIComponent(symbol)}&limit=${Math.min(Math.max(Number(limit) || 20, 5), 100)}`, 10000),
    tickerPrices: async (symbols) => {
      const q = encodeURIComponent(JSON.stringify(symbols));
      const rows = await fetchBinanceJson(`/api/v3/ticker/price?symbols=${q}`, 10000);
      const out = {};
      for (const r of rows) out[r.symbol] = Number(r.price);
      return out;
    },
    /** كل أسعار السوق في نداء واحد — يتفادى فشل الطلب الكبير بسبب رمز واحد غير مدعوم */
    allTickerPrices: async () => {
      const rows = await fetchBinanceJson('/api/v3/ticker/price', 15000);
      const out = {};
      for (const r of rows) out[r.symbol] = Number(r.price);
      return out;
    },
  },
  zones: {
    /** أحدث حالة لكل منطقة يدوية (id) — منطقة محفوظة كحدث نوع liquidity_zone في events_log */
    list: async (symbol) => {
      // ترتيب زمني تنازلي مع حدٍّ أصلي: asc+limit تُسقط الأحداث الأحدث عندما يتجاوز
      // السجلُّ الحدَّ (5046+ حدثاً فعلياً) فتُفقد أحدث المناطق اليدوية من القراءة.
      const q = new URLSearchParams({ type: 'eq.liquidity_zone', select: '*', order: 'ts.desc', limit: '5000' });
      if (symbol) q.set('symbol', `eq.${symbol.toUpperCase()}`);
      const events = await rest(`/events_log?${q}`);
      const latest = new Map();
      for (const e of events) {
        try {
          const z = JSON.parse(e.meta || 'null');
          // desc = الأحدث أولاً → النسخة الأولى لكل id هي الأحدث، فلا نستبدلها
          if (z?.id && z.source !== 'auto' && !latest.has(z.id)) latest.set(z.id, z);
        } catch { /* تجاهل السجلات التالفة */ }
      }
      return [...latest.values()].filter(z => z.active !== false);
    },
    /** المناطق الآلية: أحدث لقطة لكل رمز + تغذية راجعة وملاحظات فوقها (تشمل المرفوضة) */
    listAuto: async (symbol) => {
      const q = new URLSearchParams({ type: 'eq.auto_zones_snapshot', select: '*', order: 'ts.desc', limit: '60' });
      if (symbol) q.set('symbol', `eq.${symbol.toUpperCase()}`);
      const events = await rest(`/events_log?${q}`);
      const latestPerSymbol = new Map();
      for (const e of events) {
        if (latestPerSymbol.has(e.symbol)) continue;
        try {
          // فكّ الترميز بلا فقدان (اللقطات الجديدة) مع تحمّل اللقطات القديمة المباشرة
          const snap = expandSnapshotMeta(e.meta);
          if (snap?.zones) latestPerSymbol.set(e.symbol, snap);
        } catch { /* تجاهل التالف */ }
      }
      if (!latestPerSymbol.size) return [];
      const feedbackQ = new URLSearchParams({
        type: 'eq.zone_feedback', select: '*', order: 'ts.asc', limit: '1000'
      });
      if (symbol) feedbackQ.set('symbol', `eq.${symbol.toUpperCase()}`);
      let feedbackEvents = [];
      try { feedbackEvents = await rest(`/events_log?${feedbackQ}`); } catch { /* بلا تغذية راجعة */ }
      const all = [];
      for (const snap of latestPerSymbol.values()) {
        for (const z of snap.zones) {
          all.push({ ...z, feedback: z.feedback ?? null, note: z.note ?? '' });
        }
      }
      // ترتيب زمني تصاعدي: الأحدث يفوز في الدمج المستقل لكل حقل
      const chronological = feedbackEvents
        .sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0))
        .map(e => { try { return JSON.parse(e.meta || 'null'); } catch { return null; } })
        .filter(Boolean);
      return applyFeedback(all, chronological);
    },
    /** يدوي + آلي معاً — للعرض والمراقبة */
    listAll: async (symbol) => {
      const [manual, auto] = await Promise.all([db.zones.list(symbol), db.zones.listAuto(symbol)]);
      return [...manual, ...auto];
    },
    /** كل نسخ المناطق اليدوية (إنشاء/تعديل/حذف) من سجل الأحداث — بلا إخفاء المحذوف */
    history: async ({ symbol, limit, offset } = {}) => {
      const q = new URLSearchParams({
        type: 'eq.liquidity_zone',
        select: '*',
        order: 'ts.asc,id.asc',
        limit: String(Math.min(Number(limit) || 2000, 5000))
      });
      if (symbol) q.set('symbol', `eq.${symbol.toUpperCase()}`);
      if (offset) q.set('offset', String(Number(offset)));
      return rest(`/events_log?${q}`);
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
    appendFeedback: (f) => rest('/events_log?select=*', {
      method: 'POST',
      body: {
        symbol: String(f.symbol).toUpperCase(),
        type: 'zone_feedback',
        message: `${f.verdict === 'confirm' ? 'تأكيد' : f.verdict === 'clear' ? 'استعادة' : f.verdict ? 'رفض' : 'ملاحظة على'} منطقة آلية ${f.zoneId}`,
        meta: JSON.stringify(f),
        ts: Date.now()
      },
      prefer: 'return=minimal'
    }),
    /** أحدث لقطة مناطق آلية — لعملة محددة أو لكل العملات (أحدث لقطة لكل رمز) */
    getAutoSnapshot: async (symbol) => {
      const q = new URLSearchParams({ type: 'eq.auto_zones_snapshot', select: '*', order: 'ts.desc', limit: '60' });
      if (symbol) q.set('symbol', `eq.${symbol.toUpperCase()}`);
      const events = await rest(`/events_log?${q}`);
      const seen = new Set();
      for (const e of events) {
        if (seen.has(e.symbol)) continue;
        seen.add(e.symbol);
        try {
          const snap = expandSnapshotMeta(e.meta);
          if (!symbol || snap?.symbol === symbol.toUpperCase()) return snap;
        } catch { /* تجاهل التالف */ }
      }
      return null;
    },
    appendAutoSnapshot: (snap) => rest('/events_log?select=*', {
      method: 'POST',
      body: {
        symbol: String(snap.symbol).toUpperCase(),
        type: 'auto_zones_snapshot',
        message: `لقطة مناطق آلية: ${snap.zones.length} منطقة`,
        /**
         * الترميز بلا فقدان: اللقطة 100 منطقة ≈ 60KB و40% منها نصوص `reasons`
         * المتكررة. القاموس المشترك يقصّها إلى أجزاء من حجمها، وكل مسارات القراءة
         * تفكّها إلى الكائن الأصلي حرفياً (انظر `snapshotCodec.mjs`).
         */
        meta: JSON.stringify(compactSnapshot(snap)),
        ts: Date.now()
      },
      prefer: 'return=minimal'
    }),
    /** أحدث معايرة محفوظة (حدث zone_calibration — الأحدث يفوز) */
    getCalibration: async () => {
      const events = await rest('/events_log?type=eq.zone_calibration&select=*&order=ts.desc&limit=1');
      return events.length ? events[0] : null;
    },
    /** السجل العميق للقطات الآلية: صفحات تنازلية بلا سقف الـ60 (للتبويب التاريخي)
     * جلب مصغر: ts,symbol,meta فقط — meta الضخم هو المطلوب والباقي حشو يضخم النقل */
    autoHistory: async ({ symbol, from, to, limit, offset } = {}) => {
      const q = new URLSearchParams({
        type: 'eq.auto_zones_snapshot', select: 'id,ts,symbol,meta', order: 'ts.desc,id.desc',
        limit: String(Math.min(Number(limit) || 200, 500))
      });
      if (symbol) q.set('symbol', `eq.${String(symbol).toUpperCase()}`);
      if (from) q.set('ts', `gte.${Number(from)}`);
      if (to) q.set('ts', `lte.${Number(to)}`);
      if (offset) q.set('offset', String(Number(offset)));
      return rest(`/events_log?${q}`);
    },
    /** صورة شارت محفوظة لحظة التحديد الآلي — حدث إلحاقي (نفس نمط case_images) */
    appendZoneScreenshot: (shot) => rest('/events_log?select=*', {
      method: 'POST',
      body: {
        symbol: String(shot.symbol).toUpperCase(),
        type: 'auto_zone_screenshot',
        message: `صورة شارت لحظة التحديد: ${shot.zoneKey}`,
        meta: JSON.stringify(shot),
        ts: Date.now()
      },
      prefer: 'return=minimal'
    }),
    /** أحدث صورة لكل مفتاح منطقة خلال فترة */
    listZoneScreenshots: async ({ symbol, from, limit } = {}) => {
      const q = new URLSearchParams({
        type: 'eq.auto_zone_screenshot', select: '*', order: 'ts.desc,id.desc',
        limit: String(Math.min(Number(limit) || 1000, 2000))
      });
      if (symbol) q.set('symbol', `eq.${String(symbol).toUpperCase()}`);
      if (from) q.set('ts', `gte.${Number(from)}`);
      return rest(`/events_log?${q}`);
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
  liquidityWorkbench: {
    listScans: async (symbol) => {
      const q = new URLSearchParams({ symbol: `eq.${symbol}`, select: '*', order: 'computed_at.desc', limit: '14' });
      return restWorkbench(`/liquidity_workbench_scans?${q}`);
    },
    listEvents: async (symbol, limit = 200) => {
      const q = new URLSearchParams({ symbol: `eq.${symbol}`, select: '*', order: 'event_at.desc,id.desc', limit: String(Math.min(Math.max(Number(limit) || 200, 1), 500)) });
      return restWorkbench(`/liquidity_workbench_events?${q}`);
    },
    listCandles: async (symbol, timeframe, limit = 500) => {
      const q = new URLSearchParams({ symbol: `eq.${symbol}`, timeframe: `eq.${timeframe}`, select: '*', order: 'open_time.desc', limit: String(Math.min(Math.max(Number(limit) || 500, 1), 500)) });
      const rows = await restWorkbench(`/liquidity_workbench_candles?${q}`);
      return rows.reverse();
    },
    upsertCandles: (rows) => restWorkbench('/liquidity_workbench_candles?on_conflict=symbol,timeframe,open_time', {
      method: 'POST', body: rows, prefer: 'resolution=merge-duplicates,return=minimal'
    }),
    upsertScan: (row) => restWorkbench('/liquidity_workbench_scans?on_conflict=engine,symbol,timeframe', {
      method: 'POST', body: row, prefer: 'resolution=merge-duplicates,return=minimal'
    }),
    upsertPoints: async (rows) => {
      const links = rows.flatMap(({ zone_links = [] }) => zone_links);
      const pointRows = rows.map(({ zone_links, ...row }) => row);
      await restWorkbench('/liquidity_workbench_points?on_conflict=point_id', {
        method: 'POST', body: pointRows, prefer: 'resolution=merge-duplicates,return=minimal'
      });
      if (links.length) await db.liquidityWorkbench.upsertPointLinks(links);
    },
    upsertPointLinks: (rows) => restWorkbench('/liquidity_workbench_point_zone_links?on_conflict=point_id,engine,symbol,timeframe,zone_id,relation_role', {
      method: 'POST', body: rows, prefer: 'resolution=merge-duplicates,return=minimal'
    }),
    listPointLinks: ({ symbol, timeframe, engine, zoneId, pointIds, limit = 2000 }) => {
      const q = new URLSearchParams({
        select: '*', symbol: `eq.${symbol}`, timeframe: `eq.${timeframe}`,
        order: 'last_seen_at.desc', limit: String(Math.min(Math.max(Number(limit) || 2000, 1), 2000))
      });
      if (engine) q.set('engine', `eq.${engine}`);
      if (zoneId) q.set('zone_id', `eq.${zoneId}`);
      if (pointIds?.length) q.set('point_id', `in.(${pointIds.join(',')})`);
      return restWorkbench(`/liquidity_workbench_point_zone_links?${q}`);
    },
    listPoints: ({ symbol, timeframe, engine, zoneId, pointIds, limit = 500 }) => {
      const q = new URLSearchParams({
        select: '*',
        symbol: `eq.${symbol}`,
        timeframe: `eq.${timeframe}`,
        order: 'point_time.asc',
        limit: String(Math.min(Math.max(Number(limit) || 500, 1), 2000))
      });
      if (engine) q.set('engine', `eq.${engine}`);
      if (zoneId) q.set('zone_id', `eq.${zoneId}`);
      if (pointIds?.length) q.set('point_id', `in.(${pointIds.join(',')})`);
      return restWorkbench(`/liquidity_workbench_points?${q}`);
    },
    insertZoneEvent: (row) => restWorkbench('/liquidity_workbench_events?on_conflict=idempotency_key', {
      method: 'POST', body: row, prefer: 'resolution=ignore-duplicates,return=minimal'
    }),
    insertSample: (row) => restWorkbench('/liquidity_workbench_samples?on_conflict=sample_key', {
      method: 'POST', body: row, prefer: 'resolution=ignore-duplicates,return=minimal'
    }),
    pruneRaw: async (cutoff) => {
      const candles = new URLSearchParams({ close_time: `lt.${Number(cutoff)}` });
      const samples = new URLSearchParams({ sampled_at: `lt.${Number(cutoff)}` });
      await restWorkbench(`/liquidity_workbench_candles?${candles}`, { method: 'DELETE', prefer: 'return=minimal' });
      await restWorkbench(`/liquidity_workbench_samples?${samples}`, { method: 'DELETE', prefer: 'return=minimal' });
      return true;
    }
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
    /**
     * أسماء وأحكام فقط — للاستهلاك الجاري (قائمة المستهدفة كل دقيقة).
     * السبب المقيس: `list()` تجلب `facts` و`reasons` و`evidence`، وهي نصوص الأدلة
     * الشرعية الكاملة (ميغابايتات) لكل رمز؛ وطلبها كل دقيقة من كل محرك كان أثقل
     * جلب في النظام بلا أي استخدام للنتيجة. من يحتاج النصوص يستخدم `list()` صراحةً.
     */
    listVerdicts: () => rest('/coin_shariah?select=symbol,verdict'),
    upsert: (row) => rest('/coin_shariah?on_conflict=symbol&select=*', { method: 'POST', body: row, prefer: 'resolution=merge-duplicates,return=representation' }),
    /** إدراج دفعي — يمنع آلاف الطلبات عند حساب الأحكام على الخادم */
    upsertChunk: (rows) => rest('/coin_shariah?on_conflict=symbol&select=symbol', {
      method: 'POST', body: rows, prefer: 'resolution=merge-duplicates,return=minimal'
    }),
    remove: (symbol) => rest(`/coin_shariah?symbol=eq.${encodeURIComponent(symbol)}`, { method: 'DELETE' })
  },
  settings: {
    get: () => rest('/settings?select=*&id=eq.1'),
    create: (row) => rest('/settings?select=*', { method: 'POST', body: row, prefer: 'return=representation' }),
    update: (row) => rest('/settings?id=eq.1&select=*', { method: 'PATCH', body: row, prefer: 'return=representation' })
  },
  /** عيّنات صحة دورية — دليل التشغيل المستمر */
  health: {
    append: (sample) => rest('/health_samples?select=id', {
      method: 'POST', body: sample, prefer: 'return=minimal'
    }),
    recent: (sinceTs = 0, limit = 500) => {
      const q = new URLSearchParams({ select: '*' });
      q.set('ts', `gte.${Number(sinceTs) || 0}`);
      q.set('order', 'ts.desc');
      q.set('limit', String(Math.min(Number(limit) || 500, 2000)));
      return rest(`/health_samples?${q}`);
    },
    /**
     * عدد الصفوف — سياسة الاحتفاظ وقسم `storage` في الصحة يحتاجانه بالأرقام لا
     * بالتقدير: قرار السعة كله مبني عليه، وبدونه يبقى الحذف تخميناً.
     */
    count: async () => {
      const res = await fetch(`${SUPABASE_URL}/rest/v1/health_samples?select=id`, {
        method: 'HEAD',
        headers: { ...baseHeaders, Prefer: 'count=exact' },
        signal: AbortSignal.timeout(20000)
      });
      if (!res.ok) throw new Error(`Supabase REST ${res.status}`);
      return Number((res.headers.get('content-range') ?? '').split('/')[1] ?? 0) || 0;
    },
    deleteBefore: (beforeTs) => rest(
      `/health_samples?ts=lt.${Number(beforeTs)}`,
      { method: 'DELETE', prefer: 'return=minimal' }
    ),
    /** سقف احتياطي: يحذف الأقدم بدفعات عند تجاوز الحد المسموح للصفوف */
    deleteOldest: async (n) => {
      const want = Math.min(Math.max(0, Number(n) || 0), 20000);
      if (!want) return 0;
      const rows = await rest(`/health_samples?select=id&order=ts.asc&limit=${want}`);
      const ids = (rows ?? []).map(r => r.id);
      let done = 0;
      for (let i = 0; i < ids.length; i += 100) {
        const chunk = ids.slice(i, i + 100);
        await rest(`/health_samples?id=in.(${chunk.join(',')})`, { method: 'DELETE', prefer: 'return=minimal' });
        done += chunk.length;
      }
      return done;
    }
  },
  // سجل القرارات على events_log الإلحاقي (نفس معمارية باقي الوظائف — صفر تغيير مخطط):
  // - قرار واحد = حدث type=decision_<actor> وmeta=payload JSON
  // - صورة قرار = حدث type=decision_image وmessage='#<caseId>' للربط الدقيق
  cases: {
    save: (row) => rest('/events_log?select=*', {
      method: 'POST',
      body: {
        symbol: String(row.symbol).toUpperCase(),
        type: `decision_${row.actor}`,
        message: String(row.actor),
        meta: row.payload,
        ts: Number(row.decided_at) || Date.now()
      },
      prefer: 'return=representation'
    }),
    list: async ({ symbol, limit } = {}) => {
      const q = new URLSearchParams({ type: 'like.decision_*', select: '*', order: 'ts.desc,id.desc', limit: String(Math.min(Number(limit) || 500, 1000)) });
      if (symbol) q.set('symbol', `eq.${symbol.toUpperCase()}`);
      const rows = await rest(`/events_log?${q}`);
      return rows.map(toCardRow);
    },
    get: async (id) => {
      const rows = await rest(`/events_log?id=eq.${Number(id)}&select=*&limit=1`);
      return rows.length ? toCardRow(rows[0]) : null;
    },
    imagesSave: (rows) => rest('/events_log', { method: 'POST', body: rows.map(toImageEvent), prefer: 'return=minimal' }),
    imagesList: async (caseId) => {
      const q = new URLSearchParams({ type: 'eq.decision_image', message: `eq.%23${Number(caseId)}`, select: '*', order: 'ts.asc,id.asc' });
      const rows = await rest(`/events_log?${q}`);
      return rows.map(toImageRow);
    }
  },
  /**
   * مخزن حالة دائم (مفتاح/قيمة) بلا أي تغيير في المخطط: صف واحد لكل مفتاح على
   * `events_log` نوعه `engine_state` ورمزه هو المفتاح. الغرض: ما كان يضيع عند كل
   * إعادة تشغيل — تقرير وضع الظل، وانحياز تعلّم السيولة، وملخصات الباك تيست.
   * صف واحد لكل مفتاح (تحديث لا إدراج) حتى لا ينمو الجدول بلا حد.
   */
  engineState: {
    get: async (key) => {
      const rows = await rest(`/events_log?type=eq.engine_state&symbol=eq.${encodeURIComponent(key)}&select=meta,ts&limit=1`);
      if (!rows?.length) return null;
      try { return rows[0].meta ? JSON.parse(rows[0].meta) : null; } catch { return null; }
    },
    getStrict: async (key) => {
      const rows = await rest(`/events_log?type=eq.engine_state&symbol=eq.${encodeURIComponent(key)}&select=meta,ts&limit=1`);
      if (!rows?.length) return null;
      if (rows[0].meta == null) throw new Error(`حالة تشغيل محفوظة بلا محتوى: ${key}`);
      try {
        const parsed = typeof rows[0].meta === 'string' ? JSON.parse(rows[0].meta) : rows[0].meta;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('صيغة حالة تشغيل غير صالحة');
        return parsed;
      } catch (error) {
        throw new Error(`تعذر قراءة حالة التشغيل المحفوظة (${key}): ${error.message}`);
      }
    },
    put: async (key, value) => {
      const body = { type: 'engine_state', symbol: String(key), message: String(key), meta: JSON.stringify(value ?? null), ts: Date.now() };
      const existing = await rest(`/events_log?type=eq.engine_state&symbol=eq.${encodeURIComponent(key)}&select=id&limit=1`);
      if (existing?.length) {
        return rest(`/events_log?id=eq.${existing[0].id}`, { method: 'PATCH', body: { meta: body.meta, ts: body.ts }, prefer: 'return=minimal' });
      }
      return rest('/events_log?select=id', { method: 'POST', body, prefer: 'return=minimal' });
    },
    keys: async () => {
      const rows = await rest('/events_log?type=eq.engine_state&select=symbol&limit=200');
      return (rows ?? []).map(r => r.symbol);
    }
  },
  events: {
    list: ({ symbol, from, limit, offset, type }) => {
      const q = new URLSearchParams({ select: '*' });
      if (symbol) q.set('symbol', `eq.${symbol.toUpperCase()}`);
      if (type) q.set('type', `eq.${type}`);
      if (from) q.set('ts', `gte.${Number(from)}`);
      q.set('order', 'ts.desc,id.desc');
      q.set('limit', String(Math.min(Number(limit) || 500, 2000)));
      if (offset) q.set('offset', String(Number(offset)));
      return rest(`/events_log?${q}`);
    },
    get: (id) => rest(`/events_log?id=eq.${Number(id)}&select=*&limit=1`).then(rows => rows[0] ?? null),
    create: async (row) => {
      const created = await rest('/events_log?select=*', { method: 'POST', body: row, prefer: 'return=representation' });
      if (row?.type === 'live_opportunity') opportunityHistorySummaryCache.delete('live');
      if (row?.type === 'strategy2_published') opportunityHistorySummaryCache.delete('strategy2');
      return created;
    },
    /* ——— عمليات سياسة الاحتفاظ (حذف مقيّد بالموافقة المعتمدة) ——— */
    /** قراءة خفيفة لنوع واحد (معرّفات فقط عادةً) — للقطات المناطق */
    /**
     * عدد صفوف نوع واحد (اختياريًا منذ زمن) — يقيس حمل كل نوع على القاعدة بلا
     * جلب صفوف: قسم `storage` يبني عليه قرار التقليم بالأرقام.
     */
    countByType: async (type, sinceTs = 0) => {
      const q = new URLSearchParams({ select: 'id' });
      if (sinceTs) q.set('ts', `gte.${Number(sinceTs)}`);
      const res = await fetch(`${SUPABASE_URL}/rest/v1/events_log?type=eq.${encodeURIComponent(type)}&${q}`, {
        method: 'HEAD',
        headers: { ...baseHeaders, Prefer: 'count=exact' },
        signal: AbortSignal.timeout(20000)
      });
      if (!res.ok) throw new Error(`Supabase REST ${res.status}`);
      return Number((res.headers.get('content-range') ?? '').split('/')[1] ?? 0) || 0;
    },
    listByType: (type, { select = 'id,symbol', limit = 20000 } = {}) => {
      const q = new URLSearchParams({ select });
      q.set('type', `eq.${type}`);
      q.set('order', 'ts.desc,id.desc');
      q.set('limit', String(Math.min(Number(limit) || 20000, 50000)));
      return rest(`/events_log?${q}`);
    },
    /** حذف أحداث نوع معيّن قبل طابع زمني */
    deleteBefore: (type, beforeTs) => rest(
      `/events_log?type=eq.${encodeURIComponent(type)}&ts=lt.${Number(beforeTs)}`,
      { method: 'DELETE', prefer: 'return=minimal,count=exact' }
    ),
    /** حذف بمعرّفات محددة (دفعات صغيرة لتفادي طول الطلب) */
    deleteByIds: async (ids) => {
      let done = 0;
      for (let i = 0; i < ids.length; i += 100) {
        const chunk = ids.slice(i, i + 100);
        await rest(`/events_log?id=in.(${chunk.join(',')})`, { method: 'DELETE', prefer: 'return=minimal' });
        done += chunk.length;
      }
      return done;
    },
    /** إسقاط الصور من صفوف قديمة مع إبقاء الحدث نفسه (الصور هي الأثقل) */
    clearImagesBefore: async (type, beforeTs, { limit = 200 } = {}) => {
      const q = new URLSearchParams({ select: 'id', meta: 'not.is.null' });
      q.set('type', `eq.${type}`);
      q.set('ts', `lt.${Number(beforeTs)}`);
      q.set('limit', String(limit));
      const rows = await rest(`/events_log?${q}`);
      if (!rows?.length) return 0;
      const ids = rows.map(r => r.id);
      // الحقول التي تحمل الصور في صفوف الأحداث
      await rest(`/events_log?id=in.(${ids.join(',')})`, {
        method: 'PATCH',
        body: { meta: null, image: null, screenshot: null },
        prefer: 'return=minimal'
      });
      return ids.length;
    },
    opportunityHistoryPage: async ({ engine = 'live', beforeId = null, limit = 50 } = {}) => {
      const strategy2 = engine === 'strategy2';
      const publishedType = strategy2 ? 'strategy2_published' : 'live_opportunity';
      const closedType = strategy2 ? 'strategy2_resolved' : 'live_opportunity_closed';
      const pageLimit = Math.min(Math.max(Number(limit) || 50, 1), 100);
      const q = new URLSearchParams({ select: 'id,type,symbol,meta,ts' });
      q.set('type', `eq.${publishedType}`);
      if (beforeId != null && Number.isFinite(Number(beforeId))) q.set('id', `lt.${Number(beforeId)}`);
      q.set('order', 'id.desc');
      q.set('limit', String(pageLimit));
      const [published, total] = await Promise.all([
        rest(`/events_log?${q}`),
        db.events.countByType(publishedType)
      ]);
      const parseEventMeta = (row, label) => {
        try { return typeof row.meta === 'string' ? JSON.parse(row.meta || '{}') : (row.meta ?? {}); }
        catch { throw new Error(`تعذر تفسير بيانات ${label} المحفوظة (id=${row.id})`); }
      };
      const publishedMeta = (published ?? []).map(row => parseEventMeta(row, 'نشر الفرصة')?.opportunity ?? null);
      if (publishedMeta.some(opportunity => !opportunity?.id)) throw new Error(`تعذر تفسير سجل النشر المحفوظ لمحرك ${engine}`);
      const ids = new Set(publishedMeta.map(opportunity => opportunity.id));
      const publishedTimes = (published ?? []).map(row => Number(row.ts));
      if (publishedTimes.some(ts => !Number.isFinite(ts))) throw new Error(`يوجد توقيت نشر غير صالح في سجل ${engine}`);
      const minPublishedTs = publishedTimes.length ? Math.min(...publishedTimes) : null;
      const outcomePage = published?.length
        ? await readAllPages(({ beforeId: outcomeBeforeId, limit: outcomeLimit }) =>
          db.events.opportunityOutcomeEventsPage(closedType, minPublishedTs, outcomeBeforeId, outcomeLimit),
        { pageSize: 1000, maxRows: 50_000 })
        : { rows: [], truncated: false };
      if (outcomePage.truncated) throw new Error(`تعذر إكمال سجل نتائج ${engine}: تجاوز حد الصفوف الآمن`);
      const matchingOutcomes = [];
      for (const row of outcomePage.rows ?? []) {
        const opportunityId = parseEventMeta(row, 'نتيجة الفرصة')?.opportunity?.id;
        if (!opportunityId) throw new Error(`نتيجة محفوظة بلا هوية فرصة (id=${row.id})`);
        if (ids.has(opportunityId)) matchingOutcomes.push(row);
      }
      return { published: published ?? [], outcomes: matchingOutcomes, total, nextCursor: published?.length === pageLimit ? published[published.length - 1].id : null };
    },
    opportunityHistorySummary: async ({ engine = 'live', maxRows = 50_000 } = {}) => {
      const cached = opportunityHistorySummaryCache.get(engine);
      if (cached && cached.expiresAt > Date.now()) return cached.value;
      const strategy2 = engine === 'strategy2';
      const publishedType = strategy2 ? 'strategy2_published' : 'live_opportunity';
      const countQuery = new URLSearchParams({ select: 'id', type: `eq.${publishedType}` });
      const countResponse = await fetch(`${SUPABASE_URL}/rest/v1/events_log?${countQuery}`, {
        method: 'HEAD',
        headers: { ...baseHeaders, Prefer: 'count=exact' },
        signal: AbortSignal.timeout(20000)
      });
      if (!countResponse.ok) throw new Error(`Supabase REST ${countResponse.status}`);
      const rangeMatch = /\/(\d+)$/.exec(countResponse.headers.get('content-range') ?? '');
      const eventCount = rangeMatch ? Number(rangeMatch[1]) : null;
      const scan = await readAllPages(({ beforeId, limit }) => {
        const q = new URLSearchParams({ select: 'id,meta' });
        q.set('type', `eq.${publishedType}`);
        if (beforeId != null) q.set('id', `lt.${Number(beforeId)}`);
        q.set('order', 'id.desc');
        q.set('limit', String(Math.min(Math.max(Number(limit) || 1000, 1), 1000)));
        return rest(`/events_log?${q}`);
      }, { pageSize: 1000, maxRows });
      const summary = summarizeOpportunityHistory(scan.rows, eventCount, { truncated: scan.truncated });
      opportunityHistorySummaryCache.set(engine, { expiresAt: Date.now() + 15_000, value: summary });
      return summary;
    },
    opportunityOutcomeEventsPage: (type, sinceTs, beforeId = null, limit = 1000) => {
      const q = new URLSearchParams({ select: 'id,type,symbol,meta,ts' });
      q.set('type', `eq.${type}`);
      q.set('ts', `gte.${Number(sinceTs) || 0}`);
      if (beforeId != null) q.set('id', `lt.${Number(beforeId)}`);
      q.set('order', 'id.desc');
      q.set('limit', String(Math.min(Math.max(Number(limit) || 1000, 1), 1000)));
      return rest(`/events_log?${q}`);
    },
    rejectedEventsPage: (type, sinceTs, beforeId = null, limit = 1000) => {
      const q = new URLSearchParams({ select: 'id,message,meta,ts' });
      q.set('type', `eq.${type}`);
      q.set('ts', `gte.${Number(sinceTs) || 0}`);
      if (beforeId != null) q.set('id', `lt.${Number(beforeId)}`);
      q.set('order', 'id.desc');
      q.set('limit', String(Math.min(Math.max(Number(limit) || 1000, 1), 1000)));
      return rest(`/events_log?${q}`);
    },
    rejectedSummary: async ({ engine = 'live', sinceTs = Date.now() - 7 * 86_400_000, maxRows = 50_000 } = {}) => {
      const type = engine === 'strategy2' ? 'strategy2_rejected' : 'live_opportunity_rejected';
      const scan = await readAllPages(({ beforeId, limit }) =>
        db.events.rejectedEventsPage(type, sinceTs, beforeId, limit), { pageSize: 1000, maxRows });
      if (scan.truncated) throw new Error(`تجاوز سجل رفض ${engine} حد الصفحة الآمن خلال الفترة المطلوبة`);
      const counts = new Map();
      for (const row of scan.rows) {
        let meta = {};
        try { meta = typeof row.meta === 'string' ? JSON.parse(row.meta) : (row.meta ?? {}); } catch { /* صف تالف لا يعطل الملخص */ }
        const reason = String(meta.reason ?? row.message ?? 'غير مصنف').slice(0, 240);
        counts.set(reason, (counts.get(reason) ?? 0) + 1);
      }
      return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([reason, count]) => ({ reason, count }));
    },
    liveOppEvents: (sinceTs, limit = 2000) => {
      const q = new URLSearchParams({ select: '*' });
      q.set('type', 'in.(live_opportunity,live_opportunity_closed)');
      q.set('ts', `gte.${Number(sinceTs) || 0}`);
      q.set('order', 'ts.desc,id.desc');
      q.set('limit', String(Math.min(Number(limit) || 2000, 2000)));
      return rest(`/events_log?${q}`);
    },
    liveOppEventsPage: (sinceTs, beforeId = null, limit = 1000) => {
      const q = new URLSearchParams({ select: '*' });
      q.set('type', 'in.(live_opportunity,live_opportunity_closed)');
      q.set('ts', `gte.${Number(sinceTs) || 0}`);
      if (beforeId != null) q.set('id', `lt.${Number(beforeId)}`);
      q.set('order', 'id.desc');
      q.set('limit', String(Math.min(Math.max(Number(limit) || 1000, 1), 1000)));
      return rest(`/events_log?${q}`);
    },
    /**
     * أحداث دورة الحياة (sweep/reclaim/published/closed) — وقود الاستعادة بعد إعادة التشغيل.
     * إصلاح A9: كان الترتيب تصاعدياً مع حد أقصى، فيجلب **أقدم** الأحداث ويُسقط الأحدث —
     * فتُستعاد حالة قديمة أو ناقصة بعد إعادة التشغيل. الآن يجلب الأحدث (تنازلياً) ثم
     * يُعيد ترتيبها تصاعدياً ليبقى عقد المستدعين كما هو.
     */
    liveLifecycle: (sinceTs, limit = 2000) => {
      const q = new URLSearchParams({ select: '*' });
      q.set('type', 'eq.live_lifecycle');
      q.set('ts', `gte.${Number(sinceTs) || 0}`);
      q.set('order', 'ts.desc,id.desc');
      q.set('limit', String(Math.min(Number(limit) || 2000, 5000)));
      return rest(`/events_log?${q}`).then(rows => rows.reverse());
    },
    liveLifecyclePage: (sinceTs, beforeId = null, limit = 1000) => {
      const q = new URLSearchParams({ select: '*' });
      q.set('type', 'eq.live_lifecycle');
      q.set('ts', `gte.${Number(sinceTs) || 0}`);
      if (beforeId != null) q.set('id', `lt.${Number(beforeId)}`);
      q.set('order', 'id.desc');
      q.set('limit', String(Math.min(Math.max(Number(limit) || 1000, 1), 1000)));
      return rest(`/events_log?${q}`);
    },
    /** أحداث «الفرص الحية — استراتيجيتي» (نشر + حسم) — استمرارية دائمة بلا DDL */
    strategy2Events: (sinceTs, limit = 50000) => {
      const q = new URLSearchParams({ select: '*' });
      q.set('type', 'in.(strategy2_published,strategy2_resolved)');
      q.set('ts', `gte.${Number(sinceTs) || 0}`);
      q.set('order', 'ts.desc,id.desc');
      q.set('limit', String(Math.min(Number(limit) || 50000, 50000)));
      return rest(`/events_log?${q}`);
    },
    strategy2EventsPage: (sinceTs = 0, beforeId = null, limit = 1000) => {
      const q = new URLSearchParams({ select: '*' });
      q.set('type', 'in.(strategy2_published,strategy2_resolved)');
      q.set('ts', `gte.${Number(sinceTs) || 0}`);
      if (beforeId != null) q.set('id', `lt.${Number(beforeId)}`);
      q.set('order', 'id.desc');
      q.set('limit', String(Math.min(Math.max(Number(limit) || 1000, 1), 1000)));
      return rest(`/events_log?${q}`);
    },
    /** آخر معايرة محفوظة للمحرك الثاني */
    strategy2Calibration: async () => {
      const rows = await rest('/events_log?type=eq.strategy2_calibration&select=*&order=ts.desc,id.desc&limit=1');
      if (!Array.isArray(rows)) throw new Error('مصدر معايرة الاستراتيجية أعاد استجابة غير صالحة');
      return rows[0] ?? null;
    },
    /** التصحيح البشري لعناصر strategy2 — تعليق مُصدَر قابل للعكس (لا يمس القواعد) */
    strategy2FeedbackSave: (fb) => rest('/events_log?select=*', {
      method: 'POST',
      body: {
        symbol: String(fb.symbol || 'GLOBAL').toUpperCase(),
        type: 'strategy2_feedback',
        message: `${fb.verdict}: ${fb.elementId}`,
        meta: JSON.stringify(fb),
        ts: Number(fb.at) || Date.now()
      },
      prefer: 'return=representation'
    }),
    /**
     * كل تصحيحات strategy2 (بما فيها الإلغاءات) — يطبق المحرك الإلغاء على النسخ.
     * إصلاح A9: نفس علة liveLifecycle — كان يجلب أقدم التصحيحات فيضيع أحدثها.
     * إلغاء تصحيح سابق يعتمد على أحدث حدث، فغيابه يعني تطبيق حالة ملغاة.
     */
    strategy2FeedbackEvents: (sinceTs = 0, limit = 2000) => {
      const q = new URLSearchParams({ select: '*' });
      q.set('type', 'eq.strategy2_feedback');
      q.set('ts', `gte.${Number(sinceTs) || 0}`);
      q.set('order', 'ts.desc,id.desc');
      q.set('limit', String(Math.min(Number(limit) || 2000, 2000)));
      return rest(`/events_log?${q}`).then(rows => rows.reverse()).then(rows => rows.map(r => {
        try { return JSON.parse(r.meta ?? '{}'); } catch { return null; }
      }).filter(Boolean));
    },
    strategy2FeedbackEventsPage: (sinceTs = 0, beforeId = null, limit = 1000) => {
      const q = new URLSearchParams({ select: '*' });
      q.set('type', 'eq.strategy2_feedback');
      q.set('ts', `gte.${Number(sinceTs) || 0}`);
      if (beforeId != null) q.set('id', `lt.${Number(beforeId)}`);
      q.set('order', 'id.desc');
      q.set('limit', String(Math.min(Math.max(Number(limit) || 1000, 1), 1000)));
      return rest(`/events_log?${q}`);
    },
    strategy2DirectionEvents: (sinceTs = 0, limit = 2000) => {
      const q = new URLSearchParams({ select: '*' });
      q.set('type', 'eq.strategy2_direction');
      q.set('ts', `gte.${Number(sinceTs) || 0}`);
      q.set('order', 'ts.desc,id.desc');
      q.set('limit', String(Math.min(Number(limit) || 2000, 2000)));
      return rest(`/events_log?${q}`);
    },
    strategy2DirectionEventsPage: (sinceTs = 0, beforeId = null, limit = 1000) => {
      const q = new URLSearchParams({ select: '*' });
      q.set('type', 'eq.strategy2_direction');
      q.set('ts', `gte.${Number(sinceTs) || 0}`);
      if (beforeId != null) q.set('id', `lt.${Number(beforeId)}`);
      q.set('order', 'id.desc');
      q.set('limit', String(Math.min(Math.max(Number(limit) || 1000, 1), 1000)));
      return rest(`/events_log?${q}`);
    }
  }
};

export default db;
