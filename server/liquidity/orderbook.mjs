/* الطبقة 3: دفتر الأوامر مبسط + خريطة التصفيات التقديرية
 * كل الدوال التحليلية حتمية وقابلة للاختبار بدون شبكة؛ نداءات الشبكة معزولة في النهاية.
 */

/** عدم توازن الدفتر: مجموع الكميات ضمن ±0.5% من السعر الأوسط (bids/asks = [price, qty]) */
export function bookImbalance(bids, asks, bandPct = 0.005) {
  if (!bids.length || !asks.length) return null;
  const mid = (Number(bids[0][0]) + Number(asks[0][0])) / 2;
  const inBand = (rows) => rows.reduce((a, r) => {
    const p = Number(r[0]);
    return Math.abs(p - mid) / mid <= bandPct ? a + Number(r[1]) : a;
  }, 0);
  const bidQty = inBand(bids);
  const askQty = inBand(asks);
  if (bidQty + askQty === 0) return null;
  // >1 طلبات شراء أثقل، <1 بيع
  return bidQty / askQty;
}

/**
 * كشف آيسبرغ تقريبي من تدفق الصفقات: مستوى سعري ضُرب مرات كثيرة بحجم متقارب
 * = أمر مخفي يُعاد تعبئته. trades = {price, qty}.
 */
export function detectIceberg(trades, { minHits = 4, tolerancePct = 0.0001 } = {}) {
  const buckets = new Map();
  for (const t of trades) {
    let key = null;
    for (const [k] of buckets) {
      if (Math.abs(t.price - k) / k <= tolerancePct) { key = k; break; }
    }
    if (key === null) { key = t.price; buckets.set(key, { hits: 0, qty: 0, qtys: [] }); }
    const b = buckets.get(key);
    b.hits += 1;
    b.qty += t.qty;
    b.qtys.push(t.qty);
  }
  const out = [];
  for (const [price, b] of buckets) {
    if (b.hits >= minHits) {
      // تشابه الأحجام: انحراف معياري صغير نسبياً = إعادة تعبئة منتظمة
      const mean = b.qty / b.hits;
      const sd = Math.sqrt(b.qtys.reduce((a, q) => a + (q - mean) ** 2, 0) / b.hits);
      const cv = mean > 0 ? sd / mean : 1;
      out.push({ price, hits: b.hits, totalQty: b.qty, sizeConsistency: 1 - Math.min(1, cv) });
    }
  }
  return out.sort((a, b) => b.hits - a.hits).slice(0, 5);
}

/**
 * كشف Spoof تقريبي: مستوى كان كبيراً في اللقطة السابقة واختفى في الثانية
 * مع حجم متداول قليل عند سعره (أُلغي لم يُنفذ).
 * prev/next = مصفوفات [price, qty]، tradesAtPrice دالة تُرجع الكمية المتداولة عند مستوى.
 */
export function detectSpoof(prev, next, tradedQtyAtPrice, {
  minQtyRatio = 3, // كبير = ≥3× متوسط أفضل 20 مستوى
  executedRatioMax = 0.3
} = {}) {
  if (!prev.length || !next.length) return [];
  const avgQty = prev.slice(0, 20).reduce((a, r) => a + Number(r[1]), 0) / Math.min(20, prev.length);
  if (!avgQty) return [];
  const nextPrices = new Set(next.map(r => Number(r[0]).toString()));
  const out = [];
  for (const r of prev) {
    const price = Number(r[0]);
    const qty = Number(r[1]);
    if (qty < avgQty * minQtyRatio) continue;
    if (nextPrices.has(price.toString())) continue;
    const traded = tradedQtyAtPrice(price) ?? 0;
    if (traded <= qty * executedRatioMax) {
      out.push({ price, qty, traded });
    }
  }
  return out.slice(0, 5);
}

/* ---- خريطة التصفيات التقديرية (نفس مبدأ Coinglass — تقدير لا حقيقة) ---- */

const LEV_BANDS = [
  { lev: 10, w: 0.35 },
  { lev: 25, w: 0.30 },
  { lev: 50, w: 0.20 },
  { lev: 100, w: 0.15 }
];

/**
 * عناقيد التصفيات المرشحة من قيمة الفائدة المفتوحة:
 * - مستويات التصفية الطويلة تحت السعر، والقصيرة فوقه (مميتة الحسابات تقريباً).
 * - التمويل الموجب يعني ازدحام الطويلين → إزاحة 10% من الوزن نحو التصفيات الطويلة.
 * حتمية وقابلة للاختبار بدون شبكة.
 */
export function estimateLiqClusters(price, oiValueUsd, fundingRate = 0) {
  if (!price || !oiValueUsd) return [];
  // إزاحة الوزن حسب إشارة التمويل: موجب → طويلون مزدحمون
  const longShift = fundingRate > 0 ? 0.1 : fundingRate < 0 ? -0.1 : 0;
  const clusters = [];
  for (const { lev, w } of LEV_BANDS) {
    const longW = Math.min(0.9, Math.max(0.1, w + longShift));
    const shortW = w * 2 - longW; // مجموع وزن الباند ثابت (طويل + قصير)
    clusters.push({
      side: 'long', // تصفية طويلين عند انخفاض السعر
      lev,
      price: price * (1 - 1 / lev + 0.005),
      magnitude: oiValueUsd * longW
    });
    clusters.push({
      side: 'short',
      lev,
      price: price * (1 + 1 / lev - 0.005),
      magnitude: oiValueUsd * Math.max(0.1, shortW)
    });
  }
  return clusters.sort((a, b) => b.magnitude - a.magnitude);
}

/** أقرب عنقود تصفية لسعر معين ضمن مسافة قصوى (%) */
export function nearestLiqCluster(price, clusters, withinPct = 0.007) {
  let best = null;
  for (const c of clusters) {
    const dist = Math.abs(c.price - price) / price;
    if (dist <= withinPct && (!best || dist < best.dist)) {
      best = { ...c, dist };
    }
  }
  return best;
}

/* ---- نداءات الشبكة (معزولة) ---- */
const SPOT_HOSTS = ['https://data-api.binance.vision', 'https://api1.binance.com'];

async function fetchSpotJson(path, timeoutMs = 10000) {
  let lastErr;
  for (const host of SPOT_HOSTS) {
    try {
      const res = await fetch(`${host}${path}`, { signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) { lastErr = new Error(`HTTP ${res.status} from ${host}`); continue; }
      return await res.json();
    } catch (e) { lastErr = e; }
  }
  throw lastErr ?? new Error('all spot hosts failed');
}

export async function fetchDepth(symbol, limit = 100) {
  const d = await fetchSpotJson(`/api/v3/depth?symbol=${symbol}&limit=${limit}`);
  return { bids: d.bids, asks: d.asks };
}

export async function fetchAggTrades(symbol, limit = 1000) {
  const rows = await fetchSpotJson(`/api/v3/aggTrades?symbol=${symbol}&limit=${limit}`);
  return rows.map(t => ({ price: Number(t.p), qty: Number(t.q), isBuyerMaker: Boolean(t.m) }));
}

/* ---- فقاعات الأوامر العدوانية (فلتر فابيو بصيغة كريبتو) ---- */

/** كمية اسمية تتجاوز النسبة p من الدفعة (0..1) — من البيانات نفسها لا افتراض */
function notionalQuantile(trades, p) {
  const sorted = trades.map(t => t.price * t.qty).sort((a, b) => a - b);
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

/**
 * فقاعات الأوامر: صفقات فردية ضخمة اسمياً = عدوان لاعب كبير (مبدأ "30 عقد" مُعرَّب:
 * لا عقود في الكريبتو — العتبة بالدولار الاسمي، ومن أعلى شريحة الدفعة نفسها افتراضياً).
 * trades = {price, qty, isBuyerMaker}; isBuyerMaker=false → شراء آجل (آمر سوق مشترٍ).
 * حتمية وقابلة للاختبار بدون شبكة.
 */
export function detectBubbles(trades, { notionalPercentile = 0.999, minBubbleCount = 3 } = {}) {
  if (!Array.isArray(trades) || trades.length < minBubbleCount) return [];
  const threshold = notionalQuantile(trades, notionalPercentile);
  if (!(threshold > 0)) return [];
  const bubbles = [];
  for (const t of trades) {
    const notional = t.price * t.qty;
    if (notional >= threshold) {
      bubbles.push({
        type: t.isBuyerMaker ? 'aggressive_sell' : 'aggressive_buy',
        price: t.price,
        qty: t.qty,
        notional
      });
    }
  }
  return bubbles.sort((a, b) => b.notional - a.notional).slice(0, 5);
}
