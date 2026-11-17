import { gate, reportRateLimit, sleep, RATE_WAIT_CAP_MS } from '../net/gate.mjs';

const BINANCE_HOSTS = [
  'https://data-api.binance.vision',
  'https://api1.binance.com',
  'https://api-gcp.binance.com'
];

const RATE_RETRY_ATTEMPTS = Math.max(0, Number(process.env.BINANCE_RATE_RETRIES ?? 1));

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

function priorityOf(path, explicit) {
  if (explicit) return explicit;
  if (String(path).includes('/ticker/price')) return 'live';
  if (String(path).includes('/klines')) return 'calibration';
  return 'history';
}

export async function fetchBinanceJson(path, timeoutMs = 30000, { priority, weight } = {}) {
  await gate(priorityOf(path, priority), weight ?? pathWeightOf(path));
  let lastErr;
  for (const host of BINANCE_HOSTS) {
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
            if (attempt < RATE_RETRY_ATTEMPTS && waitMs > 0) {
              await sleep(waitMs);
              continue;
            }
            break;
          }
          lastErr = new Error(`HTTP ${status} from ${host}`);
          break;
        }
        return await res.json();
      } catch (error) {
        lastErr = error;
        break;
      }
    }
  }
  throw lastErr ?? new Error('all Binance hosts failed');
}

export function createBinanceRest({ fetchJson = fetchBinanceJson, rateRetryAttempts = RATE_RETRY_ATTEMPTS } = {}) {
  void rateRetryAttempts;
  return {
    exchangeInfo: () => fetchJson('/api/v3/exchangeInfo', 30000),
    klines: (symbol, interval, limit, startTime, endTime) => {
      const params = new URLSearchParams({ symbol, interval, limit: String(limit) });
      if (startTime) params.set('startTime', String(startTime));
      if (endTime) params.set('endTime', String(endTime));
      return fetchJson(`/api/v3/klines?${params.toString()}`, 15000);
    },
    depth: (symbol, limit = 20) => fetchJson(`/api/v3/depth?symbol=${encodeURIComponent(symbol)}&limit=${Math.min(Math.max(Number(limit) || 20, 5), 100)}`, 10000),
    tickerPrices: async (symbols) => {
      const q = encodeURIComponent(JSON.stringify(symbols));
      const rows = await fetchJson(`/api/v3/ticker/price?symbols=${q}`, 10000);
      const out = {};
      for (const row of rows) out[row.symbol] = Number(row.price);
      return out;
    },
    allTickerPrices: async () => {
      const rows = await fetchJson('/api/v3/ticker/price', 15000);
      const out = {};
      for (const row of rows) out[row.symbol] = Number(row.price);
      return out;
    }
  };
}

export const binanceRest = createBinanceRest();
export default binanceRest;
