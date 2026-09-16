/* الطبقة 2: مشتقات بينانس (Futures REST مجاني) + CVD من شموع السبوت
 * - Open Interest Hist: تكدس الرافعات حول المستويات
 * - Funding Rate: تكلفة المراكز وانحيازها
 * - Global Long/Short Account Ratio: انحياز التجزئة
 * - CVD: من عمود Taker Buy في شموع السبوت — بلا أي مصدر خارجي
 */
import { createRateLimiter } from '../research.mjs';

const FAPI_HOSTS = ['https://fapi.binance.com', 'https://fapi1.binance.com'];

async function fetchFapiJson(path, timeoutMs = 12000) {
  let lastErr;
  for (const host of FAPI_HOSTS) {
    try {
      const res = await fetch(`${host}${path}`, { signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) { lastErr = new Error(`HTTP ${res.status} from ${host}`); continue; }
      return await res.json();
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr ?? new Error('all fapi hosts failed');
}

const fapiLimiter = createRateLimiter(300);

const fapiLimited = async (path) => {
  await fapiLimiter.acquire();
  return fetchFapiJson(path);
};

/** تغير الفائدة المفتوحة: آخر قراءة مقابل ما قبل lookback قراءات (%) */
export async function oiChange(symbol, { period = '1h', limit = 25, lookback = 24 } = {}) {
  try {
    const rows = await fapiLimited(`/futures/data/openInterestHist?symbol=${symbol}&period=${period}&limit=${limit}`);
    if (!Array.isArray(rows) || rows.length < 2) return null;
    const latest = Number(rows[rows.length - 1].sumOpenInterestValue);
    const past = Number(rows[Math.max(0, rows.length - 1 - lookback)].sumOpenInterestValue);
    if (!past) return null;
    return { changePct: ((latest - past) / past) * 100, latest };
  } catch {
    return null;
  }
}

/** آخر سعر تمويل + متوسطه الأخير */
export async function funding(symbol) {
  try {
    const r = await fapiLimited(`/fapi/v1/premiumIndex?symbol=${symbol}`);
    return { last: Number(r.lastFundingRate), markPrice: Number(r.markPrice) };
  } catch {
    return null;
  }
}

/** نسبة حسابات الطويل/القصير (تجزئة) */
export async function longShortRatio(symbol, { period = '1h', limit = 6 } = {}) {
  try {
    const rows = await fapiLimited(`/futures/data/globalLongShortAccountRatio?symbol=${symbol}&period=${period}&limit=${limit}`);
    if (!Array.isArray(rows) || !rows.length) return null;
    return { last: Number(rows[rows.length - 1].longShortRatio) };
  } catch {
    return null;
  }
}

/**
 * CVD من شموع السبوت الخام (Binance klines arrays):
 * delta = 2*takerBuyBase - volume. يرجع ملخص آخر window شمعة.
 * حتمية كاملة — تُختبر بدون شبكة.
 */
export function computeCvd(rawKlines, window = 50) {
  if (!Array.isArray(rawKlines) || !rawKlines.length) return null;
  const deltas = rawKlines.map(k => {
    const vol = Number(k[5]);
    const takerBuy = Number(k[9]);
    return 2 * takerBuy - vol;
  });
  const recent = deltas.slice(-window);
  const sum = recent.reduce((a, b) => a + b, 0);
  const volSum = rawKlines.slice(-window).reduce((a, k) => a + Number(k[5]), 0);
  return {
    recentSum: sum,
    buyRatioPct: volSum > 0 ? ((volSum + sum) / 2 / volSum) * 100 : null,
    window: recent.length
  };
}

/** جمع كل إشارات المشتقات لعملة واحدة (يتسامح مع فشل أي طبقة) */
export async function collectSignals(symbol, rawSpotKlines) {
  const [oi, fund, ls] = await Promise.all([
    oiChange(symbol),
    funding(symbol),
    longShortRatio(symbol)
  ]);
  return {
    oi,
    funding: fund,
    longShort: ls,
    cvd: computeCvd(rawSpotKlines)
  };
}
