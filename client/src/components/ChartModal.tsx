import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../store/useStore';
import { api } from '../lib/api';
import { fetchKlines, fetchOlderKlines } from '../lib/binance';
import type { Candle, LiquidityZone, Timeframe } from '../lib/types';
import { TIMEFRAMES } from '../lib/types';
import { createChart, CandlestickSeries, type ISeriesApi, type IPriceLine, type IChartApi, type UTCTimestamp } from 'lightweight-charts';
import { CHART_COLORS } from './MiniChart';
import Toggle from './ui/Toggle';
import AcademyModal from './AcademyModal';

const toBar = (c: Candle) => ({
  time: c.time as UTCTimestamp,
  open: c.open, high: c.high, low: c.low, close: c.close
});

const ZONE_COLOR: Record<'BSL' | 'SSL', string> = { BSL: '#f23645', SSL: '#089981' };

function BigChart({ symbol, timeframe, zones, zoneList, annotate, showAuto, onChartClick }: {
  symbol: string;
  timeframe: string;
  zones: { ssl: number | null; bsl: number | null };
  zoneList: LiquidityZone[];
  annotate: boolean;
  showAuto: boolean;
  onChartClick: (price: number, timeframe: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const subscribeKline = useStore(s => s.subscribeKline);
  const [ready, setReady] = useState(false);
  const [loading, setLoading] = useState(true);
  const [canLoadMore, setCanLoadMore] = useState(false);
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const candlesRef = useRef<Candle[]>([]);
  const canLoadMoreRef = useRef(false);
  // مراجع وضع التعليم — لتجنّب إعادة تسجيل مستمع النقر عند كل تغيير حالة
  const annotateRef = useRef(annotate);
  const clickHandlerRef = useRef(onChartClick);
  annotateRef.current = annotate;
  clickHandlerRef.current = onChartClick;

  const load = async (loadOlder = false) => {
    setLoading(true);
    try {
      let candles: Candle[];
      if (loadOlder && candlesRef.current.length) {
        const oldest = candlesRef.current[0].time;
        const older = await fetchOlderKlines(symbol, timeframe, oldest);
        if (older.length === 0) {
          setCanLoadMore(false);
          canLoadMoreRef.current = false;
          setLoading(false);
          return;
        }
        candles = [...older, ...candlesRef.current].sort((a, b) => a.time - b.time);
      } else {
        candles = await fetchKlines(symbol, timeframe, 1000);
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
      setLoading(false);
    }
  };

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const chart = createChart(el, {
      height: 340,
      layout: { background: { color: CHART_COLORS.bg }, textColor: CHART_COLORS.text },
      grid: { vertLines: { color: CHART_COLORS.grid }, horzLines: { color: CHART_COLORS.grid } },
      timeScale: { timeVisible: true, secondsVisible: false },
      crosshair: { mode: 0 }
    });
    chartRef.current = chart;
    const s = chart.addSeries(CandlestickSeries, {
      upColor: CHART_COLORS.up, downColor: CHART_COLORS.down, borderVisible: false,
      wickUpColor: CHART_COLORS.up, wickDownColor: CHART_COLORS.down
    });
    seriesRef.current = s;
    // التقاط النقر في وضع التعليم: تحويل إحداثي Y إلى سعر
    chart.subscribeClick(param => {
      if (!annotateRef.current || !param.point) return;
      const price = s.coordinateToPrice(param.point.y);
      if (price == null) return;
      clickHandlerRef.current(Number(price), timeframe);
    });
    setReady(true);
    candlesRef.current = [];
    void load(false);

    let disposed = false;
    let lastTime = 0;
    const unsub = subscribeKline(symbol, timeframe, (k: Candle) => {
      if (disposed) return;
      if (k.time >= lastTime) { s.update(toBar(k)); lastTime = k.time; }
    });

    const ro = new ResizeObserver(() => chart.applyOptions({ width: el.clientWidth }));
    ro.observe(el);
    return () => {
      disposed = true;
      ro.disconnect();
      unsub();
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
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

  // مناطق التعليم اليدوي: خطوط متقطعة نقطية بعناوين الملاحظة
  useEffect(() => {
    const series = seriesRef.current;
    if (!series || !ready) return;
    const lines: IPriceLine[] = [];
    for (const z of zoneList.filter(z => z.source !== 'auto')) {
      const title = z.note ? `${z.type}: ${z.note.slice(0, 26)}` : z.type;
      lines.push(series.createPriceLine({
        price: z.price,
        color: ZONE_COLOR[z.type],
        title,
        lineWidth: 1,
        lineStyle: 3, // متقطع نقطي — يميز مناطق التعليم عن خطوط السعر اليدوي
        axisLabelVisible: true
      }));
    }
    return () => {
      for (const l of lines) {
        try { series.removePriceLine(l); } catch { /* ignore */ }
      }
    };
  }, [zoneList, ready]);

  // مناطق الكشف الآلي لنفس الفريم: خطوط متقطعة بشفافية حسب درجة الثقة
  useEffect(() => {
    const series = seriesRef.current;
    if (!series || !ready) return;
    const lines: IPriceLine[] = [];
    if (showAuto) {
      for (const z of zoneList.filter(z => z.source === 'auto' && (z.timeframe ?? '') === timeframe)) {
        const alpha = Math.min(0.95, 0.35 + (z.score ?? 50) / 100 * 0.6);
        const rgb = z.type === 'BSL' ? '242,54,69' : '8,153,129';
        const title = z.swept ? `${z.type} آلي ${z.score}٪ مُسحوبة` : `${z.type} آلي ${z.score}٪`;
        lines.push(series.createPriceLine({
          price: z.price,
          color: `rgba(${rgb},${alpha.toFixed(2)})`,
          title,
          lineWidth: 1,
          lineStyle: 2, // متقطع — يميز الآلي عن التعليم النقطي
          axisLabelVisible: true
        }));
      }
    }
    return () => {
      for (const l of lines) {
        try { series.removePriceLine(l); } catch { /* ignore */ }
      }
    };
  }, [zoneList, ready, showAuto, timeframe]);

  return (
    <div className="relative">
      <div
        ref={containerRef}
        style={{ height: 340, cursor: annotate ? 'crosshair' : 'default' }}
        className="rounded overflow-hidden"
      />
      {loading && (
        <div className="absolute inset-0 z-10 flex items-center justify-center pointer-events-none" style={{ background: 'rgba(15,21,34,0.45)' }}>
          <span className="text-[12px] font-semibold" style={{ color: 'var(--text-2)' }}>جاري تحميل الشموع…</span>
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

/** حوار منطقة آلية: درجة الثقة + الأسباب + تأكيد/رفض (تغذية راجعة تعلّم النظام) */
function AutoZoneDialog({ zone, onClose }: { zone: LiquidityZone; onClose: () => void }) {
  const pushToast = useStore(s => s.pushToast);
  const refreshZoneCounts = useStore(s => s.refreshZoneCounts);
  const [busy, setBusy] = useState(false);

  const send = async (verdict: 'confirm' | 'reject') => {
    setBusy(true);
    try {
      await api.zoneFeedback(zone.id, verdict);
      await refreshZoneCounts();
      pushToast(verdict === 'confirm' ? 'أكدت المنطقة — سيتعلم النظام منها' : 'رفضت المنطقة — سيتعلم النظام منها');
      onClose();
    } catch (e) {
      pushToast(`تعذر إرسال التغذية الراجعة: ${String(e)}`, 'alert');
    } finally {
      setBusy(false);
    }
  };

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
          السعر: {zone.price.toLocaleString('en', { maximumFractionDigits: 8 })}
        </div>
        <div className="text-[11.5px] leading-relaxed" style={{ color: 'var(--text-2)' }}>
          <b>لماذا حدد النظام هذه المنطقة؟</b>
          <ul className="mt-1 space-y-0.5 pr-4" style={{ listStyle: 'disc' }}>
            {(zone.reasons?.length ? zone.reasons : ['مرساة هيكلية (قمة/قاع سوينغ)']).map((r, i) => <li key={i}>{r}</li>)}
          </ul>
        </div>
        <div className="text-[11px]" style={{ color: 'var(--text-3)' }}>
          تأكيدك أو رفضك يُغذي معايرة النظام — كل رأي يرفع دقة الكشف القادم.
        </div>
        <div className="flex gap-2 pt-1">
          <button className="btn btn-accent flex-1 !py-1.5 text-[12px]" disabled={busy} onClick={() => void send('confirm')}>تأكيد</button>
          <button className="btn flex-1 !py-1.5 text-[12px]" disabled={busy} onClick={() => void send('reject')} style={{ color: ZONE_COLOR.BSL }}>رفض</button>
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
  const livePrice = useStore(s => s.prices[modal.symbol]);
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

  // تحميل المناطق عند الفتح وعند أي تغيير مُبثّ (zoneCounts تتغير عند zones_changed)
  useEffect(() => {
    let disposed = false;
    void api.getZones(modal.symbol)
      .then(({ zones }) => { if (!disposed) setZoneList(zones); })
      .catch(() => undefined);
    return () => { disposed = true; };
  }, [modal.symbol, zoneCounts]);

  // تقرير دقة الكشف مقابل مناطق التعليم
  useEffect(() => {
    let disposed = false;
    void api.getAccuracy(modal.symbol)
      .then(r => {
        if (disposed) return;
        const t = r.totals;
        setAccuracy(t.precision != null ? Math.round(t.precision * 100) : null);
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

  /** نقرة وضع التعليم: أقرب منطقة محفوظة ضمن 0.4% → آلية: تغذية راجعة، يدوية: تعديل، وإلا منطقة جديدة */
  const handleChartClick = (price: number, timeframe: string) => {
    if (zoneDialog || autoDialog) return;
    const near = zoneList.find(z => Math.abs(z.price - price) / z.price <= 0.004);
    if (near && near.source === 'auto') {
      setAutoDialog({ zone: near });
      return;
    }
    if (near) {
      setZoneDialog({ price: near.price, timeframe, zone: near });
      return;
    }
    const suggested = livePrice != null && price < livePrice ? 'SSL' : 'BSL';
    setZoneDialog({ price, timeframe, zone: null } as never);
    suggestedTypeRef.current = suggested;
  };
  const suggestedTypeRef = useRef<'BSL' | 'SSL'>('BSL');

  const zoneCount = zoneCounts?.[modal.symbol] ?? 0;

  return (
    <div
      className="anim-overlay fixed inset-0 z-40 flex items-center justify-center p-4"
      style={{ background: 'rgba(4, 6, 10, 0.82)', backdropFilter: 'blur(4px)' }}
      onClick={close}
    >
      <div
        className="anim-modal rounded-2xl w-full max-w-6xl max-h-full overflow-auto"
        style={{ background: 'var(--surface-0)', border: '1px solid var(--border-2)', boxShadow: 'var(--shadow-lg)' }}
        onClick={e => e.stopPropagation()}
      >
        {/* الترويسة */}
        <div
          className="flex items-center justify-between px-5 py-3.5 sticky top-0 z-10"
          style={{ background: 'var(--surface-glass)', backdropFilter: 'blur(10px)', borderBottom: '1px solid var(--border-1)' }}
        >
          <div className="flex items-center gap-3">
            <h2 className="text-lg font-bold" style={{ color: 'var(--text-1)' }}>{modal.symbol}</h2>
            {livePrice !== undefined && (
              <span className="num text-sm px-2.5 py-1 rounded-lg" style={{ background: 'var(--surface-2)', border: '1px solid var(--border-1)', color: 'var(--text-2)' }}>
                {livePrice.toLocaleString('en', { maximumFractionDigits: 8 })}
              </span>
            )}
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

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
            <div>
              <div className="flex items-center gap-2.5 mb-2">
                <span className="text-[13px] font-bold" style={{ color: 'var(--up)' }}>الفريم الأصغر</span>
                <div className="flex gap-1 flex-wrap">
                  {TIMEFRAMES.map(tf => (
                    <TfPill key={`l${tf}`} active={tfLower === tf} label={tf} onClick={() => changeTf('lower', tf)} />
                  ))}
                </div>
              </div>
              <BigChart symbol={modal.symbol} timeframe={tfLower} zones={zones} zoneList={zoneList} annotate={annotate} showAuto={showAuto} onChartClick={handleChartClick} />
            </div>
            <div>
              <div className="flex items-center gap-2.5 mb-2">
                <span className="text-[13px] font-bold" style={{ color: 'var(--warn)' }}>الفريم الأكبر</span>
                <div className="flex gap-1 flex-wrap">
                  {TIMEFRAMES.map(tf => (
                    <TfPill key={`u${tf}`} active={tfUpper === tf} label={tf} onClick={() => changeTf('upper', tf)} />
                  ))}
                </div>
              </div>
              <BigChart symbol={modal.symbol} timeframe={tfUpper} zones={zones} zoneList={zoneList} annotate={annotate} showAuto={showAuto} onChartClick={handleChartClick} />
            </div>
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
