import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchLiquidityHistory, type LiquidityHistoryResponse } from '../lib/liquidityHistory';
import {
  aggregateCandles,
  buildLevels,
  buildTrends,
  isFullView,
  levelDeviation,
  makeScale,
  makeY,
  mergeLevelsByGap,
  panViewBox,
  zoomViewBox,
  MIN_TOUCHES,
  MIN_TREND_POINTS,
  type LevelItem,
  type ViewBox
} from '../lib/liquidityLevels';
/**
 * شارت تاريخي إضافي (مستقل) لمستويات السيولة الدقيقة — **تفاعلي**.
 *
 * الاستقلال مقصود: لا يقرأ `buildElements` ولا حالة أي شارت آخر ولا يكتب شيئاً.
 * يقرأ نفس الحمولة المخزّنة (`/api/liquidity-history`، محرك legacy) ويعرض منها
 * **الحقول الخام** فقط، بمنطق اختيار واختبار في `lib/liquidityLevels.ts`:
 *  - `referenceLevel` = السعر الذي تكرر عنده السعر (وسيط اللمسات) → خط أفقي 1px.
 *  - `liquidityLevel` = منطقة وقف الخسارة (أعلى لمسة + 2×ATR للـBSL، وأدنى لمسة
 *    − 2×ATR للـSSL) → شرطة + نقطة عند نهاية الخط.
 *  - `trendline.points` = خط اتجاه من ثلاث نقاط أو أكثر.
 *
 * التفاعل الحقيقي:
 *  - سحب للتحريك، عجلة الفأرة للتكبير حول المؤشر، أزرار − / + / إعادة، نقر مزدوج للإعادة.
 *  - الشبكة والأسعار والأزمنة تُحسب من **النافذة المعروضة** لا من المدى الكامل.
 *  - الشموع تُعاد تجميعها من شموع الدقيقة داخل النافذة، فالتكبير يكشف تفصيلاً حقيقياً.
 *  - crosshair + قراءة سعر/زمن تحت المؤشر، ونقر أي خط يعرض أرقام المحرك الفعلية له.
 *
 * قواعد العرض:
 *  - العمق الافتراضي 30 يوماً، والتحديد يغطي الشارت من أوله إلى آخره (بلا قصّ).
 *  - الخط الأفقي يبدأ عند أول لمسة وينتهي عند آخر لمسة (لا يمرّ على فراغ).
 *  - الدمج البصري (2.5px) للعرض فقط: لا يحذف مستوى ولا يغيّر أي رقم من المحرك.
 */

const VIEW_W = 1200;
const VIEW_H = 520;
const PAD = { top: 18, right: 78, bottom: 30, left: 14 };
const PLOT_W = VIEW_W - PAD.left - PAD.right;
const PLOT_H = VIEW_H - PAD.top - PAD.bottom;
const BOUNDS: ViewBox = { x: PAD.left, y: PAD.top, w: PLOT_W, h: PLOT_H };

const MERGE_PX = 2.5;
const NEAR_PX = 4;
const COLLIDE_PX = 1.5;
const SHORT_LINE_PX = 6;
const ZOOM_STEP = 1.4;

const CANDLE_UP = '#22c55e';
const CANDLE_DOWN = '#ef4444';
const BSL_COLOR = '#fb923c';
const SSL_COLOR = '#38bdf8';
const TREND_COLOR = '#a855f7';
const STOP_COLOR = '#facc15';

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const fmtPrice = (v: number) => v.toLocaleString('en-US', { maximumFractionDigits: v >= 100 ? 2 : 6 });
const fmtDay = (sec: number) => new Date(sec * 1000).toLocaleDateString('ar', { day: '2-digit', month: '2-digit' });
const fmtClock = (sec: number) =>
  new Date(sec * 1000).toLocaleTimeString('ar', { hour: '2-digit', minute: '2-digit', hour12: false });
const fmtDayClock = (sec: number) => `${fmtDay(sec)} ${fmtClock(sec)}`;
const pct = (v: number) => `${(v * 100).toFixed(3)}%`;

/** النص الرقمي داخل مستند RTL: عزل LTR كي لا يُعكس ترتيب `08/10` و`18:03` */
const NUM_TEXT = { direction: 'ltr', unicodeBidi: 'isolate' } as const;

/** خطوة "جميلة" لمحور الأسعار */
function niceStep(raw: number): number {
  if (!Number.isFinite(raw) || raw <= 0) return 1;
  const exp = Math.floor(Math.log10(raw));
  const base = raw / 10 ** exp;
  const mult = base <= 1 ? 1 : base <= 2 ? 2 : base <= 2.5 ? 2.5 : base <= 5 ? 5 : 10;
  return mult * 10 ** exp;
}

function priceTicksFor(lo: number, hi: number, count = 6): number[] {
  if (!(hi > lo) || !Number.isFinite(hi - lo)) return [];
  const step = niceStep((hi - lo) / count);
  const start = Math.ceil(lo / step) * step;
  const out: number[] = [];
  for (let v = start; v <= hi + step * 1e-9 && out.length < 20; v += step) out.push(Number(v.toPrecision(12)));
  return out;
}

const TIME_STEPS = [60, 300, 900, 1800, 3600, 7200, 14400, 21600, 43200, 86400, 172800, 604800];

function timeTicksFor(t0: number, t1: number): number[] {
  const span = t1 - t0;
  if (!(span > 0)) return [];
  const step = TIME_STEPS.find((s) => span / s <= 7) ?? TIME_STEPS[TIME_STEPS.length - 1];
  const start = Math.ceil(t0 / step) * step;
  const out: number[] = [];
  for (let t = start; t <= t1 && out.length < 12; t += step) out.push(t);
  return out;
}

export default function LiquidityLevelsSection({ symbol }: { symbol: string }) {
  const [days, setDays] = useState(30);
  const [minTouches, setMinTouches] = useState(MIN_TOUCHES);
  const [data, setData] = useState<LiquidityHistoryResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [slow, setSlow] = useState(false);
  const [error, setError] = useState('');
  const [showBsl, setShowBsl] = useState(true);
  const [showSsl, setShowSsl] = useState(true);
  const [showStops, setShowStops] = useState(true);
  const [showTrend, setShowTrend] = useState(true);
  const [showTouches, setShowTouches] = useState(false);
  const [view, setView] = useState<ViewBox>(BOUNDS);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [cursor, setCursor] = useState<{ fx: number; fy: number; t: number; p: number } | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [dragging, setDragging] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ x: number; y: number; view: ViewBox } | null>(null);
  const viewRef = useRef(view);
  useEffect(() => { viewRef.current = view; }, [view]);

  const load = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    setError('');
    try {
      const res = await fetchLiquidityHistory({ symbol, engine: 'legacy', days, signal: controller.signal });
      if (!controller.signal.aborted) setData(res);
    } catch (e) {
      if (!controller.signal.aborted) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [symbol, days]);

  useEffect(() => {
    void load();
    return () => abortRef.current?.abort();
  }, [load]);

  useEffect(() => {
    if (!loading) { setSlow(false); return; }
    const t = setTimeout(() => setSlow(true), 12_000);
    return () => clearTimeout(t);
  }, [loading]);

  // نافذة العرض تعود للمدى الكامل عند تغيير العمق أو الرمز
  useEffect(() => {
    setView(BOUNDS);
    setSelectedId(null);
    setHoverId(null);
    setCursor(null);
  }, [days, symbol]);

  // قياس الحاوية (يُستخدم لتحويل البكسل ⇄ السعر ولثبات أحجام العلامات)
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const apply = () => {
      const rect = el.getBoundingClientRect();
      setSize({ w: rect.width, h: rect.height });
    };
    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(el);
    return () => observer.disconnect();
  }, [data, error]);

  const candles = useMemo(() => data?.candles ?? [], [data]);
  const bars = useMemo(() => aggregateCandles(candles), [candles]);
  const lastClose = useMemo(() => {
    const bar = bars[bars.length - 1];
    if (bar && Number.isFinite(bar.c)) return bar.c;
    const raw = Number(candles[candles.length - 1]?.[4]);
    return Number.isFinite(raw) ? raw : null;
  }, [bars, candles]);
  const scale = useMemo(() => makeScale(candles, bars, VIEW_W, VIEW_H, PAD), [candles, bars]);
  const y = useMemo(() => (scale ? makeY(scale, VIEW_H, PAD) : null), [scale]);

  const levelsBase = useMemo(
    () => (scale ? buildLevels(data?.zones, { t0: scale.t0, t1: scale.t1, minTouches }) : []),
    [data, scale, minTouches]
  );
  const trends = useMemo(
    () => (scale ? buildTrends(data?.zones, { t0: scale.t0, t1: scale.t1 }) : []),
    [data, scale]
  );

  /** بكسل الشاشة لكل وحدة سعر — يعتمد على التكبير الحالي */
  const pricePerPx = useMemo(() => {
    if (!scale) return 0;
    const plotCssH = size.w > 0 ? (size.w * PLOT_H) / VIEW_W : PLOT_H;
    return ((scale.hi - scale.lo) / PLOT_H) * (view.h / plotCssH);
  }, [scale, size.w, view.h]);

  /** بكسل الشاشة لكل وحدة x في فضاء الرسم */
  const pxPerUnit = useMemo(() => {
    const plotCssW = size.w > 0 ? (size.w * PLOT_W) / VIEW_W : PLOT_W;
    return plotCssW / view.w;
  }, [size.w, view.w]);

  /** الدمج البصري: يتقلّص مع التكبير حتى يعود كل مستوى مستقلاً عند التفصيل */
  const levelsView = useMemo(() => mergeLevelsByGap(levelsBase, pricePerPx * MERGE_PX), [levelsBase, pricePerPx]);

  const visibleLevels = useMemo(
    () => levelsView.filter((l) => (l.side === 'bsl' ? showBsl : showSsl)),
    [levelsView, showBsl, showSsl]
  );
  const visibleTrends = showTrend ? trends : [];

  const stopCount = showStops ? visibleLevels.filter((l) => l.stop != null).length : 0;
  const visibleBase = useMemo(
    () => levelsBase.filter((l) => (l.side === 'bsl' ? showBsl : showSsl)),
    [levelsBase, showBsl, showSsl]
  );
  const visualMerged = Math.max(0, visibleBase.length - visibleLevels.length);
  const identicalCopies = Math.max(
    0,
    visibleLevels.reduce((sum, l) => sum + Math.max(0, l.mergedCount - 1), 0) - visualMerged
  );
  const shortLines = useMemo(
    () => visibleLevels.filter((l) => (scale ? (scale.x(l.touchTimes[l.touchTimes.length - 1]) - scale.x(l.touchTimes[0])) * pxPerUnit : 0) < SHORT_LINE_PX),
    [visibleLevels, scale, pxPerUnit]
  );

  /** نقاط وقف تقع على خط مستوى آخر (في العرض الحالي) → تُرسم بحلقة مفتوحة */
  const collidedIds = useMemo(() => {
    const set = new Set<string>();
    if (!showStops || !pricePerPx) return set;
    const tol = pricePerPx * COLLIDE_PX;
    for (const level of visibleLevels) {
      if (level.stop == null) continue;
      for (const other of visibleLevels) {
        if (other.id === level.id) continue;
        if (Math.abs(level.stop - other.ref) <= tol) { set.add(level.id); break; }
      }
    }
    return set;
  }, [visibleLevels, pricePerPx, showStops]);

  /** عدد أزواج الخطوط المتقاربة بصرياً في النافذة الحالية */
  const nearbyPairs = useMemo(() => {
    if (!pricePerPx) return 0;
    const tol = pricePerPx * NEAR_PX;
    let n = 0;
    for (let i = 0; i < visibleLevels.length; i += 1) {
      for (let j = i + 1; j < visibleLevels.length; j += 1) {
        if (Math.abs(visibleLevels[i].ref - visibleLevels[j].ref) <= tol) n += 1;
      }
    }
    return n;
  }, [visibleLevels, pricePerPx]);

  const maxDeviation = useMemo(() => {
    let max = 0;
    for (const level of visibleLevels) {
      const dev = levelDeviation(level);
      if (dev > max) max = dev;
    }
    return max;
  }, [visibleLevels]);

  /* ----------------------------- النافذة والمحاور ----------------------------- */

  const priceAtY = useCallback(
    (yy: number) => (scale ? scale.hi - ((yy - PAD.top) / PLOT_H) * (scale.hi - scale.lo) : 0),
    [scale]
  );
  const timeAtX = useCallback(
    (xx: number) => (scale ? scale.t0 + ((xx - PAD.left) / PLOT_W) * (scale.t1 - scale.t0) : 0),
    [scale]
  );

  const shown = useMemo(() => {
    if (!scale) return null;
    return {
      t0: timeAtX(view.x),
      t1: timeAtX(view.x + view.w),
      hi: priceAtY(view.y),
      lo: priceAtY(view.y + view.h)
    };
  }, [scale, view, timeAtX, priceAtY]);

  const gridPrices = useMemo(() => (shown ? priceTicksFor(shown.lo, shown.hi) : []), [shown]);
  const gridTimes = useMemo(() => (shown ? timeTicksFor(shown.t0, shown.t1) : []), [shown]);

  /** موضع المحور في فضاء الرسم الثابت (الطبقة العلوية لا تتكبّر) */
  const axisY = useCallback((price: number) => (shown ? PAD.top + ((shown.hi - price) / Math.max(1e-9, shown.hi - shown.lo)) * PLOT_H : 0), [shown]);
  const axisX = useCallback((t: number) => (shown ? PAD.left + ((t - shown.t0) / Math.max(1e-9, shown.t1 - shown.t0)) * PLOT_W : 0), [shown]);

  /* ------------------------- التفاعل: سحب / عكازة / تكبير ------------------------- */

  const plotRect = useCallback(() => {
    const el = boxRef.current;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    return {
      left: rect.left + (rect.width * PAD.left) / VIEW_W,
      top: rect.top + (rect.height * PAD.top) / VIEW_H,
      width: (rect.width * PLOT_W) / VIEW_W,
      height: (rect.height * PLOT_H) / VIEW_H
    };
  }, []);

  const updateCursor = useCallback((clientX: number, clientY: number) => {
    const plot = plotRect();
    if (!plot || !plot.width || !plot.height || !scale) return;
    const u = clamp01((clientX - plot.left) / plot.width);
    const v = clamp01((clientY - plot.top) / plot.height);
    const current = viewRef.current;
    const dx = current.x + u * current.w;
    const dy = current.y + v * current.h;
    setCursor({
      fx: PAD.left + u * PLOT_W,
      fy: PAD.top + v * PLOT_H,
      t: timeAtX(dx),
      p: priceAtY(dy)
    });
  }, [plotRect, scale, timeAtX, priceAtY]);

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* ignore: بعض البيئات لا تدعم الالتقاط */ }
    dragRef.current = { x: e.clientX, y: e.clientY, view: viewRef.current };
    setDragging(true);
    updateCursor(e.clientX, e.clientY);
  }, [updateCursor]);

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    updateCursor(e.clientX, e.clientY);
    const drag = dragRef.current;
    if (!drag) return;
    const plot = plotRect();
    if (!plot || !plot.width || !plot.height) return;
    const dx = -((e.clientX - drag.x) / plot.width) * drag.view.w;
    const dy = -((e.clientY - drag.y) / plot.height) * drag.view.h;
    setView(panViewBox(drag.view, dx, dy, BOUNDS));
  }, [plotRect, updateCursor]);

  const endDrag = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (dragRef.current) {
      dragRef.current = null;
      setDragging(false);
    }
    try {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    } catch { /* ignore */ }
  }, []);

  const zoomBy = useCallback((factor: number, anchor?: { x: number; y: number }) => {
    setView((current) => zoomViewBox(current, factor, anchor ?? { x: current.x + current.w / 2, y: current.y + current.h / 2 }, BOUNDS));
  }, []);

  // wheel غير سلبي كي نمنع تمرير الصفحة أثناء التكبير
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const plot = plotRect();
      if (!plot || !plot.width || !plot.height) return;
      const u = clamp01((e.clientX - plot.left) / plot.width);
      const v = clamp01((e.clientY - plot.top) / plot.height);
      const current = viewRef.current;
      const anchor = { x: current.x + u * current.w, y: current.y + v * current.h };
      const factor = Math.exp(e.deltaY * 0.0015);
      setView(zoomViewBox(current, Math.min(2, Math.max(0.5, factor)), anchor, BOUNDS));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [plotRect, data, error]);

  /* ------------------------------- الشموع المعروضة ------------------------------- */

  const visibleBars = useMemo(() => {
    if (!scale || !shown) return [];
    const tA = shown.t0;
    const tB = shown.t1;
    const raw = candles.filter((c) => {
      const t = Number(c[0]);
      return Number.isFinite(t) && t >= tA && t <= tB;
    });
    return aggregateCandles(raw.length > 8 ? raw : candles, 1400);
  }, [candles, scale, shown]);

  const candlePaths = useMemo(() => {
    if (!scale || !y || !visibleBars.length) return null;
    const spacing = visibleBars.length > 1 ? Math.abs(scale.x(visibleBars[1].t) - scale.x(visibleBars[0].t)) : 1;
    const bodyW = Math.max(0.4, Math.min(16, spacing * 0.62));
    const upWick: string[] = [];
    const downWick: string[] = [];
    const upBody: string[] = [];
    const downBody: string[] = [];
    for (const bar of visibleBars) {
      const x = scale.x(bar.t);
      const isUp = bar.c >= bar.o;
      const wick = `M${x.toFixed(1)} ${y(bar.h).toFixed(1)}L${x.toFixed(1)} ${y(bar.l).toFixed(1)}`;
      (isUp ? upWick : downWick).push(wick);
      const yTop = y(Math.max(bar.o, bar.c));
      const yBot = y(Math.min(bar.o, bar.c));
      const bodyH = Math.max(0.5, yBot - yTop);
      const left = x - bodyW / 2;
      (isUp ? upBody : downBody).push(`M${left.toFixed(1)} ${yTop.toFixed(1)}h${bodyW.toFixed(1)}v${bodyH.toFixed(1)}h${(-bodyW).toFixed(1)}z`);
    }
    return {
      upWick: upWick.join(''),
      downWick: downWick.join(''),
      upBody: upBody.join(''),
      downBody: downBody.join('')
    };
  }, [visibleBars, scale, y]);

  /* --------------------------------- بيانات العرض --------------------------------- */

  const activeLevel: LevelItem | null = useMemo(() => {
    const id = selectedId ?? hoverId;
    if (!id) return null;
    return visibleLevels.find((l) => l.id === id) ?? null;
  }, [selectedId, hoverId, visibleLevels]);

  const levelNote = (level: LevelItem) => [
    `المستوى ${fmtPrice(level.ref)}`,
    level.stop != null ? `الوقف ${fmtPrice(level.stop)}` : 'الوقف —',
    level.atr != null ? `ATR ${fmtPrice(level.atr)}` : '',
    `لمسات ${level.touches}`,
    level.mergedCount > 1 ? `مدمجة ${level.mergedCount}` : '',
    `انحراف ${pct(levelDeviation(level))}`,
    level.state === 'confirmed' ? 'مؤكدة' : level.state === 'swept' ? 'مخترقة' : 'مرشحة'
  ].filter(Boolean).join(' · ');

  const zoneTotal = data?.totalZones ?? data?.zones?.length ?? 0;
  const zoomRatio = BOUNDS.w / view.w;
  const fullView = isFullView(view, BOUNDS);

  return (
    <section className="rounded-xl p-3 space-y-2" style={{ background: 'var(--surface-1)' }} data-testid="levels-section">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-[13px] font-bold" style={{ color: 'var(--text-1)' }}>الشارت التاريخي الإضافي — مستويات السيولة الدقيقة</h3>
          <p className="text-[11px] mt-0.5" style={{ color: 'var(--text-3)' }}>
            خط 1px على السعر المتكرر (لمسات ≥ {MIN_TOUCHES}) · وقف عند {`السيولة (أعلى/أدنى لمسة ± 2×ATR)`} · خط اتجاه من {MIN_TREND_POINTS} نقاط · اسحب للتحريك · عجلة للتكبير · انقر خطاً لأرقامه
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-[11px]">
          <select
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
            className="px-2 py-1 rounded-md"
            style={{ background: 'var(--surface-2, var(--surface-1))', border: '1px solid var(--border-1)', color: 'var(--text-1)' }}
            aria-label="عمق الشارت"
          >
            <option value={7}>7 أيام</option>
            <option value={30}>30 يوماً</option>
            <option value={90}>90 يوماً</option>
          </select>
          <select
            value={minTouches}
            onChange={(e) => setMinTouches(Number(e.target.value))}
            className="px-2 py-1 rounded-md"
            style={{ background: 'var(--surface-2, var(--surface-1))', border: '1px solid var(--border-1)', color: 'var(--text-1)' }}
            aria-label="أقل عدد لمسات"
          >
            <option value={3}>3 لمسات+ (أساسي)</option>
            <option value={4}>4 لمسات+</option>
            <option value={5}>5 لمسات+</option>
            <option value={6}>6 لمسات+</option>
            <option value={8}>8 لمسات+</option>
          </select>
          <Toggle on={showBsl} onClick={() => setShowBsl(!showBsl)} label="BSL" color={BSL_COLOR} />
          <Toggle on={showSsl} onClick={() => setShowSsl(!showSsl)} label="SSL" color={SSL_COLOR} />
          <Toggle on={showTrend} onClick={() => setShowTrend(!showTrend)} label="خط الاتجاه" color={TREND_COLOR} />
          <Toggle on={showStops} onClick={() => setShowStops(!showStops)} label="نقاط الوقف" color={STOP_COLOR} />
          <Toggle on={showTouches} onClick={() => setShowTouches(!showTouches)} label="اللمسات" color="var(--text-2)" />
          <button
            onClick={() => void load()}
            disabled={loading}
            className="px-2 py-1 rounded-md font-bold"
            style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}
          >
            {loading ? 'يُجهّز...' : 'تحديث'}
          </button>
        </div>
      </div>

      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px]" style={{ color: 'var(--text-2)' }}>
        <span data-testid="levels-stats">
          مستويات: <b className="num">{visibleLevels.length}</b> · نقاط وقف: <b className="num">{stopCount}</b> · خطوط اتجاه: <b className="num">{visibleTrends.length}</b>
        </span>
        <span data-testid="levels-merged">
          مدمجة بصرياً: <b className="num">{visualMerged}</b> (خطوط أقرب من {MERGE_PX}px صارت خطاً واحداً) · نسخ متطابقة: <b className="num">{identicalCopies}</b>
        </span>
        <span data-testid="levels-nearby">
          متقاربة في العرض: <b className="num">{nearbyPairs}</b> (أقرب من {NEAR_PX}px)
        </span>
        <span data-testid="levels-short">
          خطوط قصيرة (≤ {SHORT_LINE_PX}px): <b className="num">{shortLines.length}</b>
        </span>
        <span data-testid="levels-deviation">
          أقصى انحراف لمسة عن الخط: <b className="num">{visibleLevels.length ? pct(maxDeviation) : '—'}</b>
        </span>
        <span>
          شموع: <b className="num">{(data?.bars ?? 0).toLocaleString('en-US')}</b> · مناطق المحرك: <b className="num">{zoneTotal.toLocaleString('en-US')}</b>
        </span>
        {data?.cached && <span style={{ color: 'var(--text-3)' }}>نتيجة مخزنة</span>}
        {loading && data && <span style={{ color: 'var(--accent)' }} data-testid="levels-refreshing">يُحدّث العمق...</span>}
      </div>

      {error && (
        <div className="rounded-lg px-3 py-2 text-[12px] flex items-center justify-between gap-2" style={{ background: 'var(--down-soft)', color: 'var(--down)' }}>
          <span>تعذّر تجهيز الشارت الإضافي: {error}</span>
          <button onClick={() => void load()} className="px-2 py-1 rounded-md font-bold" style={{ background: 'var(--surface-1)', color: 'var(--text-1)' }}>إعادة المحاولة</button>
        </div>
      )}

      {!error && !data && (
        <div className="rounded-lg py-14 text-center text-[12px]" style={{ color: 'var(--text-3)' }}>
          {loading ? 'يُجهّز الشموع والمناطق...' : 'لا بيانات بعد'}
          {loading && slow && (
            <div className="mt-2 text-[11px]" style={{ color: 'var(--text-2)' }}>
              الخادم يحسب هذه المدة أول مرة (لا نتيجة مخزنة بعد). قد يستغرق دقائق — يمكنك اختيار 90 يوماً فهي مخزنة الآن.
            </div>
          )}
        </div>
      )}

      {data && scale && y && shown && (
        <div className="rounded-lg overflow-hidden" style={{ border: '1px solid var(--border-1)' }}>
          <div className="flex flex-wrap items-center justify-between gap-2 px-2 py-1 text-[11px]" style={{ borderBottom: '1px solid var(--border-1)', color: 'var(--text-3)' }}>
            <span data-testid="levels-window">
              النافذة: <b className="num" style={{ color: 'var(--text-1)' }}>
                {shown.t1 - shown.t0 > 86400 ? fmtDay(shown.t0) : fmtDayClock(shown.t0)} → {shown.t1 - shown.t0 > 86400 ? fmtDay(shown.t1) : fmtDayClock(shown.t1)}
              </b>
              {' · '}السعر: <b className="num" style={{ color: 'var(--text-1)' }}>{fmtPrice(shown.lo)} — {fmtPrice(shown.hi)}</b>
              {' · '}تكبير: <b className="num" style={{ color: 'var(--text-1)' }}>×{zoomRatio.toFixed(2)}</b>
            </span>
            <span className="flex items-center gap-1">
              <button
                onClick={() => zoomBy(1 / ZOOM_STEP)}
                className="px-2 py-0.5 rounded-md font-bold"
                style={{ background: 'var(--surface-2, var(--surface-1))', border: '1px solid var(--border-1)', color: 'var(--text-1)' }}
                aria-label="تكبير"
                data-testid="levels-zoom-in"
              >+</button>
              <button
                onClick={() => zoomBy(ZOOM_STEP)}
                className="px-2 py-0.5 rounded-md font-bold"
                style={{ background: 'var(--surface-2, var(--surface-1))', border: '1px solid var(--border-1)', color: 'var(--text-1)' }}
                aria-label="تصغير"
                data-testid="levels-zoom-out"
              >−</button>
              <button
                onClick={() => { setView(BOUNDS); setSelectedId(null); }}
                disabled={fullView}
                className="px-2 py-0.5 rounded-md"
                style={{ background: 'var(--surface-2, var(--surface-1))', border: '1px solid var(--border-1)', color: fullView ? 'var(--text-3)' : 'var(--text-1)' }}
                data-testid="levels-reset"
              >إعادة ضبط</button>
            </span>
          </div>

          <div
            ref={boxRef}
            data-testid="levels-viewport"
            className="relative w-full select-none"
            style={{ aspectRatio: `${VIEW_W} / ${VIEW_H}`, background: 'var(--surface-0, transparent)', cursor: dragging ? 'grabbing' : 'crosshair', touchAction: 'none' }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            onPointerLeave={() => { setCursor(null); }}
            onDoubleClick={() => { setView(BOUNDS); setSelectedId(null); }}
          >
            {/* طبقة البيانات: تتكبّر عبر viewBox فقط */}
            <svg
              data-testid="levels-chart"
              viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
              preserveAspectRatio="xMidYMid meet"
              style={{
                position: 'absolute',
                left: `${(PAD.left / VIEW_W) * 100}%`,
                top: `${(PAD.top / VIEW_H) * 100}%`,
                width: `${(PLOT_W / VIEW_W) * 100}%`,
                height: `${(PLOT_H / VIEW_H) * 100}%`,
                background: 'var(--surface-0, transparent)'
              }}
              role="img"
              aria-label="شارت مستويات السيولة الدقيقة"
            >
              {candlePaths && (
                <g data-testid="levels-candles">
                  <path d={candlePaths.upWick} stroke={CANDLE_UP} strokeWidth={0.5} opacity={0.45} fill="none" vectorEffect="non-scaling-stroke" />
                  <path d={candlePaths.downWick} stroke={CANDLE_DOWN} strokeWidth={0.5} opacity={0.45} fill="none" vectorEffect="non-scaling-stroke" />
                  <path d={candlePaths.upBody} fill={CANDLE_UP} opacity={0.55} />
                  <path d={candlePaths.downBody} fill={CANDLE_DOWN} opacity={0.55} />
                </g>
              )}

              {visibleTrends.map((trend) => {
                const color = trend.side === 'ssl' ? SSL_COLOR : TREND_COLOR;
                const first = trend.points[0];
                const last = trend.points[trend.points.length - 1];
                return (
                  <g key={trend.id} data-testid="levels-trend">
                    <line
                      x1={scale.x(first.t)}
                      y1={y(first.p)}
                      x2={scale.x(last.t)}
                      y2={y(last.p)}
                      stroke={color}
                      strokeOpacity={0.8}
                      strokeWidth={1.2}
                      strokeDasharray="6 4"
                      vectorEffect="non-scaling-stroke"
                    />
                    {trend.points.map((point, i) => (
                      <circle key={`${trend.id}-${i}`} cx={scale.x(point.t)} cy={y(point.p)} r={1.8 / pxPerUnit} fill={color} fillOpacity={0.95} />
                    ))}
                    <title>{`خط اتجاه · ${trend.kind} · نقاط ${trend.points.length}${trend.state ? ` · ${trend.state}` : ''}`}</title>
                  </g>
                );
              })}

              {visibleLevels.map((level) => {
                const color = level.side === 'ssl' ? SSL_COLOR : BSL_COLOR;
                const swept = level.state === 'swept';
                const strength = Math.min(1, 0.45 + Math.max(0, level.touches - MIN_TOUCHES) * 0.11);
                const isActive = activeLevel != null && activeLevel.id === level.id;
                const dimmed = activeLevel != null && !isActive;
                const groupOpacity = dimmed ? 0.14 : 1;
                const yy = y(level.ref);
                const x0 = scale.x(level.touchTimes[0]);
                const x1 = scale.x(level.touchTimes[level.touchTimes.length - 1]);
                const widthUnits = Math.abs(x1 - x0);
                const short = widthUnits * pxPerUnit < SHORT_LINE_PX;
                const stopY = level.stop != null ? y(level.stop) : null;
                const collided = collidedIds.has(level.id);
                const strokeOpacity = (swept ? 0.55 : 0.95) * strength * groupOpacity + (dimmed ? 0.06 : 0);
                return (
                  <g key={level.id} data-testid="levels-line">
                    {short ? (
                      <circle cx={(x0 + x1) / 2} cy={yy} r={1.8 / pxPerUnit} fill={color} fillOpacity={Math.min(1, strokeOpacity)} />
                    ) : (
                      <line
                        x1={x0}
                        x2={x1}
                        y1={yy}
                        y2={yy}
                        stroke={color}
                        strokeWidth={isActive ? 1.8 : 1}
                        strokeOpacity={Math.min(1, strokeOpacity)}
                        strokeDasharray={swept ? '4 3' : undefined}
                        vectorEffect="non-scaling-stroke"
                      />
                    )}
                    {showTouches && level.touchTimes.map((t, i) => (
                      <circle
                        key={`${level.id}-t${i}`}
                        cx={scale.x(t)}
                        cy={y(level.touchPrices[i])}
                        r={1.5 / pxPerUnit}
                        fill={color}
                        fillOpacity={Math.min(1, 0.9 * strength * groupOpacity)}
                      />
                    ))}
                    {showStops && stopY != null && (
                      <g opacity={groupOpacity}>
                        <line
                          x1={x1}
                          x2={x1}
                          y1={yy}
                          y2={stopY}
                          stroke={STOP_COLOR}
                          strokeWidth={0.9}
                          strokeOpacity={0.5}
                          vectorEffect="non-scaling-stroke"
                        />
                        <line
                          x1={x1 - 3 / pxPerUnit}
                          x2={x1 + 3 / pxPerUnit}
                          y1={stopY}
                          y2={stopY}
                          stroke={STOP_COLOR}
                          strokeWidth={1.6}
                          strokeOpacity={0.95}
                          vectorEffect="non-scaling-stroke"
                        />
                        <circle
                          cx={x1}
                          cy={stopY}
                          r={(collided ? 2.6 : 1.9) / pxPerUnit}
                          fill={collided ? 'none' : STOP_COLOR}
                          fillOpacity={collided ? 0 : 0.95}
                          stroke={STOP_COLOR}
                          strokeWidth={collided ? 1.2 : 0.8}
                          strokeOpacity={0.95}
                          vectorEffect="non-scaling-stroke"
                        />
                      </g>
                    )}
                    <rect
                      x={Math.min(x0, x1) - 4 / pxPerUnit}
                      y={yy - 5 / pxPerUnit}
                      width={Math.max(8 / pxPerUnit, widthUnits + 8 / pxPerUnit)}
                      height={10 / pxPerUnit}
                      fill="transparent"
                      style={{ cursor: 'pointer' }}
                      onMouseEnter={() => setHoverId(level.id)}
                      onMouseLeave={() => setHoverId((current) => (current === level.id ? null : current))}
                      onClick={(e) => { e.stopPropagation(); setSelectedId((current) => (current === level.id ? null : level.id)); }}
                    />
                    <title>{levelNote(level)}</title>
                  </g>
                );
              })}

              {lastClose != null && (
                <line
                  x1={PAD.left}
                  x2={VIEW_W - PAD.right}
                  y1={y(lastClose)}
                  y2={y(lastClose)}
                  stroke="currentColor"
                  strokeOpacity={0.35}
                  strokeWidth={0.8}
                  strokeDasharray="2 4"
                  vectorEffect="non-scaling-stroke"
                />
              )}
            </svg>

            {/* طبقة المحاور والـcrosshair: ثابتة، تُحسب من النافذة الحالية */}
            <svg
              viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
              preserveAspectRatio="none"
              className="absolute inset-0 w-full h-full pointer-events-none"
              data-testid="levels-overlay"
              style={{ color: 'var(--text-2)' }}
            >
              {gridPrices.map((price) => {
                const yy = axisY(price);
                return (
                  <g key={`gp${price}`}>
                    <line x1={PAD.left} x2={VIEW_W - PAD.right} y1={yy} y2={yy} stroke="currentColor" strokeOpacity={0.1} strokeWidth={1} vectorEffect="non-scaling-stroke" />
                    <text x={VIEW_W - PAD.right + 5} y={yy + 3} fontSize={9} fill="currentColor" fillOpacity={0.7} style={NUM_TEXT}>{fmtPrice(price)}</text>
                  </g>
                );
              })}
              {gridTimes.map((t) => {
                const xx = axisX(t);
                const span = shown.t1 - shown.t0;
                const label = span <= 6 * 3600 ? fmtClock(t) : span <= 86400 ? fmtDayClock(t) : fmtDay(t);
                return (
                  <g key={`gt${t}`}>
                    <line x1={xx} x2={xx} y1={PAD.top} y2={VIEW_H - PAD.bottom} stroke="currentColor" strokeOpacity={0.08} strokeWidth={1} vectorEffect="non-scaling-stroke" />
                    <text x={xx} y={VIEW_H - PAD.bottom + 12} fontSize={9} textAnchor="middle" fill="currentColor" fillOpacity={0.7} style={NUM_TEXT}>{label}</text>
                  </g>
                );
              })}

              {lastClose != null && !cursor && (
                <text
                  x={VIEW_W - PAD.right + 5}
                  y={axisY(lastClose) + 3}
                  fontSize={9}
                  fill="currentColor"
                  fillOpacity={0.85}
                >آخر {fmtPrice(lastClose)}</text>
              )}

              {cursor && (() => {
                const timeLabel = shown.t1 - shown.t0 <= 86400 ? fmtClock(cursor.t) : fmtDayClock(cursor.t);
                const bubbleW = Math.max(52, timeLabel.length * 5.6 + 10);
                const bubbleX = Math.min(VIEW_W - PAD.right - bubbleW - 2, Math.max(PAD.left + 2, cursor.fx - bubbleW / 2));
                return (
                  <g data-testid="levels-crosshair">
                    <line x1={cursor.fx} x2={cursor.fx} y1={PAD.top} y2={VIEW_H - PAD.bottom} stroke="currentColor" strokeOpacity={0.45} strokeWidth={1} strokeDasharray="3 3" />
                    <line x1={PAD.left} x2={VIEW_W - PAD.right} y1={cursor.fy} y2={cursor.fy} stroke="currentColor" strokeOpacity={0.45} strokeWidth={1} strokeDasharray="3 3" />
                    <rect x={VIEW_W - PAD.right + 1} y={cursor.fy - 7} width={PAD.right - 4} height={14} rx={2} fill="var(--surface-1, #111827)" fillOpacity={0.95} />
                    <text x={VIEW_W - PAD.right + 4} y={cursor.fy + 3} fontSize={9} fill="currentColor" fillOpacity={0.95} style={NUM_TEXT}>{fmtPrice(cursor.p)}</text>
                    <rect x={bubbleX} y={VIEW_H - PAD.bottom + 2} width={bubbleW} height={13} rx={2} fill="var(--surface-1, #111827)" fillOpacity={0.95} />
                    <text x={bubbleX + bubbleW / 2} y={VIEW_H - PAD.bottom + 11.5} fontSize={9} textAnchor="middle" fill="currentColor" fillOpacity={0.95} style={NUM_TEXT}>
                      {timeLabel}
                    </text>
                  </g>
                );
              })()}
            </svg>

            {cursor && (
              <div
                className="absolute pointer-events-none rounded-md px-2 py-1 text-[10px] num"
                style={{
                  left: `${(cursor.fx / VIEW_W) * 100}%`,
                  top: `${(cursor.fy / VIEW_H) * 100}%`,
                  transform: `translate(${cursor.fx > VIEW_W * 0.62 ? 'calc(-100% - 8px)' : '8px'}, -50%)`,
                  background: 'var(--surface-1, #111827)',
                  border: '1px solid var(--border-1, #1f2937)',
                  color: 'var(--text-1, #e5e7eb)',
                  whiteSpace: 'nowrap'
                }}
                data-testid="levels-cursor-readout"
              >
                {fmtPrice(cursor.p)} · {shown.t1 - shown.t0 <= 86400 ? fmtClock(cursor.t) : fmtDayClock(cursor.t)}
              </div>
            )}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 px-2 py-1 text-[11px]" style={{ color: 'var(--text-3)' }}>
            <span>{activeLevel ? levelNote(activeLevel) : 'مرّر أو انقر أي خط لعرض أرقام المحرك له (السعر، الوقف، ATR، اللمسات، الانحراف)'}</span>
            <span>متقطع = مخترق · حلقة مفتوحة = وقف يتقاطع مع خط آخر</span>
          </div>
        </div>
      )}

      {activeLevel && (
        <div className="rounded-lg p-2 text-[11px] space-y-1" style={{ background: 'var(--surface-2, var(--surface-1))', border: '1px solid var(--border-1)' }} data-testid="levels-detail">
          <div className="flex flex-wrap gap-x-3 gap-y-1 num" style={{ color: 'var(--text-1)' }}>
            <b>{activeLevel.side.toUpperCase()} · {activeLevel.state}</b>
            <span>السعر {fmtPrice(activeLevel.ref)}</span>
            <span>الوقف {activeLevel.stop != null ? fmtPrice(activeLevel.stop) : '—'}</span>
            <span>ATR {activeLevel.atr != null ? fmtPrice(activeLevel.atr) : '—'}</span>
            <span>لمسات {activeLevel.touches}</span>
            <span>ثقة {activeLevel.confidence != null ? activeLevel.confidence.toFixed(3) : '—'}</span>
            <span>مناطق مدمجة {activeLevel.mergedCount}</span>
            <span>انحراف أقصى {pct(levelDeviation(activeLevel))}</span>
          </div>
          <div className="num" style={{ color: 'var(--text-2)' }}>
            أول لمسة {fmtDayClock(activeLevel.touchTimes[0])} · آخر لمسة {fmtDayClock(activeLevel.touchTimes[activeLevel.touchTimes.length - 1])}
          </div>
          <div className="num" style={{ color: 'var(--text-2)' }}>
            أسعار اللمسات: {activeLevel.touchPrices.slice(0, 8).map((p) => fmtPrice(p)).join(' · ')}
            {activeLevel.touchPrices.length > 8 ? ` … (+${activeLevel.touchPrices.length - 8})` : ''}
          </div>
          <div style={{ color: 'var(--text-3)' }}>معرّف المحرك: {activeLevel.id}</div>
        </div>
      )}

      {data && !scale && !error && (
        <div className="rounded-lg py-8 text-center text-[12px]" style={{ color: 'var(--text-3)' }} data-testid="levels-no-scale">
          تعذّر بناء مقياس الرسم: الشموع غير كافية أو الأسعار غير صالحة.
        </div>
      )}

      {data && scale && !visibleLevels.length && !visibleTrends.length && (
        <div className="rounded-lg py-8 text-center text-[12px]" style={{ color: 'var(--text-3)' }}>
          لا مستويات مطابقة في هذا النطاق (أو كلها مخفية بالمفاتيح أعلاه)
        </div>
      )}

      {showTrend && data && trends.length === 0 && (
        <div className="text-[11px]" style={{ color: 'var(--text-3)' }} data-testid="levels-trend-gap">
          خطوط الاتجاه: المحرك لم يُنتج أي خط في هذه المدة (يشترط ثلاث نقاط على خط واحد بخطأ محدود). الشارت لا يرسم خطاً من عنده.
        </div>
      )}
    </section>
  );
}

function Toggle({ on, onClick, label, color }: { on: boolean; onClick: () => void; label: string; color: string }) {
  return (
    <button
      onClick={onClick}
      aria-pressed={on}
      className="px-2 py-1 rounded-md inline-flex items-center gap-1"
      style={{
        background: on ? 'var(--surface-2, var(--surface-1))' : 'transparent',
        border: `1px solid ${on ? color : 'var(--border-1)'}`,
        color: on ? 'var(--text-1)' : 'var(--text-3)'
      }}
    >
      <span style={{ width: 6, height: 6, borderRadius: 3, background: color, opacity: on ? 1 : 0.35 }} />
      {label}
    </button>
  );
}