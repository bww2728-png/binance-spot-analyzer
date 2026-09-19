import { useCallback, useEffect, useMemo, useRef, useState, memo } from 'react';
import { useStore } from '../store/useStore';
import { api } from '../lib/api';
import { fetchKlines, fetchOlderKlines, fmtPrice } from '../lib/binance';
import type { Candle, LiquidityZone, Timeframe } from '../lib/types';
import { TIMEFRAMES } from '../lib/types';
import { createChart, createSeriesMarkers, CandlestickSeries, type ISeriesApi, type IPriceLine, type IChartApi, type UTCTimestamp, type ISeriesMarkersPluginApi, type Time, type CandlestickData } from 'lightweight-charts';
import { CHART_COLORS, HOLLOW_CANDLES } from './MiniChart';
import Toggle from './ui/Toggle';
import AcademyModal from './AcademyModal';
import { useZoneBands, zoneRange } from './ZoneBands';
import ZoneListPanel from './ZoneListPanel';

const toBar = (c: Candle) => ({
  time: c.time as UTCTimestamp,
  open: c.open, high: c.high, low: c.low, close: c.close
});

const ZONE_COLOR: Record<'BSL' | 'SSL', string> = { BSL: '#f23645', SSL: '#089981' };

/** شارة السعر الحي معزولة كي لا تُعاد رسم نافذة الشارت عند كل تحديث سعر */
const LiveBadge = memo(function LiveBadge({ symbol }: { symbol: string }) {
  const price = useStore(s => s.prices[symbol]);
  if (price === undefined) return null;
  return (
    <span className="num text-sm px-2.5 py-1 rounded-lg" style={{ background: 'var(--surface-2)', border: '1px solid var(--border-1)', color: 'var(--text-2)' }}>
      {fmtPrice(price)}
    </span>
  );
});

/** ثواني الشمعة لكل فريم — لحساب نافذة النقل عند اختيار منطقة */
const TF_SECONDS: Record<string, number> = {
  '1m': 60, '3m': 180, '5m': 300, '15m': 900, '30m': 1800, '1h': 3600,
  '2h': 7200, '4h': 14400, '6h': 21600, '8h': 28800, '12h': 43200,
  '1d': 86400, '3d': 259200, '1w': 604800
};

function BigChart({ symbol, timeframe, zones, zoneList, annotate, showAuto, onChartClick, highlightId, scrollTarget, height, showAutoMarkers = true }: {
  symbol: string;
  timeframe: string;
  zones: { ssl: number | null; bsl: number | null };
  zoneList: LiquidityZone[];
  annotate: boolean;
  showAuto: boolean;
  onChartClick: (price: number, timeframe: string) => void;
  highlightId: string | null;
  scrollTarget: { time: number; nonce: number } | null;
  height: number;
  showAutoMarkers?: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const subscribeKline = useStore(s => s.subscribeKline);
  const [ready, setReady] = useState(false);
  const [loading, setLoading] = useState(true);
  const [canLoadMore, setCanLoadMore] = useState(false);
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const markersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const candlesRef = useRef<Candle[]>([]);
  const canLoadMoreRef = useRef(false);
  // مراجع الحماية من السباق: fetch متأخر أو شمعة بعد التفكيك لا تلمس series الجديد
  const aliveRef = useRef(true);
  const symbolRef = useRef(symbol);
  const tfRef = useRef(timeframe);
  symbolRef.current = symbol;
  tfRef.current = timeframe;
  // legend OHLC — الشمعة تحت المؤشر
  const [hoverBar, setHoverBar] = useState<null | { time: number; open: number; high: number; low: number; close: number }>(null);
  // مراجع وضع التعليم — لتجنّب إعادة تسجيل مستمع النقر عند كل تغيير حالة
  const annotateRef = useRef(annotate);
  const clickHandlerRef = useRef(onChartClick);
  annotateRef.current = annotate;
  clickHandlerRef.current = onChartClick;

  const load = async (loadOlder = false) => {
    const mySymbol = symbol;
    const myTf = timeframe;
    const isCurrent = () => aliveRef.current && symbolRef.current === mySymbol && tfRef.current === myTf;
    setLoading(true);
    try {
      let candles: Candle[];
      if (loadOlder && candlesRef.current.length) {
        const oldest = candlesRef.current[0].time;
        const older = await fetchOlderKlines(symbol, timeframe, oldest);
        if (!isCurrent()) return;
        if (older.length === 0) {
          setCanLoadMore(false);
          canLoadMoreRef.current = false;
          setLoading(false);
          return;
        }
        candles = [...older, ...candlesRef.current].sort((a, b) => a.time - b.time);
      } else {
        candles = await fetchKlines(symbol, timeframe, 1000);
        if (!isCurrent()) return;
      }
      candlesRef.current = candles;
      if (!candles.length) {
        setCanLoadMore(false);
        canLoadMoreRef.current = false;
        setLoading(false);
        return;
      }
      // ضبط العلم قبل setData/fitContent حتى يرى حدث النطاق القيمة الصحيحة
      const more = candles.length >= 1000;
      setCanLoadMore(more);
      canLoadMoreRef.current = more;
      const chart = chartRef.current;
      const series = seriesRef.current;
      if (chart && series) {
        series.setData(candles.map(toBar));
        if (!loadOlder) chart.timeScale().fitContent();
      }
    } catch (e) {
      console.error('[chart] load failed', e);
    } finally {
      if (isCurrent()) setLoading(false);
    }
  };

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    aliveRef.current = true;
    const chart = createChart(el, {
      height: el.clientHeight || height,
      layout: { background: { color: CHART_COLORS.bg }, textColor: CHART_COLORS.text },
      grid: { vertLines: { color: CHART_COLORS.grid }, horzLines: { color: CHART_COLORS.grid } },
      timeScale: { timeVisible: true, secondsVisible: false },
      crosshair: { mode: 0, vertLine: { color: CHART_COLORS.crosshair, style: 3, labelBackgroundColor: '#334155' }, horzLine: { color: CHART_COLORS.crosshair, style: 3, labelBackgroundColor: '#334155' } },
      kineticScroll: { mouse: true, touch: true }
    });
    chartRef.current = chart;
    const s = chart.addSeries(CandlestickSeries, { ...HOLLOW_CANDLES });
    seriesRef.current = s;
    // مُدير العلامات الأصلية — كل علامة مثبتة على (زمن الاكتشاف، سعر السيولة) وتتحرك مع التكبير
    markersRef.current = createSeriesMarkers(s, []);
    // التقاط النقر في وضع التعليم: تحويل إحداثي Y إلى سعر
    chart.subscribeClick(param => {
      if (!annotateRef.current || !param.point) return;
      const price = s.coordinateToPrice(param.point.y);
      if (price == null) return;
      clickHandlerRef.current(Number(price), timeframe);
    });
    setReady(true);
    candlesRef.current = [];
    setHoverBar(null);
    void load(false);

    let disposed = false;
    let lastTime = 0;
    const unsub = subscribeKline(symbol, timeframe, (k: Candle) => {
      if (disposed) return;
      if (k.time >= lastTime) {
        try { s.update(toBar(k)); lastTime = k.time; } catch { /* سباق التفكيك — تُهمل بصمت */ }
      }
    });

    // legend OHLC حي — الشمعة تحت المؤشر (rAF-throttle بلا إغراق React)
    let hoverRaf: number | null = null;
    let pendingBar: null | { time: number; open: number; high: number; low: number; close: number } = null;
    chart.subscribeCrosshairMove(param => {
      const bar = param.seriesData.get(s) as CandlestickData<Time> | undefined;
      pendingBar = bar
        ? { time: Number(bar.time), open: Number(bar.open), high: Number(bar.high), low: Number(bar.low), close: Number(bar.close) }
        : null;
      if (hoverRaf == null) {
        hoverRaf = requestAnimationFrame(() => {
          hoverRaf = null;
          setHoverBar(pendingBar);
        });
      }
    });

    const ro = new ResizeObserver(() => {
      // تجاهل إخفاء الشارت (display:none) — الأبعاد الصفرية تفسد المقياس
      if (el.clientWidth > 0 && el.clientHeight > 0) {
        chart.applyOptions({ width: el.clientWidth, height: el.clientHeight });
      }
    });
    ro.observe(el);
    return () => {
      disposed = true;
      if (hoverRaf != null) cancelAnimationFrame(hoverRaf);
      ro.disconnect();
      unsub();
      // الترتيب حرج: أطفئ refs قبل remove حتى لا تستدعيها callbacks قائمة بين remove() والتعيين → "Object is disposed"
      chartRef.current = null;
      seriesRef.current = null;
      markersRef.current = null;
      aliveRef.current = false;
      try { chart.remove(); } catch { /* سباق تفكيك — تُهمل بصمت */ }
      setReady(false);
      setCanLoadMore(false);
      canLoadMoreRef.current = false;
    };
  }, [symbol, timeframe, subscribeKline]);

  // reset loadMore flag when timeframe/symbol changes (handled by effect teardown)

  useEffect(() => {
    const series = seriesRef.current;
    if (!series || !ready) return;
    const lines: IPriceLine[] = [];
    if (zones.ssl != null) {
      lines.push(series.createPriceLine({ price: zones.ssl, color: '#089981', title: 'SSL', lineWidth: 1, lineStyle: 2, axisLabelVisible: true }));
    }
    if (zones.bsl != null) {
      lines.push(series.createPriceLine({ price: zones.bsl, color: '#f23645', title: 'BSL', lineWidth: 1, lineStyle: 2, axisLabelVisible: true }));
    }
    return () => {
      for (const l of lines) {
        try { series.removePriceLine(l); } catch { /* ignore */ }
      }
    };
  }, [zones.ssl, zones.bsl, ready]);

  // مناطق السيولة تُرسم كمناطق مظللة (Bands) عبر canvas overlay — لا خطوط
  const visibleZones = useMemo(() => {
    const list = showAuto
      ? zoneList
      : zoneList.filter(z => z.source !== 'auto');
    // الآلي: يُقيَّد بفريم الشارت المعروض؛ اليدوي: يظهر على كل الفريمات
    return list.filter(z => z.source !== 'auto' || (z.timeframe ?? '') === timeframe);
  }, [zoneList, showAuto, timeframe]);

  // علامات أصلية مثبتة: (زمن الاكتشاف، سعر السيولة) — تتحرك مع التكبير والتحريك بشكل مثالي
  useEffect(() => {
    const markers = markersRef.current;
    if (!markers || !ready) return;
    if (!showAutoMarkers) { try { markers.setMarkers([]); } catch { /* تفكيك */ } return; }
    const top = visibleZones
      .filter(z => z.source === 'auto' && z.anchorTime != null && z.feedback !== 'confirm') // المؤكدة تصبح Band دائماً
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      .slice(0, 5)
      .sort((a, b) => (a.anchorTime ?? 0) - (b.anchorTime ?? 0)); // المكتبة تتطلب ترتيباً زمنياً تصاعدياً
    try {
      markers.setMarkers(top.map(z => {
      const highlighted = highlightId === z.id;
      return {
        id: z.id,
        time: z.anchorTime as UTCTimestamp,
        price: z.price,
        position: z.type === 'BSL' ? 'atPriceTop' as const : 'atPriceBottom' as const,
        shape: 'circle' as const,
        color: ZONE_COLOR[z.type],
        size: highlighted ? 2 : 1,
        text: `${z.type} ${z.score}٪${z.swept ? ' مُسحوبة' : ''}`,
        textColor: '#334155'
      };
    }));
    } catch { /* سباق تفكيك — تُهمل بصمت */ }
  }, [visibleZones, ready, showAutoMarkers, highlightId]);

  // نقل الشارت إلى شمعة الاكتشاف عند اختيار منطقة من القائمة الجانبية
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !ready || !scrollTarget?.nonce) return;
    const sec = TF_SECONDS[timeframe] ?? 900;
    const t = scrollTarget.time;
    // حماية سباق التفكيك: remove() قد يسبق الاستدعاء
    try { chart.timeScale().setVisibleRange({ from: (t - sec * 45) as UTCTimestamp, to: (t + sec * 45) as UTCTimestamp }); } catch { /* تُهمل بصمت */ }
  }, [scrollTarget, ready, timeframe]);

  const getPriceCoord = useCallback((price: number) => {
    const s = seriesRef.current;
    if (!s) return null;
    return s.priceToCoordinate(price);
  }, []);

  const bandsCanvasRef = useZoneBands(containerRef, chartRef, getPriceCoord, visibleZones, highlightId);

  return (
    <div className="relative">
      <div
        ref={containerRef}
        style={{ height, cursor: annotate ? 'crosshair' : 'default' }}
        className="rounded overflow-hidden"
      />
      <canvas
        ref={bandsCanvasRef}
        className="absolute top-0 left-0 pointer-events-none"
        style={{ zIndex: 5 }}
      />
      {loading && (
        <div className="absolute inset-0 z-10 flex items-center justify-center pointer-events-none" style={{ background: 'rgba(15,21,34,0.45)' }}>
          <span className="text-[12px] font-semibold" style={{ color: 'var(--text-2)' }}>جاري تحميل الشموع…</span>
        </div>
      )}
      {!loading && candlesRef.current.length === 0 && (
        <div className="absolute inset-0 z-10 flex items-center justify-center pointer-events-none">
          <span className="text-[12px] font-semibold" style={{ color: 'var(--text-3)' }}>لا بيانات متاحة لهذا الفريم</span>
        </div>
      )}
      {hoverBar && (
        <div
          className="num absolute z-10 text-[10.5px] px-2 py-1 rounded-lg pointer-events-none whitespace-nowrap"
          style={{ top: annotate ? 36 : 8, left: 8, background: 'rgba(10,14,22,0.8)', border: '1px solid var(--border-1)', color: 'var(--text-1)' }}
        >
          <span style={{ color: 'var(--text-3)' }}>O </span>{fmtPrice(hoverBar.open)}
          <span style={{ color: 'var(--text-3)' }}> H </span>{fmtPrice(hoverBar.high)}
          <span style={{ color: 'var(--text-3)' }}> L </span>{fmtPrice(hoverBar.low)}
          <span style={{ color: 'var(--text-3)' }}> C </span>
          <span style={{ color: hoverBar.close >= hoverBar.open ? CHART_COLORS.up : CHART_COLORS.down }}>{fmtPrice(hoverBar.close)}</span>
        </div>
      )}
      {canLoadMore && !loading && (
        <button
          type="button"
          onClick={() => void load(true)}
          className="absolute bottom-3 left-3 z-10 text-[11px] font-semibold px-3 py-1.5 rounded-lg shadow"
          style={{ background: 'var(--accent)', color: '#fff' }}
        >
          تحميل المزيد من التاريخ
        </button>
      )}
      {!canLoadMore && !loading && candlesRef.current.length > 0 && (
        <div className="absolute bottom-3 left-3 z-10 text-[10.5px] px-2 py-1 rounded" style={{ background: 'var(--surface-2)', color: 'var(--text-3)' }}>
          لا توجد بيانات أقدم
        </div>
      )}
      {annotate && !loading && (
        <div className="absolute top-2 left-2 z-10 text-[10.5px] font-semibold px-2 py-1 rounded pointer-events-none" style={{ background: 'rgba(59,130,246,0.85)', color: '#fff' }}>
          وضع التعليم: انقر على السعر لتحديد منطقة
        </div>
      )}
    </div>
  );
}

/** زر حبوبة (Pill) لاختيار الفريم */
function TfPill({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="num text-[11px] px-2.5 py-1 rounded-full font-semibold"
      style={{
        background: active ? 'var(--accent)' : 'var(--surface-2)',
        color: active ? '#fff' : 'var(--text-2)',
        border: `1px solid ${active ? 'var(--accent)' : 'var(--border-1)'}`,
        transition: 'background var(--transition), color var(--transition), border-color var(--transition)'
      }}
    >
      {label}
    </button>
  );
}

/** حوار إضافة/تعديل منطقة سيولة */
function ZoneDialog({ symbol, timeframe, price, zone, onClose }: {
  symbol: string;
  timeframe: string;
  price: number;
  zone: LiquidityZone | null;
  onClose: () => void;
}) {
  const pushToast = useStore(s => s.pushToast);
  const refreshZoneCounts = useStore(s => s.refreshZoneCounts);
  const [type, setType] = useState<'BSL' | 'SSL'>(zone?.type ?? 'BSL');
  const [zonePrice, setZonePrice] = useState(String(zone?.price ?? price));
  const [note, setNote] = useState(zone?.note ?? '');
  const [expiry, setExpiry] = useState(String(
    zone?.expires_at ? Math.max(24, Math.round((zone.expires_at - Date.now()) / 3600000)) : 0
  ));
  const [saving, setSaving] = useState(false);

  const save = async () => {
    const p = Number(zonePrice);
    if (!Number.isFinite(p) || p <= 0) { pushToast('السعر غير صالح', 'alert'); return; }
    setSaving(true);
    try {
      const expiresAt = Number(expiry) > 0 ? Date.now() + Number(expiry) * 3600000 : null;
      if (zone) {
        await api.updateZone(zone.id, { price: p, note, type, active: true });
        pushToast('تم تحديث المنطقة');
      } else {
        await api.createZone({ symbol, timeframe, type, price: p, note, expires_at: expiresAt });
        pushToast(`حُفظت منطقة ${type} على ${symbol}`);
      }
      await refreshZoneCounts();
      onClose();
    } catch (e) {
      pushToast(`تعذر الحفظ: ${String(e)}`, 'alert');
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!zone) return;
    setSaving(true);
    try {
      await api.deleteZone(zone.id);
      await refreshZoneCounts();
      pushToast('حُذفت المنطقة');
      onClose();
    } catch (e) {
      pushToast(`تعذر الحذف: ${String(e)}`, 'alert');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="absolute inset-0 z-20 flex items-center justify-center p-4" style={{ background: 'rgba(4,6,10,0.6)' }} onClick={onClose}>
      <div
        className="rounded-xl p-4 w-full max-w-sm space-y-3"
        style={{ background: 'var(--surface-1)', border: '1px solid var(--border-2)', boxShadow: 'var(--shadow-lg)' }}
        onClick={e => e.stopPropagation()}
      >
        <div className="text-[13px] font-bold" style={{ color: 'var(--text-1)' }}>
          {zone ? 'تعديل منطقة سيولة' : 'منطقة سيولة جديدة'} — {symbol}
        </div>
        <div className="flex gap-2">
          <button
            className={`btn flex-1 !py-1.5 text-[12px] ${type === 'BSL' ? 'btn-accent' : ''}`}
            style={type === 'BSL' ? { background: ZONE_COLOR.BSL, color: '#fff' } : {}}
            onClick={() => setType('BSL')}
          >
            BSL شرائية
          </button>
          <button
            className={`btn flex-1 !py-1.5 text-[12px] ${type === 'SSL' ? 'btn-accent' : ''}`}
            style={type === 'SSL' ? { background: ZONE_COLOR.SSL, color: '#fff' } : {}}
            onClick={() => setType('SSL')}
          >
            SSL بيعية
          </button>
        </div>
        <label className="block text-[12px]" style={{ color: 'var(--text-2)' }}>
          السعر
          <input type="number" step="any" className="num w-full mt-1" value={zonePrice} onChange={e => setZonePrice(e.target.value)} />
        </label>
        <label className="block text-[12px]" style={{ color: 'var(--text-2)' }}>
          ملاحظة
          <textarea className="w-full mt-1" rows={2} value={note} placeholder="مثال: قمة سوينغ متساوية — سيولة وقف" onChange={e => setNote(e.target.value)} />
        </label>
        <label className="block text-[12px]" style={{ color: 'var(--text-2)' }}>
          الصلاحية
          <select className="w-full mt-1" value={expiry} onChange={e => setExpiry(e.target.value)}>
            <option value="0">بلا انتهاء</option>
            <option value="24">24 ساعة</option>
            <option value="168">7 أيام</option>
            <option value="720">30 يوماً</option>
          </select>
        </label>
        <div className="flex gap-2 pt-1">
          <button className="btn btn-accent flex-1 !py-1.5 text-[12px]" disabled={saving} onClick={() => void save()}>
            {saving ? '…' : 'حفظ'}
          </button>
          {zone && (
            <button className="btn flex-1 !py-1.5 text-[12px]" disabled={saving} onClick={() => void remove()} style={{ color: ZONE_COLOR.BSL }}>
              حذف
            </button>
          )}
          <button className="btn flex-1 !py-1.5 text-[12px]" onClick={onClose}>إلغاء</button>
        </div>
      </div>
    </div>
  );
}

/** حوار منطقة آلية: درجة الثقة + الأسباب + ملاحظتك + تأكيد/رفض/استعادة (تغذية راجعة تعلّم النظام) */
function AutoZoneDialog({ zone, onClose }: { zone: LiquidityZone; onClose: () => void }) {
  const pushToast = useStore(s => s.pushToast);
  const refreshZoneCounts = useStore(s => s.refreshZoneCounts);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(zone.note ?? '');

  const send = async (verdict: 'confirm' | 'reject' | 'clear') => {
    setBusy(true);
    try {
      await api.zoneFeedback(zone.id, verdict);
      await refreshZoneCounts();
      pushToast(
        verdict === 'confirm' ? 'أكدت المنطقة — أصبحت Band دائماً على الشارت ويتعلم النظام منها'
        : verdict === 'reject' ? 'رفضت المنطقة — نُقلت إلى «المرفوضة» ويتعلم النظام منها'
        : 'استُعيدت المنطقة إلى غير مصنفة'
      );
      onClose();
    } catch (e) {
      pushToast(`تعذر إرسال التغذية الراجعة: ${String(e)}`, 'alert');
    } finally {
      setBusy(false);
    }
  };

  const saveNote = async () => {
    setBusy(true);
    try {
      await api.zoneNote(zone.id, note);
      await refreshZoneCounts();
      pushToast('حُفظت ملاحظتك على المنطقة');
      onClose();
    } catch (e) {
      pushToast(`تعذر حفظ الملاحظة: ${String(e)}`, 'alert');
    } finally {
      setBusy(false);
    }
  };

  const { low, high } = zoneRange(zone);
  return (
    <div className="absolute inset-0 z-20 flex items-center justify-center p-4" style={{ background: 'rgba(4,6,10,0.6)' }} onClick={onClose}>
      <div
        className="rounded-xl p-4 w-full max-w-sm space-y-3"
        style={{ background: 'var(--surface-1)', border: '1px solid var(--border-2)', boxShadow: 'var(--shadow-lg)' }}
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-2">
          <div className="text-[13px] font-bold" style={{ color: 'var(--text-1)' }}>
            منطقة آلية — {zone.type} على {zone.timeframe}
          </div>
          <span className="num text-[12px] font-bold px-2 py-0.5 rounded-full" style={{ background: 'var(--accent)', color: '#fff' }}>
            {zone.score}٪
          </span>
        </div>
        <div className="num text-[12px]" style={{ color: 'var(--text-2)' }}>
          السعر: {fmtPrice(zone.price)}
        </div>
        <div className="num text-[11px]" style={{ color: 'var(--text-3)' }}>
          النطاق: {fmtPrice(low)} – {fmtPrice(high)}
          {zone.anchorTime != null && (
            <> · اكتُشفت: {new Date(zone.anchorTime * 1000).toLocaleString('en', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</>
          )}
          {zone.swept ? ' · مُسحوبة' : ''}
        </div>
        <div className="text-[11.5px] leading-relaxed" style={{ color: 'var(--text-2)' }}>
          <b>لماذا حدد النظام هذه المنطقة؟</b>
          <ul className="mt-1 space-y-0.5 pr-4" style={{ listStyle: 'disc' }}>
            {(zone.reasons?.length ? zone.reasons : ['مرساة هيكلية (قمة/قاع سوينغ)']).map((r, i) => <li key={i}>{r}</li>)}
          </ul>
        </div>
        <label className="block text-[12px]" style={{ color: 'var(--text-2)' }}>
          ملاحظتك على هذه المنطقة
          <textarea className="w-full mt-1" rows={2} value={note} placeholder="مثال: سيولة قوية — راقب السحب هنا" onChange={e => setNote(e.target.value)} />
        </label>
        <div className="text-[11px]" style={{ color: 'var(--text-3)' }}>
          تأكيدك يُرقّيها إلى Band دائم على الشارت، ورفضك ينقلها إلى «المرفوضة» — النظام يتعلم من كليهما.
        </div>
        <div className="flex gap-2 pt-1">
          {zone.feedback ? (
            <button className="btn flex-1 !py-1.5 text-[12px]" disabled={busy} onClick={() => void send('clear')}>استعادة</button>
          ) : (
            <button className="btn btn-accent flex-1 !py-1.5 text-[12px]" disabled={busy} onClick={() => void send('confirm')}>تأكيد</button>
          )}
          {zone.feedback !== 'reject' && (
            <button className="btn flex-1 !py-1.5 text-[12px]" disabled={busy} onClick={() => void send('reject')} style={{ color: ZONE_COLOR.BSL }}>رفض</button>
          )}
          <button className="btn flex-1 !py-1.5 text-[12px]" disabled={busy} onClick={() => void saveNote()}>حفظ الملاحظة</button>
          <button className="btn flex-1 !py-1.5 text-[12px]" onClick={onClose}>إغلاق</button>
        </div>
      </div>
    </div>
  );
}

/** نافذة شارت تحليل كامل: الفريمان الأصغر والأكبر جنباً إلى جنب + تحرير المناطق + وضع التعليم */
export default function ChartModal() {
  const modal = useStore(s => s.chartModal)!;
  const close = useStore(s => s.closeChart);
  const analyses = useStore(s => s.analyses);
  const update = useStore(s => s.updateAnalysis);
  const scanBarcode = useStore(s => s.scanBarcode);
  const analysis = analyses.find(a => a.symbol === modal.symbol);
  const barcodeScan = useStore(s => s.barcodeScans[modal.symbol]);
  const isBarcode = barcodeScan?.status === 'success' && barcodeScan.is_barcode;
  const [barcodeAck, setBarcodeAck] = useState(false);
  const [barcodeScanning, setBarcodeScanning] = useState(false);

  const [tfLower, setTfLower] = useState(analysis?.tf_lower ?? '15m');
  const [tfUpper, setTfUpper] = useState(analysis?.tf_upper ?? '4h');

  // ---- وضع التعليم ومناطق السيولة ----
  const zoneCounts = useStore(s => s.zoneCounts);
  const [annotate, setAnnotate] = useState(false);
  const [showAuto, setShowAuto] = useState(true);
  const [zoneList, setZoneList] = useState<LiquidityZone[]>([]);
  const [zoneDialog, setZoneDialog] = useState<null | { price: number; timeframe: string; zone: LiquidityZone | null }>(null);
  const [autoDialog, setAutoDialog] = useState<null | { zone: LiquidityZone }>(null);
  const [academyOpen, setAcademyOpen] = useState(false);
  const [accuracy, setAccuracy] = useState<number | null>(null);
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const highlightTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [scrollTarget, setScrollTarget] = useState<{ time: number; nonce: number } | null>(null);
  const [fullscreen, setFullscreen] = useState<null | 'lower' | 'upper'>(null);

  /** وميض المنطقة على الشارتين لثانيتين */
  const flashZone = (id: string) => {
    if (highlightTimer.current) clearTimeout(highlightTimer.current);
    setHighlightId(id);
    highlightTimer.current = setTimeout(() => setHighlightId(null), 2000);
  };

  /** اختيار من القائمة الجانبية: وميض + نقل الشارت لشمعة الاكتشاف + فتح حوار التفاصيل */
  const pickFromPanel = (z: LiquidityZone) => {
    flashZone(z.id);
    if (z.anchorTime != null) setScrollTarget({ time: z.anchorTime, nonce: Date.now() });
    if (z.source === 'auto') setAutoDialog({ zone: z });
    else setZoneDialog({ price: z.price, timeframe: z.timeframe, zone: z });
  };

  // تحميل المناطق عند الفتح وعند أي تغيير مُبثّ (zoneCounts تتغير عند zones_changed)
  useEffect(() => {
    let disposed = false;
    void api.getZones(modal.symbol)
      .then(({ zones }) => { if (!disposed) setZoneList(zones); })
      .catch(() => undefined);
    return () => { disposed = true; };
  }, [modal.symbol, zoneCounts]);

  // Esc: يخرج من ملء الشاشة أولاً، وإن لم يكن ملءًا يغلق النافذة كاملة
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        if (fullscreen) setFullscreen(null);
        else close();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [fullscreen, close]);

  // تقرير دقة الكشف مقابل مناطق التعليم
  useEffect(() => {
    let disposed = false;
    void api.getAccuracy(modal.symbol)
      .then(r => {
        if (disposed) return;
        const t = r.totals;
        // الدقة بلا معنى بلا مرجع يدوي — لا تعرضها
        setAccuracy(t.manualCount > 0 && t.precision != null ? Math.round(t.precision * 100) : null);
      })
      .catch(() => undefined);
    return () => { disposed = true; };
  }, [modal.symbol, zoneCounts]);

  useEffect(() => {
    let disposed = false;
    setBarcodeScanning(true);
    void scanBarcode(modal.symbol)
      .catch(() => undefined)
      .finally(() => { if (!disposed) setBarcodeScanning(false); });
    return () => { disposed = true; };
  }, [modal.symbol, scanBarcode]);

  const zones = useMemo(() => ({
    ssl: analysis?.ssl_price ?? null,
    bsl: analysis?.bsl_price ?? null
  }), [analysis?.ssl_price, analysis?.bsl_price]);

  const patch = (p: Parameters<typeof update>[1]) => analysis && void update(analysis.id, p);
  const changeTf = (which: 'lower' | 'upper', value: string) => {
    const tf = value as Timeframe;
    if (which === 'lower') { setTfLower(tf); patch({ tf_lower: tf }); }
    else { setTfUpper(tf); patch({ tf_upper: tf }); }
  };

  /** نقرة وضع التعليم: داخل حدود منطقة مظللة → آلية: تغذية راجعة، يدوية: تعديل، وإلا منطقة جديدة */
  const handleChartClick = (price: number, timeframe: string) => {
    if (zoneDialog || autoDialog) return;
    const near = zoneList.find(z => {
      const { low, high } = zoneRange(z);
      return price >= low && price <= high;
    });
    if (near && near.source === 'auto') {
      setAutoDialog({ zone: near });
      return;
    }
    if (near) {
      setZoneDialog({ price: near.price, timeframe, zone: near });
      return;
    }
    const cur = useStore.getState().prices[modal.symbol];
    const suggested = cur != null && price < cur ? 'SSL' : 'BSL';
    setZoneDialog({ price, timeframe, zone: null } as never);
    suggestedTypeRef.current = suggested;
  };
  const suggestedTypeRef = useRef<'BSL' | 'SSL'>('BSL');

  const zoneCount = zoneCounts?.[modal.symbol] ?? 0;
  // ارتفاع الشارت: عادي 340px / الملء داخل ملء الشاشة يملأ ارتفاع الشاشة بالكامل
  const fullscreenChartHeight = window.innerHeight;

  /** شريط التحكم العائم داخل ملء الشاشة: صف الفريمات + تبديل الاصغر/الأكبر + إنهاء */
  const fullscreenBar = (which: 'lower' | 'upper') => {
    const isLower = which === 'lower';
    const current = isLower ? tfLower : tfUpper;
    return (
      <div
        className="absolute top-3 left-1/2 -translate-x-1/2 z-10 flex items-center gap-2 flex-wrap justify-center px-3 py-2 rounded-xl anim-overlay"
        style={{ background: 'rgba(10,14,22,0.92)', border: '1px solid var(--border-1)' }}
      >
        <span className="text-[12px] font-bold" style={{ color: isLower ? 'var(--up)' : 'var(--warn)' }}>
          {isLower ? 'الفريم الأصغر' : 'الفريم الأكبر'}
        </span>
        <div className="flex gap-1 flex-wrap">
          {TIMEFRAMES.map(tf => (
            <TfPill key={`fb${which}${tf}`} active={current === tf} label={tf} onClick={() => changeTf(which, tf)} />
          ))}
        </div>
        <button
          className="btn !py-1.5 !px-3 text-[11.5px]"
          onClick={() => setFullscreen(which === 'lower' ? 'upper' : 'lower')}
          title="التبديل بين الفريمين — بلا إعادة جلب الشموع"
        >
          التبديل إلى {isLower ? 'الأكبر' : 'الاصغر'} ⇄
        </button>
        <button className="btn btn-accent !py-1.5 !px-3 text-[11.5px]" onClick={() => setFullscreen(null)} title="Esc يخرج أيضاً">
          إنهاء الملء ✕
        </button>
      </div>
    );
  };

  return (
    <div
      className={`anim-overlay fixed inset-0 z-40 flex items-center justify-center ${fullscreen ? 'p-0' : 'p-4'}`}
      style={{ background: 'rgba(4, 6, 10, 0.85)' }}
      onClick={close}
    >
      <div
        className={`anim-modal w-full overflow-auto ${fullscreen ? 'max-w-none h-full rounded-none' : 'rounded-2xl max-w-6xl max-h-full'}`}
        style={{ background: 'var(--surface-0)', border: '1px solid var(--border-2)', boxShadow: 'var(--shadow-lg)' }}
        onClick={e => e.stopPropagation()}
      >
        {/* الترويسة */}
        <div
          className="flex items-center justify-between px-5 py-3.5 sticky top-0 z-10"
          style={{ background: 'var(--surface-glass)', borderBottom: '1px solid var(--border-1)' }}
        >
          <div className="flex items-center gap-3">
            <h2 className="text-lg font-bold" style={{ color: 'var(--text-1)' }}>{modal.symbol}</h2>
            <LiveBadge symbol={modal.symbol} />
            <button
              className={`btn !py-1.5 !px-3 text-[11.5px] ${annotate ? 'btn-accent' : ''}`}
              style={annotate ? { background: '#3b82f6', color: '#fff' } : {}}
              onClick={() => setAnnotate(v => !v)}
              title="تعليم مناطق السيولة بالنقر على الشارت"
            >
              {annotate ? 'وضع التعليم: مفعل' : 'وضع التعليم'}
            </button>
            <button
              className={`btn !py-1.5 !px-3 text-[11.5px] ${showAuto ? 'btn-accent' : ''}`}
              style={showAuto ? { background: '#8b5cf6', color: '#fff' } : {}}
              onClick={() => setShowAuto(v => !v)}
              title="إظهار/إخفاء مناطق الكشف الآلي"
            >
              مناطق آلية: {showAuto ? 'ظاهرة' : 'مخفية'}
            </button>
            {accuracy !== null && (
              <span
                className="text-[11px] px-2 py-0.5 rounded-full font-semibold num"
                style={{ background: 'var(--surface-2)', color: 'var(--text-2)', border: '1px solid var(--border-1)' }}
                title="نسبة مناطق الكشف الآلي المطابقة لمناطق تعليمك"
              >
                دقة الكشف {accuracy}٪
              </span>
            )}
            {zoneCount > 0 && (
              <span className="text-[11px] px-2 py-0.5 rounded-full font-semibold" style={{ background: 'var(--surface-2)', color: 'var(--text-2)', border: '1px solid var(--border-1)' }}>
                {zoneCount} منطقة
              </span>
            )}
            <button
              className="btn !py-1.5 !px-3 text-[11.5px]"
              onClick={() => setAcademyOpen(true)}
              title="دليل كل أدوات السيولة وعلاقتها بالنظام"
            >
              أكاديمية النظام
            </button>
          </div>
          <button
            onClick={close}
            aria-label="إغلاق"
            className="w-8 h-8 rounded-lg flex items-center justify-center text-xl"
            style={{ color: 'var(--text-2)', transition: 'background var(--transition), color var(--transition)' }}
            onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'var(--surface-3)'; (e.currentTarget as HTMLElement).style.color = 'var(--text-1)'; }}
            onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent'; (e.currentTarget as HTMLElement).style.color = 'var(--text-2)'; }}
          >
            ×
          </button>
        </div>

        <div className="p-5">
          {barcodeScanning && (
            <div className="mb-5 rounded-xl p-3.5 text-[12px]" style={{ background: 'var(--surface-2)', color: 'var(--text-2)' }}>
              جارٍ تأكيد فحص الباركود على آخر 100 شمعة دقيقة…
            </div>
          )}
          {barcodeScan?.status === 'success' && !barcodeAck && (
            <div
              className="mb-5 rounded-xl p-3.5 flex items-start justify-between gap-3 flex-wrap"
              style={{ background: 'var(--warn-soft)', border: '1px solid rgba(245,158,11,0.35)' }}
              role="alert"
            >
              <div className="text-[12.5px] leading-relaxed flex-1" style={{ color: '#fbbf24' }}>
                <b>{isBarcode ? 'تحذير «باركود»:' : 'نتيجة فحص الباركود:'}</b> {barcodeScan.reason}.
                الدرجة {barcodeScan.score} من 100، وفُحصت {barcodeScan.candles_count} شمعة.
                مراقبة SSL/BSL تعمل على السعر الحي المباشر ولا تتأثر — والوسم تحذيري فقط ولا يستبعد العملة.
              </div>
              <button className="btn btn-accent !py-1.5 !px-3 text-[11px]" onClick={() => setBarcodeAck(true)}>
                فهمت
              </button>
            </div>
          )}
          {analysis && (
            <div className="flex flex-wrap items-center gap-x-6 gap-y-3 mb-5 text-[13px]" style={{ color: 'var(--text-2)' }}>
              <label className="flex items-center gap-2">
                سعر SSL:
                <input type="number" step="any" className="num w-28" style={{ borderColor: 'rgba(8,153,129,0.45)' }} value={analysis.ssl_price ?? ''}
                  onChange={e => patch({ ssl_price: e.target.value === '' ? null : Number(e.target.value) })} />
              </label>
              <label className="flex items-center gap-2">
                سعر BSL:
                <input type="number" step="any" className="num w-28" style={{ borderColor: 'rgba(242,54,69,0.45)' }} value={analysis.bsl_price ?? ''}
                  onChange={e => patch({ bsl_price: e.target.value === '' ? null : Number(e.target.value) })} />
              </label>
              <label className="flex items-center gap-2">
                لمس BSL
                <Toggle on={analysis.bsl_touched === 1} label="لمس BSL" onChange={v => patch({ bsl_touched: v ? 1 : 0 })} />
              </label>
              <label className="flex items-center gap-2">
                لمس SSL
                <Toggle on={analysis.ssl_touched === 1} label="لمس SSL" onChange={v => patch({ ssl_touched: v ? 1 : 0 })} />
              </label>
            </div>
          )}

          {/* شارت تحليل: عادي شبكة جنباً إلى جنب، أو فريم واحد يملأ العرض بالكامل */}
          <div className={fullscreen ? '' : 'grid grid-cols-1 lg:grid-cols-2 gap-5'}>
            <div
              className={fullscreen === 'lower' ? 'fixed inset-0 z-[60]' : fullscreen ? 'hidden' : ''}
              style={fullscreen === 'lower' ? { background: 'var(--surface-0)' } : undefined}
            >
              {fullscreen === 'lower' ? fullscreenBar('lower') : (
                <div className="flex items-center gap-2.5 mb-2">
                  <span className="text-[13px] font-bold" style={{ color: 'var(--up)' }}>الفريم الأصغر</span>
                  <div className="flex gap-1 flex-wrap">
                    {TIMEFRAMES.map(tf => (
                      <TfPill key={`l${tf}`} active={tfLower === tf} label={tf} onClick={() => changeTf('lower', tf)} />
                    ))}
                  </div>
                  <button className="btn !py-1 !px-2.5 text-[10.5px]" onClick={() => setFullscreen('lower')} title="ملء الشاشة — هذا الفريم فقط">
                    ملء الشاشة ⛶
                  </button>
                </div>
              )}
              <BigChart symbol={modal.symbol} timeframe={tfLower} zones={zones} zoneList={zoneList} annotate={annotate} showAuto={showAuto} onChartClick={handleChartClick} highlightId={highlightId} scrollTarget={scrollTarget} height={fullscreen === 'lower' ? fullscreenChartHeight : 340} />
            </div>
            <div
              className={fullscreen === 'upper' ? 'fixed inset-0 z-[60]' : fullscreen ? 'hidden' : ''}
              style={fullscreen === 'upper' ? { background: 'var(--surface-0)' } : undefined}
            >
              {fullscreen === 'upper' ? fullscreenBar('upper') : (
                <div className="flex items-center gap-2.5 mb-2">
                  <span className="text-[13px] font-bold" style={{ color: 'var(--warn)' }}>الفريم الأكبر</span>
                  <div className="flex gap-1 flex-wrap">
                    {TIMEFRAMES.map(tf => (
                      <TfPill key={`u${tf}`} active={tfUpper === tf} label={tf} onClick={() => changeTf('upper', tf)} />
                    ))}
                  </div>
                  <button className="btn !py-1 !px-2.5 text-[10.5px]" onClick={() => setFullscreen('upper')} title="ملء الشاشة — هذا الفريم فقط">
                    ملء الشاشة ⛶
                  </button>
                </div>
              )}
              <BigChart symbol={modal.symbol} timeframe={tfUpper} zones={zones} zoneList={zoneList} annotate={annotate} showAuto={showAuto} onChartClick={handleChartClick} highlightId={highlightId} scrollTarget={scrollTarget} height={fullscreen === 'upper' ? fullscreenChartHeight : 340} />
            </div>
          </div>

          {/* القائمة الجانبية: أين حدد النظام/أنت المناطق — النقر يميّزها بوميض */}
          <div className="mt-5">
            <ZoneListPanel zones={zoneList} onPick={pickFromPanel} />
          </div>
        </div>

        {zoneDialog && (
          <div className="absolute inset-0">
            <ZoneDialog
              symbol={modal.symbol}
              timeframe={zoneDialog.timeframe}
              price={zoneDialog.price}
              zone={zoneDialog.zone}
              onClose={() => setZoneDialog(null)}
            />
          </div>
        )}

        {autoDialog && (
          <div className="absolute inset-0">
            <AutoZoneDialog zone={autoDialog.zone} onClose={() => setAutoDialog(null)} />
          </div>
        )}

        {academyOpen && <AcademyModal onClose={() => setAcademyOpen(false)} />}
      </div>
    </div>
  );
}
