import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  buildElements,
  defaultFilters,
  filterOptions,
  hiddenTotal,
  mergeFilters,
  selectElements,
  stepIndex,
  type HistoryFilters
} from '../../../shared/historyModel.mjs';
import { fetchLiquidityHistory, type LiquidityHistoryResponse } from '../lib/liquidityHistory';
import HistoryChartView, { type CandleRow } from './history/HistoryChartView';
import HistoryFiltersPanel from './history/HistoryFiltersPanel';
import HistoryDetailPanel from './history/HistoryDetailPanel';

/**
 * الشارت التاريخي (1m) — منظومة عرض وتتبع لمخرجات محرك واحد فقط.
 *
 * - engine='legacy' ⇒ نتائج `detectLiquidityZones` وحدها.
 * - engine='v2'     ⇒ نتائج `detectLiquidityZonesV2` وحدها (+ أحداث البنية وFVG).
 * لا يُنقل نوع أو حدث أو خاصية بين المحركين، ولا يُعاد أي حساب كشف هنا.
 *
 * التتبع حتمي: المؤشر فهرس شمعة، والعرض دالة نقية من (البيانات، الفلاتر، المؤشر)
 * بلا أي اعتماد على ساعة الجهاز.
 */

const FILTERS_STORAGE = (engine: string) => `liquidityHistory:filters:v2:${engine}`;

function loadFilters(engine: string): HistoryFilters {
  try {
    const raw = localStorage.getItem(FILTERS_STORAGE(engine));
    if (!raw) return defaultFilters();
    return mergeFilters(JSON.parse(raw));
  } catch {
    return defaultFilters();
  }
}

const fmtDateTime = (sec: number | null) => (sec == null ? '—' : new Date(sec * 1000).toLocaleString('ar', { dateStyle: 'short', timeStyle: 'short' }));

export default function LiquidityHistorySection({ engine, symbol }: { engine: 'legacy' | 'v2'; symbol: string }) {
  const [open, setOpen] = useState(true);
  const [days, setDays] = useState(engine === 'v2' ? 14 : 90);
  const [data, setData] = useState<LiquidityHistoryResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [fullscreen, setFullscreen] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [filters, setFilters] = useState<HistoryFilters>(() => loadFilters(engine));
  const [cursorIndex, setCursorIndex] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(4);
  const [stepBars, setStepBars] = useState(1);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [stats, setStats] = useState({ drawn: 0, culled: 0, labelSkips: 0 });
  const wrapRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(async (depthDays = days) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    setError('');
    try {
      const result = await fetchLiquidityHistory({ symbol, engine, days: depthDays, signal: controller.signal });
      setData(result);
      setCursorIndex(null);
      setSelectedId(null);
      setPlaying(false);
    } catch (e) {
      if (!controller.signal.aborted) setError(String((e as Error)?.message ?? e));
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [symbol, engine, days]);

  useEffect(() => {
    if (open && !data && !loading) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // مفتاح الهوية: يمنع بقاء رسم/شموع من رمز أو عمق سابق
  const dataKey = data ? `${data.symbol}|${data.engineKey}|${data.days}|${data.from}|${data.to}` : '';

  // فلترة محفوظة لكل واجهة على حدة — لا تتسرّب من القديم إلى الجديد
  useEffect(() => {
    try { localStorage.setItem(FILTERS_STORAGE(engine), JSON.stringify(filters)); } catch { /* التخزين اختياري */ }
  }, [filters, engine]);

  useEffect(() => {
    const onFsChange = () => setFullscreen(document.fullscreenElement === wrapRef.current);
    document.addEventListener('fullscreenchange', onFsChange);
    return () => document.removeEventListener('fullscreenchange', onFsChange);
  }, []);

  const toggleFullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void wrapRef.current?.requestFullscreen();
  };

  const candles = useMemo<CandleRow[]>(() => (data?.candles ?? []).map(([time, open, high, low, close, volume]) => ({
    time, open, high, low, close, volume
  })), [data]);

  const built = useMemo(() => buildElements({
    engine,
    zones: (data?.zones ?? []) as unknown[],
    structureEvents: (data?.structureEvents ?? []) as unknown[]
  }), [data, engine]);

  const lastIndex = Math.max(0, candles.length - 1);
  const cursor = cursorIndex == null ? lastIndex : Math.max(0, Math.min(lastIndex, cursorIndex));
  const replay = candles.length > 0 && cursor < lastIndex;
  const rows = useMemo(() => (replay ? candles.slice(0, cursor + 1) : candles), [candles, cursor, replay]);
  const cursorTime = rows.length ? rows[rows.length - 1].time : 0;
  const cursorPrice = rows.length ? rows[rows.length - 1].close : null;

  // ATR مرجعي للفلتر: وسيط ATR المعلن من المحرك (بلا اشتقاق جديد)
  const atrRef = useMemo(() => {
    const list = built.elements.map((e) => e.atr).filter((v): v is number => v != null && v > 0).sort((a, b) => a - b);
    return list.length ? list[Math.floor(list.length / 2)] : null;
  }, [built.elements]);

  const selection = useMemo(() => selectElements(built.elements, {
    filters,
    cursorTime,
    replay,
    cursorPrice,
    atrRef
  }), [built.elements, filters, cursorTime, replay, cursorPrice, atrRef]);

  const options = useMemo(() => filterOptions(built.elements), [built.elements]);

  // ---- التشغيل: تقدّم حتمي بخطوة ثابتة، ولا يلمس أي قرار أو محرك
  useEffect(() => {
    if (!playing || !candles.length) return;
    const id = setInterval(() => {
      setCursorIndex((i) => {
        const from = i == null ? lastIndex : i;
        return stepIndex(from, stepBars, candles.length);
      });
    }, Math.max(60, Math.round(1000 / speed)));
    return () => clearInterval(id);
  }, [playing, speed, stepBars, candles.length, lastIndex]);

  useEffect(() => {
    if (playing && cursor >= lastIndex) setPlaying(false);
  }, [playing, cursor, lastIndex]);

  const jumpTo = useCallback((time: number) => {
    if (!candles.length) return;
    // بحث ثنائي على زمن الشموع (مرتّب تصاعدياً) — لا افتراض على ترتيب المصفوفة
    let lo = 0;
    let hi = candles.length - 1;
    if (time <= candles[0].time) { setCursorIndex(0); setPlaying(false); return; }
    if (time >= candles[hi].time) { setCursorIndex(null); setPlaying(false); return; }
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (candles[mid].time === time) { setCursorIndex(mid); setPlaying(false); return; }
      if (candles[mid].time < time) lo = mid + 1;
      else hi = mid - 1;
    }
    setCursorIndex(Math.max(0, Math.min(candles.length - 1, lo)));
    setPlaying(false);
  }, [candles]);

  const selected = useMemo(
    () => built.elements.find((e) => e.id === selectedId) ?? null,
    [built.elements, selectedId]
  );

  const lastCandleLabel = data?.candles.length ? fmtDateTime(data.candles[data.candles.length - 1][0]) : '';
  const hidden = hiddenTotal(selection.counts);

  const onStats = useCallback((next: { drawn: number; culled: number; labelSkips: number }) => {
    setStats((prev) => (prev.drawn === next.drawn && prev.culled === next.culled && prev.labelSkips === next.labelSkips ? prev : next));
  }, []);

  return (
    <section className="rounded-xl p-3 sm:p-4 space-y-3" style={{ background: 'var(--surface-1)', border: '1px solid var(--border-1)' }}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="text-[13px] font-bold" style={{ color: 'var(--text-1)' }}>
            الشارت التاريخي — محرك {engine === 'legacy' ? 'القديم (legacy) وحده' : 'v2 وحده'} · 1m {symbol ? `· ${symbol}` : ''}
          </div>
          <div className="text-[11px] mt-0.5" style={{ color: 'var(--text-3)' }}>
            يعرض مخرجات هذا المحرك فقط: {engine === 'legacy'
              ? 'BSL/SSL أفقي وخطوط اتجاه من نقاط لمس حقيقية. لا أحداث بنية ولا FVG ولا عرض/طلب (لا ينتجها هذا المحرك).'
              : 'BSL/SSL وخطوط اتجاه وعرض/طلب وأحداث IDM/BOS/CHoCH وفجوات FVG.'}
            {' '}التتبع شمعة بشمعة يعرض كل عنصر عند لحظة معرفته الحقيقية فقط.
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={days}
            onChange={(e) => { const v = Number(e.target.value); setDays(v); if (open) void load(v); }}
            className="px-2.5 py-1.5 rounded-lg text-[12px]"
            style={{ background: 'var(--surface-0)', border: '1px solid var(--border-1)', color: 'var(--text-1)' }}
            title="عمق التاريخ بالأيام"
          >
            {(engine === 'v2' ? [7, 14] : [30, 60, 90, 120]).map((d) => <option key={d} value={d}>{d} يوماً</option>)}
          </select>
          <button
            onClick={() => setOpen((o) => !o)}
            className="px-3 py-2 rounded-lg text-[12px] font-semibold"
            style={{ background: open ? 'var(--surface-0)' : 'var(--accent-soft)', color: open ? 'var(--text-2)' : 'var(--accent)', border: '1px solid var(--border-1)' }}
          >
            {open ? 'إخفاء الشارت' : 'إظهار الشارت التاريخي'}
          </button>
          <button
            onClick={() => void load()}
            disabled={loading}
            className="px-3 py-2 rounded-lg text-[12px] font-semibold"
            style={{ background: 'var(--accent)', color: '#fff', opacity: loading ? 0.6 : 1 }}
          >
            {loading ? 'يجهّز…' : 'تحديث'}
          </button>
          {data && (
            <button
              onClick={toggleFullscreen}
              className="px-3 py-2 rounded-lg text-[12px] font-semibold"
              style={{ background: 'var(--surface-0)', color: 'var(--text-2)', border: '1px solid var(--border-1)' }}
            >
              {fullscreen ? 'إنهاء ملء الشاشة' : 'ملء الشاشة'}
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="rounded-lg px-3 py-2 text-[12px] flex items-center justify-between gap-2" style={{ background: 'var(--down-soft)', color: 'var(--down)' }}>
          <span>{error}</span>
          <button onClick={() => void load()} className="px-2 py-1 rounded" style={{ background: 'var(--surface-0)', color: 'var(--text-1)' }}>إعادة المحاولة</button>
        </div>
      )}
      {loading && (
        <div className="rounded-lg px-3 py-3 text-[12px]" style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}>
          جارٍ تجهيز الشارت التاريخي: جلب شموع الدقيقة من Binance دفعةً بعد دفعة ثم حساب مناطق المحرك على خيط منفصل — أول حساب يستغرق {engine === 'v2' ? 'دقائق معدودة' : 'دقائق'} ثم تُخزَّن النتيجة على الخادم.
        </div>
      )}

      <div ref={wrapRef} style={fullscreen ? { background: 'var(--surface-0)', padding: 8 } : undefined}>
        {open && data && candles.length > 0 && (
          <div className="space-y-2">
            {/* أدوات التتبع */}
            <div className="rounded-xl px-2.5 py-2 flex flex-wrap items-center gap-2 text-[11px]" style={{ background: 'var(--surface-0)', border: '1px solid var(--border-1)' }}>
              <button
                onClick={() => { setCursorIndex(0); setPlaying(false); }}
                className="px-2 py-1 rounded-lg font-semibold"
                style={{ background: 'var(--surface-1)', color: 'var(--text-2)', border: '1px solid var(--border-1)' }}
                title="العودة إلى بداية الفترة"
              >⏮ البداية</button>
              <button
                onClick={() => { setPlaying(false); setCursorIndex(stepIndex(cursor, -stepBars, candles.length)); }}
                className="px-2 py-1 rounded-lg font-semibold"
                style={{ background: 'var(--surface-1)', color: 'var(--text-2)', border: '1px solid var(--border-1)' }}
                title="خطوة للخلف"
              >◀ {stepBars > 1 ? stepBars : 'شمعة'}</button>
              <button
                onClick={() => {
                  if (playing) { setPlaying(false); return; }
                  if (cursor >= lastIndex) setCursorIndex(Math.max(0, lastIndex - Math.max(60, stepBars)));
                  setPlaying(true);
                }}
                className="px-3 py-1 rounded-lg font-bold"
                style={{ background: playing ? 'var(--down-soft)' : 'var(--accent)', color: playing ? 'var(--down)' : '#fff' }}
              >{playing ? '⏸ إيقاف مؤقت' : '▶ تشغيل'}</button>
              <button
                onClick={() => { setPlaying(false); setCursorIndex(stepIndex(cursor, stepBars, candles.length)); }}
                className="px-2 py-1 rounded-lg font-semibold"
                style={{ background: 'var(--surface-1)', color: 'var(--text-2)', border: '1px solid var(--border-1)' }}
                title="خطوة للأمام"
              >{stepBars > 1 ? stepBars : 'شمعة'} ▶</button>
              <button
                onClick={() => { setPlaying(false); setCursorIndex(null); }}
                className="px-2 py-1 rounded-lg font-semibold"
                style={{ background: 'var(--surface-1)', color: 'var(--text-2)', border: '1px solid var(--border-1)' }}
                title="آخر شمعة (العرض الكامل)"
              >آخر شمعة ⏭</button>

              <label className="flex items-center gap-1">
                <span style={{ color: 'var(--text-3)' }}>خطوة</span>
                <select
                  value={stepBars}
                  onChange={(e) => setStepBars(Number(e.target.value))}
                  className="px-1.5 py-1 rounded-lg num"
                  style={{ background: 'var(--surface-1)', border: '1px solid var(--border-1)', color: 'var(--text-1)' }}
                >
                  {[1, 5, 15, 60, 240].map((v) => <option key={v} value={v}>{v}</option>)}
                </select>
              </label>
              <label className="flex items-center gap-1">
                <span style={{ color: 'var(--text-3)' }}>سرعة</span>
                <select
                  value={speed}
                  onChange={(e) => setSpeed(Number(e.target.value))}
                  className="px-1.5 py-1 rounded-lg num"
                  style={{ background: 'var(--surface-1)', border: '1px solid var(--border-1)', color: 'var(--text-1)' }}
                >
                  {[1, 2, 4, 8, 16].map((v) => <option key={v} value={v}>{v}×</option>)}
                </select>
              </label>

              <input
                type="range"
                min={0}
                max={lastIndex}
                value={cursor}
                onChange={(e) => { setPlaying(false); setCursorIndex(Number(e.target.value)); }}
                className="flex-1 min-w-[140px]"
                title="شريط التتبع الزمني"
              />

              <span className="num" style={{ color: replay ? '#b45309' : 'var(--text-2)' }}>
                {replay ? 'تتبع: ' : 'العرض الكامل: '}{fmtDateTime(cursorTime)}
                {' · '}شمعة {cursor.toLocaleString('en-US')} / {lastIndex.toLocaleString('en-US')}
              </span>
              {replay && (
                <button
                  onClick={() => { setPlaying(false); setCursorIndex(null); }}
                  className="px-2 py-1 rounded-lg text-[10.5px]"
                  style={{ background: 'var(--warn-soft)', color: '#b45309' }}
                >عرض كل التاريخ</button>
              )}
            </div>

            {/* الشارت */}
            <div className="relative overflow-hidden rounded-xl" style={{ background: 'var(--surface-0)' }}>
              <HistoryChartView
                rows={rows}
                dataKey={`${dataKey}|${replay ? 'r' : 'f'}`}
                elements={selection.visible}
                style={filters.appearance}
                replay={replay}
                altInReplay={filters.untimed}
                selectedId={selectedId}
                height={fullscreen ? Math.max(420, window.innerHeight - 320) : 520}
                onSelect={setSelectedId}
                onStats={onStats}
              />
              <div className="absolute top-2 right-2 z-10 flex flex-wrap gap-x-2.5 gap-y-0.5 max-w-[80%] rounded-md px-2 py-1 text-[10px] pointer-events-none" style={{ background: 'rgba(10,14,22,.82)', color: '#e2e8f0' }}>
                {options.types.filter((t) => filters.types[t.id] !== false).map((t) => (
                  <span key={t.id}><b style={{ color: t.color }}>▬</b> {t.label}</span>
                ))}
                <span style={{ opacity: 0.75 }}>شفاف = مسحوبة/مبطلة · ◆ = لحظة النشأة</span>
              </div>
              <div className="absolute top-2 left-2 z-10 rounded px-2 py-1 text-[10px] font-semibold pointer-events-none" style={{ background: 'rgba(10,14,22,.82)', color: '#fff' }}>
                {data.symbol} · 1m · {data.days} يوماً · {data.bars.toLocaleString('en-US')} شمعة
                {' · '}مرئي <span className="num">{selection.counts.visible}</span>/{selection.counts.total}
                {hidden > 0 && <span style={{ color: '#fbbf24' }}> · مخفي {hidden}</span>}
                {stats.culled > 0 && <span style={{ color: '#93c5fd' }}> · خارج النطاق {stats.culled}</span>}
                {stats.labelSkips > 0 && <span style={{ color: '#94a3b8' }}> · تسميات متداخلة {stats.labelSkips}</span>}
                {replay && <span style={{ color: '#fbbf24' }}> · تتبع</span>}
              </div>
              <div className="absolute bottom-1 left-2 z-10 text-[9px] pointer-events-none" style={{ color: 'var(--text-3)' }}>
                مصدر البيانات: Binance Spot · {data.engine} · للعرض والتحقق اليدوي فقط
              </div>
            </div>

            {/* لوحة التفاصيل */}
            {selected && (
              <HistoryDetailPanel
                element={selected}
                data={data}
                cursorTime={cursorTime}
                replay={replay}
                onClose={() => setSelectedId(null)}
                onJump={jumpTo}
              />
            )}

            {/* الفلاتر */}
            <HistoryFiltersPanel
              open={filtersOpen}
              onToggle={() => setFiltersOpen((v) => !v)}
              options={options}
              filters={filters}
              meta={built.meta}
              counts={selection.counts}
              range={{ from: data.from, to: data.to }}
              onChange={(next) => setFilters(next)}
              onReset={() => setFilters(defaultFilters())}
            />

            <div className="text-[10.5px] px-1" style={{ color: 'var(--text-3)' }}>
              آخر شمعة: {lastCandleLabel} · النطاق من {new Date(data.from * 1000).toLocaleDateString('ar')} إلى {new Date(data.to * 1000).toLocaleDateString('ar')}
              {' '}· إجمالي المناطق من المحرك {data.totalZones}
              {data.zonesCapped ? ' · مُرسلة ' + data.zones.length : ' · كل المناطق مُرسلة (بلا سقف صامت)'}
              {data.cached ? ' · نتيجة مخزنة' : ' · حساب جديد'}
              {data.gaps > 0 && <span style={{ color: '#b45309' }}> · فجوات زمنية في الشموع: {data.gaps.toLocaleString('en-US')}</span>}
              {' '}· أزمنة المعرفة (availableAt) من قاعدة تأكيد البيفوت في المحرك (rightBars={data.meta?.rightBars ?? '—'})
            </div>
          </div>
        )}
        {open && !data && !loading && !error && (
          <div className="rounded-lg py-10 text-center text-[12px]" style={{ color: 'var(--text-3)', background: 'var(--surface-0)' }}>
            اضغط «تحديث» لجلب التاريخ وحساب المناطق
          </div>
        )}
      </div>
    </section>
  );
}
