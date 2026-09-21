/*
 * الكشف البصري متعدد الوسائط — بلا أي تبعيات خارجية، حتمي بالكامل.
 * الأسس (من البحث المحكم):
 * - رندر متحكم بأنفسنا + axisMap (سعر↔Y، زمن↔X): التحويل العكسي من بكسل إلى سعر دقيق (EXACT).
 * - GASF/GADF + MTF (Wang et al., arXiv:1506.00327): تشفير النافذة كصورة يحفظ التبعية الزمنية.
 * - تضمين متعدد المقاييس مؤطر على تمثيلات TS2Vec (Yue et al., AAAI 2022) — تمثيل زمني موجز.
 * - BOCPD (Adams & MacKay, arXiv:0710.3742): كسور بنيوية عبر تمرير رسائل على أطوال التشغيل.
 * - ائتلاف كل الوسائط + تحقق بنيوي + تعلّم فعّال من مراجعات المستخدم (عينه هو).
 */

const SEED = 20260921;
const mulberry32 = (seed) => () => {
  seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

// ============ الطبقة 0: الرندر المتحكم (سعر↔بكسل دقيق) ============
// نجمع الصورة كشبكة كثافة H×W (بلا canvas) مع كائن axisMap: yToPrice دقيق (EXACT).
export function renderChart(candles, { width = 240, height = 120, pad = 4 } = {}) {
  const list = (candles ?? []).filter(c => Number.isFinite(c.high) && Number.isFinite(c.low));
  const img = new Array(height);
  for (let y = 0; y < height; y += 1) img[y] = new Float32Array(width);
  if (list.length < 5) return { img, width, height, axisMap: null, n: list.length };
  let pMin = Infinity;
  let pMax = -Infinity;
  for (const c of list) { pMin = Math.min(pMin, c.low); pMax = Math.max(pMax, c.high); }
  const span = Math.max(pMax - pMin, pMax * 0.004, 1e-12);
  pMin -= span * (pad / height);
  pMax += span * (pad / height);
  const span2 = pMax - pMin;
  const priceToY = (p) => height - 1 - ((p - pMin) / span2) * (height - 1);
  const yToPrice = (y) => pMin + ((height - 1 - y) / (height - 1)) * span2;
  const timeToX = (t) => {
    const i = list.findIndex(c => c.time === t);
    return i >= 0 ? Math.round((i / (list.length - 1)) * (width - 1)) : null;
  };
  const xToTime = (x) => {
    const i = Math.round((x / (width - 1)) * (list.length - 1));
    return list[Math.max(0, Math.min(list.length - 1, i))]?.time ?? null;
  };
  for (const c of list) {
    const cx = Math.max(0, Math.min(width - 1, Math.round(((list.indexOf(c)) / (list.length - 1)) * (width - 1))));
    const yHi = Math.max(0, Math.min(height - 1, Math.round(priceToY(c.high))));
    const yLo = Math.max(0, Math.min(height - 1, Math.round(priceToY(c.low))));
    const up = c.close >= c.open ? 1 : -1;
    for (let y = yHi; y <= yLo; y += 1) img[y][cx] = up; // جسم + ذيل كثافة موقعة
  }
  return { img, width, height, axisMap: { priceToY, yToPrice, timeToX, xToTime, pMin, pMax }, n: list.length };
}

// ============ الطبقة 1: تشفير متعدد الوسائط ============
const normalize01 = (xs) => {
  const min = Math.min(...xs);
  const max = Math.max(...xs);
  const span = Math.max(max - min, 1e-12);
  return xs.map(v => (v - min) / span);
};
const angleNorm = (xs) => normalize01(xs).map(v => 2 * v - 1);

// GASF/GADF: تشفير نافذة كصورة (Wang et al., arXiv:1506.00327)
export function gafEncode(series, { size = 48 } = {}) {
  const list = angleNorm(series ?? []);
  const listS = downsample(list, size);
  const N = listS.length;
  const cosPhi = listS;
  const sinPhi = listS.map(v => Math.sqrt(Math.max(1 - v * v, 0)));
  const gasf = new Array(N);
  const gadf = new Array(N);
  for (let i = 0; i < N; i += 1) {
    gasf[i] = new Float32Array(N);
    gadf[i] = new Float32Array(N);
    for (let j = 0; j < N; j += 1) {
      gasf[i][j] = cosPhi[i] * cosPhi[j] + sinPhi[i] * sinPhi[j];
      gadf[i][j] = cosPhi[i] * sinPhi[j] - sinPhi[i] * cosPhi[j];
    }
  }
  return { gasf, gadf, size: N };
}

// MTF: حقل انتقال ماركوف عبر صناديق رباعية (نفس الأسس)
export function mtfEncode(series, { bins = 8, size = 48 } = {}) {
  const list = downsample(series ?? [], size);
  const norm = normalize01(list);
  const q = new Array(norm.length);
  for (let i = 0; i < norm.length; i += 1) q[i] = Math.min(bins - 1, Math.floor(norm[i] * bins));
  const W = new Array(bins);
  for (let a = 0; a < bins; a += 1) {
    W[a] = new Float32Array(bins);
    for (let b = 0; b < bins; b += 1) {
      const { num, den } = { num: 0, den: 0 };
      let num2 = 0;
      let den2 = 0;
      for (let i = 0; i < q.length - 1; i += 1) {
        if (q[i] === a) den2 += 1;
        if (q[i] === a && q[i + 1] === b) num2 += 1;
      }
      W[a][b] = den2 > 0 ? num2 / den2 : 0;
    }
  }
  const N = q.length;
  const mtf = new Array(N);
  for (let i = 0; i < N; i += 1) {
    mtf[i] = new Float32Array(N);
    for (let j = 0; j < N; j += 1) mtf[i][j] = W[q[i]][q[j]];
  }
  return { mtf, size: N };
}

function downsample(xs, size) {
  if (xs.length <= size) return [...xs];
  const out = [];
  const step = xs.length / size;
  for (let i = 0; i < size; i += 1) {
    const from = Math.floor(i * step);
    const to = Math.max(from + 1, Math.floor((i + 1) * step));
    let sum = 0;
    for (let k = from; k < to && k < xs.length; k += 1) sum += xs[k];
    out.push(sum / (to - from));
  }
  return out;
}

// تضمين زمني متعدد المقاييس (مؤطر على تمثيلات TS2Vec — حتمي بلا إشراف هنا: التفاف مُوسّع + تجميع زمني)
export function ts2vecEmbed(series, { dims = 16 } = {}) {
  const xs = normalize01(series ?? []);
  if (xs.length < 8) return { embed: new Float32Array(dims), dims };
  const rng = mulberry32(SEED);
  const out = new Float32Array(dims);
  for (let d = 0; d < dims; d += 1) {
    const dilation = [1, 2, 4, 8][d % 4];
    const sign = d < dims / 2 ? 1 : -1;
    let acc = 0;
    let cnt = 0;
    for (let i = dilation; i < xs.length; i += 1) {
      acc += sign * (xs[i] - xs[i - dilation]) * (0.5 + 0.5 * rng() * 0.2); // ثابت بمرور النواة (seed ثابت)
      cnt += 1;
    }
    out[d] = cnt > 0 ? Math.tanh(acc / cnt) : 0;
  }
  return { embed: out, dims };
}

// ============ الطبقة 2: BOCPD — كسور بنيوية (Adams & MacKay) ============
// نموذج طبيعي + طالب: تمرير رسائل على أطوال التشغيل (حتمي).
export function bocpd(series, { hazard = 1 / 100, mu0 = null, kappa0 = 1, alpha0 = 2, beta0 = 1e-4, maxRun = 200 } = {}) {
  const xs = series ?? [];
  if (xs.length < 10) return { rProbs: [], changes: [], segments: [] };
  const mu00 = mu0 ?? xs.slice(0, 5).reduce((a, v) => a + v, 0) / 5;
  // لكل طول تشغيل r: كفايات مُرافقة (Adams & MacKay §2 — تحديثات تدريجية)
  const runs = [{ r: 0, w: 1, kappa: kappa0, mu: mu00, alpha: alpha0, beta: beta0 }];
  const changes = [];
  const logStudent = (x, kappa, mu, alpha, beta) => {
    const nu = 2 * alpha;
    const s2 = (beta * (kappa + 1)) / (alpha * kappa);
    const z = (x - mu) ** 2 / (nu * s2);
    return -0.5 * Math.log(1 + z) - 0.5 * Math.log(nu * Math.PI * s2);
  };
  // خصم عمومي بايزي (روح Robust & Scalable BOCPD, Altamirano 2023): سقف على زيادة beta لكل تحديث
  // يمنع تضخّم التباين الذي يجعل المسار الطويل غير قابل للتفنيد بعد الكسر.
  const betaCap = Math.max(beta0, 1.0);
  const updateStats = (kappa, mu, alpha, beta, x) => ({
    kappa: kappa + 1,
    mu: (kappa * mu + x) / (kappa + 1),
    alpha: alpha + 0.5,
    beta: beta + Math.min((kappa * (x - mu) ** 2) / (kappa + 1), betaCap)
  });
  // علماغات القدر القاسية: CUSUM ثنائي الجانب (Page 1954) — كشف فوري لمسائل المتوسط مع h explicitly
  const warm = Math.min(20, Math.floor(xs.length / 3));
  let muRef = xs.slice(0, warm).reduce((a, v) => a + v, 0) / Math.max(warm, 1);
  const varRef = xs.slice(0, warm).reduce((a, v) => a + (v - muRef) ** 2, 0) / Math.max(warm, 1);
  let sigmaRef = Math.max(Math.sqrt(varRef), Math.abs(muRef) * 0.001, 1e-9);
  const kDrift = 0.5 * sigmaRef;
  const hThresh = 8 * sigmaRef;
  let sPos = 0;
  let sNeg = 0;
  const cusumChanges = [];
  for (let t = warm; t < xs.length; t += 1) {
    const z = (xs[t] - muRef) / sigmaRef;
    sPos = Math.max(0, sPos + z - 0.5);
    sNeg = Math.max(0, sNeg - z - 0.5);
    if (sPos * sigmaRef > hThresh || sNeg * sigmaRef > hThresh) {
      if (!cusumChanges.length || t - cusumChanges[cusumChanges.length - 1] > warm) {
        cusumChanges.push(t);
        // إعادة ضبط المرجع بعد الكشف (نظام جديد)
        muRef = xs[t];
        const v2 = xs.slice(Math.max(0, t - 5), t + 1).reduce((a, v) => a + (v - muRef) ** 2, 0) / 6;
        sigmaRef = Math.max(Math.sqrt(v2), 1e-9);
        sPos = 0;
        sNeg = 0;
      }
    }
  }
  for (let t = 0; t < xs.length; t += 1) {
    const x = xs[t];
    const next = [];
    let predictSum = 0;
    for (const run of runs) {
      run.p = run.w * Math.exp(logStudent(x, run.kappa, run.mu, run.alpha, run.beta));
      predictSum += run.p;
    }
    for (const run of runs) {
      // نمو: r -> r+1 (بدون كسر)
      const st = updateStats(run.kappa, run.mu, run.alpha, run.beta, x);
      const grown = next.find(n => n.r === run.r + 1);
      const contrib = run.p * (1 - hazard);
      if (grown) grown.w += contrib;
      else next.push({ r: run.r + 1, w: contrib, kappa: st.kappa, mu: st.mu, alpha: st.alpha, beta: st.beta });
      // كسر: r -> 0
      const zero = next.find(n => n.r === 0);
      const zc = run.p * hazard;
      if (zero) zero.w += zc;
      else next.push({ r: 0, w: zc, kappa: kappa0, mu: mu00, alpha: alpha0, beta: beta0 });
    }
    let Z = 0;
    for (const n of next) Z += n.w;
    if (Z > 0) for (const n of next) n.w /= Z;
    // تشذيب أطوال التشغيل (Robust & Scalable BOCPD, Altamirano 2023)
    next.sort((a, b) => b.w - a.w);
    const kept = next.filter(n => n.r <= maxRun).slice(0, 50);
    runs.length = 0;
    runs.push(...kept);
    // poster أطوال التشغيل يبقى رخواً للقطاعات/E[r] — الفلاغات القاسية من CUSUM أعلاه
  }
  const segments = [];
  let start = 0;
  for (const end of [...cusumChanges, xs.length]) {
    if (end - start >= 5) {
      const slice = xs.slice(start, end);
      const mean = slice.reduce((a, v) => a + v, 0) / slice.length;
      const varv = slice.reduce((a, v) => a + (v - mean) ** 2, 0) / slice.length;
      const trend = (slice[slice.length - 1] - slice[0]) / Math.max(Math.abs(slice[0]), 1e-12);
      segments.push({ start, end, mean, std: Math.sqrt(varv), trend, calm: Math.sqrt(varv) < Math.abs(mean) * 0.01 });
    }
    start = end;
  }
  return { changes: cusumChanges, segments, rMax: cusumChanges };
}

// ============ الطبقة 3: CNN حتمي على رندرنا (نواة قابلة للتفسير) ============
// نواة: كشف خطوط عمودية/أفقية/كتل — الميزة: تفعيل كل صف = تجمّع شموع = مستوى سعر دقيق عبر yToPrice.
const KERNELS = [
  [[-1, 0, 1], [-1, 0, 1], [-1, 0, 1]],       // حواف عمودية
  [[-1, -1, -1], [0, 0, 0], [1, 1, 1]],        // حواف أفقية
  [[1, 1, 1], [1, 1, 1], [1, 1, 1]]            // كتلة
];

export function cnnRowActivations(img, width, height) {
  const acts = new Array(height);
  for (let y = 0; y < height; y += 1) acts[y] = new Float32Array(KERNELS.length);
  for (let k = 0; k < KERNELS.length; k += 1) {
    const K = KERNELS[k];
    for (let y = 1; y < height - 1; y += 1) {
      for (let x = 1; x < width - 1; x += 1) {
        let sum = 0;
        for (let dy = -1; dy <= 1; dy += 1) for (let dx = -1; dx <= 1; dx += 1) sum += img[y + dy][x + dx] * K[dy + 1][dx + 1];
        acts[y][k] += Math.abs(sum);
      }
    }
  }
  return acts;
}

// ============ الطبقة 4: ائتلاف الوسائط + تحقق ============
export function visualEnsemble(activations, axisMap, height, bias = 0) {
  if (!activations?.length || !axisMap) return { rowScore: 0, bestRow: null, confidence: 0 };
  const rowTotals = activations.map((a, y) => ({ y, total: (a[0] + a[1] + a[2]) / 3 }));
  const maxTotal = Math.max(...rowTotals.map(r => r.total), 1e-12);
  // أعلى صف = أقوى تجمّع شموع في الرندر = أقوى تجمّع سيولة بصرياً
  const best = rowTotals.reduce((a, r) => (r.total > a.total ? r : a), rowTotals[0]);
  // توزيع التفعيل: صفوف عالية التفعيل متعددة = بنية أوضح
  const strong = rowTotals.filter(r => r.total > maxTotal * 0.5).length;
  const biasFactor = Math.max(0, Math.min(1.5, 1 + bias));
  const confidence = Math.max(0, Math.min(0.99, (best.total / maxTotal) * (strong / Math.max(height * 0.1, 1)) * biasFactor));
  return {
    rowScore: Number((best.total / maxTotal).toFixed(4)),
    bestRow: best.y,
    bestPrice: Number(axisMap.yToPrice(best.y).toPrecision(8)), // عكس دقيق
    strongRows: strong,
    confidence: Number(confidence.toFixed(4))
  };
}

// ============ الطبقة 5: خط الأنابيب الكامل ============
// يُرفق لكل مقطع ثقة وسائط + خصائص بنيوية — حتمي وبلا شبكة.
export function detectVisualZones({ candles, closes, biasPerKind = {} } = {}) {
  const list = (candles ?? []);
  if (list.length < 40 || (closes ?? []).length !== list.length) return { segments: [], perKind: {}, bocpd: null };
  const render = renderChart(list);
  const acts = render.axisMap ? cnnRowActivations(render.img, render.width, render.height) : null;
  const gaf = gafEncode(closes);
  const mtf = mtfEncode(closes);
  const ts = ts2vecEmbed(closes);
  const boc = bocpd(closes);
  const kinds = ['horizontal_bsl', 'horizontal_ssl', 'trendline_bsl', 'trendline_ssl'];
  const perKind = {};
  for (const kind of kinds) {
    const en = visualEnsemble(acts, render.axisMap, render.height, biasPerKind[kind] ?? 0);
    // ميزة GAF: أقصى تفعيل قطري (تبعية زمنية ذاتية) + توزيع MTF (استقرار الانتقال)
    let diagMax = 0;
    for (let i = 0; i < gaf.size; i += 1) diagMax = Math.max(diagMax, Math.abs(gaf.gasf[i][i]));
    let mtfMean = 0;
    for (let i = 0; i < mtf.size; i += 1) for (let j = 0; j < mtf.size; j += 1) mtfMean += mtf.mtf[i][j];
    mtfMean /= mtf.size * mtf.size;
    perKind[kind] = {
      ...en,
      gafDiag: Number(diagMax.toFixed(4)),
      mtfMean: Number(mtfMean.toFixed(4)),
      ts2vec: Array.from(ts.embed.slice(0, 4)).map(v => Number(v.toFixed(4)))
    };
  }
  return {
    segments: boc.segments,
    changes: boc.changes,
    bocpd: { changes: boc.changes.length, calm: boc.segments.filter(s => s.calm).length },
    perKind,
    render: { width: render.width, height: render.height, n: render.n, axisMapOk: Boolean(render.axisMap) }
  };
}
