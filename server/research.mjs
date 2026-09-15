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
    const search = await throttledFetch(`${GECKO}/search?query=${encodeURIComponent(base)}`);
    const id = pickCoinId(search, base);
    if (!id) {
      out.status = 'insufficient';
      out.message = 'لم يُعثر على مشروع مطابق للرمز في CoinGecko';
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
