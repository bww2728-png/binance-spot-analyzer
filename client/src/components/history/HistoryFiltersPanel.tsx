import type { HistoryFilters, HistoryMeta, SelectionCounts } from '../../../../shared/historyModel.mjs';

interface Options {
  types: Array<{ id: string; label: string; color: string; count: number }>;
  states: Array<{ id: string; label: string }>;
  formations: Array<{ id: string; label: string }>;
}

interface Props {
  open: boolean;
  onToggle: () => void;
  options: Options;
  filters: HistoryFilters;
  meta: HistoryMeta;
  counts: SelectionCounts;
  range: { from: number; to: number };
  onChange: (next: HistoryFilters) => void;
  onReset: () => void;
}

const chipStyle = (on: boolean, color?: string) => ({
  background: on ? 'var(--accent-soft)' : 'var(--surface-0)',
  color: on ? (color ?? 'var(--accent)') : 'var(--text-3)',
  border: `1px solid ${on ? (color ?? 'var(--accent)') : 'var(--border-1)'}`
});

const fmtTime = (sec: number | null) => {
  if (sec == null) return '—';
  const d = new Date(sec * 1000);
  return d.toLocaleString('ar', { dateStyle: 'short', timeStyle: 'short' });
};

/** تحويل ثوانٍ إلى قيمة حقل datetime-local بالتوقيت المحلي */
const toLocalInput = (sec: number | null) => {
  if (sec == null) return '';
  const d = new Date(sec * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const fromLocalInput = (v: string) => {
  if (!v) return null;
  const ms = new Date(v).getTime();
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
};

/**
 * لوحة فلاتر الشارت التاريخي — تعمل على مجموعة العرض فقط.
 * لا تعيد حساب المحرك ولا تحذف بيانات: كل خيار يخفي/يظهر عناصر ويعرض عدّادها.
 */
export default function HistoryFiltersPanel({
  open, onToggle, options, filters, meta, counts, range, onChange, onReset
}: Props) {
  const set = (patch: Partial<HistoryFilters>) => onChange({ ...filters, ...patch });
  const setAppearance = (patch: Partial<HistoryFilters['appearance']>) => onChange({ ...filters, appearance: { ...filters.appearance, ...patch } });
  const typeOn = (id: string) => filters.types[id] !== false;
  const stateOn = (id: string) => filters.states[id] !== false;
  const formationOn = (id: string) => filters.formations[id] !== false;
  const activeCount = [
    Object.values(filters.types).filter((v) => v === false).length > 0,
    Object.values(filters.states).filter((v) => v === false).length > 0,
    Object.values(filters.formations).filter((v) => v === false).length > 0,
    filters.minTouches > 0,
    filters.minConfidence > 0,
    filters.timeFrom != null || filters.timeTo != null,
    filters.side !== 'all' || filters.priceMin != null || filters.priceMax != null || filters.atrDistance != null,
    !filters.showHistory,
    filters.confirmedOnly,
    filters.untimed
  ].filter(Boolean).length;

  return (
    <div className="rounded-xl" style={{ background: 'var(--surface-1)', border: '1px solid var(--border-1)' }}>
      <button
        onClick={onToggle}
        className="w-full flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-[12px] font-bold"
        style={{ color: 'var(--text-1)' }}
      >
        <span>
          {open ? '▾' : '▸'} الفلاتر والتحكم بالعرض
          {activeCount > 0 && <span className="mr-2 px-1.5 py-0.5 rounded text-[10px]" style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}>{activeCount} مفعّل</span>}
        </span>
        <span className="text-[10.5px] font-normal num" style={{ color: 'var(--text-3)' }}>
          إجمالي {counts.total} · مرئي {counts.visible} · مخفي {Object.values(counts.hidden).reduce((a, b) => a + b, 0)}
        </span>
      </button>

      {open && (
        <div className="px-3 pb-3 space-y-3 text-[11px]">
          {/* الأنواع */}
          <Group title="أنواع العناصر (من مخرجات المحرك المختار فقط)">
            <div className="flex flex-wrap gap-1.5">
              {options.types.map((t) => (
                <button
                  key={t.id}
                  onClick={() => set({ types: { ...filters.types, [t.id]: !typeOn(t.id) } })}
                  className="px-2 py-1 rounded-lg text-[10.5px] font-semibold num"
                  style={chipStyle(typeOn(t.id), t.color)}
                  title={`${t.count} عنصراً من هذا النوع في البيانات`}
                >
                  {typeOn(t.id) ? '✓ ' : '✕ '}{t.label} <span style={{ opacity: 0.7 }}>({t.count})</span>
                </button>
              ))}
              <button
                onClick={() => set({ types: Object.fromEntries(options.types.map((t) => [t.id, false])) })}
                className="px-2 py-1 rounded-lg text-[10.5px]"
                style={{ background: 'var(--surface-0)', color: 'var(--text-3)', border: '1px solid var(--border-1)' }}
              >إخفاء الكل</button>
              <button
                onClick={() => set({ types: {} })}
                className="px-2 py-1 rounded-lg text-[10.5px]"
                style={{ background: 'var(--surface-0)', color: 'var(--text-3)', border: '1px solid var(--border-1)' }}
              >إظهار الكل</button>
            </div>
          </Group>

          {/* الحالات */}
          <Group title="الحالات (تُقيَّم عند مؤشر الوقت — لا الحالة النهائية)">
            <div className="flex flex-wrap gap-1.5">
              {options.states.map((s) => (
                <button
                  key={s.id}
                  onClick={() => set({ states: { ...filters.states, [s.id]: !stateOn(s.id) } })}
                  className="px-2 py-1 rounded-lg text-[10.5px] font-semibold"
                  style={chipStyle(stateOn(s.id))}
                >
                  {stateOn(s.id) ? '✓ ' : '✕ '}{s.label}
                </button>
              ))}
              <label className="flex items-center gap-1 px-2 py-1 rounded-lg" style={{ background: 'var(--surface-0)', border: '1px solid var(--border-1)', color: 'var(--text-2)' }}>
                <input type="checkbox" checked={filters.confirmedOnly} onChange={(e) => set({ confirmedOnly: e.target.checked })} />
                المؤكدة فقط
              </label>
            </div>
          </Group>

          {/* التكوين */}
          {options.formations.length > 1 && (
            <Group title="طريقة التكوين (كما يسمّيها المحرك، لا من الشكل البصري)">
              <div className="flex flex-wrap gap-1.5">
                {options.formations.map((f) => (
                  <button
                    key={f.id}
                    onClick={() => set({ formations: { ...filters.formations, [f.id]: !formationOn(f.id) } })}
                    className="px-2 py-1 rounded-lg text-[10.5px] font-semibold"
                    style={chipStyle(formationOn(f.id))}
                  >
                    {formationOn(f.id) ? '✓ ' : '✕ '}{f.label}
                  </button>
                ))}
              </div>
            </Group>
          )}

          {/* القوة */}
          <Group title="القوة (من حقول المحرك: اللمسات والثقة)">
            <div className="flex flex-wrap items-center gap-3">
              <label className="flex items-center gap-1.5">
                <span style={{ color: 'var(--text-3)' }}>أقل عدد لمسات</span>
                <select
                  value={filters.minTouches}
                  onChange={(e) => set({ minTouches: Number(e.target.value) })}
                  className="px-2 py-1 rounded-lg num"
                  style={{ background: 'var(--surface-0)', border: '1px solid var(--border-1)', color: 'var(--text-1)' }}
                >
                  {[0, 2, 3, 4, 5].map((v) => <option key={v} value={v}>{v === 0 ? 'بلا حد' : v}</option>)}
                </select>
              </label>
              <label className="flex items-center gap-1.5">
                <span style={{ color: 'var(--text-3)' }}>أقل ثقة {(filters.minConfidence * 100).toFixed(0)}%</span>
                <input
                  type="range" min={0} max={0.95} step={0.05}
                  value={filters.minConfidence}
                  onChange={(e) => set({ minConfidence: Number(e.target.value) })}
                />
              </label>
            </div>
          </Group>

          {/* الزمن */}
          <Group title={`الزمن (نطاق البيانات: ${fmtTime(range.from)} → ${fmtTime(range.to)})`}>
            <div className="flex flex-wrap items-center gap-2">
              <label className="flex items-center gap-1">
                <span style={{ color: 'var(--text-3)' }}>من</span>
                <input
                  type="datetime-local"
                  value={toLocalInput(filters.timeFrom)}
                  onChange={(e) => set({ timeFrom: fromLocalInput(e.target.value) })}
                  className="px-2 py-1 rounded-lg num"
                  style={{ background: 'var(--surface-0)', border: '1px solid var(--border-1)', color: 'var(--text-1)' }}
                />
              </label>
              <label className="flex items-center gap-1">
                <span style={{ color: 'var(--text-3)' }}>إلى</span>
                <input
                  type="datetime-local"
                  value={toLocalInput(filters.timeTo)}
                  onChange={(e) => set({ timeTo: fromLocalInput(e.target.value) })}
                  className="px-2 py-1 rounded-lg num"
                  style={{ background: 'var(--surface-0)', border: '1px solid var(--border-1)', color: 'var(--text-1)' }}
                />
              </label>
              {[500, 2000, 5000].map((n) => (
                <button
                  key={n}
                  onClick={() => set({ timeFrom: Math.max(range.from, range.to - n * 60), timeTo: null })}
                  className="px-2 py-1 rounded-lg num"
                  style={{ background: 'var(--surface-0)', border: '1px solid var(--border-1)', color: 'var(--text-2)' }}
                >آخر {n} شمعة</button>
              ))}
              {(filters.timeFrom != null || filters.timeTo != null) && (
                <button
                  onClick={() => set({ timeFrom: null, timeTo: null })}
                  className="px-2 py-1 rounded-lg"
                  style={{ background: 'var(--surface-0)', border: '1px solid var(--border-1)', color: 'var(--text-3)' }}
                >مسح</button>
              )}
            </div>
          </Group>

          {/* السعر */}
          <Group title="السعر (مقارنة بمستويات المحرك)">
            <div className="flex flex-wrap items-center gap-2">
              <select
                value={filters.side}
                onChange={(e) => set({ side: e.target.value as HistoryFilters['side'] })}
                className="px-2 py-1 rounded-lg"
                style={{ background: 'var(--surface-0)', border: '1px solid var(--border-1)', color: 'var(--text-1)' }}
              >
                <option value="all">كل المستويات</option>
                <option value="above">فوق السعر الحالي</option>
                <option value="below">تحت السعر الحالي</option>
              </select>
              <label className="flex items-center gap-1">
                <span style={{ color: 'var(--text-3)' }}>أدنى</span>
                <input
                  value={filters.priceMin ?? ''}
                  onChange={(e) => set({ priceMin: e.target.value === '' ? null : Number(e.target.value) })}
                  className="px-2 py-1 rounded-lg num w-24"
                  style={{ background: 'var(--surface-0)', border: '1px solid var(--border-1)', color: 'var(--text-1)' }}
                  placeholder="—"
                />
              </label>
              <label className="flex items-center gap-1">
                <span style={{ color: 'var(--text-3)' }}>أقصى</span>
                <input
                  value={filters.priceMax ?? ''}
                  onChange={(e) => set({ priceMax: e.target.value === '' ? null : Number(e.target.value) })}
                  className="px-2 py-1 rounded-lg num w-24"
                  style={{ background: 'var(--surface-0)', border: '1px solid var(--border-1)', color: 'var(--text-1)' }}
                  placeholder="—"
                />
              </label>
              <label className="flex items-center gap-1">
                <span style={{ color: 'var(--text-3)' }}>ضمن ATR ×</span>
                <input
                  value={filters.atrDistance ?? ''}
                  onChange={(e) => set({ atrDistance: e.target.value === '' ? null : Number(e.target.value) })}
                  className="px-2 py-1 rounded-lg num w-16"
                  style={{ background: 'var(--surface-0)', border: '1px solid var(--border-1)', color: 'var(--text-1)' }}
                  placeholder="—"
                  title="المسافة بين منتصف العنصر وسعر المؤشر مقسومة على ATR الخاص بالعنصر"
                />
              </label>
            </div>
          </Group>

          {/* المظهر */}
          <Group title="المظهر (لا يغيّر أي قيمة)">
            <div className="flex flex-wrap items-center gap-3">
              <label className="flex items-center gap-1.5">
                <span style={{ color: 'var(--text-3)' }}>الشفافية {(filters.appearance.opacity * 100).toFixed(0)}%</span>
                <input type="range" min={0.15} max={1} step={0.05} value={filters.appearance.opacity} onChange={(e) => setAppearance({ opacity: Number(e.target.value) })} />
              </label>
              <label className="flex items-center gap-1.5">
                <span style={{ color: 'var(--text-3)' }}>سمك الخطوط {filters.appearance.lineWidth.toFixed(1)}</span>
                <input type="range" min={0.5} max={3} step={0.25} value={filters.appearance.lineWidth} onChange={(e) => setAppearance({ lineWidth: Number(e.target.value) })} />
              </label>
              {([
                ['labels', 'النصوص'],
                ['touchPoints', 'نقاط اللمس والكسور'],
                ['alt', 'المرجع البديل'],
                ['fvg', 'تفاصيل FVG'],
                ['body', 'جسم الشمعة الأصلية'],
                ['extend', 'تمديد المناطق']
              ] as Array<[keyof HistoryFilters['appearance'], string]>).map(([key, label]) => (
                <label key={key} className="flex items-center gap-1 px-2 py-1 rounded-lg" style={{ background: 'var(--surface-0)', border: '1px solid var(--border-1)', color: 'var(--text-2)' }}>
                  <input type="checkbox" checked={Boolean(filters.appearance[key])} onChange={(e) => setAppearance({ [key]: e.target.checked })} />
                  {label}
                </label>
              ))}
            </div>
          </Group>

          {/* العرض التاريخي */}
          <Group title="العرض التاريخي">
            <div className="flex flex-wrap items-center gap-2">
              <label className="flex items-center gap-1 px-2 py-1 rounded-lg" style={{ background: 'var(--surface-0)', border: '1px solid var(--border-1)', color: 'var(--text-2)' }}>
                <input type="checkbox" checked={filters.showHistory} onChange={(e) => set({ showHistory: e.target.checked })} />
                إظهار العناصر المنتهية (مسحوبة/مبطلة)
              </label>
              <label
                className="flex items-center gap-1 px-2 py-1 rounded-lg"
                style={{ background: 'var(--surface-0)', border: '1px solid var(--border-1)', color: filters.untimed ? 'var(--text-2)' : 'var(--text-3)' }}
                title="المرجع البديل ينتجه المحرك بلا زمن تكوّن — إظهاره في وضع التتبع قد يوحي بمعرفة سابقة"
              >
                <input type="checkbox" checked={filters.untimed} onChange={(e) => set({ untimed: e.target.checked })} />
                العناصر غير المؤرخة في وضع التتبع
              </label>
              <span className="px-2 py-1 rounded-lg" style={{ background: 'var(--surface-0)', border: '1px dashed var(--border-1)', color: 'var(--text-3)' }}>
                الفريم: 1m فقط — خدمة التاريخ لا تدعم غيره
              </span>
            </div>
          </Group>

          {/* عدّادات الإخفاء */}
          <div className="rounded-lg px-2 py-1.5 num text-[10.5px] flex flex-wrap gap-x-3 gap-y-1" style={{ background: 'var(--surface-0)', color: 'var(--text-3)' }}>
            <span>إجمالي: <b style={{ color: 'var(--text-1)' }}>{counts.total}</b></span>
            <span>مرئي: <b style={{ color: 'var(--up)' }}>{counts.visible}</b></span>
            {counts.hidden.replay > 0 && <span>لم يقع بعد: <b>{counts.hidden.replay}</b></span>}
            {counts.hidden.type > 0 && <span>نوع: <b>{counts.hidden.type}</b></span>}
            {counts.hidden.state > 0 && <span>حالة: <b>{counts.hidden.state}</b></span>}
            {counts.hidden.formation > 0 && <span>تكوين: <b>{counts.hidden.formation}</b></span>}
            {counts.hidden.strength > 0 && <span>قوة: <b>{counts.hidden.strength}</b></span>}
            {counts.hidden.time > 0 && <span>زمن: <b>{counts.hidden.time}</b></span>}
            {counts.hidden.price > 0 && <span>سعر: <b>{counts.hidden.price}</b></span>}
            {counts.hidden.history > 0 && <span>منتهية: <b>{counts.hidden.history}</b></span>}
            {counts.hidden.untimed > 0 && <span>غير مؤرخة: <b>{counts.hidden.untimed}</b></span>}
            <button onClick={onReset} className="mr-auto px-2 py-0.5 rounded" style={{ background: 'var(--surface-1)', border: '1px solid var(--border-1)', color: 'var(--text-2)' }}>استعادة الافتراضي</button>
          </div>

          {meta.gaps.length > 0 && (
            <details className="rounded-lg px-2 py-1.5" style={{ background: 'var(--warn-soft)', color: 'var(--text-2)' }}>
              <summary className="cursor-pointer text-[10.5px] font-semibold">فجوات بيانات موثقة ({meta.gaps.length}) — لا تُخترع لها قيم</summary>
              <ul className="mt-1 space-y-0.5 list-disc pr-4 text-[10.5px]">
                {meta.gaps.map((g) => <li key={g}>{g}</li>)}
              </ul>
            </details>
          )}
        </div>
      )}
    </div>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <div className="text-[10.5px] font-semibold" style={{ color: 'var(--text-3)' }}>{title}</div>
      {children}
    </div>
  );
}
