import { useEffect, useRef } from 'react';
import type { Candle } from '../lib/types';
import type { LiquidityZoneV2 } from '../lib/types';

/**
 * رسم مناطق محرك السيولة v2 على قماش (canvas) بلا مكتبات رسم خارجية.
 *
 * لماذا رسم يدوي لا مكتبة شارت: المطلوب ليس شموعاً فقط، بل **مستطيل منطقة + خط سيولة +
 * خط مرجعي ثانٍ + نقاط لمس + خطوات كسر + أسهم أحداث بنيوية (IDM/BOS/CHoCH)** في طبقة
 * واحدة متناسقة. والمكتبات تعطي الشموع وتترك الباقي لطبقات إضافية محدودة؛ والقماش يعطي
 * تحكماً كاملاً بكل عنصر وبكل شفافية.
 *
 * القواعد البصرية المنفَّذة (قرارات صاحب النظام):
 *  - اللون بالنوع: BSL أحمر، SSL أخضر، عرض برتقالي، طلب أزرق.
 *  - شدة اللون = قوة المنطقة (`confidence` وعدد اللمسات).
 *  - المسحوبة (`swept`) تُرسم بشفافية عالية مع وقت المسح وسعره.
 *  - كل منطقة تُرسم على مداها الزمني الحقيقي، لا كنقطة.
 */

export const KIND_COLORS: Record<string, { line: string; fill: string; label: string }> = {
  horizontal_bsl: { line: '#f23645', fill: 'rgba(242,54,69,0.18)', label: 'سيولة شراء (BSL)' },
  horizontal_ssl: { line: '#089981', fill: 'rgba(8,153,129,0.18)', label: 'سيولة بيع (SSL)' },
  trendline_bsl: { line: '#f23645', fill: 'rgba(242,54,69,0.10)', label: 'خط هابط (BSL)' },
  trendline_ssl: { line: '#089981', fill: 'rgba(8,153,129,0.10)', label: 'خط صاعد (SSL)' },
  supply: { line: '#f97316', fill: 'rgba(249,115,22,0.20)', label: 'منطقة عرض' },
  demand: { line: '#3b82f6', fill: 'rgba(59,130,246,0.20)', label: 'منطقة طلب' }
};

export const EVENT_COLORS: Record<string, string> = {
  idm: '#a855f7',
  bos_up: '#089981',
  bos_down: '#f23645',
  choch_up: '#089981',
  choch_down: '#f23645'
};

const EVENT_LABEL: Record<string, string> = {
  idm: 'IDM',
  bos_up: 'BOS↑',
  bos_down: 'BOS↓',
  choch_up: 'CHoCH↑',
  choch_down: 'CHoCH↓'
};

interface Props {
  candles: Candle[];
  zones: LiquidityZoneV2[];
  height?: number;
  showBoxes: boolean;
  showStructure: boolean;
  showTouchPoints: boolean;
  showTrendlines: boolean;
  onlyTimeframe?: string;
}

const PAD = { top: 18, right: 74, bottom: 22, left: 8 };

/**
 * سقف مستطيلات العرض/الطلب المرسومة — حماية من إغراق الشارت (سقف مصرَّح لا حذف صامت).
 * و**حدّ امتداد** لكل مستطيل: المنطقة تُرسم من شمعتها الأصلية بامتداد محدود لا حتى حافة
 * الشارت. الامتداد إلى الحافة كان يجعل 60 مستطيلاً تتراكب في أشرطة سميكة تحجب الشموع
 * تماماً، وهي بعيدة عن لحظة تكوّنها أصلاً.
 */
const BOX_CAP = 30;
const BOX_MAX_BARS = 80;

/**
 * سقف خطوط السيولة (BSL/SSL/خطوط الاتجاه) المرسومة. بلا سقف كان رسم 213 منطقة
 * (من 1h وحتى 6h) يُنتج مئات الخطوط الأفقية التي تغطي الشموع تماماً.
 * الترتيب: المؤكدة أولاً، ثم الأقوى ثقة، ثم الأحدث.
 *
 * وكل منطقة أفقية ترسم **ثلاثة** خطوط (المستوى المرجعي، وخط السيولة، والمرجع الثاني)
 * فالسقف الفعلي ثلاثة أضعافه — لذلك خُفِّض إلى 12 بعد أن أثبتت المعاينة أن 25 تُنتج
 * أشرطة كثيفة تحجب السعر رغم أن المستطيلات محدودة الامتداد.
 */
const LINE_CAP = 12;

/**
 * خفوت تدريجي للمناطق الأقدم: الأقدم أخفت حتى تبقى الشموع مقروءة، والأحدث أبرز.
 * الحد الأدنى 0.4 لا صفراً — المنطقة القديمة تبقى مرئية (لا حذف صامت).
 */
const LINE_MIN_ALPHA = 0.4;

/** سقف أسهم الأحداث البنيوية (IDM/BOS/CHoCH) — بلا سقف تُغطي المنصّات الشموع. */
const EVENT_CAP = 60;

export default function LiquidityV2Chart({
  candles, zones, height = 460, showBoxes, showStructure, showTouchPoints, showTrendlines, onlyTimeframe
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const parent = canvas.parentElement;
    const width = Math.max(parent?.clientWidth ?? 800, 320);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const bars = candles ?? [];
    const shown = (zones ?? []).filter(z => !onlyTimeframe || z.timeframe === onlyTimeframe);

    const bg = getComputedStyle(document.documentElement).getPropertyValue('--surface-1').trim() || '#0b1220';
    const fg = getComputedStyle(document.documentElement).getPropertyValue('--text-3').trim() || '#7c8798';
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, width, height);

    if (!bars.length) {
      ctx.fillStyle = fg;
      ctx.font = '12px system-ui';
      ctx.fillText('لا شموع لهذا المفتاح — المخزن لم يُسخَّن بعد', 14, height / 2);
      return;
    }

    // ---- نطاق السعر: من الشموع ومن كل عناصر المناطق المعروضة
    let hi = -Infinity;
    let lo = Infinity;
    for (const c of bars) { hi = Math.max(hi, c.high); lo = Math.min(lo, c.low); }
    for (const z of shown) {
      for (const v of [z.zoneBox?.high, z.zoneBox?.low, z.liquidityLevel, z.retailStop, z.referenceLevel, z.referenceAlt]) {
        if (Number.isFinite(v as number)) { hi = Math.max(hi, v as number); lo = Math.min(lo, v as number); }
      }
      for (const p of z.touchPoints ?? []) { hi = Math.max(hi, p.price); lo = Math.min(lo, p.price); }
      if (showStructure) for (const e of z.structureEvents ?? []) { hi = Math.max(hi, e.price); lo = Math.min(lo, e.price); }
    }
    if (!Number.isFinite(hi) || !Number.isFinite(lo) || hi <= lo) { hi = lo + 1; }
    const padPct = (hi - lo) * 0.06;
    hi += padPct; lo -= padPct;

    const chartW = width - PAD.left - PAD.right;
    const chartH = height - PAD.top - PAD.bottom;
    const n = bars.length;
    const x = (i: number) => PAD.left + (n <= 1 ? chartW / 2 : (i / (n - 1)) * chartW);
    const y = (p: number) => PAD.top + (1 - (p - lo) / (hi - lo)) * chartH;

    // ---- شبكة ومحور سعري
    ctx.strokeStyle = 'rgba(148,163,184,0.14)';
    ctx.fillStyle = fg;
    ctx.font = '10px system-ui';
    ctx.textAlign = 'left';
    for (let g = 0; g <= 4; g += 1) {
      const p = lo + ((hi - lo) * g) / 4;
      const yy = y(p);
      ctx.beginPath();
      ctx.moveTo(PAD.left, yy);
      ctx.lineTo(PAD.left + chartW, yy);
      ctx.stroke();
      ctx.fillText(p.toPrecision(6), PAD.left + chartW + 6, yy + 3);
    }

    // ---- الشموع
    const bw = Math.max(Math.min(chartW / Math.max(n, 1) * 0.7, 8), 1);
    for (let i = 0; i < n; i += 1) {
      const c = bars[i];
      const up = c.close >= c.open;
      ctx.strokeStyle = up ? '#089981' : '#f23645';
      ctx.fillStyle = up ? 'rgba(8,153,129,0.85)' : 'rgba(242,54,69,0.85)';
      const xx = x(i);
      ctx.beginPath();
      ctx.moveTo(xx, y(c.high));
      ctx.lineTo(xx, y(c.low));
      ctx.stroke();
      const yTop = y(Math.max(c.open, c.close));
      const yBot = y(Math.min(c.open, c.close));
      ctx.fillRect(xx - bw / 2, yTop, bw, Math.max(yBot - yTop, 1));
    }

    // ---- خرائط الزمن إلى فهرس الشمعة (للربط الزمني الصحيح لكل عنصر)
    const timeToIndex = new Map<number, number>();
    for (let i = 0; i < n; i += 1) timeToIndex.set(bars[i].time, i);
    const idxOfTime = (t: number | null | undefined) => {
      if (t == null) return null;
      if (timeToIndex.has(t)) return timeToIndex.get(t) as number;
      // أقرب شمعة (المنطقة قد تنشأ على فريم أعلى من المعروض)
      let best = 0;
      let bestD = Infinity;
      for (let i = 0; i < n; i += 1) {
        const d = Math.abs(bars[i].time - t);
        if (d < bestD) { bestD = d; best = i; }
      }
      return best;
    };

    // ---- مناطق العرض/الطلب وFVG (مستطيلات الذيل-إلى-الذيل)
    /**
     * تحديد ما يُرسم فعلاً — كان الرسم السابق يُغرق الشارت:
     * مناطق العرض/الطلب **المبدئية** (بلا كسر بنيوي) تُنتج ~940 منطقة مقابل ~60 مؤكدة،
     * فرسمها كلها يحجب الشموع ويجعل الشاشة غير مقروءة. القرار: تُرسم المؤكدة وحدها
     * (وهي المعتمدة بشرط صاحب النظام: الكسر)، مع سقف مصرَّح للمستطيلات.
     */
    const boxZones = shown
      .filter(z => (z.kind === 'supply' || z.kind === 'demand') && z.zoneBox)
      .filter(z => z.state === 'confirmed' || z.state === 'swept')
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, BOX_CAP);
    /**
     * خطوط السيولة: سقف مصرَّح بنفس منطق المستطيلات. المؤكدة قبل المبدئية،
     * والأقوى ثقة قبل الأضعف، ثم الأحدث (الأقرب لنهاية الشارت) قبل الأقدم.
     */
    const stateRank = (s: string) => (s === 'confirmed' ? 0 : s === 'candidate' ? 1 : s === 'swept' ? 2 : 3);
    const lineZones = shown
      .filter(z => z.kind === 'horizontal_bsl' || z.kind === 'horizontal_ssl' || z.kind.startsWith('trendline'))
      .filter(z => !z.kind.startsWith('trendline') || showTrendlines)
      .sort((a, b) =>
        stateRank(a.state) - stateRank(b.state) ||
        (b.confidence ?? 0) - (a.confidence ?? 0) ||
        (idxOfTime(b.createdAt) ?? 0) - (idxOfTime(a.createdAt) ?? 0))
      .slice(0, LINE_CAP);
    const drawnIds = new Set([...boxZones, ...lineZones].map(z => z.id));
    const drawnZones = shown.filter(z => drawnIds.has(z.id));
    for (const z of boxZones) {
      if (!showBoxes) break;
      const col = KIND_COLORS[z.kind];
      const from = idxOfTime(z.createdAt) ?? 0;
      // امتداد محدود: المنطقة تُرسم حول لحظة تكوّنها لا حتى حافة الشارت
      const right = Math.min(n - 1, from + BOX_MAX_BARS);
      const w = Math.max(x(right) - x(from), 2);
      const alpha = z.state === 'swept' ? 0.10 : 0.14 + Math.min(z.confidence, 0.99) * 0.18;
      ctx.fillStyle = `rgba(${z.kind === 'supply' ? '249,115,22' : '59,130,246'},${alpha})`;
      const yTop = y(z.zoneBox.high);
      const yBot = y(z.zoneBox.low);
      ctx.fillRect(x(from), yTop, w, Math.max(yBot - yTop, 1));
      ctx.strokeStyle = col.line;
      ctx.globalAlpha = z.state === 'swept' ? 0.4 : 0.85;
      ctx.lineWidth = 1;
      ctx.strokeRect(x(from), yTop, w, Math.max(yBot - yTop, 1));
      ctx.globalAlpha = 1;
      if (z.bodyBox && z.bodyBox.high > z.bodyBox.low) {
        ctx.setLineDash([2, 3]);
        ctx.strokeStyle = 'rgba(255,255,255,0.35)';
        ctx.strokeRect(x(from), y(z.bodyBox.high), w, Math.max(y(z.bodyBox.low) - y(z.bodyBox.high), 1));
        ctx.setLineDash([]);
      }
    }

    // ---- خطوط السيولة والمراجع (BSL/SSL وخطوط الاتجاه)
    for (const z of lineZones) {
      const col = KIND_COLORS[z.kind] ?? { line: '#94a3b8', fill: '', label: '' };
      const from = idxOfTime(z.createdAt) ?? 0;
      // خفوت تدريجي بالأقدمية: الأقدم أخفت، والحد الأدنى لا يبلغ الصفر (لا حذف صامت)
      const lifeAlpha = LINE_MIN_ALPHA + (1 - LINE_MIN_ALPHA) * Math.min(1, Math.max(0, from / Math.max(n - 1, 1)));
      const isTrend = z.kind.startsWith('trendline');
      if (isTrend && z.trendline) {
        // خط اتجاه مائل من نقاطه الحقيقية
        const pts = z.trendline.points ?? [];
        if (pts.length >= 2) {
          const i0 = idxOfTime(pts[0].time) ?? pts[0].index;
          ctx.strokeStyle = col.line;
          ctx.lineWidth = 1.6;
          ctx.globalAlpha = lifeAlpha * (z.state === 'swept' ? 0.35 : 0.9);
          ctx.beginPath();
          ctx.moveTo(x(i0), y(pts[0].price));
          ctx.lineTo(x(n - 1), y(z.trendline.projected));
          ctx.stroke();
          ctx.globalAlpha = 1;
          ctx.lineWidth = 1;
          ctx.fillStyle = col.line;
          for (const p of pts) ctx.fillRect(x(idxOfTime(p.time) ?? p.index) - 1.5, y(p.price) - 1.5, 3, 3);
        }
        continue;
      }
      // BSL/SSL: خط المستوى + خط السيولة (الوقف المرجعي) + الخط الفرعي الثاني
      ctx.strokeStyle = col.line;
      ctx.lineWidth = 1.4;
      ctx.globalAlpha = lifeAlpha * (z.state === 'swept' ? 0.35 : 0.95);
      ctx.beginPath();
      ctx.moveTo(x(from), y(z.referenceLevel));
      ctx.lineTo(x(n - 1), y(z.referenceLevel));
      ctx.stroke();
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      ctx.moveTo(x(from), y(z.liquidityLevel));
      ctx.lineTo(x(n - 1), y(z.liquidityLevel));
      ctx.stroke();
      // الخط الفرعي الثاني يُرسم فقط إن كان بعيداً فعلاً عن المستوى المرجعي —
      // وإلا فهو خط مكرر يضيف كثافة بلا معلومة
      const alt = z.referenceAlt as number | undefined;
      if (Number.isFinite(alt) && Math.abs((alt as number) - z.referenceLevel) > Math.max(Math.abs(z.referenceLevel) * 0.001, 1e-9)) {
        ctx.setLineDash([2, 4]);
        ctx.beginPath();
        ctx.moveTo(x(from), y(alt as number));
        ctx.lineTo(x(n - 1), y(alt as number));
        ctx.stroke();
      }
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
      ctx.lineWidth = 1;
    }

    // ---- نقاط اللمس وخطوات الكسر (دليل «كم مرة تكرر السعر» وكسر كل تكرار)
    if (showTouchPoints) {
      for (const z of drawnZones) {
        const col = KIND_COLORS[z.kind] ?? { line: '#94a3b8' };
        for (const p of z.touchPoints ?? []) {
          const i = idxOfTime(p.time) ?? p.index;
          ctx.beginPath();
          ctx.arc(x(i), y(p.price), 3.2, 0, Math.PI * 2);
          ctx.fillStyle = col.line;
          ctx.fill();
          ctx.strokeStyle = '#fff';
          ctx.lineWidth = 1;
          ctx.stroke();
        }
        for (const b of z.breakSteps ?? []) {
          const i = idxOfTime(b.time) ?? b.index;
          const yy = y(b.reactionPrice);
          ctx.strokeStyle = '#eab308';
          ctx.lineWidth = 1.4;
          ctx.beginPath();
          ctx.moveTo(x(i) - 3, yy - 3);
          ctx.lineTo(x(i) + 3, yy + 3);
          ctx.moveTo(x(i) + 3, yy - 3);
          ctx.lineTo(x(i) - 3, yy + 3);
          ctx.stroke();
        }
      }
      ctx.lineWidth = 1;
    }

    // ---- أسهم الأحداث البنيوية: IDM / BOS / CHoCH (سبب وجود كل منطقة)
    if (showStructure) {
      const seen = new Set<string>();
      const events: { type: string; time?: number | null; index?: number; price: number; i: number }[] = [];
      for (const z of drawnZones) {
        for (const e of z.structureEvents ?? []) {
          const key = `${e.type}:${e.time ?? e.index}`;
          if (seen.has(key)) continue; // لا تكرار لسهم واحد بسبب عدة مناطق
          seen.add(key);
          const i = idxOfTime(e.time) ?? e.index;
          if (i == null) continue;
          if (!Number.isFinite(e.price)) continue;
          events.push({ type: e.type, time: e.time, index: e.index, price: e.price, i });
        }
      }
      // الأحدث أولاً ثم سقف مصرَّح — بلا سقف تُغطي المنصّات الشموع كلها
      events.sort((a, b) => b.i - a.i);
      const capped = events.slice(0, EVENT_CAP);
      const label = capped.length <= EVENT_CAP;
      for (const e of capped) {
        const i = e.i;
        const color = EVENT_COLORS[e.type] ?? '#a855f7';
        const isDown = e.type === 'bos_down' || e.type === 'choch_down';
        const isIdm = e.type === 'idm';
        const yy = y(e.price);
        const dir = isIdm ? -1 : (isDown ? 1 : -1);
        ctx.fillStyle = color;
        ctx.beginPath();
        const tipY = yy + dir * 12;
        ctx.moveTo(x(i), tipY);
        ctx.lineTo(x(i) - 5, tipY - dir * 8);
        ctx.lineTo(x(i) + 5, tipY - dir * 8);
        ctx.closePath();
        ctx.fill();
        if (label) {
          ctx.font = 'bold 9px system-ui';
          ctx.textAlign = 'center';
          ctx.fillStyle = color;
          ctx.fillText(EVENT_LABEL[e.type] ?? e.type, x(i), tipY + (dir > 0 ? 16 : -11));
          ctx.textAlign = 'left';
        }
      }
    }

    // ---- مفتاح الألوان داخل الرسم
    const kindsPresent = [...new Set(shown.map(z => z.kind))];
    let lx = PAD.left + 4;
    const ly = height - 6;
    ctx.font = '10px system-ui';
    for (const k of kindsPresent) {
      const c = KIND_COLORS[k];
      if (!c) continue;
      ctx.fillStyle = c.line;
      ctx.fillRect(lx, ly - 7, 8, 8);
      ctx.fillStyle = fg;
      ctx.fillText(c.label, lx + 11, ly);
      lx += ctx.measureText(c.label).width + 26;
      if (lx > width - 160) break;
    }
  }, [candles, zones, height, showBoxes, showStructure, showTouchPoints, showTrendlines, onlyTimeframe]);

  return <canvas ref={canvasRef} className="w-full rounded-lg" style={{ display: 'block' }} />;
}
