import { stateAt, type HistoryElement, type HistoryState } from '../../../../shared/historyModel.mjs';
import type { HistoryStructureEvent, LiquidityHistoryResponse } from '../../lib/liquidityHistory';

interface Props {
  element: HistoryElement;
  data: LiquidityHistoryResponse;
  cursorTime: number;
  replay: boolean;
  onClose: () => void;
  onJump: (time: number) => void;
}

const STATE_AR: Record<HistoryState, string> = {
  pending: 'غير معروفة بعد',
  candidate: 'مرشحة',
  confirmed: 'مؤكدة',
  swept: 'مسحوبة',
  invalidated: 'مبطلة'
};

const fmtTime = (sec: number | null | undefined) => {
  if (sec == null) return '—';
  return new Date(sec * 1000).toLocaleString('ar', { dateStyle: 'short', timeStyle: 'short' });
};
const fmt = (v: number | null | undefined, digits = 7) => (v == null || !Number.isFinite(Number(v)) ? '—' : Number(v).toPrecision(digits));
const fmtPct = (v: number | null | undefined) => (v == null ? '—' : `${(Number(v) * 100).toFixed(1)}%`);

const BASIS_AR: Record<string, string> = {
  engine: 'من المحرك (confirmedAt)',
  final_break_derived: 'مشتق من finalBreak مع اكتمال سلسلة الكسور (المحرك القديم لا يعبّئ confirmedAt للمسحوبة)',
  none: 'غير متاح في مخرجات المحرك',
  pivot: 'تأكيد بيفوت',
  fvg_formed: 'تكون الفجوة (شمعة الإغلاق التالية)',
  close: 'إغلاق الشمعة',
  wick: 'ذيل الشمعة',
  created: 'زمن النشأة فقط'
};

/**
 * لوحة تفاصيل العنصر: تعرض **بيانات المصدر كما وصلت** من المحرك،
 * مع سلسلة التوقيت الحقيقية (نشأة/معرفة/تأكيد/انتهاء) والحالة عند مؤشر الوقت.
 * لا تُحسب أي قيمة جديدة هنا — كل رقم مأخوذ من مخرجات المحرك.
 */
export default function HistoryDetailPanel({ element, data, cursorTime, replay, onClose, onJump }: Props) {
  const current = stateAt(element, cursorTime);
  const raw = element.raw as Record<string, unknown>;
  /**
   * المحرك v2 يرفق بكل منطقة `structureEvents` = كل الأحداث من نشأتها حتى نهاية
   * النافذة، لا أحداثاً مرتبطة بها بعينها. لذلك تُعرض هنا الأحداث الواقعة داخل
   * نطاق حياة المنطقة من القائمة العامة (بيانات المصدر نفسها، بلا صلة مخترعة).
   */
  const zoneStart = element.createdAt ?? element.availableAt;
  /**
   * نهاية نطاق حياة المنطقة لا تتجاوز مؤشر الوقت في وضع التتبع: منطقة سُحبت بعد
   * المؤشر كان نطاقها يمتد إلى ما بعد المؤشر، فتُعرض أحداث لم تقع بعد عند هذه اللحظة.
   */
  const zoneEnd = element.endAt == null
    ? cursorTime
    : (replay ? Math.min(element.endAt, cursorTime) : element.endAt);
  const relatedEvents: HistoryStructureEvent[] = (data.structureEvents ?? []).filter((e) => {
    if (zoneStart == null) return false;
    const at = e.availableAt ?? e.time;
    return at >= zoneStart && (zoneEnd == null || at <= zoneEnd);
  });
  const timeline = [
    { label: 'النشأة (createdAt)', at: element.createdAt, note: 'زمن العنصر السعري — قد يسبق لحظة المعرفة' },
    { label: 'أول معرفة (availableAt)', at: element.availableAt, note: BASIS_AR[String(raw.availableAtBasis ?? element.confirmedBasis ?? 'created')] ?? '—' },
    { label: 'التأكيد (confirmedAt)', at: element.confirmedAt, note: BASIS_AR[element.confirmedBasis] ?? element.confirmedBasis },
    { label: 'السويب (sweptAt)', at: element.sweptAt, note: 'زمن بلوغ سعر السيولة' },
    { label: 'الإبطال (invalidatedAt)', at: element.invalidatedAt, note: 'زمن انتهاء صلاحية العنصر' }
  ].filter((x) => x.at != null);

  return (
    <div className="rounded-xl p-3 space-y-2 text-[11px]" style={{ background: 'var(--surface-1)', border: `1px solid ${element.color}` }} dir="rtl">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[12.5px] font-bold" style={{ color: element.color }}>{element.label}</span>
        <span className="num" style={{ color: 'var(--text-1)' }}>{fmt(element.price ?? element.high)}</span>
        <span className="px-1.5 py-0.5 rounded text-[10px]" style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}>
          عند المؤشر: {STATE_AR[current]}
        </span>
        <span className="px-1.5 py-0.5 rounded text-[10px]" style={{ background: 'var(--surface-0)', color: 'var(--text-2)' }}>
          الحالة النهائية في المحرك: {element.state ?? '—'}
        </span>
        {replay && <span className="px-1.5 py-0.5 rounded text-[10px]" style={{ background: 'var(--warn-soft)', color: '#b45309' }}>وضع التتبع</span>}
        <button onClick={onClose} className="mr-auto px-2 py-0.5 rounded" style={{ background: 'var(--surface-0)', color: 'var(--text-2)', border: '1px solid var(--border-1)' }}>إغلاق ✕</button>
      </div>

      <div className="rounded-lg p-2 space-y-1" style={{ background: 'var(--surface-0)' }}>
        <div className="text-[10.5px] font-semibold" style={{ color: 'var(--text-3)' }}>سلسلة التوقيت الحقيقية</div>
        {timeline.length === 0 && <div style={{ color: 'var(--text-3)' }}>لا أزمنة في مخرجات هذا العنصر</div>}
        {timeline.map((t) => (
          <div key={t.label} className="flex flex-wrap items-center gap-2">
            <span style={{ color: 'var(--text-3)' }}>{t.label}:</span>
            <b className="num" style={{ color: 'var(--text-1)' }}>{fmtTime(t.at)}</b>
            <button onClick={() => onJump(t.at as number)} className="px-1.5 py-0.5 rounded text-[10px]" style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}>انتقل</button>
            <span className="text-[10px]" style={{ color: 'var(--text-3)' }}>{t.note}</span>
          </div>
        ))}
        {raw.detectedAt != null && (
          <div className="text-[10px]" style={{ color: 'var(--text-3)' }}>
            detectedAt (ساعة الخادم عند الحساب): <span className="num">{fmtTime(Number(raw.detectedAt))}</span> — لا يُستخدم في قرار الظهور التاريخي.
          </div>
        )}
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5">
        <Cell label="المستوى المرجعي" value={fmt(element.price)} />
        <Cell label="مستوى السيولة/الوقف" value={fmt(element.liquidity)} />
        <Cell label="المرجع البديل" value={element.priceAlt == null ? '—' : `${fmt(element.priceAlt)} (بلا زمن تكوّن)`} />
        <Cell label="وقف الريتيل" value={fmt(element.retailStop)} />
        <Cell label="حدود المنطقة" value={element.high != null && element.low != null ? `${fmt(element.low)} – ${fmt(element.high)}` : '—'} />
        <Cell label="جسم الشمعة الأصلية" value={element.bodyHigh != null ? `${fmt(element.bodyLow)} – ${fmt(element.bodyHigh)}` : '—'} />
        <Cell label="ATR" value={fmt(element.atr, 6)} />
        <Cell label="المسافة/ATR" value={element.distanceAtr == null ? '—' : Number(element.distanceAtr).toFixed(3)} />
        <Cell label="اللمسات" value={element.touches == null ? '—' : String(element.touches)} />
        <Cell label="الثقة" value={fmtPct(element.confidence)} />
        <Cell label="طريقة التكوين" value={element.formation ?? '—'} />
        <Cell label="الفريم" value={String(raw.timeframe ?? '1m')} />
      </div>

      {Array.isArray(raw.reasons) && (raw.reasons as string[]).length > 0 && (
        <div className="rounded-lg p-2" style={{ background: 'var(--surface-0)' }}>
          <div className="text-[10.5px] font-semibold mb-1" style={{ color: 'var(--text-3)' }}>أسباب المحرك</div>
          <ul className="list-disc pr-4 space-y-0.5" style={{ color: 'var(--text-2)' }}>
            {(raw.reasons as string[]).map((r) => <li key={r}>{r}</li>)}
          </ul>
        </div>
      )}

      {element.points.length > 0 && (
        <div className="rounded-lg p-2" style={{ background: 'var(--surface-0)' }}>
          <div className="text-[10.5px] font-semibold mb-1" style={{ color: 'var(--text-3)' }}>نقاط اللمس/الارتكاز ({element.points.length})</div>
          <div className="flex flex-wrap gap-1.5 num">
            {element.points.map((p) => (
              <button
                key={`${p.time}:${p.price}`}
                onClick={() => onJump(p.time)}
                className="px-1.5 py-0.5 rounded"
                style={{ background: 'var(--surface-1)', border: '1px solid var(--border-1)', color: 'var(--text-2)' }}
                title={`معروفة من: ${fmtTime(p.availableAt)}`}
              >
                {fmt(p.price, 6)} · {fmtTime(p.time)}
              </button>
            ))}
          </div>
        </div>
      )}

      {element.breaks.length > 0 && (
        <div className="rounded-lg p-2" style={{ background: 'var(--surface-0)' }}>
          <div className="text-[10.5px] font-semibold mb-1" style={{ color: 'var(--text-3)' }}>خطوات الكسر بعد كل تكرار</div>
          <div className="flex flex-wrap gap-1.5 num">
            {element.breaks.map((b) => (
              <button key={`${b.time}:${b.price}`} onClick={() => onJump(b.time)} className="px-1.5 py-0.5 rounded" style={{ background: 'var(--surface-1)', border: '1px solid var(--border-1)', color: 'var(--text-2)' }}>
                {fmt(b.price, 6)} · {fmtTime(b.time)}
              </button>
            ))}
          </div>
        </div>
      )}

      {element.fvgs.length > 0 && (
        <div className="rounded-lg p-2" style={{ background: 'var(--surface-0)' }}>
          <div className="text-[10.5px] font-semibold mb-1" style={{ color: 'var(--text-3)' }}>الفجوات المرتبطة ({element.fvgs.length})</div>
          <div className="flex flex-wrap gap-1.5 num">
            {element.fvgs.map((f) => (
              <span key={`${f.index}:${f.kind}`} className="px-1.5 py-0.5 rounded" style={{ background: 'var(--surface-1)', border: '1px solid var(--border-1)', color: 'var(--text-2)' }}>
                {f.kind === 'bullish' ? 'صاعدة' : 'هابطة'} {fmt(f.bottom, 6)}–{fmt(f.top, 6)}
                {f.invalidatedAt ? ` · أُبطلت ${fmtTime(f.invalidatedAt)}` : ''}
              </span>
            ))}
          </div>
        </div>
      )}

      {element.trend && (
        <div className="rounded-lg p-2" style={{ background: 'var(--surface-0)' }}>
          <div className="text-[10.5px] font-semibold mb-1" style={{ color: 'var(--text-3)' }}>
            نقاط خط الاتجاه ({element.trend.points.length}) · الميل {element.trend.slope == null ? '—' : Number(element.trend.slope).toPrecision(6)} سعر/شمعة
          </div>
          <div className="flex flex-wrap gap-1.5 num">
            {element.trend.points.map((p) => (
              <button key={`${p.time}:${p.price}`} onClick={() => onJump(p.time)} className="px-1.5 py-0.5 rounded" style={{ background: 'var(--surface-1)', border: '1px solid var(--border-1)', color: 'var(--text-2)' }}>
                {fmt(p.price, 6)} · {fmtTime(p.time)}
              </button>
            ))}
          </div>
          <div className="mt-1 text-[10px]" style={{ color: 'var(--text-3)' }}>
            الإسقاط المخزّن في المحرك ({fmt(element.trend.projected, 6)}) محسوب عند آخر شمعة في النافذة — لا يُستخدم للرسم عند لحظة سابقة.
          </div>
        </div>
      )}

      {relatedEvents.length > 0 && (
        <div className="rounded-lg p-2" style={{ background: 'var(--surface-0)' }}>
          <div className="text-[10.5px] font-semibold mb-1" style={{ color: 'var(--text-3)' }}>أحداث البنية داخل نطاق حياة المنطقة ({relatedEvents.length})</div>
          <div className="text-[10px] mb-1" style={{ color: 'var(--text-3)' }}>
            تُعرض من قائمة الأحداث العامة حسب زمن وقوعها بين نشأة المنطقة ونهايتها — المحرك يرفق بكل منطقة كل الأحداث بعد نشأتها لا صلة محددة.
          </div>
          <div className="space-y-0.5">
            {relatedEvents.slice(0, 20).map((e) => (
              <div key={e.key} className="flex flex-wrap items-center gap-2">
                <b style={{ color: 'var(--text-1)' }}>{e.type}</b>
                <span className="num" style={{ color: 'var(--text-2)' }}>{fmt(e.price, 6)}</span>
                <button onClick={() => onJump(e.time)} className="px-1.5 py-0.5 rounded text-[10px]" style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}>شمعة الحدث</button>
                <span className="text-[10px]" style={{ color: 'var(--text-3)' }}>
                  {fmtTime(e.time)} · كسر {e.confirmBasis ?? '—'} · المستوى المكسور {fmt(e.brokenLevel, 6)}
                  {e.brokenTime ? ` · زمن كسر IDM ${fmtTime(e.brokenTime)}` : ''}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      <details className="rounded-lg p-2" style={{ background: 'var(--surface-0)' }}>
        <summary className="cursor-pointer text-[10.5px] font-semibold" style={{ color: 'var(--text-3)' }}>بيانات المصدر الكاملة (JSON)</summary>
        <pre className="mt-1 overflow-x-auto text-[9.5px] num" style={{ color: 'var(--text-2)', direction: 'ltr' }}>{JSON.stringify(element.raw, null, 1)}</pre>
      </details>
    </div>
  );
}

function Cell({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded px-2 py-1" style={{ background: 'var(--surface-0)' }}>
      <div className="text-[9.5px]" style={{ color: 'var(--text-3)' }}>{label}</div>
      <div className="num" style={{ color: 'var(--text-1)' }}>{value}</div>
    </div>
  );
}
