export function analyzeBarcode(raw, threshold = 35) {
  let gapCount = 0;
  let bigWick = 0;
  for (let i = 0; i < raw.length; i += 1) {
    const o = Number(raw[i][1]);
    const h = Number(raw[i][2]);
    const l = Number(raw[i][3]);
    const c = Number(raw[i][4]);
    if (i > 0) {
      const prevC = Number(raw[i - 1][4]);
      if (Math.min(o, c) > prevC * 1.001 || Math.max(o, c) < prevC * 0.999) gapCount += 1;
    }
    const range = h - l;
    const body = Math.abs(c - o);
    if (range > 0 && body / range < 0.2) bigWick += 1;
  }
  const candlesCount = raw.length;
  const score = candlesCount
    ? (gapCount / candlesCount) * 60 + (bigWick / candlesCount) * 40
    : 0;
  return {
    is_barcode: score >= threshold,
    score: Math.round(score),
    gap_count: gapCount,
    big_wick_count: bigWick,
    candles_count: candlesCount,
    threshold,
    reason: score >= threshold
      ? 'تكررت فجوات أو ظلال غير طبيعية في شموع الدقيقة'
      : 'شموع الدقيقة ضمن النمط الطبيعي وفق معيار الفحص الحالي'
  };
}