/* الطبقة 4: الملف الحجمي (Volume Profile) وفق منطق فابيو — أين تتركز القيمة وأين يخترق السعر بلا احتكاك
 * حساب حتمي بالكامل من شموع السبوت: يوزَّع حجم كل شمعة توزيعاً موحداً على نطاق low→high.
 * يعيد POC / VAH / VAL (نطاق 70% من الحجم) + عقد الحجم المنخفض (LVN) والعالي (HVN).
 * كل الدوال قابلة للاختبار بدون شبكة — نفس المدخلات تعطي نفس المخرجات.
 */

/** ATR محلي (نفس حساب structure.mjs) لتجنب دورة الاستيراد */
function atrLocal(candles, period = 14) {
  if (candles.length < period + 1) return null;
  let sum = 0;
  for (let i = candles.length - period; i < candles.length; i += 1) {
    const prevClose = candles[i - 1].close;
    const tr = Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - prevClose),
      Math.abs(candles[i].low - prevClose)
    );
    sum += tr;
  }
  return sum / period;
}

/**
 * التوزيع: حجم الحجة على rows مستوى سعري بين أدنى low وأعلى high.
 * الشمعة تدخل النطاق المنقاطع فقط بنسبة الانقطاع (توزيع موحد داخل الشمعة — المعيار المنشور).
 */
export function computeVolumeProfile(candles, rows = 48) {
  if (!Array.isArray(candles) || candles.length === 0 || rows < 1) return null;
  const priceMin = Math.min(...candles.map(c => c.low));
  const priceMax = Math.max(...candles.map(c => c.high));
  if (!Number.isFinite(priceMin) || !Number.isFinite(priceMax)) return null;

  const totalRaw = candles.reduce((a, c) => a + (Number(c.volume) || 0), 0);
  if (priceMax <= priceMin || totalRaw <= 0) {
    // شموع مسطحة أو بلا أحجام: مستوى واحد
    const p = (priceMin + priceMax) / 2;
    return {
      poc: p, vah: p, val: p, binHeight: Math.max(0, priceMax - priceMin),
      lvnZones: [], hvnZones: [], profile: [totalRaw],
      priceMin, priceMax, totalVolume: totalRaw
    };
  }

  const binHeight = (priceMax - priceMin) / rows;
  const hist = new Array(rows).fill(0);
  const idxOf = (p) => Math.max(0, Math.min(rows - 1, Math.floor((p - priceMin) / binHeight)));

  for (const c of candles) {
    const volume = Number(c.volume);
    if (!Number.isFinite(volume) || volume <= 0) continue;
    const lo = Number(c.low);
    const hi = Number(c.high);
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) continue;
    if (hi <= lo) { hist[idxOf(lo)] += volume; continue; }
    const start = idxOf(lo);
    const end = idxOf(hi);
    const span = hi - lo;
    for (let k = start; k <= end; k += 1) {
      const binBottom = priceMin + k * binHeight;
      const binTop = binBottom + binHeight;
      const overlap = Math.min(hi, binTop) - Math.max(lo, binBottom);
      if (overlap > 0) hist[k] += volume * (overlap / span);
    }
  }

  const totalVolume = hist.reduce((a, b) => a + b, 0);
  const center = (k) => priceMin + (k + 0.5) * binHeight;
  if (totalVolume <= 0) {
    const p = (priceMin + priceMax) / 2;
    return {
      poc: p, vah: p, val: p, binHeight,
      lvnZones: [], hvnZones: [], profile: hist,
      priceMin, priceMax, totalVolume
    };
  }

  // POC: أعلى حجة
  let pocIdx = 0;
  for (let k = 1; k < rows; k += 1) if (hist[k] > hist[pocIdx]) pocIdx = k;

  // منطقة القيمة: توسّع من POC حتى 70% من الحجم (نحو الجار الأثقل أولاً)
  let loIdx = pocIdx;
  let hiIdx = pocIdx;
  let area = hist[pocIdx];
  while (area < 0.7 * totalVolume && (loIdx > 0 || hiIdx < rows - 1)) {
    const below = loIdx > 0 ? hist[loIdx - 1] : -1;
    const above = hiIdx < rows - 1 ? hist[hiIdx + 1] : -1;
    if (above >= below) { hiIdx += 1; area += hist[hiIdx]; }
    else { loIdx -= 1; area += hist[loIdx]; }
  }

  // العقد: قيعان وقمم محلية للحجة (كثافة كفء المزاد)
  const meanBin = totalVolume / rows;
  const lvnZones = [];
  const hvnZones = [];
  for (let k = 1; k < rows - 1; k += 1) {
    if (hist[k] < hist[k - 1] && hist[k] <= hist[k + 1] && hist[k] < meanBin) {
      lvnZones.push({ price: center(k), volume: hist[k], index: k });
    }
    if (hist[k] > hist[k - 1] && hist[k] >= hist[k + 1] && k !== pocIdx) {
      hvnZones.push({ price: center(k), volume: hist[k], index: k });
    }
  }
  const rel = (a, b) => a.volume / meanBin - b.volume / meanBin;
  lvnZones.sort(rel);
  hvnZones.sort(rel);

  return {
    poc: center(pocIdx),
    vah: priceMin + (hiIdx + 1) * binHeight,
    val: priceMin + loIdx * binHeight,
    binHeight,
    lvnZones: lvnZones.slice(0, 4),
    hvnZones: hvnZones.slice(0, 4),
    profile: hist,
    priceMin, priceMax, totalVolume
  };
}

/**
 * تصنيف الموقع (الخطوة 1 في نموذج فابيو): هل السوق في توازن أم خارجَه؟
 * - إغلاق أخير فوق VAH → imbalance_up، تحت VAL → imbalance_down، داخل النطاق → balance.
 * - الثقة: بُعد الإغلاق عن نطاق القيمة مقيساً بعدد المدى الحقيقي (ATR) حتى 100.
 */
export function classifyLocation(candles, profile, { atrPeriod = 14 } = {}) {
  if (!profile || !Array.isArray(candles) || candles.length === 0) {
    return { state: 'balance', confidence: null };
  }
  const close = Number(candles[candles.length - 1].close);
  if (!Number.isFinite(close)) return { state: 'balance', confidence: null };
  const atr = atrLocal(candles, atrPeriod);
  let state = 'balance';
  let confidence = null;
  if (close > profile.vah) state = 'imbalance_up';
  else if (close < profile.val) state = 'imbalance_down';
  if (state !== 'balance' && atr && atr > 0) {
    const edge = state === 'imbalance_up' ? profile.vah : profile.val;
    confidence = Math.min(100, Math.round((Math.abs(close - edge) / atr) * 100));
  }
  return { state, confidence };
}
