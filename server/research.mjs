/* ============================================================
   خدمة البحث الآلي عن المشاريع — CoinGecko + الموقع الرسمي
   ------------------------------------------------------------
   تسلسل منضبط يحترم حدود الـ API: طلب واحد كل ~3.2 ثانية،
   وإعادة محاولة تراجعية على 429، وجلب الموقع الرسمي فقط عند
   الغموض وبحد زمني. الفشل نتيجة معلنة لا حكم.
   ============================================================ */

import { extractFacts, verdictGate, researchConfidence, researchSummary } from './researchCore.mjs';

const GECKO = 'https://api.coingecko.com/api/v3';
const MIN_INTERVAL_MS = 3200;
let lastCallAt = 0;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function throttledFetch(url, { attempts = 3 } = {}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const wait = lastCallAt + MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastCallAt = Date.now();
    const res = await fetch(url, {
      headers: { accept: 'application/json', 'user-agent': 'binance-spot-analyzer/1.0' },
      signal: AbortSignal.timeout(15000)
    });
    if (res.status === 429) {
      await sleep(15000 * (attempt + 1));
      continue;
    }
    if (!res.ok) throw new Error(`CoinGecko HTTP ${res.status}`);
    return await res.json();
  }
  throw new Error('تجاوز حد CoinGecko بعد إعادة المحاولات');
}

/** يطابق رمز الأصل مع نتيجة البحث: رمز صريح متساوٍ فقط */
export function pickCoinId(searchResult, base) {
  const coins = Array.isArray(searchResult?.coins) ? searchResult.coins : [];
  const target = base.toLowerCase();
  const exact = coins.filter(c => String(c.symbol).toLowerCase() === target);
  if (exact.length === 0) return null;
  exact.sort((a, b) => (a.market_cap_rank ?? 9999) - (b.market_cap_rank ?? 9999));
  return exact[0]?.id ?? null;
}

/** يطابق رمز الأصل مع نتائج /coins/markets (فلتر الرموز الحرفي): الأدنى رتبة سوقية يفوز */
export function pickCoinIdFromMarkets(marketsResult, base) {
  const rows = Array.isArray(marketsResult) ? marketsResult : [];
  const target = base.toLowerCase();
  const exact = rows.filter(r => String(r?.symbol ?? '').toLowerCase() === target);
  if (exact.length === 0) return null;
  exact.sort((a, b) => (a.market_cap_rank ?? 9999) - (b.market_cap_rank ?? 9999));
  // مرشحان فأكثر بلا رتبة إطلاقاً = غموض — لا إسناد
  if (exact.length > 1 && exact[0].market_cap_rank == null) return null;
  return exact[0]?.id ?? null;
}

/**
 * يتحقق أن عملة مرشحة من البحث تُتاجر فعلاً على بينانس بـ base مطابق لرمز الأصل.
 * المرجع: /exchanges/binance/tickers?coin_ids={id} — مطابقة رسمية من CoinGecko نفسه.
 * يحل اختلاف الرمز بين المنصتين (مثال: بينانس VELODROME ↔ كوينجيكو velodrome-finance برمز VELO).
 */
export function tickerMatchesBinanceBase(tickersResult, base) {
  const tickers = Array.isArray(tickersResult?.tickers) ? tickersResult.tickers : [];
  const target = String(base).toUpperCase();
  return tickers.some(t =>
    String(t?.base ?? '').toUpperCase() === target &&
    t?.market?.identifier === 'binance' &&
    !!t?.coin_id &&
    t?.is_anomaly !== true
  );
}

async function fetchHomepageText(url) {
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': 'binance-spot-analyzer/1.0' },
      signal: AbortSignal.timeout(7000)
    });
    if (!res.ok) return '';
    const html = await res.text();
    return html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .slice(0, 20000);
  } catch {
    return '';
  }
}

/**
 * يبحث عن مشروع العملة ويستخرج الحقائق حتمياً.
 * @returns {Promise<{status:'documented'|'insufficient'|'failed', coinName:?, geckoId:?,
 *   facts:Object, gated:Object, confidence:number, summary:Object, sources:string[], message:string}>}
 */
export async function researchSymbol(base) {
  const out = {
    status: 'failed', coinName: null, geckoId: null,
    facts: {}, gated: {}, confidence: 0, summary: { resolvedRaw: 0, resolvedGated: 0 },
    sources: [], message: ''
  };
  try {
    /* الطبقة 1: /search مع تطابق رمز حرفي (سريع، يكفي أغلب الحالات) */
    const search = await throttledFetch(`${GECKO}/search?query=${encodeURIComponent(base)}`);
    let id = pickCoinId(search, base);
    /* الطبقة 2: /coins/markets بفلتر الرموز — تطابق حرفي بلا ضبابية + رتبة السوق */
    if (!id) {
      const markets = await throttledFetch(
        `${GECKO}/coins/markets?vs_currency=usd&symbols=${encodeURIComponent(base)}&per_page=25&page=1`
      );
      id = pickCoinIdFromMarkets(markets, base);
    }
    /* الطبقة 3: مرشحو البحث برمز مختلف على كوينجيكو — تحقق أن أحدهم يُتاجر على بينانس بـ base مطابق */
    if (!id) {
      const candidates = (Array.isArray(search?.coins) ? search.coins : [])
        .filter(c => c?.id)
        .sort((a, b) => (a.market_cap_rank ?? 9999) - (b.market_cap_rank ?? 9999))
        .slice(0, 3);
      for (const cand of candidates) {
        const tickers = await throttledFetch(
          `${GECKO}/exchanges/binance/tickers?coin_ids=${encodeURIComponent(cand.id)}&page=1`
        );
        if (tickerMatchesBinanceBase(tickers, base)) { id = cand.id; break; }
      }
    }
    if (!id) {
      /* حالة نهائية: العملة غير موجودة في CoinGecko — لا فائدة من إعادة المحاولة الدورية */
      out.status = 'not_found';
      out.message = 'هذه العملة غير موجودة في CoinGecko — لا يتوفر بحث آلي لها. وثّقها يدوياً من النماذج أدناه.';
      return out;
    }
    const coin = await throttledFetch(
      `${GECKO}/coins/${encodeURIComponent(id)}?localization=false&tickers=false&market_data=false&community_data=false&developer_data=false&sparkline=false`
    );
    out.geckoId = id;
    out.coinName = coin?.name ?? null;

    const facts = extractFacts(coin, '');
    /* طبقة الموقع الرسمي فقط عند الغموض: لا منفعة محسومة ولا مخاطر محسومة */
    const decisive = ['has_utility', 'is_memecoin', 'has_lending_interest', 'linked_haram_activity'];
    const anyDecisive = decisive.some(k => facts[k].value !== null);
    if (!anyDecisive && Array.isArray(coin?.links?.homepage)) {
      const home = coin.links.homepage.find(u => typeof u === 'string' && u.startsWith('http'));
      if (home) {
        const homeText = await fetchHomepageText(home);
        const enriched = extractFacts(coin, homeText);
        for (const k of Object.keys(facts)) {
          if (facts[k].value === null || enriched[k].confidence > facts[k].confidence) facts[k] = enriched[k];
        }
      }
    }

    const gated = verdictGate(facts);
    out.facts = facts;
    out.gated = gated;
    out.confidence = researchConfidence(facts);
    out.summary = researchSummary(facts, gated);
    out.sources = [`https://www.coingecko.com/en/coins/${id}`];
    const home = coin?.links?.homepage?.find(u => typeof u === 'string' && u.startsWith('http'));
    if (home) out.sources.push(home);
    out.status = out.summary.resolvedGated > 0 ? 'documented' : 'insufficient';
    if (out.status === 'insufficient') {
      out.message = 'لا توجد بيانات كافية بثقة مقبولة — تبقى للتحقق وإعادة البحث دورياً';
    }
    return out;
  } catch (e) {
    out.message = String(e?.message || e);
    return out;
  }
}

/* ---- محدد معدل قابل للفحص: لا يسمح بأكثر من طلب واحد في النافذة ---- */
export function createRateLimiter(minIntervalMs) {
  let last = 0;
  return {
    async acquire() {
      const wait = last + minIntervalMs - Date.now();
      if (wait > 0) await sleep(wait);
      last = Date.now();
    },
    get lastCallAt() { return last; }
  };
}
