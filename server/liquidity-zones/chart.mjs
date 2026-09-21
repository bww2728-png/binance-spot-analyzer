// رسم شارت حقيقي من الشموع الفعلية (بدون أي رسمة مزيفة) — وحدة مستقلة قابلة للاختبار.
// يشمل: شموع حقيقية (جسم + ذيل حسب OHLC)، علامة دائرية بارزة على مستوى سعر السيولة عند لحظة الاكتشاف،
// الزمن الحقيقي على المحور السيني + وقت الاكتشاف وسعر الاكتشاف في العنوان، ومفتاح قارئ.

const escapeSvg = (v) => String(v).replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));

const fmtTime = (ms) => {
  const d = new Date(ms);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
};

export const renderZoneChart = (zone, candles, markerIndex) => {
  const w = 960;
  const h = 430;
  const left = 50;
  const right = 940;
  const top = 60;
  const bottom = 310;
  const list = (candles || []).filter(c => Number.isFinite(c.high) && Number.isFinite(c.low));
  if (list.length < 5) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="#fff"/><text x="${w / 2}" y="${h / 2}" text-anchor="middle" font-family="Arial" font-size="20" fill="#64748b">لا شموع متاحة للعرض</text></svg>`;
  }
  const num = (v) => (v == null || v === '' ? NaN : Number(v));
  const ref = num(zone.referenceLevel);
  const liq = num(zone.liquidityLevel);
  const stop = num(zone.retailStop);
  const fib = zone.premium?.fib || null;
  const fibVals = fib ? [fib.low, fib.high].filter(Number.isFinite) : [];
  const lvlVals = [ref, liq, stop, ...fibVals].filter(Number.isFinite);
  const lows = list.map(c => Math.min(c.low, ...lvlVals));
  const highs = list.map(c => Math.max(c.high, ...lvlVals));
  const pMin = Math.min(...lows);
  const pMax = Math.max(...highs);
  const span = Math.max(pMax - pMin, pMax * 0.004, 1e-12);
  const x = (i) => left + ((i + 0.5) / list.length) * (right - left);
  const y = (p) => bottom - ((p - pMin) / span) * (bottom - top);
  const bodyW = Math.max(((right - left) / list.length) * 0.6, 1);
  const color = String(zone.kind).includes('ssl') ? '#089981' : '#f23645';
  const marker = markerIndex != null && markerIndex >= 0 && markerIndex < list.length ? x(markerIndex) : null;
  const detCandle = markerIndex != null && markerIndex >= 0 && markerIndex < list.length ? list[markerIndex] : null;
  // الشموع الحقيقية: جسم حسب open/close + ذيل حسب high/low
  const bars = list.map((c, i) => {
    const cx = x(i);
    const up = c.close >= c.open;
    const col = up ? '#26a69a' : '#ef5350';
    const hi = y(c.high);
    const lo = y(c.low);
    const op = y(c.open);
    const cl = y(c.close);
    const topB = Math.min(op, cl);
    const botB = Math.max(op, cl);
    return `<line x1="${cx}" x2="${cx}" y1="${hi}" y2="${lo}" stroke="${col}" stroke-width="1"/><rect x="${(cx - bodyW / 2)}" y="${topB}" width="${bodyW}" height="${Math.max(botB - topB, 1)}" fill="${col}"/>`;
  }).join('');
  const hLine = (p, col, width, dash, label) => {
    if (!Number.isFinite(p)) return '';
    const ly = y(p);
    const text = `<text x="${right - 8}" y="${ly - 6}" text-anchor="end" font-family="Arial" font-size="15" fill="${col}">${escapeSvg(label)} ${p.toPrecision(8)}</text>`;
    return `<line x1="${left}" x2="${right}" y1="${ly}" y2="${ly}" stroke="${col}" stroke-width="${width}" ${dash}/>${text}`;
  };
  // علامة دائرية احترافية على مستوى سعر السيولة عند لحظة الاكتشاف
  let liqMarker = '';
  if (Number.isFinite(liq)) {
    const ly = y(liq);
    const px = marker != null ? marker : x(list.length - 1);
    const above = ly < (top + bottom) / 2; // التسمية تُوضع بعيداً عن الحافة
    const dy1 = above ? -18 : 30;
    const dy2 = above ? 34 : 46;
    liqMarker = `<circle cx="${px}" cy="${ly}" r="17" fill="${color}" opacity="0.16"/>` +
      `<circle cx="${px}" cy="${ly}" r="11" fill="none" stroke="${color}" stroke-width="2.5"/>` +
      `<circle cx="${px}" cy="${ly}" r="4.5" fill="${color}"/>` +
      `<text x="${px + 22}" y="${ly + dy1 / 2}" font-family="Arial" font-size="15" font-weight="700" fill="${color}">السيولة</text>` +
      `<text x="${px + 22}" y="${ly + dy2 / 2}" font-family="Arial" font-size="13" fill="${color}" opacity="0.9">${liq.toPrecision(8)}</text>`;
  }
  // دوائر نقاط اللمس على القمم/القيعان التي بنّت المنطقة
  const dots = (zone.touchPoints || []).map(t => {
    const i = list.findIndex(c => c.time === t.time);
    if (i < 0) return '';
    return `<circle cx="${x(i)}" cy="${y(t.price)}" r="6" fill="none" stroke="#7c3aed" stroke-width="2.5"/>`;
  }).join('');
  // خط الاتجاه: يُرسم من النقاط + امتداده للمشروع
  let trend = '';
  if (zone.trendline?.points?.length) {
    const pts = zone.trendline.points.map(p => {
      const i = list.findIndex(c => c.time === p.time);
      return i >= 0 ? `${x(i)},${y(p.price)}` : null;
    }).filter(Boolean);
    if (pts.length) {
      trend = `<polyline points="${pts.join(' ')}" fill="none" stroke="#f59e0b" stroke-width="2.5"/>`;
    }
  }
  // تظليل منطقة Premium إن انطبقت
  let premium = '';
  if (fib && Number.isFinite(fib.low) && Number.isFinite(fib.high)) {
    const yMid = y((fib.low + fib.high) / 2);
    premium = `<rect x="${left}" y="${top}" width="${right - left}" height="${Math.max(yMid - top, 0)}" fill="rgba(124,58,237,0.08)"/><text x="${left + 8}" y="${top + 18}" font-family="Arial" font-size="13" fill="#7c3aed">Premium</text>`;
  }
  const grid = Array.from({ length: 6 }, (_, i) => `<line x1="${left}" x2="${right}" y1="${top + i * ((bottom - top) / 5)}" y2="${top + i * ((bottom - top) / 5)}" stroke="#f1f5f9"/>`).join('');
  // الزمن الحقيقي على المحور السيني: 5 طوابع زمنية موزعة على الشموع الفعلية
  const stamps = Array.from({ length: 5 }, (_, i) => {
    const idx = Math.round((i / 4) * (list.length - 1));
    const anchor = Math.round(idx / (list.length - 1) * 4);
    return `<text x="${x(idx)}" y="${bottom + 20}" text-anchor="${anchor === 0 ? 'start' : anchor === 4 ? 'end' : 'middle'}" font-family="Arial" font-size="13" fill="#94a3b8">${fmtTime(list[idx].time * 1000)}</text>`;
  }).join('');
  const legend = [
    ['<line x1="0" x2="18" y1="0" y2="0" stroke="#64748b" stroke-width="3" stroke-dasharray="8 8"/>', 'المرجع'],
    [`<line x1="0" x2="18" y1="0" y2="0" stroke="${color}" stroke-width="4" stroke-dasharray="3 7"/>`, 'السيولة'],
    ['<line x1="0" x2="18" y1="0" y2="0" stroke="#d97706" stroke-width="3" stroke-dasharray="2 5"/>', 'وقف Retail'],
    ['<circle cx="9" cy="0" r="5" fill="none" stroke="#7c3aed" stroke-width="2.5"/>', 'نقطة لمس'],
    ['<line x1="0" x2="18" y1="0" y2="0" stroke="#f59e0b" stroke-width="2.5"/>', 'خط اتجاه'],
    [`<circle cx="9" cy="0" r="5" fill="${color}"/>`, 'سعر السيولة']
  ].map((p, i) => `<g transform="translate(${left + i * 145},${352})">${p[0]}<text x="26" y="5" font-family="Arial" font-size="14" fill="#334155">${escapeSvg(p[1])}</text></g>`).join('');
  const title = `${zone.symbol} ${zone.timeframe} — ${String(zone.kind).replace(/_/g, ' ')} — ${String(zone.state)}`;
  const anchorMs = Math.max(Number(zone.confirmedAt) || 0, Number(zone.createdAt) || 0, Number(zone.detectedAt) > 1e12 ? Number(zone.detectedAt) / 1000 : Number(zone.detectedAt) || 0) * 1000;
  const detTime = anchorMs ? fmtTime(anchorMs) : '';
  const detPrice = detCandle ? Number(detCandle.close).toPrecision(8) : '';
  const detLine = [`الاكتشاف: ${detTime}${detPrice ? ` · سعر الاكتشاف: ${detPrice}` : ''}`.trim(), (zone.reasons || []).slice(0, 2).join(' · ')].filter(Boolean).join(' — ');
  const markerLine = marker ? `<line x1="${marker}" x2="${marker}" y1="${top - 24}" y2="${bottom}" stroke="#334155" stroke-width="1.5" stroke-dasharray="4 4"/><text x="${marker + 6}" y="${top - 10}" font-family="Arial" font-size="13" fill="#334155">الاكتشاف</text>` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
    <rect width="100%" height="100%" fill="#fff"/>
    ${grid}${premium}
    ${bars}${dots}
    ${hLine(ref, '#64748b', 3, 'stroke-dasharray="8 8"', 'المرجع')}
    ${hLine(liq, color, 4, 'stroke-dasharray="3 7"', 'السيولة')}
    ${hLine(stop, '#d97706', 3, 'stroke-dasharray="2 5"', 'وقف Retail')}
    ${markerLine}${liqMarker}${trend}
    <text x="${left}" y="28" font-family="Arial" font-size="20" font-weight="700" fill="#0f172a">${escapeSvg(title)}</text>
    <text x="${left}" y="48" font-family="Arial" font-size="13" fill="#475569">${escapeSvg(detLine)}</text>
    <text x="${left}" y="${h - 20}" font-family="Arial" font-size="13" fill="#64748b">${escapeSvg((zone.reasons || []).slice(2, 4).join(' · '))}</text>
    ${stamps}
    ${legend}
  </svg>`;
};
