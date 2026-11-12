import { TF_MS } from '../market/candleStore.mjs';

const finiteNumber = (value) => {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

export function detectHistoryGaps(candles, intervalMs) {
  const gaps = [];
  const intervalSeconds = intervalMs / 1000;
  for (let index = 1; index < candles.length; index += 1) {
    const previousTime = candles[index - 1].time;
    const nextTime = candles[index].time;
    const delta = nextTime - previousTime;
    if (delta <= intervalSeconds) continue;
    const missingBars = Math.max(1, Math.round(delta / intervalSeconds) - 1);
    gaps.push({
      after: previousTime,
      before: nextTime,
      missingBars
    });
  }
  return gaps;
}

export function normalizeHistoryKlines(rows, {
  timeframe,
  startTime,
  endTime,
  snapshotTime
} = {}) {
  const intervalMs = TF_MS[timeframe];
  if (!intervalMs) throw new Error(`فريم تاريخي غير مدعوم: ${timeframe}`);
  if (!Array.isArray(rows)) throw new Error('استجابة الشموع التاريخية ليست مصفوفة');
  if (!Number.isSafeInteger(startTime) || !Number.isSafeInteger(endTime) || endTime <= startTime) {
    throw new Error('حدود الفترة التاريخية غير صالحة');
  }
  if (!Number.isSafeInteger(snapshotTime) || snapshotTime <= startTime || snapshotTime > endTime) {
    throw new Error('وقت اللقطة التاريخية غير صالح');
  }

  const candles = [];
  let previousOpenTime = -Infinity;
  let incompleteBars = 0;

  for (const [index, row] of rows.entries()) {
    if (!Array.isArray(row) || row.length < 6) {
      throw new Error(`شمعة تاريخية غير مكتملة في موضع ${index}`);
    }

    const openTime = finiteNumber(row[0]);
    const open = finiteNumber(row[1]);
    const high = finiteNumber(row[2]);
    const low = finiteNumber(row[3]);
    const close = finiteNumber(row[4]);
    const volume = finiteNumber(row[5]);

    if (!Number.isSafeInteger(openTime) || openTime < 0 || openTime % 1000 !== 0) {
      throw new Error(`وقت شمعة REST غير صالح في موضع ${index}`);
    }
    if (openTime >= endTime) {
      throw new Error(`وحدة أو حد وقت شمعة REST غير متوافق عند ${openTime}`);
    }
    if (openTime <= previousOpenTime) {
      const detail = openTime === previousOpenTime ? 'مكررة' : 'غير مرتبة';
      throw new Error(`شمعة تاريخية ${detail} عند ${openTime}`);
    }
    if (![open, high, low, close, volume].every(Number.isFinite)
      || open <= 0 || high <= 0 || low <= 0 || close <= 0 || volume < 0
      || high < Math.max(open, close, low)
      || low > Math.min(open, close, high)) {
      throw new Error(`قيم OHLCV غير صالحة لشمعة ${openTime}`);
    }

    if (row[6] != null) {
      const closeTime = finiteNumber(row[6]);
      if (!Number.isSafeInteger(closeTime)
        || closeTime < openTime
        || closeTime >= openTime + intervalMs) {
        throw new Error(`وقت إغلاق غير متوافق مع الفريم لشمعة ${openTime}`);
      }
    }

    previousOpenTime = openTime;
    if (openTime < startTime || openTime >= endTime) continue;
    if (openTime + intervalMs > snapshotTime) {
      incompleteBars += 1;
      continue;
    }

    candles.push({
      time: openTime / 1000,
      open,
      high,
      low,
      close,
      volume
    });
  }

  const gaps = detectHistoryGaps(candles, intervalMs);
  return {
    candles,
    quality: {
      sourceUnit: 'milliseconds',
      intervalMs,
      receivedRows: rows.length,
      acceptedBars: candles.length,
      incompleteBars,
      gapCount: gaps.length,
      missingBars: gaps.reduce((sum, gap) => sum + gap.missingBars, 0),
      gaps,
      firstOpenTime: candles[0]?.time ?? null,
      lastOpenTime: candles[candles.length - 1]?.time ?? null
    }
  };
}
