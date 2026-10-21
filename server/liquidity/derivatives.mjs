/* الطبقة 2: مشتقات بينانس (Futures REST مجاني) + CVD من شموع السبوت
 * - Open Interest Hist: تكدس الرافعات حول المستويات
 * - Funding Rate: تكلفة المراكز وانحيازها
 * - Global Long/Short Account Ratio: انحياز التجزئة
 * - CVD: من عمود Taker Buy في شموع السبوت — بلا أي مصدر خارجي
 */
import { gate, reportRateLimit, sleep, RATE_WAIT_CAP_MS } from '../net/gate.mjs';

const FAPI_HOSTS = ['https://fapi.binance.com', 'https://fapi1.binance.com'];

/**
 * إصلاح B6 (الجزء الناقص): كان لهذا المسار محدّد محلي بسيط — «طلب واحد كل 300ms»
 * بلا دلو أوزان ولا أولويات ولا احترام Retry-After — فلم يكن منضبطاً أمام طلبات
 * الخادم الأخرى (باك تيست، بحث، معايرة، محركات حية) على حدود الشبكة.
 * الآن يمرّ بالمحدد الموحّد. الوزن 1 عن قصد: نقاط FAPI تستهلك وزنها الخاص (‎+40/د
 * لكل نداء وزنٍ 1، وحدّها 2400/د)، وتُحسب هنا على ميزانية السبوت كتحفّظ إضافي —
 * أي أن السقف الفعلي أقل من المسموح، لا أكثر.
 */
const FAPI_WEIGHT = 1;

async function fetchFapiJson(path, timeoutMs = 12000) {
  let lastErr;
  for (const host of FAPI_HOSTS) {
    for (let attempt = 0; attempt <= 1; attempt += 1) {
      await gate('calibration', FAPI_WEIGHT);
      try {
        const res = await fetch(`${host}${path}`, { signal: AbortSignal.timeout(timeoutMs) });
        if (!res.ok) {
          lastErr = new Error(`HTTP ${res.status} from ${host}`);
          if (res.status === 429 || res.status === 418) {
            const retryAfter = Number(res.headers.get('retry-after'));
            const declared = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 0;
            reportRateLimit(res.status, declared);
            const waitMs = Math.min(declared || 20_000, RATE_WAIT_CAP_MS);
            if (attempt === 0 && waitMs > 0) { await sleep(waitMs); continue; }
          }
          break; // خطأ غير متعلق بالمعدل، أو استُهلكت محاولة الإعادة: المضيف التالي
        }
        return await res.json();
      } catch (e) { lastErr = e; break; }
    }
  }
  throw lastErr ?? new Error('all fapi hosts failed');
}

const fapiLimited = async (path) => fetchFapiJson(path);

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
