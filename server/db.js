import { applyFeedback } from './liquidity/engine.mjs';

// تُحقن من بيئة الاستضافة (Verdent/Railway) — لا قيم مدمجة في الكود
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_PUBLISHABLE_KEY || '';

const baseHeaders = {
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  'Content-Type': 'application/json'
};

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

const BINANCE_HOSTS = [
  'https://data-api.binance.vision',
  'https://api1.binance.com',
  'https://api-gcp.binance.com'
];

/**
 * محدّد معدل موحّد لكل نداءات بينانس REST (إصلاح B6).
 * قبل التوصيل: كل محرك كان يطلق طلباته بلا تنظيم مشترك، وعند 429/418 كان الكود
 * ينتقل لمضيف آخر — وهو ما يزيد خطر الحظر الفعلي لعنوان الخادم لأن الرفض بسبب
 * المعدل لا المضيف. الآن: دلو أوزان بأولويات (حي > معايرة > تاريخي)، واحترام
 * Retry-After، وتهدئة إجبارية عند الرفض.
 * ملاحظة: rateLimiter قابل للحقن من الاختبارات (بلا شبكة).
 */
let rateLimiter = null;
export function setRateLimiter(limiter) { rateLimiter = limiter; }

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
  if (rateLimiter) {
    await rateLimiter.acquire(priorityOf(path, priority), weight ?? pathWeightOf(path));
  }
  let lastErr;
  for (const host of BINANCE_HOSTS) {
    try {
      const res = await fetch(`${host}${path}`, { signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) {
        const status = res.status;
        // 429/418 بسبب المعدل: تُبلَّغ للمحدد ليوقف كل الطلبات بدل تجربة مضيف آخر
        if (status === 429 || status === 418) {
          const retryAfter = Number(res.headers.get('retry-after'));
          rateLimiter?.report(status, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 0);
          lastErr = new Error(`HTTP ${status} (rate limited) from ${host}`);
          continue;
        }
        lastErr = new Error(`HTTP ${status} from ${host}`);
        continue;
      }
      return await res.json();
    } catch (e) {
      lastErr = e;
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
          const snap = JSON.parse(e.meta || 'null');
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
          const snap = JSON.parse(e.meta || 'null');
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
        meta: JSON.stringify(snap),
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
    create: (row) => rest('/events_log?select=*', { method: 'POST', body: row, prefer: 'return=representation' }),
    /* ——— عمليات سياسة الاحتفاظ (حذف مقيّد بالموافقة المعتمدة) ——— */
    /** قراءة خفيفة لنوع واحد (معرّفات فقط عادةً) — للقطات المناطق */
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
    /** سجل أحداث الفرص الحية (نشر + حسم) — التاريخ الدائم للوحة التحكم */
    liveOppEvents: (sinceTs, limit = 2000) => {
      const q = new URLSearchParams({ select: '*' });
      q.set('type', 'in.(live_opportunity,live_opportunity_closed)');
      q.set('ts', `gte.${Number(sinceTs) || 0}`);
      q.set('order', 'ts.desc,id.desc');
      q.set('limit', String(Math.min(Number(limit) || 2000, 2000)));
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
    /** أحداث «الفرص الحية — استراتيجيتي» (نشر + حسم) — استمرارية دائمة بلا DDL */
    strategy2Events: (sinceTs, limit = 2000) => {
      const q = new URLSearchParams({ select: '*' });
      q.set('type', 'in.(strategy2_published,strategy2_resolved)');
      q.set('ts', `gte.${Number(sinceTs) || 0}`);
      q.set('order', 'ts.desc,id.desc');
      q.set('limit', String(Math.min(Number(limit) || 2000, 2000)));
      return rest(`/events_log?${q}`);
    },
    /** آخر معايرة محفوظة للمحرك الثاني */
    strategy2Calibration: () => rest('/events_log?type=eq.strategy2_calibration&select=*&order=ts.desc&limit=1'),
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
    /** أحداث تغيّر الاتجاهات (انقلاب/مرحلة/موت مشوار) — التاريخ الدائم للاتجاهات */
    strategy2DirectionEvents: (sinceTs = 0, limit = 2000) => {
      const q = new URLSearchParams({ select: '*' });
      q.set('type', 'eq.strategy2_direction');
      q.set('ts', `gte.${Number(sinceTs) || 0}`);
      q.set('order', 'ts.desc,id.desc');
      q.set('limit', String(Math.min(Number(limit) || 2000, 2000)));
      return rest(`/events_log?${q}`);
    }
  }
};

export default db;
