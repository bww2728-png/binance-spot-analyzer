import { createHash } from 'node:crypto';
import { detectLiquidityZones } from '../liquidity-zones/engine.mjs';
import { detectLiquidityZonesV2 } from '../liquidity-zones/v2/index.mjs';

const ENGINE_VERSION = { legacy: 'liquidity-engine-v1', v2: 'liquidity-engine-v2' };
const HISTORY_LIMIT = 500;
/**
 * الحد الأدنى لشموع الإغلاق المقبولة لكل فريم. الفريمات الكبيرة (1w مثلاً) لا تملك
 * 500 شمعة مغلقة أصلًا في تاريخ الزوج كله (BTCUSDT سبوت ≈ 479 أسبوعًا)، والمحرك
 * نفسه يتجاوز الكشف تحت 40 شمعة؛ فشرط 500 الكامل كان يُسقط فريمات سليمة ويوقف
 * الاستعادة كلها. 60 شمعة تحفظ هامش أمان فوق حد الكشف دون مساس بقواعده.
 */
const MIN_HISTORY_BARS = 60;
const asMillis = (value) => {
  const n = typeof value === 'string' && !/^\d+(\.\d+)?$/.test(value) ? Date.parse(value) : Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n < 1e12 ? n * 1000 : n;
};
const stableKey = (...values) => createHash('sha256').update(values.map(String).join('|')).digest('hex');
const buildZonePoints = (engine, zone, candles, reviewedAt) => {
  const points = [];
  const seenIds = new Set();
  const add = ({ type, role, time, index, price, low, high, payload }) => {
    const normalizedTime = asMillis(time);
    const numericPrice = Number(price);
    const numericLow = Number(low);
    const numericHigh = Number(high);
    const pointPayload = { ...(payload ?? {}), zoneKind: zone.kind, zoneState: zone.state ?? null, zoneConfidence: zone.confidence ?? null };
    // أحداث البنية سياق مشترك للنافذة كاملة (المحرك يرفق نفس القائمة بكل منطقة)،
    // فمعرّفها بلا هوية المنطقة وتُسند لأول منطقة تُظهرها؛ بقية النقاط خاصة بالمنطقة.
    const shared = type.startsWith('structure_');
    const pointId = stableKey(engine, zone.symbol, zone.timeframe, shared ? 'window' : zone.id, type, role, normalizedTime ?? '', index ?? '', Number.isFinite(numericPrice) ? numericPrice : '', Number.isFinite(numericLow) ? numericLow : '', Number.isFinite(numericHigh) ? numericHigh : '');
    // القمم/القيعان المجمّعة قد تتكرر حرفيًا داخل المنطقة نفسها؛ النقطة الواحدة تُحفظ مرة واحدة.
    if (seenIds.has(pointId)) return;
    seenIds.add(pointId);
    points.push({
      point_id: pointId,
      engine,
      symbol: zone.symbol,
      timeframe: zone.timeframe,
      zone_id: String(zone.id),
      point_type: type,
      role,
      point_time: normalizedTime,
      candle_index: index == null || !Number.isInteger(Number(index)) ? null : Number(index),
      price: Number.isFinite(numericPrice) ? numericPrice : null,
      price_low: Number.isFinite(numericLow) ? numericLow : null,
      price_high: Number.isFinite(numericHigh) ? numericHigh : null,
      zone_state: zone.state ?? null,
      confirmed_at: asMillis(zone.confirmedAt),
      last_reviewed_at: reviewedAt,
      rules_version: engine,
      payload: pointPayload
    });
  };
  for (const [pointIndex, point] of (zone.touchPoints ?? []).entries()) {
    const isOrigin = pointIndex === 0 && (zone.kind === 'supply' || zone.kind === 'demand');
    add({
      type: isOrigin ? 'origin_candle' : zone.kind.startsWith('trendline_') ? 'trendline_anchor' : 'liquidity_touch',
      role: isOrigin ? 'zone_origin' : pointIndex === 0 ? 'first_touch' : 'cluster_touch',
      time: point.time ?? candles?.[point.index]?.time,
      index: point.index,
      price: point.price,
      payload: { form: zone.form ?? null }
    });
  }
  for (const [pointIndex, point] of (zone.trendline?.points ?? []).entries()) {
    add({ type: 'trendline_anchor', role: `anchor_${pointIndex + 1}`, time: point.time ?? candles?.[point.index]?.time, index: point.index, price: point.price });
  }
  for (const gap of zone.fvgs ?? []) {
    const candle = candles?.[gap.index];
    add({
      type: 'fvg', role: 'zone_gap', time: candle?.time ?? gap.time, index: gap.index,
      price: (Number(gap.top) + Number(gap.bottom)) / 2, low: gap.bottom, high: gap.top,
      payload: { kind: gap.kind }
    });
  }
  for (const event of zone.structureEvents ?? []) {
    const candle = candles?.[event.index];
    add({ type: `structure_${event.type}`, role: 'confirmation_or_structure', time: event.time ?? candle?.time, index: event.index, price: event.price ?? event.brokenLevel, payload: event });
  }
  return points;
};
export const deriveZonePoints = (engine, zones, candles, reviewedAt) => {
  const seen = new Set();
  const rows = [];
  for (const zone of zones) {
    for (const point of buildZonePoints(engine, zone, candles, reviewedAt)) {
      if (seen.has(point.point_id)) continue;
      seen.add(point.point_id);
      rows.push(point);
    }
  }
  return rows;
};
const directionOf = (zone) => {
  const direction = String(zone?.direction ?? '').toLowerCase();
  if (direction === 'up') return 'up';
  if (direction === 'down') return 'down';
  const kind = String(zone?.kind ?? '');
  if (kind.endsWith('bsl') || kind === 'supply') return 'down';
  if (kind.endsWith('ssl') || kind === 'demand') return 'up';
  return null;
};
const referenceOf = (zone) => {
  for (const value of [zone?.referenceLevel, zone?.liquidityLevel, zone?.zoneBox?.high, zone?.zoneBox?.low]) {
    if (value == null || value === '') continue;
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return Number.NaN;
};
const timeOf = (zone) => asMillis(zone?.createdAt ?? zone?.confirmedAt ?? zone?.sweptAt);

export function findLiquidityMatchCandidates(legacy = [], v2 = [], { tickSize, timeframeMs } = {}) {
  const tick = Number(tickSize);
  const windowMs = Number(timeframeMs);
  if (!Number.isFinite(tick) || tick <= 0 || !Number.isFinite(windowMs) || windowMs <= 0) return [];
  const used = new Set();
  const matches = [];
  for (const oldZone of legacy) {
    const oldReference = referenceOf(oldZone);
    const oldTime = timeOf(oldZone);
    const oldDirection = directionOf(oldZone);
    if (!Number.isFinite(oldReference) || oldTime == null || !oldDirection) continue;
    let selected = null;
    for (let index = 0; index < v2.length; index += 1) {
      if (used.has(index)) continue;
      const newZone = v2[index];
      const newReference = referenceOf(newZone);
      const newTime = timeOf(newZone);
      if (newZone.symbol !== oldZone.symbol || newZone.timeframe !== oldZone.timeframe) continue;
      if (directionOf(newZone) !== oldDirection || !Number.isFinite(newReference) || newTime == null) continue;
      const priceDelta = Math.abs(oldReference - newReference);
      const timeDeltaMs = Math.abs(oldTime - newTime);
      if (priceDelta > tick + Math.max(1e-12, tick * 1e-9) || timeDeltaMs > windowMs) continue;
      if (!selected || priceDelta < selected.priceDelta || (priceDelta === selected.priceDelta && timeDeltaMs < selected.timeDeltaMs)) {
        selected = { index, newZone, priceDelta, timeDeltaMs };
      }
    }
    if (!selected) continue;
    used.add(selected.index);
    matches.push({
      legacyId: oldZone.id,
      v2Id: selected.newZone.id,
      symbol: oldZone.symbol,
      timeframe: oldZone.timeframe,
      direction: oldDirection,
      legacyReference: oldReference,
      v2Reference: referenceOf(selected.newZone),
      priceDelta: selected.priceDelta,
      timeDeltaMs: selected.timeDeltaMs,
      classification: 'candidate'
    });
  }
  return matches;
}

export function describeZone(zone, { price, priceAt, now = Date.now() } = {}) {
  const reference = referenceOf(zone);
  const currentPrice = Number(price);
  const distance = Number.isFinite(reference) && Number.isFinite(currentPrice) && currentPrice > 0
    ? Math.abs(reference - currentPrice)
    : null;
  return {
    distance,
    distancePct: distance == null ? null : distance / currentPrice * 100,
    priceAt: Number.isFinite(Number(priceAt)) ? Number(priceAt) : null,
    priceAgeMs: Number.isFinite(Number(priceAt)) ? Math.max(0, now - Number(priceAt)) : null,
    basis: 'abs(referenceLevel - latestFreshPrice); percentage = distance / latestFreshPrice * 100'
  };
}

function closedRows(rawRows, now) {
  return (Array.isArray(rawRows) ? rawRows : [])
    .filter((row) => Array.isArray(row)
      && Number.isFinite(Number(row[0]))
      && Number.isFinite(Number(row[6]))
      && Number(row[6]) < now)
    .slice(-HISTORY_LIMIT);
}

async function forEachClosedRange(fetchKlines, symbol, timeframe, duration, fromOpen, toOpen, now, onRows) {
  if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(fromOpen) || !Number.isFinite(toOpen)) {
    throw new Error(`حدود استعادة غير صالحة للفريم ${timeframe}`);
  }
  if (toOpen < fromOpen) return 0;
  if ((toOpen - fromOpen) % duration !== 0) throw new Error(`نطاق استعادة غير محاذٍ لشموع الفريم ${timeframe}`);

  let nextOpen = fromOpen;
  let total = 0;
  while (nextOpen <= toOpen) {
    const count = Math.min(1000, Math.floor((toOpen - nextOpen) / duration) + 1);
    const pageEnd = nextOpen + (count - 1) * duration + duration - 1;
    const raw = await fetchKlines(symbol, timeframe, count, nextOpen, pageEnd);
    const page = (Array.isArray(raw) ? raw : [])
      .filter((row) => Array.isArray(row) && Number.isFinite(Number(row[0])) && Number.isFinite(Number(row[6])) && Number(row[6]) < now)
      .filter((row) => Number(row[0]) >= nextOpen && Number(row[0]) <= pageEnd)
      .sort((left, right) => Number(left[0]) - Number(right[0]));
    if (page.length !== count) throw new Error(`قراءة استعادة ناقصة للفريم ${timeframe}: ${page.length}/${count}`);
    for (let index = 0; index < page.length; index += 1) {
      if (Number(page[index][0]) !== nextOpen + index * duration) throw new Error(`فجوة شموع في استعادة الفريم ${timeframe}`);
    }
    await onRows(page);
    total += page.length;
    nextOpen += count * duration;
  }
  return total;
}

function fromStoredCandle(row) {
  return [
    Number(row.open_time), Number(row.open), Number(row.high), Number(row.low), Number(row.close),
    Number(row.volume ?? 0), Number(row.close_time), 0, 0, Number(row.taker_buy_base ?? 0)
  ];
}

function toStoredCandle(symbol, timeframe, row, now, source = 'binance-spot') {
  return {
    symbol,
    timeframe,
    open_time: Number(row[0]),
    open: Number(row[1]),
    high: Number(row[2]),
    low: Number(row[3]),
    close: Number(row[4]),
    volume: Number(row[5] ?? 0),
    close_time: Number(row[6]),
    taker_buy_base: Number(row[9] ?? 0),
    source,
    updated_at: now
  };
}

function normalizeKline(kline) {
  const openTime = Number(kline?.t);
  const closeTime = Number(kline?.T);
  const open = Number(kline?.o);
  const high = Number(kline?.h);
  const low = Number(kline?.l);
  const close = Number(kline?.c);
  if (![openTime, closeTime, open, high, low, close].every(Number.isFinite)) return null;
  return [openTime, open, high, low, close, Number(kline.v ?? 0), closeTime, 0, 0, Number(kline.V ?? 0)];
}

export function createLiquidityWorkbench({
  repository,
  market,
  fetchKlines,
  fetchDepth,
  timeframes,
  timeframeMs = {},
  tickSizeFor = async () => null,
  engineOptions = () => ({}),
  symbol = 'BTCUSDT',
  now = () => Date.now(),
  onUpdate = () => {}
}) {
  const state = {
    enabled: true,
    recovery: 'pending',
    error: null,
    symbol,
    timeframes: [...timeframes],
    seeded: 0,
    expected: timeframes.length,
    historyTarget: HISTORY_LIMIT,
    historyCounts: {},
    latestCloseAt: null,
    latestScanAt: null,
    storedCandles: 0,
    lastPrunedAt: null,
    tickSize: null,
    samples: 0,
    lastGapRepairedAt: null
  };
  const scans = new Map();
  const liveCandles = new Map();
  const recentEvents = [];
  const eventKeys = new Set();
  const processedBars = new Map();
  const sampleAt = new Map();
  const retryTimers = new Set();
  let started = false;
  let stopping = false;
  let lifecycleGeneration = 0;
  let startPromise = null;
  let unsubscribe = null;
  let retentionTimer = null;
  let scanQueue = Promise.resolve();
  let lastDepthAt = 0;

  const setFailure = (error, recovery = 'failed') => {
    state.recovery = recovery;
    state.error = String(error?.message ?? error).slice(0, 240);
    onUpdate({ type: 'status', status: { ...state } });
  };

  const flushRawRetention = async () => {
    const cutoff = now() - 30 * 24 * 60 * 60 * 1000;
    await repository.pruneRaw(cutoff);
    state.lastPrunedAt = now();
  };

  const observe = async (includeDepth) => {
    const at = now();
    const priceAt = market.getPriceAt(symbol);
    const price = market.getFreshPrice(symbol);
    const flow = market.flowSnapshot(symbol);
    let depth = null;
    if (includeDepth && fetchDepth && at - lastDepthAt >= 60_000) {
      lastDepthAt = at;
      try {
        depth = await fetchDepth(symbol, 20);
      } catch {
        depth = null;
      }
    }
    return { at, price, priceAt, flow, depth };
  };

  const repairGap = async (timeframe, history, incomingRow) => {
    const last = history.at(-1);
    const duration = Number(timeframeMs[timeframe]);
    if (!last || !Number.isFinite(duration) || duration <= 0) throw new Error(`تعذر تحديد حدود فجوة الفريم ${timeframe}`);
    const expectedOpenTime = Number(last[0]) + duration;
    const missing = Math.round((incomingRow[0] - expectedOpenTime) / duration);
    if (missing <= 0) return history;
    if ((incomingRow[0] - expectedOpenTime) % duration !== 0) throw new Error(`توقيت شمعة غير متوافق مع الفريم ${timeframe}`);
    let repairedHistory = history;
    await forEachClosedRange(fetchKlines, symbol, timeframe, duration, expectedOpenTime, incomingRow[0] - duration, now(), async (page) => {
      for (const row of page) {
        repairedHistory = [...repairedHistory, row].slice(-HISTORY_LIMIT);
        liveCandles.set(timeframe, repairedHistory);
        await repository.upsertCandles([toStoredCandle(symbol, timeframe, row, now(), 'binance-spot-backfill')]);
        await scanClosedBar({
          symbol, timeframe,
          kline: { t: row[0], T: row[6], o: row[1], h: row[2], l: row[3], c: row[4], v: row[5], V: row[9], x: true },
          duringRecovery: true
        });
        if (state.recovery === 'degraded') throw new Error(state.error ?? `فشل حفظ استعادة الفريم ${timeframe}`);
      }
    });
    state.lastGapRepairedAt = now();
    state.recovery = 'ready';
    state.error = null;
    return repairedHistory;
  };

  const scanClosedBar = async ({ symbol: closedSymbol, timeframe, kline, duringRecovery = false }) => {
    if (stopping || closedSymbol !== symbol || !state.timeframes.includes(timeframe) || kline?.x !== true) return;
    const row = normalizeKline(kline);
    if (!row) throw new Error(`شمعة إغلاق غير صالحة للفريم ${timeframe}`);
    const openTime = row[0];
    const key = `${closedSymbol}|${timeframe}`;
    if (processedBars.get(key) >= openTime) return;
    if (!duringRecovery && state.recovery !== 'ready' && state.recovery !== 'degraded') return;
    const history = liveCandles.get(timeframe) ?? [];
    const last = history.at(-1);
    if (!last || Number(last[0]) !== openTime) {
      const next = history.filter((item) => Number(item[0]) !== openTime);
      next.push(row);
      liveCandles.set(timeframe, next.slice(-HISTORY_LIMIT));
    } else {
      history[history.length - 1] = row;
    }
    try {
      await repository.upsertCandles([toStoredCandle(closedSymbol, timeframe, row, now(), 'binance-spot-stream')]);
      state.storedCandles += 1;
      const candles = (liveCandles.get(timeframe) ?? []).map((item, index) => ({
        time: Number(item[0]) / 1000,
        open: Number(item[1]),
        high: Number(item[2]),
        low: Number(item[3]),
        close: Number(item[4]),
        volume: Number(item[5] ?? 0),
        index
      }));
      const endIndex = candles.length - 1;
      if (endIndex < 39) {
        processedBars.set(key, openTime);
        return;
      }
      const config = engineOptions() ?? {};
      const legacyZones = detectLiquidityZones({
        symbol: closedSymbol,
        timeframe,
        candles,
        endIndex,
        tolerancePct: config.tolerancePct,
        biasPerKind: config.biasPerKind ?? {}
      });
      const v2Zones = detectLiquidityZonesV2({
        symbol: closedSymbol,
        timeframe,
        candles,
        endIndex,
        opts: { nowMs: now() }
      });
      const tickSize = Number(await tickSizeFor(closedSymbol));
      const matches = findLiquidityMatchCandidates(legacyZones, v2Zones, {
        tickSize,
        timeframeMs: timeframeMs[timeframe]
      });
      const computedAt = now();
      const activeCount = legacyZones.length + v2Zones.length;
      const lastSample = sampleAt.get(symbol) ?? 0;
      const includeSample = activeCount > 0 && computedAt - lastSample >= 60_000;
      const observation = await observe(includeSample);
      const scanMeta = {
        symbol: closedSymbol,
        timeframe,
        candleOpenTime: openTime,
        computedAt,
        barCount: endIndex + 1,
        dataSource: 'binance-spot',
        tickSize: Number.isFinite(tickSize) && tickSize > 0 ? tickSize : null,
        zones: { legacy: legacyZones, v2: v2Zones },
        matches,
        observation: { at: observation.at, price: observation.price, priceAt: observation.priceAt, flow: observation.flow }
      };
      const engineRows = [
        { engine: ENGINE_VERSION.legacy, zones: legacyZones },
        { engine: ENGINE_VERSION.v2, zones: v2Zones }
      ];
      for (const { engine, zones } of engineRows) {
        const pointRows = deriveZonePoints(engine, zones, candles, computedAt);
        if (pointRows.length) await repository.upsertPoints(pointRows);
        const previous = new Map((scans.get(`${engine}|${closedSymbol}|${timeframe}`)?.zones ?? []).map((zone) => [zone.id, zone]));
        for (const zone of zones) {
          const oldZone = previous.get(zone.id);
          const changes = [];
          if (!oldZone) changes.push({ type: 'discovered', previousState: null, previousTouchPoints: null });
          else {
            if (oldZone.state !== zone.state) changes.push({ type: 'state_changed', previousState: oldZone.state ?? null, previousTouchPoints: null });
            if (JSON.stringify(oldZone.touchPoints ?? []) !== JSON.stringify(zone.touchPoints ?? [])) {
              changes.push({ type: 'touch_points_changed', previousState: null, previousTouchPoints: oldZone.touchPoints ?? [] });
            }
            const oldGeometry = JSON.stringify({ referenceLevel: oldZone.referenceLevel, liquidityLevel: oldZone.liquidityLevel, zoneBox: oldZone.zoneBox, bodyBox: oldZone.bodyBox, trendline: oldZone.trendline });
            const newGeometry = JSON.stringify({ referenceLevel: zone.referenceLevel, liquidityLevel: zone.liquidityLevel, zoneBox: zone.zoneBox, bodyBox: zone.bodyBox, trendline: zone.trendline });
            if (oldGeometry !== newGeometry) changes.push({ type: 'geometry_changed', previousState: null, previousTouchPoints: null, previousGeometry: JSON.parse(oldGeometry) });
          }
          for (const change of changes) {
            const eventKey = change.type === 'discovered'
              ? stableKey(engine, closedSymbol, timeframe, zone.id, change.type, openTime)
              : stableKey(engine, closedSymbol, timeframe, zone.id, change.type, openTime, JSON.stringify(zone.touchPoints ?? []), zone.state ?? '');
            const zoneEvent = {
              idempotency_key: eventKey,
              engine,
              symbol: closedSymbol,
              timeframe,
              zone_id: String(zone.id),
              event_type: change.type,
              event_at: computedAt,
              payload: { previousState: change.previousState, previousTouchPoints: change.previousTouchPoints, previousGeometry: change.previousGeometry ?? null, zone, candleOpenTime: openTime }
            };
            await repository.insertZoneEvent(zoneEvent);
            if (!eventKeys.has(eventKey)) {
              eventKeys.add(eventKey);
              recentEvents.unshift(zoneEvent);
              if (recentEvents.length > 200) recentEvents.pop();
              if (eventKeys.size > 2000) eventKeys.delete(eventKeys.values().next().value);
            }
          }
        }
      }
      await repository.upsertScan({
        engine: 'combined',
        symbol: closedSymbol,
        timeframe,
        candle_open_time: openTime,
        computed_at: computedAt,
        bar_count: endIndex + 1,
        data_source: 'binance-spot',
        payload: scanMeta
      });
      if (includeSample) {
        await repository.insertSample({
          sample_key: `${symbol}-${Math.floor(computedAt / 60_000)}`,
          symbol,
          timeframe,
          sampled_at: computedAt,
          source: 'binance-spot',
          payload: { ...observation, activeZoneCount: activeCount, matches }
        });
        sampleAt.set(symbol, computedAt);
        state.samples += 1;
      }
      scans.set(`${ENGINE_VERSION.legacy}|${closedSymbol}|${timeframe}`, { zones: legacyZones });
      scans.set(`${ENGINE_VERSION.v2}|${closedSymbol}|${timeframe}`, { zones: v2Zones });
      scans.set(`combined|${closedSymbol}|${timeframe}`, {
        computed_at: computedAt,
        data_source: 'binance-spot',
        payload: scanMeta
      });
      processedBars.set(key, openTime);
      state.latestCloseAt = Number(kline.T) || now();
      state.latestScanAt = computedAt;
      state.recovery = duringRecovery ? 'loading' : 'ready';
      state.error = null;
      onUpdate({ type: 'scan', symbol: closedSymbol, timeframe, at: computedAt });
    } catch (error) {
      setFailure(error, 'degraded');
      throw error;
    }
  };

  const enqueueKline = (event, attempt = 0) => {
    scanQueue = scanQueue.then(() => updateKline(event)).catch((error) => {
      if (stopping || attempt >= 5) {
        setFailure(error, 'degraded');
        return;
      }
      const delay = Math.min(60_000, 1000 * 2 ** attempt);
      const timer = setTimeout(() => {
        retryTimers.delete(timer);
        enqueueKline(event, attempt + 1);
      }, delay);
      timer.unref?.();
      retryTimers.add(timer);
    });
  };

  const updateKline = async ({ symbol: incomingSymbol, timeframe, kline }) => {
    if (stopping || incomingSymbol !== symbol || !state.timeframes.includes(timeframe)) return;
    const row = normalizeKline(kline);
    if (!row) return;
    const history = liveCandles.get(timeframe);
    if (!history) return;
    const last = history.at(-1);
    if (last && row[0] < Number(last[0])) return;
    if (last && row[0] > Number(last[0])) {
      const repaired = await repairGap(timeframe, history, row);
      repaired.push(row);
      liveCandles.set(timeframe, repaired.slice(-HISTORY_LIMIT));
    } else if (last) {
      history[history.length - 1] = row;
    }
    if (kline.x === true && row[0] > (processedBars.get(`${symbol}|${timeframe}`) ?? 0)) {
      await scanClosedBar({ symbol: incomingSymbol, timeframe, kline });
    }
  };

  const onKlineEvent = (event) => enqueueKline(event);


  const start = () => {
    if (startPromise) {
      if (!stopping) return startPromise;
      return startPromise.catch(() => undefined).then(() => start());
    }
    if (started) return Promise.resolve({ ...state });
    stopping = false;
    const generation = ++lifecycleGeneration;
    const isCurrentStart = () => generation === lifecycleGeneration && !stopping;
    state.seeded = 0;
    state.storedCandles = 0;
    state.historyCounts = {};
    state.recovery = 'loading';
    startPromise = (async () => {
      try {
        const [storedScans, storedEvents, storedByTimeframe] = await Promise.all([
          repository.listScans(symbol),
          repository.listEvents(symbol, 200),
          Promise.all(state.timeframes.map((timeframe) => repository.listCandles(symbol, timeframe, HISTORY_LIMIT)))
        ]);
        if (!isCurrentStart()) return { ...state, recovery: 'idle' };
        if (!Array.isArray(storedScans) || storedScans.length > state.timeframes.length || !Array.isArray(storedEvents) || !Array.isArray(storedByTimeframe)) {
          throw new Error('قراءة استعادة غير مكتملة');
        }
        recentEvents.splice(0, recentEvents.length, ...storedEvents.slice(0, 200));
        eventKeys.clear();
        for (const event of recentEvents) if (event.idempotency_key) eventKeys.add(event.idempotency_key);
        for (const row of storedScans) {
          const payload = row.payload ?? {};
          const zones = payload.zones ?? {};
          if (row.engine !== 'combined' || !zones.legacy || !zones.v2 || !state.timeframes.includes(row.timeframe)) continue;
          scans.set(`${ENGINE_VERSION.legacy}|${symbol}|${row.timeframe}`, { zones: zones.legacy });
          scans.set(`${ENGINE_VERSION.v2}|${symbol}|${row.timeframe}`, { zones: zones.v2 });
          scans.set(`combined|${symbol}|${row.timeframe}`, { ...row, payload });
          processedBars.set(`${symbol}|${row.timeframe}`, Number(row.candle_open_time));
        }
        const latestRows = new Map();
        for (let index = 0; index < state.timeframes.length; index += 1) {
          if (!isCurrentStart()) return { ...state, recovery: 'idle' };
          const timeframe = state.timeframes[index];
          const stored = storedByTimeframe[index];
          if (!Array.isArray(stored)) throw new Error(`قراءة شموع غير مكتملة للفريم ${timeframe}`);
          let rows = stored
            .filter((row) => Number(row.close_time) < now())
            .sort((a, b) => Number(a.open_time) - Number(b.open_time))
            .slice(-HISTORY_LIMIT)
            .map(fromStoredCandle);
          if (rows.length < HISTORY_LIMIT) {
            const fetched = closedRows(await fetchKlines(symbol, timeframe, HISTORY_LIMIT + 10), now());
            if (!isCurrentStart()) return { ...state, recovery: 'idle' };
            if (fetched.length < MIN_HISTORY_BARS) throw new Error(`شموع تاريخية غير كافية للفريم ${timeframe}: ${fetched.length}/${MIN_HISTORY_BARS}`);
            rows = fetched;
            await repository.upsertCandles(rows.map((row) => toStoredCandle(symbol, timeframe, row, now())));
            if (!isCurrentStart()) return { ...state, recovery: 'idle' };
          }
          const latest = rows.at(-1);
          if (!latest) throw new Error(`لا توجد شموع مغلقة لاستعادة الفريم ${timeframe}`);
          latestRows.set(timeframe, latest);
          const cursor = processedBars.get(`${symbol}|${timeframe}`) ?? 0;
          if (cursor > Number(latest[0])) throw new Error(`مؤشر المسح يتجاوز آخر شمعة للفريم ${timeframe}`);
          const cursorIndex = rows.findIndex((row) => Number(row[0]) === cursor);
          if (cursor > 0 && cursorIndex >= 0) {
            liveCandles.set(timeframe, rows.slice(0, cursorIndex + 1));
          } else if (cursor > 0) {
            const duration = Number(timeframeMs[timeframe]);
            const contextStart = cursor - (HISTORY_LIMIT - 1) * duration;
            const contextRows = [];
            await forEachClosedRange(fetchKlines, symbol, timeframe, duration, contextStart, cursor, now(), async (page) => contextRows.push(...page));
            if (contextRows.length < MIN_HISTORY_BARS) throw new Error(`شموع سياق غير كافية لاستعادة الفريم ${timeframe}`);
            liveCandles.set(timeframe, contextRows.slice(-HISTORY_LIMIT));
            await repository.upsertCandles(contextRows.map((row) => toStoredCandle(symbol, timeframe, row, now(), 'binance-spot-recovery')));
          } else {
            liveCandles.set(timeframe, rows.slice(-HISTORY_LIMIT));
          }
          state.seeded += 1;
          state.storedCandles += rows.length;
        }
        state.tickSize = Number(await tickSizeFor(symbol)) || null;
        await flushRawRetention();
        state.recovery = 'ready';
        for (const timeframe of state.timeframes) {
          const latest = latestRows.get(timeframe);
          const latestOpenTime = Number(latest?.[0]);
          const cursor = processedBars.get(`${symbol}|${timeframe}`) ?? 0;
          if (!latest || latestOpenTime <= cursor) continue;
          const duration = Number(timeframeMs[timeframe]);
          if (cursor > 0) {
            const recoveryStart = cursor + duration;
            const replayed = await forEachClosedRange(fetchKlines, symbol, timeframe, duration, recoveryStart, latestOpenTime, now(), async (page) => {
              for (const row of page) {
                if (!isCurrentStart()) return;
                const kline = { t: row[0], T: row[6], o: row[1], h: row[2], l: row[3], c: row[4], v: row[5], V: row[9], x: true };
                await scanClosedBar({ symbol, timeframe, kline, duringRecovery: true });
                if (state.recovery === 'degraded') throw new Error(state.error ?? 'فشل تخزين شمعة الاستعادة');
              }
            });
            if (replayed) state.lastGapRepairedAt = now();
          } else {
            const kline = { t: latest[0], T: latest[6], o: latest[1], h: latest[2], l: latest[3], c: latest[4], v: latest[5], V: latest[9], x: true };
            await scanClosedBar({ symbol, timeframe, kline, duringRecovery: true });
            if (state.recovery === 'degraded') throw new Error(state.error ?? 'فشل تخزين المسح الأولي');
          }
        }
        state.recovery = 'ready';
        if (stopping) return { ...state, recovery: 'idle' };
        const keys = state.timeframes.map((timeframe) => `${symbol}|${timeframe}`);
        market.setKlineSubscriptions(keys, 'liquidity-workbench');
        market.setAggTradeSubscriptions([symbol], 'liquidity-workbench');
        unsubscribe = market.onKlineUpdate(onKlineEvent);
        started = true;
        state.recovery = 'ready';
        state.error = null;
        retentionTimer = setInterval(() => {
          void flushRawRetention().catch((error) => setFailure(error, 'degraded'));
        }, 24 * 60 * 60 * 1000);
        retentionTimer.unref?.();
        onUpdate({ type: 'ready', status: { ...state } });
        return { ...state };
      } catch (error) {
        if (!isCurrentStart()) return { ...state, recovery: 'idle' };
        setFailure(error);
        throw error;
      } finally {
        startPromise = null;
      }
    })();
    return startPromise;
  };

  const stop = () => {
    stopping = true;
    lifecycleGeneration += 1;
    if (unsubscribe) unsubscribe();
    unsubscribe = null;
    if (retentionTimer) clearInterval(retentionTimer);
    retentionTimer = null;
    for (const timer of retryTimers) clearTimeout(timer);
    retryTimers.clear();
    market.setKlineSubscriptions([], 'liquidity-workbench');
    market.setAggTradeSubscriptions([], 'liquidity-workbench');
    started = false;
    state.recovery = 'idle';
  };

  const snapshot = (timeframe) => {
    const legacyScan = scans.get(`${ENGINE_VERSION.legacy}|${symbol}|${timeframe}`);
    const v2Scan = scans.get(`${ENGINE_VERSION.v2}|${symbol}|${timeframe}`);
    const combined = scans.get(`combined|${symbol}|${timeframe}`);
    const price = market.getFreshPrice(symbol);
    const priceAt = market.getPriceAt(symbol);
    const at = now();
    const currentZones = (engine, rows) => (rows ?? []).map((zone) => ({
      ...zone,
      engine,
      observation: describeZone(zone, { price, priceAt, now: at })
    }));
    const candleRows = (liveCandles.get(timeframe) ?? []).map((row) => ({
      time: Number(row[0]) / 1000,
      open: Number(row[1]),
      high: Number(row[2]),
      low: Number(row[3]),
      close: Number(row[4]),
      volume: Number(row[5] ?? 0)
    }));
    return {
      status: { ...state, recovery: state.recovery, error: state.error, persistence: repository.persistenceMode ?? 'supabase', persistenceDetails: repository.persistenceStatus?.() ?? null },
      symbol,
      timeframe,
      currentPrice: price,
      currentPriceAt: priceAt,
      currentPriceAgeMs: priceAt == null ? null : Math.max(0, at - priceAt),
      candles: candleRows,
      latestScan: combined?.computed_at ?? null,
      legacy: currentZones(ENGINE_VERSION.legacy, legacyScan?.zones),
      v2: currentZones(ENGINE_VERSION.v2, v2Scan?.zones),
      matches: combined?.payload?.matches ?? [],
      recentEvents: recentEvents.filter((event) => event.timeframe === timeframe).slice(0, 50),
      dataSource: combined?.data_source ?? 'waiting-for-first-complete-scan'
    };
  };

  return { start, stop, snapshot, listPoints: ({ timeframe, engine, zoneId }) => repository.listPoints({ symbol, timeframe, engine, zoneId, limit: 2000 }), status: () => ({ ...state, persistence: repository.persistenceMode ?? 'supabase', persistenceDetails: repository.persistenceStatus?.() ?? null }), get started() { return started; } };
}
