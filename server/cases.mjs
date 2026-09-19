/* Case Ledger assembly layer.
 * Determinism: every derived stat comes ONLY from fully-closed candles before
 * the decision instant (no forming candle), preventing any look-ahead.
 * Thermal: Binance derivatives + order book + Fear&Greed + stablecoin mcap.
 * Reuses existing liquidity/ modules as-is (no parallel systems).
 */
import { collectSignals } from './liquidity/derivatives.mjs';
import { bookSignals } from './liquidity/engine.mjs';
import { estimateLiqClusters } from './liquidity/orderbook.mjs';
import { candidateZones, referenceLevels } from './liquidity/structure.mjs';

export const DECISION_ACTORS = [
  'zone_create', 'zone_edit', 'zone_delete',
  'zone_auto_feedback', 'zone_auto_note',
  'analysis_edit', 'coin_add', 'coin_remove'
];

export const TF_SECONDS = {
  '1m': 60, '3m': 180, '5m': 300, '15m': 900, '30m': 1800, '1h': 3600,
  '2h': 7200, '4h': 14400, '6h': 21600, '8h': 28800, '12h': 43200,
  '1d': 86400, '3d': 259200, '1w': 604800
};

/** Candles fully closed before the decision second — the anti-look-ahead gate. */
export function closedCandles(candles, tfSec, decidedAtSec) {
  if (!Array.isArray(candles)) return [];
  return candles.filter(c => Number(c.time) + tfSec <= decidedAtSec);
}

/** Deterministic structural summary from closed candles only (network-free, testable). */
export function deriveStats(candles, { tfSec, decidedAtSec, strength = 3, eqhTolerancePct = 0.002 } = {}) {
  const closed = closedCandles(candles, tfSec, decidedAtSec);
  if (!closed.length) return { closedCount: 0, lastClose: null, stats: null };
  const lastClose = Number(closed[closed.length - 1].close);
  const { zones, pivots, clusters, fvgs } = candidateZones(closed, {
    strength, eqhTolerancePct, now: decidedAtSec * 1000
  });
  const ref = referenceLevels(closed);
  return {
    closedCount: closed.length,
    lastClose,
    stats: {
      zones: zones.map(z => ({
        type: z.type, price: z.price, clusterCount: z.clusterCount,
        swept: z.swept, fvgNear: z.fvgNear, bandPct: z.bandPct
      })),
      eqh: clusters.filter(c => c.kind === 'high').map(c => ({ price: c.price, count: c.count })),
      eql: clusters.filter(c => c.kind === 'low').map(c => ({ price: c.price, count: c.count })),
      fvgs: fvgs.slice(-8).map(f => ({ time: f.time, top: f.top, bottom: f.bottom, dir: f.dir })),
      refHigh: ref?.high ?? null,
      refLow: ref?.low ?? null,
      pivots: pivots.slice(-12).map(p => ({ time: p.time, price: p.price, kind: p.kind }))
    }
  };
}

/** Full decision payload: on-screen candles + closed summaries + zones + thermal. */
export async function assembleCase({ symbol, actor, decidedAt = Date.now(), snapshot = {}, db }) {
  const decidedAtSec = Math.floor(decidedAt / 1000);
  const chart = {};
  const charts = Array.isArray(snapshot.charts) ? snapshot.charts : [];
  for (const c of charts) {
    const tfSec = Number(c.tfSec) || TF_SECONDS[c.tf];
    if (!tfSec) continue;
    chart[c.tf] = {
      tf: c.tf,
      tfSec,
      decidedAtSec,
      candles: Array.isArray(c.candles) ? c.candles.slice(-800) : [],
      stats: deriveStats(c.candles ?? [], { tfSec, decidedAtSec })
    };
  }
  const thermal = await collectThermal(symbol, db, decidedAt);
  return {
    meta: {
      symbol,
      actor,
      decided_at: decidedAt,
      livePrice: snapshot.livePrice ?? null
    },
    chart,
    zones: Array.isArray(snapshot.zones) ? snapshot.zones : [],
    analysisBefore: snapshot.analysis ?? null,
    analysisAfter: snapshot.analysisAfter ?? null,
    note: snapshot.note ?? null,
    zone: snapshot.zone ?? null,
    thermal
  };
}

/** Market climate at the decision instant — every layer tolerates failure. */
export async function collectThermal(symbol, db, decidedAt) {
  const out = {
    funding: null, oi: null, longShort: null, cvd: null,
    book: null, liqClusters: null, fearGreed: null, stables: null,
    decidedAt
  };
  try {
    const raw1h = await db.binance.klines(symbol, '1h', 120);
    const signals = await collectSignals(symbol, raw1h);
    out.funding = signals.funding;
    out.oi = signals.oi;
    out.longShort = signals.longShort;
    out.cvd = signals.cvd;
    const price = signals.funding?.markPrice ?? (raw1h.length ? Number(raw1h[raw1h.length - 1][4]) : null);
    if (price && signals.oi?.latest) {
      out.liqClusters = estimateLiqClusters(price, signals.oi.latest, signals.funding?.last ?? 0).slice(0, 8);
    }
    out.book = await bookSignals(symbol, 700);
  } catch { /* thermal is best-effort */ }
  out.fearGreed = await fetchFearGreed();
  out.stables = await fetchStables();
  return out;
}

async function fetchFearGreed() {
  try {
    const res = await fetch('https://api.alternative.me/fng/?limit=1', { signal: AbortSignal.timeout(6000) });
    const j = await res.json();
    const d = j?.data?.[0];
    if (!d) return { available: false };
    return {
      available: true,
      value: Number(d.value),
      classification: d.value_classification ?? null,
      ts: d.timestamp ? Number(d.timestamp) * 1000 : null
    };
  } catch {
    return { available: false };
  }
}

async function fetchStables() {
  try {
    const res = await fetch('https://api.llama.fi/stablecoins?includePrices=true', { signal: AbortSignal.timeout(6000) });
    const j = await res.json();
    const total = Number(j?.total ?? 0);
    if (!total) return { available: false };
    return {
      available: true,
      totalMcapUsd: total,
      pegged: (j?.peggedAssets ?? []).slice(0, 5).map(a => ({
        symbol: a?.symbol ?? a?.asset ?? '',
        mcapUsd: Number(a?.circulating ?? 0)
      }))
    };
  } catch {
    return { available: false };
  }
}