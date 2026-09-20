import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { createChart, CandlestickSeries, createSeriesMarkers, LineStyle, type UTCTimestamp } from 'lightweight-charts';
import { useStore, type ArchiveSection } from '../store/useStore';
import { api } from '../lib/api';
import { fmtPrice } from '../lib/binance';
import type { Analysis, CaseChartView, CaseImage, CaseRow, LiquidityZone } from '../lib/types';
import SkeletonRow from './ui/Skeleton';
import ZonesHistory from './ZonesHistory';
import EventsLog from './EventsLog';

const ZONE_COLOR: Record<'BSL' | 'SSL', string> = { BSL: '#f23645', SSL: '#089981' };
const NAV_TABS: { key: ArchiveSection; label: string; desc: string }[] = [
  { key: 'cases', label: 'القرارات', desc: 'لقطة كل قرار تحليل' },
  { key: 'zones', label: 'المناطق — كل النسخ', desc: 'إنشاء/تعديل/حذف لكل تحديد يدوي' },
  { key: 'events', label: 'أحداث النظام', desc: 'السجل الإلحاقي الكامل بجميع الأنواع' }
];

export const ACTOR_LABELS: Record<string, string> = {
  zone_create: 'منطقة يدوية جديدة',
  zone_edit: 'تعديل منطقة',
  zone_delete: 'حذف منطقة',
  zone_auto_feedback: 'تغذية راجعة على منطقة آلية',
  zone_auto_note: 'ملاحظة على منطقة آلية',
  analysis_edit: 'تعديل خطة التحليل',
  coin_add: 'إضافة عملة للوحة',
  coin_remove: 'إزالة عملة من اللوحة'
};

/** أعِد رسم اللقطة كما كانت لحظة القرار — بدون أي شموع مستقبلية */
const ReplayChart = memo(function ReplayChart({ view, zones, analysis }: {
  view: CaseChartView;
  zones: LiquidityZone[];
  analysis: Analysis | null;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const chart = createChart(el, {
      height: 220,
      layout: { background: { color: 'transparent' }, textColor: '#8b93a7' },
      grid: { vertLines: { color: 'rgba(255,255,255,0.04)' }, horzLines: { color: 'rgba(255,255,255,0.04)' } },
      timeScale: {},
      rightPriceScale: { borderColor: 'rgba(255,255,255,0.08)' },
      crosshair: { mode: 1 }
    });
    const series = chart.addSeries(CandlestickSeries, {
      upColor: '#26a69a', downColor: '#ef5350', wickUpColor: '#26a69a', wickDownColor: '#ef5350',
      borderVisible: false
    });
    const data = view.candles.map(c => ({ time: c.time as UTCTimestamp, open: c.open, high: c.high, low: c.low, close: c.close }));
    series.setData(data);

    const extras: ReturnType<typeof series.createPriceLine>[] = [];
    const seen = new Set<string>();
    for (const z of zones) {
      if (!(z.timeframe === view.tf || !z.timeframe) || seen.has(`${z.type}:${z.price}`)) continue;
      seen.add(`${z.type}:${z.price}`);
      extras.push(series.createPriceLine({
        price: z.price, color: ZONE_COLOR[z.type], lineWidth: 1,
        lineStyle: LineStyle.Dashed, axisLabelVisible: false, title: z.type
      }));
    }
    if (analysis?.bsl_price != null) {
      extras.push(series.createPriceLine({ price: analysis.bsl_price, color: ZONE_COLOR.BSL, lineWidth: 1, lineStyle: LineStyle.Solid, axisLabelVisible: true, title: 'BSL' }));
    }
    if (analysis?.ssl_price != null) {
      extras.push(series.createPriceLine({ price: analysis.ssl_price, color: ZONE_COLOR.SSL, lineWidth: 1, lineStyle: LineStyle.Solid, axisLabelVisible: true, title: 'SSL' }));
    }
    if (data.length) {
      createSeriesMarkers(series, []).setMarkers([{
        time: data[data.length - 1].time,
        position: 'inBar',
        color: '#b45309',
        shape: 'circle',
        text: 'قرار'
      }]);
    }
    if (data.length) chart.timeScale().setVisibleLogicalRange({
      from: Math.max(0, data.length - 140),
      to: data.length + 2
    });

    const ro = new ResizeObserver(() => chart.applyOptions({ width: el.clientWidth }));
    ro.observe(el);
    return () => { ro.disconnect(); extras.forEach(p => series.removePriceLine(p)); chart.remove(); };
  }, [view, zones, analysis]);

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <span className="text-[11.5px] font-bold" style={{ color: 'var(--text-1)' }}>{view.tf}</span>
        <span className="num text-[10.5px]" style={{ color: 'var(--text-3)' }}>
          {view.stats.closedCount} شمعة مغلقة{view.stats.lastClose != null ? ` · إغلاق ${fmtPrice(view.stats.lastClose)}` : ''}
        </span>
      </div>
      <div ref={ref} className="w-full rounded-lg overflow-hidden" style={{ background: 'var(--surface-1)', border: '1px solid var(--border-1)' }} />
    </div>
  );
});

const THERM_LABELS: Record<string, string> = {
  funding: 'التمويل', oi: 'الفائدة المفتوحة', longShort: 'طويل/قصير',
  cvd: 'التدفق التراكمي', book: 'الدفتر', liqClusters: 'كتل السيولة',
  fearGreed: 'الخوف/الطمع', stables: 'العملات المستقرة'
};

/** بطاقة مناخ سوق واحدة */
function ThermCard({ title, ok, text, sub }: { title: string; ok: boolean; text: string; sub?: string }) {
  return (
    <div className="rounded-lg p-2.5 space-y-1" style={{ background: 'var(--surface-1)', border: '1px solid var(--border-1)' }}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10.5px] font-semibold" style={{ color: 'var(--text-2)' }}>{title}</span>
        <span className="text-[10px] px-1.5 py-0.5 rounded-full num" style={ok
          ? { background: 'rgba(38,166,154,0.15)', color: '#26a69a' }
          : { background: 'rgba(127,140,160,0.12)', color: 'var(--text-3)' }}>
          {ok ? 'متوفر' : '—'}
        </span>
      </div>
      <div className="num text-[11.5px] font-bold" style={{ color: ok ? 'var(--text-1)' : 'var(--text-3)' }}>{text}</div>
      {sub && <div className="num text-[10px]" style={{ color: 'var(--text-3)' }}>{sub}</div>}
    </div>
  );
}

function ThermalGrid({ c }: { c: CaseRow }) {
  const th = c.payload.thermal ?? {};
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
      <ThermCard title={THERM_LABELS.funding} ok={!!th.funding}
        text={th.funding ? `${(th.funding.last * 100).toFixed(3)}٪` : 'غير متاح'}
        sub={th.funding ? `مارك: ${fmtPrice(th.funding.markPrice)}` : 'يتطلب fapi'} />
      <ThermCard title={THERM_LABELS.oi} ok={!!th.oi}
        text={th.oi ? `${th.oi.changePct > 0 ? '+' : ''}${th.oi.changePct.toFixed(2)}٪` : 'غير متاح'}
        sub={th.oi?.latest != null ? `أحدث: ${fmtPrice(th.oi.latest)}` : undefined} />
      <ThermCard title={THERM_LABELS.longShort} ok={!!th.longShort}
        text={th.longShort ? `${(th.longShort.last * 100).toFixed(1)}٪` : 'غير متاح'} />
      <ThermCard title={THERM_LABELS.cvd} ok={!!th.cvd}
        text={th.cvd ? `${th.cvd.recentSum > 0 ? '+' : ''}${th.cvd.recentSum.toFixed(0)}` : 'غير متاح'}
        sub={th.cvd?.buyRatioPct != null ? `نسبة الشراء: ${th.cvd.buyRatioPct.toFixed(1)}٪` : undefined} />
      <ThermCard title={THERM_LABELS.book} ok={!!th.book && th.book.book != null}
        text={th.book?.book != null ? `${(th.book.book * 100).toFixed(1)}٪` : 'غير متاح'}
        sub={th.book?.icebergs?.length ? `${th.book.icebergs.length} جبال جليد` : undefined} />
      <ThermCard title={THERM_LABELS.liqClusters} ok={!!th.liqClusters?.length}
        text={th.liqClusters?.length ? `${th.liqClusters.length} كتلة` : 'غير متاح'}
        sub={th.liqClusters?.[0] ? `${th.liqClusters[0].side} عند ${fmtPrice(th.liqClusters[0].price)}` : undefined} />
      <ThermCard title={THERM_LABELS.fearGreed} ok={!!th.fearGreed?.available}
        text={th.fearGreed?.available ? `${th.fearGreed.value} — ${th.fearGreed.classification ?? ''}` : 'غير متاح'} />
      <ThermCard title={THERM_LABELS.stables} ok={!!th.stables?.available}
        text={th.stables?.available ? `${(th.stables.totalMcapUsd! / 1e9).toFixed(1)}B$` : 'غير متاح'}
        sub={th.stables?.pegged?.[0]?.symbol ? `${th.stables.pegged[0].symbol} ${(th.stables.pegged[0].mcapUsd / 1e9).toFixed(2)}B$` : undefined} />
    </div>
  );
}

function CaseDetail({ row, onBack }: { row: CaseRow; onBack: () => void }) {
  const p = row.payload;
  const zones = p.zones ?? [];
  const before = p.analysisBefore ?? null;
  const after = p.analysisAfter ?? null;
  const tfs = Object.keys(p.chart ?? {});
  const [images, setImages] = useState<CaseImage[]>([]);

  useEffect(() => {
    let alive = true;
    setImages([]);
    api.getCase(row.id).then(r => { if (alive) setImages(r.images ?? []); }).catch(() => undefined);
    return () => { alive = false; };
  }, [row.id]);

  const diff = useMemo(() => {
    if (!before || !after) return null;
    const out: string[] = [];
    const keys = ['trend_lower', 'trend_upper', 'ssl_price', 'bsl_price', 'notes'] as const;
    for (const k of keys) {
      if (before[k] !== after[k]) {
        out.push(`${k === 'ssl_price' || k === 'bsl_price' ? (k === 'ssl_price' ? 'SSL' : 'BSL') : k}: ${String(before[k] ?? '—')} ← ${String(after[k] ?? '—')}`);
      }
    }
    return out.length ? out : null;
  }, [before, after]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <button className="btn !py-1.5 !px-3 text-[11.5px]" onClick={onBack}>→ رجوع</button>
        <div className="text-[11px] text-left" style={{ color: 'var(--text-3)' }}>
          {new Date(row.decided_at).toLocaleString('en', { dateStyle: 'medium', timeStyle: 'short' })}
          {p.meta.livePrice != null && <span className="num"> · لحظة القرار: {fmtPrice(p.meta.livePrice)}</span>}
        </div>
      </div>

      {images.length > 0 && (
        <div>
          <div className="text-[11.5px] font-bold mb-1.5" style={{ color: 'var(--text-2)' }}>
            لقطة الشارت لحظة القرار ({images.length})
          </div>
          <div className="grid md:grid-cols-2 gap-3">
            {images.map(img => (
              <div key={img.id} className="space-y-1">
                <span className="text-[11px] font-bold" style={{ color: 'var(--text-2)' }}>الفريم {img.tf}</span>
                <img src={img.data_url} alt={`لقطة ${img.tf}`} className="w-full rounded-lg" style={{ border: '1px solid var(--border-1)' }} />
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="grid md:grid-cols-2 gap-5">
        {tfs.map(tf => (
          <ReplayChart key={tf} view={p.chart[tf]} zones={zones} analysis={before} />
        ))}
        {!tfs.length && (
          <div className="text-[12px] rounded-lg p-3" style={{ background: 'var(--surface-1)', border: '1px dashed var(--border-2)', color: 'var(--text-3)' }}>
            لا توجد لقطة شارت لهذا القرار (لم يكن الشارت مفتوحاً).
          </div>
        )}
      </div>

      {!images.length && tfs.length > 0 && (
        <div className="text-[10.5px]" style={{ color: 'var(--text-3)' }}>
          PNG غير متاح لهذا القرار (التقاط الصور يبدأ من الآن) — يعتمد العرض على إعادة الرسم من البيانات المخزنة.
        </div>
      )}

      <ThermalGrid c={row} />

      {(zones.length > 0) && (
        <div>
          <div className="text-[11.5px] font-bold mb-1.5" style={{ color: 'var(--text-2)' }}>مناطق السيولة وقت القرار ({zones.length})</div>
          <div className="flex flex-wrap gap-1.5">
            {zones.map((z, i) => (
              <span key={i} className="num text-[10.5px] px-2 py-0.5 rounded-full" style={{
                background: z.type === 'BSL' ? 'rgba(242,54,69,0.12)' : 'rgba(8,153,129,0.12)',
                color: ZONE_COLOR[z.type],
                border: `1px solid ${ZONE_COLOR[z.type]}44`
              }}>
                {z.type} {fmtPrice(z.price)}{z.timeframe ? ` · ${z.timeframe}` : ''}{z.swept ? ' · مسحوبة' : ''}
              </span>
            ))}
          </div>
        </div>
      )}

      {before && after && diff && (
        <div className="rounded-lg p-3 space-y-1" style={{ background: 'var(--surface-1)', border: '1px solid var(--border-1)' }}>
          <div className="text-[11.5px] font-bold" style={{ color: 'var(--text-2)' }}>تغييرات خطة التحليل</div>
          {diff.map((d, i) => <div key={i} className="num text-[11px]" style={{ color: 'var(--text-1)' }}>{d}</div>)}
        </div>
      )}

      {p.note && (
        <div className="rounded-lg p-3" style={{ background: 'var(--surface-2)', border: '1px solid var(--border-1)' }}>
          <div className="text-[11px] font-semibold mb-1" style={{ color: 'var(--text-3)' }}>ملاحظة المستخدم</div>
          <div className="text-[12px] leading-relaxed" style={{ color: 'var(--text-1)' }}>{p.note}</div>
        </div>
      )}
    </div>
  );
}

/** قسم القرارات — السجل القائم */
function CasesSection() {
  const cases = useStore(s => s.cases);
  const caseFilter = useStore(s => s.caseFilter);
  const refresh = useStore(s => s.refreshCases);
  const setCaseFilter = useStore(s => s.setCaseFilter);
  const casesLoaded = useStore(s => s.casesLoaded);
  const casesError = useStore(s => s.casesError);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [search, setSearch] = useState('');

  const byActor = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of cases) m.set(c.actor, (m.get(c.actor) ?? 0) + 1);
    return [...m.entries()].map(([k, v]) => ({ actor: k, count: v }));
  }, [cases]);

  const selected = cases.find(c => c.id === selectedId) ?? null;
  const list = (caseFilter ? cases.filter(c => c.symbol === caseFilter) : cases)
    .filter(c => !search || c.symbol.toLowerCase().includes(search.toLowerCase()));

  const exportJson = () => {
    const blob = new Blob([JSON.stringify(list, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `cases-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <span className="text-[12px] font-bold" style={{ color: 'var(--text-1)' }}>{list.length} قرار</span>
          {caseFilter && (
            <button className="mr-2 text-[11px]" onClick={() => setCaseFilter(null)} style={{ color: ZONE_COLOR.BSL }}>
              تصفية: {caseFilter} ✕
            </button>
          )}
        </div>
        <div className="flex items-center gap-2">
          <input className="num px-2 py-1.5 text-[11px] w-32" placeholder="بحث…" value={search} onChange={e => setSearch(e.target.value)} />
          <button className="btn !py-1.5 !px-3 text-[11px]" onClick={() => void refresh()}>تحديث</button>
          <button className="btn !py-1.5 !px-3 text-[11px]" onClick={exportJson}>تصدير JSON</button>
        </div>
      </div>

      {casesError && (
        <div className="badge badge-warn flex items-center gap-2">
          تعذر جلب القرارات: {casesError}
          <button className="underline cursor-pointer" onClick={() => void refresh()}>إعادة المحاولة</button>
        </div>
      )}

      {!casesLoaded ? (
        <SkeletonRow height={64} />
      ) : selected ? (
        <CaseDetail row={selected} onBack={() => setSelectedId(null)} />
      ) : (
        <>
          {byActor.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {byActor.map(({ actor, count }) => (
                <span key={actor} className="text-[10.5px] px-2 py-0.5 rounded-full" style={{ background: 'var(--surface-2)', color: 'var(--text-2)', border: '1px solid var(--border-1)' }}>
                  {ACTOR_LABELS[actor] ?? actor}: {count}
                </span>
              ))}
            </div>
          )}
          <div className="space-y-1.5">
            {list.length === 0 && (
              <div className="text-center text-[12px] py-10" style={{ color: 'var(--text-3)' }}>
                لا قرارات محفوظة بعد — أضف منطقة يدوية أو عدّل خطة تحليل من الشارت ليُسجَّل مقابلها قرار.
              </div>
            )}
            {list.map((c) => (
              <button
                key={c.id}
                className="w-full text-right rounded-xl px-3.5 py-2.5 space-y-1 transition-opacity"
                style={{ background: 'var(--surface-1)', border: '1px solid var(--border-1)' }}
                onClick={() => setSelectedId(c.id)}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="text-[13px] font-bold num" style={{ color: 'var(--text-1)' }}>{c.symbol}</span>
                    <span className="text-[10.5px] px-2 py-0.5 rounded-full" style={{ background: 'var(--surface-2)', color: 'var(--text-2)', border: '1px solid var(--border-1)' }}>
                      {ACTOR_LABELS[c.actor] ?? c.actor}
                    </span>
                  </div>
                  <span className="num text-[10.5px]" style={{ color: 'var(--text-3)' }}>
                    {new Date(c.decided_at).toLocaleString('en', { dateStyle: 'medium', timeStyle: 'short' })}
                  </span>
                </div>
                <div className="flex items-center gap-3 text-[10.5px]" style={{ color: 'var(--text-3)' }}>
                  <span>شموع: {Object.keys(c.payload.chart ?? {}).map(tf => `${tf}:${c.payload.chart?.[tf]?.stats?.closedCount ?? 0}`).join(' | ') || '—'}</span>
                  {c.payload.note && <span className="truncate max-w-40">{c.payload.note}</span>}
                </div>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

export default function CaseLedger() {
  const screen = useStore(s => s.screen);
  const archiveSection = useStore(s => s.archiveSection);
  const setArchiveSection = useStore(s => s.setArchiveSection);
  const caseFilter = useStore(s => s.caseFilter);
  const setScreen = useStore(s => s.setScreen);

  if (screen !== 'cases') return null;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold" style={{ color: 'var(--text-1)' }}>الأرشيف الكامل</h2>
          <p className="text-[11px]" style={{ color: 'var(--text-3)' }}>
            كل ما عاشه النظام مسجّل: قرارات التحليل، نسخ التحديدات اليدوية، ولقطات السجل الإلحاقي المستمر.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {caseFilter && (
            <span className="text-[11px] px-2 py-1 rounded-full num" style={{ background: 'var(--surface-2)', border: '1px solid var(--border-1)', color: 'var(--text-2)' }}>
              العملة: {caseFilter}
            </span>
          )}
          <button className="btn !py-1.5 !px-3 text-[11px]" onClick={() => setScreen('board')}>إغلاق</button>
        </div>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {NAV_TABS.map(t => (
          <button
            key={t.key}
            type="button"
            onClick={() => setArchiveSection(t.key)}
            className="px-3 py-1.5 rounded-lg text-[11.5px] font-semibold transition-colors text-right"
            style={archiveSection === t.key
              ? { background: 'var(--accent)', color: '#fff' }
              : { background: 'var(--surface-1)', border: '1px solid var(--border-1)', color: 'var(--text-2)' }}
            title={t.desc}
          >
            {t.label}
          </button>
        ))}
      </div>

      {archiveSection === 'cases' && <CasesSection />}
      {archiveSection === 'zones' && <ZonesHistory />}
      {archiveSection === 'events' && <EventsLog />}
    </div>
  );
}