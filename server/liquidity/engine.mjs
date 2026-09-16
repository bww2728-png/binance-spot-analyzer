/* منسّق الكشف: يجمع الطبقات لعملة واحدة عبر الفريمات، ويخطط عمليات التخزين.
 * الأجزاء الشبكية معزولة في detectSymbol، وplanAppends حتمي وقابل للاختبار.
 */
import { candidateZones, pivotStrengthFor, referenceLevels } from './structure.mjs';
import { scoreZones } from './score.mjs';
import { collectSignals } from './derivatives.mjs';
import { estimateLiqClusters, fetchDepth, fetchAggTrades, detectIceberg, detectSpoof, bookImbalance } from './orderbook.mjs';

export const ALL_TIMEFRAMES = ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '8h', '12h', '1d', '3d', '1w'];

/** حدود المناطق لكل فريم: الفريمات الصغيرة أكثر ضجيجاً — حد أدنى أرفع وعدد أقل */
export const TF_LIMITS = {
  minScoreAdj: { '1m': 15, '3m': 10, '5m': 5, '15m': 0, '30m': 0, '1h': 0, '2h': 0, '4h': 0, '6h': 0, '8h': 0, '12h': 0, '1d': 0, '3d': 0, '1w': 0 },
  limit: { '1m': 4, '3m': 4, '5m': 6, '15m': 6, '30m': 8, '1h': 8, '2h': 8, '4h': 8, '6h': 8, '8h': 8, '12h': 8, '1d': 8, '3d': 8, '1w': 8 }
};

export const toCandles = (raw) => raw.map(k => ({
  time: Math.floor(Number(k[0]) / 1000),
  open: parseFloat(String(k[1])),
  high: parseFloat(String(k[2])),
  low: parseFloat(String(k[3])),
  close: parseFloat(String(k[4]))
}));

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** إشارات الدفتر: لقطتان بفاصل زمني + صفقات */
export async function bookSignals(symbol) {
  try {
    const [b1, trades] = await Promise.all([fetchDepth(symbol), fetchAggTrades(symbol)]);
    await sleep(4000);
    const b2 = await fetchDepth(symbol);
    const tradedQtyAtPrice = (price) =>
      trades.filter(t => Math.abs(t.price - price) / price <= 0.0001).reduce((a, t) => a + t.qty, 0);
    return {
      book: bookImbalance(b2.bids, b2.asks),
      icebergs: detectIceberg(trades),
      spoofs: detectSpoof(b1.asks.concat(b1.bids), b2.asks.concat(b2.bids), tradedQtyAtPrice)
    };
  } catch {
    return { book: null, icebergs: [], spoofs: [] };
  }
}

/** كشف كامل لعملة واحدة — يتسامح مع فشل أي فريم أو طبقة */
export async function detectSymbol({
  symbol,
  timeframes = ALL_TIMEFRAMES,
  fetchKlines, // (symbol, tf, limit) => raw arrays
  calibration = { eqhTolerancePct: 0.002, minScore: 50 }
}) {
  // المشتقات + CVD من شموع الساعة
  let raw1h = [];
  try { raw1h = await fetchKlines(symbol, '1h', 100); } catch { /* بلا CVD */ }
  const signals = await collectSignals(symbol, raw1h);

  // خريطة التصفيات التقديرية
  const price = signals.funding?.markPrice
    ?? (raw1h.length ? Number(raw1h[raw1h.length - 1][4]) : null);
  const liqClusters = price && signals.oi?.latest
    ? estimateLiqClusters(price, signals.oi.latest, signals.funding?.last ?? 0)
    : [];

  // إشارات الدفتر (طبقة شبكية مستقلة)
  const book = await bookSignals(symbol);

  const perTf = {};
  for (const tf of timeframes) {
    try {
      const raw = await fetchKlines(symbol, tf, 500);
      if (!Array.isArray(raw) || raw.length < 40) continue;
      const candles = toCandles(raw);
      const cands = candidateZones(candles, {
        strength: pivotStrengthFor(tf),
        eqhTolerancePct: calibration.eqhTolerancePct
      });
      const scored = scoreZones(cands.zones, {
        ...signals,
        ...book,
        liqClusters
      }, {
        minScore: calibration.minScore + (TF_LIMITS.minScoreAdj[tf] ?? 0),
        limit: TF_LIMITS.limit[tf] ?? 8,
        refLevels: referenceLevels(candles)
      });
      if (scored.length) perTf[tf] = scored;
    } catch { /* فريم فاشل لا يعطل البقية */ }
  }

  return { perTf, signals: { oi: signals.oi, funding: signals.funding, longShort: signals.longShort, cvd: signals.cvd, ...book }, liqClusters };
}

/**
 * خطة التحديث الحتمية: مقارنة المناطق المرشحة بالآلي المحفوظ (لقطات سابقة).
 * - مطابقة (نفس النوع + الفريم + ضمن matchTolerancePct) → إعادة استخدام id مع نقل feedback وتحديث الدرجة إذا تغيرت ≥5 أو تغير السحب.
 * - جديد → إنشاء.
 */
export function planAppends({ symbol, perTf, existingAuto, now = Date.now(), matchTolerancePct = 0.003 }) {
  const appends = [];
  const matchedIds = new Set();
  const sameTf = (z, tf) => (z.timeframe ?? '') === tf;

  for (const [tf, zones] of Object.entries(perTf)) {
    for (const z of zones) {
      const prev = existingAuto.find(e =>
        e.symbol === symbol && sameTf(e, tf) && !matchedIds.has(e.id) &&
        e.type === z.type && Math.abs(e.price - z.price) / z.price <= matchTolerancePct);
      if (prev) {
        matchedIds.add(prev.id);
        const scoreDiff = Math.abs((prev.score ?? 0) - z.score);
        const sweptChanged = Boolean(prev.swept) !== Boolean(z.swept);
        if (scoreDiff >= 5 || sweptChanged) {
          appends.push({
            ...prev,
            price: z.price,
            score: z.score,
            reasons: z.reasons,
            swept: z.swept,
            sweptAt: z.sweptAt,
            updated_at: now
          });
        }
      } else {
        appends.push({
          id: `auto-${symbol}-${tf}-${z.type}-${Math.round(z.price * 1e6)}`,
          symbol,
          type: z.type,
          price: z.price,
          timeframe: tf,
          note: '',
          score: z.score,
          reasons: z.reasons,
          clusterCount: z.clusterCount,
          swept: z.swept,
          sweptAt: z.sweptAt,
          source: 'auto',
          created_at: now,
          expires_at: null,
          active: true,
          feedback: null
        });
      }
    }
  }

  // الفريم الفاشل لا يُبطل شيئاً هنا — اللقطة الجديدة تُبنى فقط من الفريمات الناجحة
  return { appends };
}

/** بناء لقطة المناطق النشطة لعملة (نقل feedback المطابقات + استبعاد المرفوض) */
export function buildSnapshot({ symbol, perTf, existingAuto, now = Date.now(), matchTolerancePct = 0.003 }) {
  const zones = [];
  for (const [tf, list] of Object.entries(perTf)) {
    for (const z of list) {
      const prev = existingAuto.find(e =>
        e.symbol === symbol && (e.timeframe ?? '') === tf &&
        e.type === z.type && Math.abs(e.price - z.price) / z.price <= matchTolerancePct);
      if (prev?.feedback === 'reject') continue; // المستخدم رفضها — لا تعرضها مجدداً
      zones.push({
        id: prev?.id ?? `auto-${symbol}-${tf}-${z.type}-${Math.round(z.price * 1e6)}`,
        symbol,
        type: z.type,
        price: z.price,
        timeframe: tf,
        note: '',
        score: z.score,
        reasons: z.reasons,
        clusterCount: z.clusterCount,
        swept: z.swept,
        sweptAt: z.sweptAt,
        bandPct: z.bandPct,
        source: 'auto',
        created_at: prev?.created_at ?? now,
        updated_at: now,
        expires_at: null,
        active: true,
        feedback: prev?.feedback ?? null
      });
    }
  }
  return { symbol, zones, ts: now };
}
