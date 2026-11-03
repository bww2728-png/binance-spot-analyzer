import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchLiquidityHistory, type LiquidityHistoryResponse } from '../lib/liquidityHistory';
import {
  aggregateCandles,
  buildLevels,
  buildTrends,
  makeScale,
  makeY,
  MIN_TOUCHES,
  MIN_TREND_POINTS
} from '../lib/liquidityLevels';
/**
 * شارت تاريخي إضافي (مستقل) لمستويات السيولة الدقيقة.
 *
 * الاستقلال مقصود: لا يقرأ `buildElements` ولا حالة أي شارت آخر ولا يكتب شيئاً.
 * يقرأ نفس الحمولة المخزّنة (`/api/liquidity-history`، محرك legacy) ويعرض منها
 * **الحقول الخام** فقط، بمنطق اختيار واختبار في `lib/liquidityLevels.ts`:
 *  - `referenceLevel` = السعر الذي تكرر عنده السعر (وسيط اللمسات) → خط أفقي 1px.
 *  - `liquidityLevel` = منطقة وقف الخسارة (أعلى لمسة + 2×ATR للـBSL، وأدنى لمسة
 *    − 2×ATR للـSSL) → نقطة صريحة + وصلة متقطعة من آخر لمسة.
 *  - `trendline.points` = خط اتجاه من ثلاث نقاط أو أكثر.
 *
 * قواعد العرض المتفق عليها:
 *  - العمق الافتراضي 30 يوماً، والتحديد يغطي الشارت من أوله إلى آخره (بلا قصّ لآخر شمعة).
 *  - الخط الأفقي يبدأ عند أول لمسة وينتهي عند آخر لمسة (لا يمرّ على فراغ).
 *  - لا نطاقات عريضة: خط 1px + نقطة وقف + خط اتجاه.
 */

const VIEW_W = 1200;
const VIEW_H = 520;
const PAD = { top: 18, right: 78, bottom: 30, left: 14 };
const PLOT_W = VIEW_W - PAD.left - PAD.right;

const CANDLE_UP = '#22c55e';
const CANDLE_DOWN = '#ef4444';
const BSL_COLOR = '#fb923c';
const SSL_COLOR = '#38bdf8';
const TREND_COLOR = '#a855f7';
const STOP_COLOR = '#facc15';

const fmtPrice = (v: number) => v.toLocaleString('en-US', { maximumFractionDigits: v >= 100 ? 2 : 6 });
const fmtDate = (sec: number) => new Date(sec * 1000).toLocaleDateString('ar', { day: '2-digit', month: '2-digit' });
const pct = (v: number) => `${(v * 100).toFixed(3)}%`;

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
  const [hover, setHover] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

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

  const levels = useMemo(
    () => (scale ? buildLevels(data?.zones, { t0: scale.t0, t1: scale.t1, minTouches }) : []),
    [data, scale, minTouches]
  );
  const trends = useMemo(
    () => (scale ? buildTrends(data?.zones, { t0: scale.t0, t1: scale.t1 }) : []),
    [data, scale]
  );

  const visibleLevels = useMemo(
    () => levels.filter((l) => (l.side === 'bsl' ? showBsl : showSsl)),
    [levels, showBsl, showSsl]
  );
  const visibleTrends = showTrend ? trends : [];
  const stopCount = showStops ? visibleLevels.filter((l) => l.stop != null).length : 0;
  const mergedAway = visibleLevels.reduce((sum, l) => sum + (l.mergedCount - 1), 0);

  /** أقصى انحراف بين سعر اللمسة والخط — دليل رقمي على أن الخط يقع حيث تكرر السعر */
  const maxDeviation = useMemo(() => {
    let max = 0;
    for (const level of visibleLevels) {
      for (const price of level.touchPrices) {
        const dev = Math.abs(price - level.ref) / level.ref;
        if (dev > max) max = dev;
      }
    }
    return max;
  }, [visibleLevels]);

  const priceTicks = useMemo(() => {
    if (!scale || !y) return [];
    return [0, 0.25, 0.5, 0.75, 1].map((f) => {
      const p = scale.hi - (scale.hi - scale.lo) * f;
      return { p, yy: y(p) };
    });
  }, [scale, y]);

  const timeTicks = useMemo(() => {
    if (!scale) return [];
    return [0, 0.25, 0.5, 0.75, 1].map((f) => {
      const t = scale.t0 + (scale.t1 - scale.t0) * f;
      return { t, xx: scale.x(t) };
    });
  }, [scale]);

  const candlePaths = useMemo(() => {
    if (!scale || !y || !bars.length) return null;
    const stepW = PLOT_W / Math.max(1, bars.length);
    const bodyW = Math.max(1, stepW * 0.62);
    const upWick: string[] = [];
    const downWick: string[] = [];
    const upBody: string[] = [];
    const downBody: string[] = [];
    for (const bar of bars) {
      const x = scale.x(bar.t);
      const isUp = bar.c >= bar.o;
      const wick = `M${x.toFixed(1)} ${y(bar.h).toFixed(1)}L${x.toFixed(1)} ${y(bar.l).toFixed(1)}`;
      (isUp ? upWick : downWick).push(wick);
      const yTop = y(Math.max(bar.o, bar.c));
      const yBot = y(Math.min(bar.o, bar.c));
      const bodyH = Math.max(0.6, yBot - yTop);
      const left = x - bodyW / 2;
      (isUp ? upBody : downBody).push(`M${left.toFixed(1)} ${yTop.toFixed(1)}h${bodyW.toFixed(1)}v${bodyH.toFixed(1)}h${(-bodyW).toFixed(1)}z`);
    }
    return {
      upWick: upWick.join(''),
      downWick: downWick.join(''),
      upBody: upBody.join(''),
      downBody: downBody.join('')
    };
  }, [bars, scale, y]);

  const levelNote = (level: (typeof levels)[number]) => [
    level.kind,
    `المستوى ${fmtPrice(level.ref)}`,
    level.stop != null ? `الوقف ${fmtPrice(level.stop)}` : 'الوقف —',
    level.atr != null ? `ATR ${fmtPrice(level.atr)}` : '',
    `لمسات ${level.touches}`,
    level.mergedCount > 1 ? `مدمجة ${level.mergedCount}` : '',
    level.state === 'confirmed' ? 'مؤكدة' : level.state === 'swept' ? 'مخترقة' : 'مرشحة'
  ].filter(Boolean).join(' · ');

  const zoneTotal = data?.totalZones ?? data?.zones?.length ?? 0;

  return (
    <section className="rounded-xl p-3 space-y-2" style={{ background: 'var(--surface-1)' }} data-testid="levels-section">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-[13px] font-bold" style={{ color: 'var(--text-1)' }}>الشارت التاريخي الإضافي — مستويات السيولة الدقيقة</h3>
          <p className="text-[11px] mt-0.5" style={{ color: 'var(--text-3)' }}>
            خط 1px على السعر المتكرر (لمسات ≥ {MIN_TOUCHES}) · نقطة الوقف عند السيولة (أعلى/أدنى لمسة ± 2×ATR) · خط اتجاه من {MIN_TREND_POINTS} نقاط أو أكثر · مستقل تماماً
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
            {loading ? 'يُجهّز…' : 'تحديث'}
          </button>
        </div>
      </div>

      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px]" style={{ color: 'var(--text-2)' }}>
        <span data-testid="levels-stats">
          مستويات: <b className="num">{visibleLevels.length}</b> · نقاط وقف: <b className="num">{stopCount}</b> · خطوط اتجاه: <b className="num">{visibleTrends.length}</b>
        </span>
        <span data-testid="levels-merged">
          نسخ مدمجة: <b className="num">{mergedAway}</b> (نفس السعر خلال 0.02%)
        </span>
        <span style={{ color: 'var(--text-3)' }}>متقطع = مخترق (swept) · متصل = قائم</span>
        <span>
          شموع: <b className="num">{(data?.bars ?? 0).toLocaleString('en-US')}</b> · مناطق المحرك: <b className="num">{zoneTotal.toLocaleString('en-US')}</b>
        </span>
        <span data-testid="levels-deviation">
          أقصى انحراف لمسة عن الخط: <b className="num">{visibleLevels.length ? pct(maxDeviation) : '—'}</b>
        </span>
        <span>
          النطاق: <b className="num">{data && candles.length ? `${fmtDate(data.from ?? candles[0][0])} → ${fmtDate(data.to ?? candles[candles.length - 1][0])}` : '—'}</b>
        </span>
        {data?.cached && <span style={{ color: 'var(--text-3)' }}>نتيجة مخزنة</span>}
        {loading && data && <span style={{ color: 'var(--accent)' }} data-testid="levels-refreshing">يُحدّث العمق…</span>}
      </div>

      {error && (
        <div className="rounded-lg px-3 py-2 text-[12px] flex items-center justify-between gap-2" style={{ background: 'var(--down-soft)', color: 'var(--down)' }}>
          <span>تعذّر تجهيز الشارت الإضافي: {error}</span>
          <button onClick={() => void load()} className="px-2 py-1 rounded-md font-bold" style={{ background: 'var(--surface-1)', color: 'var(--text-1)' }}>إعادة المحاولة</button>
        </div>
      )}

      {!error && !data && (
        <div className="rounded-lg py-14 text-center text-[12px]" style={{ color: 'var(--text-3)' }}>
          {loading ? 'يُجهّز الشموع والمناطق…' : 'لا بيانات بعد'}
          {loading && slow && (
            <div className="mt-2 text-[11px]" style={{ color: 'var(--text-2)' }}>
              الخادم يحسب هذه المدة أول مرة (لا نتيجة مخزنة بعد). قد يستغرق دقائق — يمكنك اختيار 90 يوماً فهي مخزنة الآن.
            </div>
          )}
        </div>
      )}

      {data && scale && y && (
        <div className="rounded-lg overflow-hidden" style={{ border: '1px solid var(--border-1)' }}>
          <svg viewBox={`0 0 ${VIEW_W} ${VIEW_H}`} className="w-full h-auto block" style={{ background: 'var(--surface-0, transparent)' }} role="img" aria-label="شارت مستويات السيولة الدقيقة" data-testid="levels-chart">
            {priceTicks.map((tick) => (
              <g key={`p${tick.p}`}>
                <line x1={PAD.left} x2={VIEW_W - PAD.right} y1={tick.yy} y2={tick.yy} stroke="currentColor" strokeOpacity={0.08} strokeWidth={1} />
                <text x={VIEW_W - PAD.right + 4} y={tick.yy + 3} fontSize={9} fill="currentColor" fillOpacity={0.55}>{fmtPrice(tick.p)}</text>
              </g>
            ))}
            {timeTicks.map((tick) => (
              <g key={`t${tick.t}`}>
                <line x1={tick.xx} x2={tick.xx} y1={PAD.top} y2={VIEW_H - PAD.bottom} stroke="currentColor" strokeOpacity={0.06} strokeWidth={1} />
                <text x={tick.xx} y={VIEW_H - PAD.bottom + 12} fontSize={9} textAnchor="middle" fill="currentColor" fillOpacity={0.55}>{fmtDate(tick.t)}</text>
              </g>
            ))}

            {candlePaths && (
              <g data-testid="levels-candles">
                <path d={candlePaths.upWick} stroke={CANDLE_UP} strokeWidth={0.5} opacity={0.45} fill="none" />
                <path d={candlePaths.downWick} stroke={CANDLE_DOWN} strokeWidth={0.5} opacity={0.45} fill="none" />
                <path d={candlePaths.upBody} fill={CANDLE_UP} opacity={0.55} />
                <path d={candlePaths.downBody} fill={CANDLE_DOWN} opacity={0.55} />
              </g>
            )}

            {visibleTrends.map((trend) => {
              const color = trend.side === 'ssl' ? SSL_COLOR : BSL_COLOR;
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
                    strokeOpacity={0.75}
                    strokeWidth={1}
                    strokeDasharray="6 4"
                  />
                  {trend.points.map((point, i) => (
                    <circle key={`${trend.id}-${i}`} cx={scale.x(point.t)} cy={y(point.p)} r={1.8} fill={color} fillOpacity={0.9} />
                  ))}
                  <title>{`خط اتجاه · ${trend.kind} · نقاط ${trend.points.length}${trend.state ? ` · ${trend.state}` : ''}`}</title>
                </g>
              );
            })}

            {visibleLevels.map((level) => {
              const color = level.side === 'ssl' ? SSL_COLOR : BSL_COLOR;
              const swept = level.state === 'swept';
              const strength = Math.min(1, 0.45 + Math.max(0, level.touches - MIN_TOUCHES) * 0.11);
              const yy = y(level.ref);
              const x0 = scale.x(level.touchTimes[0]);
              const x1 = scale.x(level.touchTimes[level.touchTimes.length - 1]);
              const yStop = level.stop != null ? y(level.stop) : null;
              return (
                <g key={level.id} data-testid="levels-line">
                  <line
                    x1={x0}
                    x2={x1}
                    y1={yy}
                    y2={yy}
                    stroke={color}
                    strokeWidth={1}
                    strokeOpacity={(swept ? 0.5 : 0.95) * strength}
                    strokeDasharray={swept ? '4 3' : undefined}
                  />
                  {showTouches && level.touchTimes.map((t, i) => (
                    <circle key={`${level.id}-t${i}`} cx={scale.x(t)} cy={y(level.touchPrices[i])} r={1.2} fill={color} fillOpacity={0.9 * strength} />
                  ))}
                  {showStops && yStop != null && (
                    <>
                      <line x1={x1} x2={x1} y1={yy} y2={yStop} stroke={STOP_COLOR} strokeWidth={0.8} strokeOpacity={0.55 * strength} strokeDasharray="2 2" />
                      <circle cx={x1} cy={yStop} r={2.6} fill={STOP_COLOR} fillOpacity={0.95} stroke="var(--surface-1, #000)" strokeWidth={0.8} />
                    </>
                  )}
                  <rect
                    x={Math.min(x0, x1) - 3}
                    y={yy - 4}
                    width={Math.max(6, Math.abs(x1 - x0) + 6)}
                    height={8}
                    fill="transparent"
                    onMouseEnter={() => setHover(levelNote(level))}
                    onMouseLeave={() => setHover(null)}
                  />
                  <title>{levelNote(level)}</title>
                </g>
              );
            })}

            {lastClose != null && (
              <g>
                <line x1={PAD.left} x2={VIEW_W - PAD.right} y1={y(lastClose)} y2={y(lastClose)} stroke="currentColor" strokeOpacity={0.35} strokeWidth={0.8} strokeDasharray="2 4" />
                <text x={PAD.left + 2} y={y(lastClose) - 3} fontSize={9} fill="currentColor" fillOpacity={0.6}>آخر سعر {fmtPrice(lastClose)}</text>
              </g>
            )}
          </svg>
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

      <div className="flex flex-wrap items-center justify-between gap-2 text-[11px]" style={{ color: 'var(--text-3)' }}>
        <span>{hover ? <b style={{ color: 'var(--text-1)' }}>{hover}</b> : 'مرّر على أي خط لعرض السعر والوقف واللمسات والحالة'}</span>
        <span>الخط من أول لمسة إلى آخرها · النقاط الصغيرة = أسعار اللمسات الفعلية · لا نطاقات عريضة</span>      </div>
    </section>
  );
}

function Toggle({ on, onClick, label, color }: { on: boolean; onClick: () => void; label: string; color: string }) {
  return (
    <button
      onClick={onClick}
      className="px-2 py-1 rounded-md flex items-center gap-1"
      style={{
        background: on ? 'var(--surface-2, rgba(255,255,255,0.06))' : 'transparent',
        border: `1px solid ${on ? color : 'var(--border-1)'}`,
        color: on ? 'var(--text-1)' : 'var(--text-3)'
      }}
      aria-pressed={on}
    >
      <span style={{ width: 8, height: 8, borderRadius: 999, background: on ? color : 'transparent', border: `1px solid ${color}`, display: 'inline-block' }} />
      {label}
    </button>
  );
}
