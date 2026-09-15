import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../store/useStore';
import { fetchKlines } from '../lib/binance';
import type { Candle, Timeframe } from '../lib/types';
import { TIMEFRAMES } from '../lib/types';
import { createChart, CandlestickSeries, type ISeriesApi, type IPriceLine, type UTCTimestamp } from 'lightweight-charts';
import { CHART_COLORS } from './MiniChart';
import Toggle from './ui/Toggle';

const toBar = (c: Candle) => ({
  time: c.time as UTCTimestamp,
  open: c.open, high: c.high, low: c.low, close: c.close
});

function BigChart({ symbol, timeframe, zones }: {
  symbol: string;
  timeframe: string;
  zones: { ssl: number | null; bsl: number | null };
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const subscribeKline = useStore(s => s.subscribeKline);
  const [ready, setReady] = useState(false);
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);

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
    const s = chart.addSeries(CandlestickSeries, {
      upColor: CHART_COLORS.up, downColor: CHART_COLORS.down, borderVisible: false,
      wickUpColor: CHART_COLORS.up, wickDownColor: CHART_COLORS.down
    });
    seriesRef.current = s;
    setReady(true);
    let disposed = false;
    let lastTime = 0;
    void fetchKlines(symbol, timeframe, 300).then(candles => {
      if (disposed || !candles.length) return;
      s.setData(candles.map(toBar));
      lastTime = candles[candles.length - 1].time;
      chart.timeScale().fitContent();
    }).catch(() => { /* ignore */ });
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
      seriesRef.current = null;
      setReady(false);
    };
  }, [symbol, timeframe, subscribeKline]);

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

  return <div ref={containerRef} className="rounded-lg" style={{ border: '1px solid var(--border-1)' }} />;
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

/** نافذة شارت تحليل كامل: الفريمان الأصغر والأكبر جنباً إلى جنب + تحرير المناطق */
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
              <BigChart symbol={modal.symbol} timeframe={tfLower} zones={zones} />
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
              <BigChart symbol={modal.symbol} timeframe={tfUpper} zones={zones} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
