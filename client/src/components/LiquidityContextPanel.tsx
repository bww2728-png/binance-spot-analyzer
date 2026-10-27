import { useEffect, useState } from 'react';
import { fetchLiquidityWorkbenchContext, type LiquidityWorkbenchContext, type LiquidityWorkbenchZone } from '../lib/liquidityWorkbench';

const kindLabel: Record<string, string> = {
  horizontal_bsl: 'سيولة BSL أفقية',
  horizontal_ssl: 'سيولة SSL أفقية',
  trendline_bsl: 'خط اتجاه BSL',
  trendline_ssl: 'خط اتجاه SSL',
  supply: 'عرض',
  demand: 'طلب'
};

const formatPrice = (value: number | null | undefined) => value == null || !Number.isFinite(Number(value)) ? '—' : Number(value).toLocaleString('en-US', { maximumFractionDigits: 8 });
const formatAge = (value: number | null | undefined) => value == null ? 'غير معروف' : `${Math.max(0, Math.floor((Date.now() - value) / 1000))} ثانية`;

function EngineZones({ title, zones }: { title: string; zones: LiquidityWorkbenchZone[] }) {
  return (
    <div>
      <div className="flex items-center justify-between text-[11px] font-bold" style={{ color: 'var(--text-1)' }}>
        <span>{title}</span><span className="num">{zones.length}</span>
      </div>
      {zones.length === 0 ? <div className="text-[11px] mt-1" style={{ color: 'var(--text-3)' }}>لا توجد مناطق في آخر مسح متاح.</div> : (
        <div className="mt-1 space-y-1">
          {zones.slice(0, 6).map((zone) => (
            <div key={`${zone.engine}:${zone.id}`} className="flex flex-wrap items-center justify-between gap-x-2 text-[10.5px]" style={{ color: 'var(--text-2)' }}>
              <span>{kindLabel[zone.kind] ?? zone.kind} · {zone.state ?? 'حالة غير محددة'}</span>
              <span className="num">{formatPrice(zone.referenceLevel ?? zone.liquidityLevel)}</span>
            </div>
          ))}
          {zones.length > 6 && <div className="text-[10px]" style={{ color: 'var(--text-3)' }}>و{zones.length - 6} مناطق أخرى غير مفصلة هنا.</div>}
        </div>
      )}
    </div>
  );
}

export default function LiquidityContextPanel({ symbol, timeframe }: { symbol: string; timeframe: string }) {
  const [expanded, setExpanded] = useState(false);
  const [context, setContext] = useState<LiquidityWorkbenchContext | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!expanded) return;
    const controller = new AbortController();
    let firstLoad = true;
    let active = false;
    const load = async () => {
      if (active || controller.signal.aborted) return;
      active = true;
      if (firstLoad) setLoading(true);
      setError(null);
      try {
        setContext(await fetchLiquidityWorkbenchContext(symbol, timeframe, controller.signal));
      } catch (reason) {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : 'تعذر تحميل سياق السيولة');
      } finally {
        if (!controller.signal.aborted && firstLoad) setLoading(false);
        firstLoad = false;
        active = false;
      }
    };
    void load();
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, 15_000);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [expanded, symbol, timeframe]);

  return (
    <div className="rounded-lg p-2.5" style={{ background: 'var(--surface-0)', border: '1px solid var(--border-1)' }}>
      <button onClick={() => setExpanded((value) => !value)} className="w-full flex items-center justify-between gap-2 text-[11px] font-bold" style={{ color: 'var(--text-1)' }} aria-expanded={expanded}>
        <span>سياق مناطق السيولة · {symbol} · {timeframe}</span><span>{expanded ? 'إخفاء' : 'عرض'}</span>
      </button>
      {expanded && (
        <div className="mt-2 space-y-2">
          <div className="text-[10px] leading-4" style={{ color: 'var(--text-3)' }}>عرض وصفي مستقل من Workbench؛ لا يثبت ارتباطًا سببيًا بهذه الفرصة ولا يغيّر قرارات أي محرك.</div>
          {loading && <div className="text-[11px]" style={{ color: 'var(--text-2)' }}>جارٍ تحميل السياق…</div>}
          {error && <div className="text-[11px]" style={{ color: 'var(--down)' }}>{error}</div>}
          {!loading && !error && context && !context.available && <div className="text-[11px]" style={{ color: 'var(--text-3)' }}>لا تتوفر بيانات Workbench لهذا الرمز/الفريم ({context.reason === 'symbol_not_monitored' ? 'الرمز غير مراقب' : 'الفريم غير مدعوم'}).</div>}
          {!loading && !error && context?.available && (
            <>
              <div className="text-[10px] num" style={{ color: 'var(--text-3)' }}>الحالة: {context.recovery ?? 'غير معروفة'} · آخر مسح: {formatAge(context.latestScan)} · التخزين: {context.persistence ?? 'غير معروف'}</div>
              {context.recovery !== 'ready' && <div className="text-[10px]" style={{ color: 'var(--warn)' }}>الخدمة ليست في حالة جاهزية كاملة؛ اعتبر النتائج السابقة قديمة أو غير مكتملة.</div>}
              {context.latestScan == null ? <div className="text-[11px]" style={{ color: 'var(--text-3)' }}>لم تتوفر دورة مسح مكتملة بعد؛ هذا لا يعني أن السوق خالٍ من المناطق.</div> : <>
                <EngineZones title="المحرك V1" zones={context.legacy ?? []} />
                <EngineZones title="المحرك V2" zones={context.v2 ?? []} />
              </>}
            </>
          )}
        </div>
      )}
    </div>
  );
}
