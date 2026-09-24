import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import type { BuyHistoryResponse } from '../lib/types';

/* ═══ لوحة تحكم الفرص الحية — تقويم · توزيع ساعات · KPIs · جدول زمني مفلتر ═══
 * التجميع كله محلياً (توقيت الجهاز) — الخادم يعيد الأحداث الخام من سجل الأحداث الدائم.
 */

const TIER_STYLE: Record<string, { label: string; color: string }> = {
  qualified: { label: 'مؤهلة ≥60%', color: '#0a7f6a' },
  probationary: { label: 'تحت التجربة', color: '#b45309' }
};

const OUTCOME_STYLE: Record<string, { label: string; color: string }> = {
  target: { label: 'الهدف', color: '#0a7f6a' },
  stop: { label: 'الوقف', color: '#dc2626' }
};

const fmt = (v: number | null | undefined, d = 2) => (v == null || !Number.isFinite(Number(v)) ? '—' : Number(v).toFixed(d));
const fmtPx = (v: number | null | undefined) => (v == null ? '—' : Number(v) >= 100 ? Number(v).toFixed(2) : Number(v).toPrecision(6));

function localDayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function csvCell(v: string): string {
  return `"${v.replace(/"/g, '""')}"`;
}

export default function LiveDashboard({ refreshKey = 0 }: { refreshKey?: number }) {
  const [history, setHistory] = useState<BuyHistoryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [monthOffset, setMonthOffset] = useState(0); // 0 = الشهر الحالي
  const [dayFilter, setDayFilter] = useState<string | null>(null);
  const [symbolFilter, setSymbolFilter] = useState('');
  const [tfFilter, setTfFilter] = useState('');
  const [tierFilter, setTierFilter] = useState<'all' | 'qualified' | 'probationary'>('all');
  const [outcomeFilter, setOutcomeFilter] = useState<'all' | 'target' | 'stop' | 'open'>('all');

  const load = useCallback(async () => {
    try {
      setError(null);
      setHistory(await api.getBuyHistoryEvents(90));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'فشل جلب السجل');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load, refreshKey]);
  useEffect(() => {
    const id = window.setInterval(() => { void load(); }, 60_000);
    return () => window.clearInterval(id);
  }, [load]);

  const all = history?.timeline ?? [];

  const filtered = useMemo(() => all.filter(e =>
    (!dayFilter || localDayKey(e.ts) === dayFilter)
    && (!symbolFilter || e.symbol.toLowerCase().includes(symbolFilter.trim().toLowerCase()))
    && (!tfFilter || e.timeframe === tfFilter)
    && (tierFilter === 'all' || (e.tier ?? 'probationary') === tierFilter)
    && (outcomeFilter === 'all'
      || (outcomeFilter === 'open' ? e.outcome == null : e.outcome === outcomeFilter))
  ), [all, dayFilter, symbolFilter, tfFilter, tierFilter, outcomeFilter]);

  /* ---- KPIs ---- */
  const kpis = useMemo(() => {
    const now = Date.now();
    const weekAgo = now - 7 * 86_400_000;
    const resolved = all.filter(e => e.outcome != null);
    const wins = resolved.filter(e => e.outcome === 'target').length;
    const byTier: Record<string, { n: number; w: number }> = {};
    for (const e of resolved) {
      const t = e.tier ?? 'probationary';
      byTier[t] = byTier[t] ?? { n: 0, w: 0 };
      byTier[t].n += 1;
      if (e.outcome === 'target') byTier[t].w += 1;
    }
    const durations = resolved.map(e => e.durationMs).filter((v): v is number => v != null && v > 0);
    return {
      total: all.length,
      week: all.filter(e => e.ts >= weekAgo).length,
      resolved: resolved.length,
      wins,
      winRate: resolved.length ? wins / resolved.length : null,
      qualifiedWr: byTier.qualified?.n ? byTier.qualified.w / byTier.qualified.n : null,
      probationaryWr: byTier.probationary?.n ? byTier.probationary.w / byTier.probationary.n : null,
      avgDurationMs: durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : null,
      active: history?.active.length ?? 0
    };
  }, [all, history]);

  /* ---- التقويم الشهري (ميلادي، توقيت محلي) ---- */
  const calendar = useMemo(() => {
    const base = new Date();
    base.setDate(1);
    base.setMonth(base.getMonth() + monthOffset);
    const year = base.getFullYear();
    const month = base.getMonth();
    const firstDow = new Date(year, month, 1).getDay(); // 0=الأحد
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const byDay = new Map<string, { total: number; target: number; stop: number; open: number }>();
    for (const e of all) {
      const k = localDayKey(e.ts);
      const cell = byDay.get(k) ?? { total: 0, target: 0, stop: 0, open: 0 };
      cell.total += 1;
      if (e.outcome === 'target') cell.target += 1;
      else if (e.outcome === 'stop') cell.stop += 1;
      else cell.open += 1;
      byDay.set(k, cell);
    }
    const cells: { day: number; key: string | null; stat: { total: number; target: number; stop: number; open: number } | null }[] = [];
    for (let i = 0; i < firstDow; i += 1) cells.push({ day: 0, key: null, stat: null });
    for (let d = 1; d <= daysInMonth; d += 1) {
      const key = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      cells.push({ day: d, key, stat: byDay.get(key) ?? null });
    }
    return { year, month, cells, label: base.toLocaleDateString('ar', { month: 'long', year: 'numeric' }) };
  }, [all, monthOffset]);

  /* ---- توزيع الساعات (0-23 محلي) ---- */
  const byHour = useMemo(() => {
    const arr = Array.from({ length: 24 }, () => ({ total: 0, target: 0 }));
    for (const e of all) {
      const h = new Date(e.ts).getHours();
      arr[h].total += 1;
      if (e.outcome === 'target') arr[h].target += 1;
    }
    return arr;
  }, [all]);
  const hourMax = Math.max(1, ...byHour.map(h => h.total));

  const exportCsv = () => {
    const header = ['الوقت', 'الرمز', 'الفريم', 'الطبقة', 'الدخول', 'الوقف', 'الهدف', 'R:R', 'النتيجة', 'المدة (د)', 'MFE(R)', 'MAE(R)', 'نسبة معايَرة'];
    const lines = [header.map(csvCell).join(',')];
    for (const e of [...filtered].sort((a, b) => a.ts - b.ts)) {
      lines.push([
        new Date(e.ts).toISOString(),
        e.symbol, e.timeframe ?? '', e.tier ?? '',
        e.entry ?? '', e.stop ?? '', e.tp ?? '', e.rr ?? '',
        e.outcome ? OUTCOME_STYLE[e.outcome].label : 'قيد المتابعة',
        e.durationMs ? Math.round(e.durationMs / 60_000) : '',
        e.mfeR ?? '', e.maeR ?? '',
        e.calibratedWinRate != null ? `${(e.calibratedWinRate * 100).toFixed(1)}%` : ''
      ].map(v => csvCell(String(v))).join(','));
    }
    const blob = new Blob(['\ufeff' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `live-opportunities-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const symbols = useMemo(() => [...new Set(all.map(e => e.symbol))].sort(), [all]);
  const timeframes = useMemo(() => [...new Set(all.map(e => e.timeframe).filter((v): v is string => !!v))], [all]);

  return (
    <div className="space-y-4">
      {/* KPIs */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2.5">
        <KpiCard label="إجمالي الفرص (90 يوماً)" value={String(kpis.total)} color="var(--accent)" />
        <KpiCard label="هذا الأسبوع" value={String(kpis.week)} color="var(--text-1)" />
        <KpiCard label="نسبة النجاح الحية" value={kpis.winRate != null ? `${(kpis.winRate * 100).toFixed(0)}%` : '—'} sub={`${kpis.wins}/${kpis.resolved}`} color={kpis.winRate != null && kpis.winRate >= 0.6 ? 'var(--up)' : 'var(--warn)'} />
        <KpiCard label="مؤهلة / تجريبية" value={`${kpis.qualifiedWr != null ? `${(kpis.qualifiedWr * 100).toFixed(0)}%` : '—'} · ${kpis.probationaryWr != null ? `${(kpis.probationaryWr * 100).toFixed(0)}%` : '—'}`} color="var(--text-1)" />
        <KpiCard label="متوسط زمن الحسم" value={kpis.avgDurationMs != null ? `${Math.round(kpis.avgDurationMs / 60_000)} د` : '—'} color="var(--text-1)" />
        <KpiCard label="نشطة الآن" value={String(kpis.active)} color="var(--up)" />
      </div>

      {loading && <div className="text-[12px]" style={{ color: 'var(--text-3)' }}>جارٍ جلب السجل…</div>}
      {error && <div className="text-[12px]" style={{ color: 'var(--down)' }}>{error}</div>}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* التقويم الشهري */}
        <div className="card p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="text-[13px] font-bold" style={{ color: 'var(--text-1)' }}>التقويم — {calendar.label}</div>
            <div className="flex gap-1">
              <button onClick={() => setMonthOffset(v => v - 1)} className="px-2 py-1 rounded text-[12px]" style={{ background: 'var(--surface-0)', border: '1px solid var(--border-1)', color: 'var(--text-2)' }}>‹ السابق</button>
              <button onClick={() => setMonthOffset(0)} disabled={monthOffset === 0} className="px-2 py-1 rounded text-[11px]" style={{ background: 'var(--surface-0)', border: '1px solid var(--border-1)', color: monthOffset === 0 ? 'var(--text-3)' : 'var(--text-2)' }}>الشهر الحالي</button>
              <button onClick={() => setMonthOffset(v => Math.min(0, v + 1))} disabled={monthOffset >= 0} className="px-2 py-1 rounded text-[12px]" style={{ background: 'var(--surface-0)', border: '1px solid var(--border-1)', color: monthOffset >= 0 ? 'var(--text-3)' : 'var(--text-2)' }}>التالي ›</button>
            </div>
          </div>
          <div className="grid grid-cols-7 gap-1 text-center text-[10px] font-bold mb-1" style={{ color: 'var(--text-3)' }}>
            {['أحد', 'اثن', 'ثلا', 'أرب', 'خمي', 'جمع', 'سبت'].map(d => <div key={d}>{d}</div>)}
          </div>
          <div className="grid grid-cols-7 gap-1">
            {calendar.cells.map((c, i) => {
              if (!c.day) return <div key={`x${i}`} />;
              const bg = !c.stat || c.stat.total === 0 ? 'var(--surface-0)'
                : c.stat.target > c.stat.stop ? 'var(--up-soft)'
                  : c.stat.stop > c.stat.target ? 'var(--down-soft)'
                    : 'var(--warn-soft)';
              const selected = dayFilter === c.key;
              return (
                <button
                  key={c.key ?? c.day}
                  onClick={() => setDayFilter(selected ? null : c.key)}
                  title={c.stat ? `${c.key}: ${c.stat.total} فرصة (${c.stat.target} هدف · ${c.stat.stop} وقف · ${c.stat.open} قيد المتابعة)` : `${c.key}: لا فرص`}
                  className="rounded-lg py-1.5 px-0.5 text-center transition-opacity"
                  style={{ background: bg, border: selected ? '2px solid var(--accent)' : '1px solid var(--border-1)', cursor: 'pointer' }}
                >
                  <div className="text-[11px] font-bold num" style={{ color: 'var(--text-1)' }}>{c.day}</div>
                  {c.stat && c.stat.total > 0 && (
                    <div className="text-[10px] num font-bold" style={{ color: c.stat.target > c.stat.stop ? 'var(--up)' : c.stat.stop > c.stat.target ? 'var(--down)' : 'var(--warn)' }}>
                      {c.stat.total}
                    </div>
                  )}
                </button>
              );
            })}
          </div>
          {dayFilter && (
            <button onClick={() => setDayFilter(null)} className="mt-2 text-[11px]" style={{ color: 'var(--accent)' }}>
              إلغاء فلتر اليوم ({dayFilter})
            </button>
          )}
        </div>

        {/* توزيع الساعات */}
        <div className="card p-4">
          <div className="text-[13px] font-bold mb-3" style={{ color: 'var(--text-1)' }}>توزيع الساعات (توقيتك المحلي) — أي ساعة تولّد فرصاً أكثر؟</div>
          <div className="flex items-end gap-[3px] h-40" style={{ direction: 'ltr' }}>
            {byHour.map((h, hour) => (
              <div key={hour} className="flex-1 flex flex-col items-center justify-end h-full gap-1" title={`${hour}:00 — ${h.total} فرصة · ${h.target} هدف`}>
                <div
                  className="w-full rounded-t"
                  style={{
                    height: h.total ? `${(h.total / hourMax) * 100}%` : '2px',
                    background: h.total ? 'var(--accent)' : 'var(--border-1)',
                    opacity: h.total ? 0.45 + 0.55 * (h.total / hourMax) : 1,
                    minHeight: '2px'
                  }}
                />
                <div className="text-[8.5px] num" style={{ color: 'var(--text-3)' }}>{hour}</div>
              </div>
            ))}
          </div>
          <div className="text-[10.5px] mt-2" style={{ color: 'var(--text-3)' }}>
            الأكثر إنتاجاً: {byHour.map((h, i) => ({ h, i })).sort((a, b) => b.h.total - a.h.total).slice(0, 3).filter(x => x.h.total > 0).map(x => `${x.i}:00`).join(' · ') || '—'}
          </div>
        </div>
      </div>

      {/* الفلاتر */}
      <div className="card p-3 flex flex-wrap items-center gap-2">
        <input
          value={symbolFilter}
          onChange={e => setSymbolFilter(e.target.value)}
          placeholder="رمز…"
          list="dash-symbols"
          className="text-[12px] px-2.5 py-1.5 rounded-lg w-28"
          style={{ background: 'var(--surface-0)', border: '1px solid var(--border-1)', color: 'var(--text-1)' }}
        />
        <datalist id="dash-symbols">{symbols.map(s => <option key={s} value={s} />)}</datalist>
        <select value={tfFilter} onChange={e => setTfFilter(e.target.value)} className="text-[12px] px-2 py-1.5 rounded-lg" style={{ background: 'var(--surface-0)', border: '1px solid var(--border-1)', color: 'var(--text-1)' }}>
          <option value="">كل الفريمات</option>
          {timeframes.map(tf => <option key={tf} value={tf}>{tf}</option>)}
        </select>
        {(['all', 'qualified', 'probationary'] as const).map(t => (
          <button key={t} onClick={() => setTierFilter(t)} className="text-[11.5px] font-semibold px-2.5 py-1 rounded-full"
            style={{
              background: tierFilter === t ? (t === 'qualified' ? 'var(--up-soft)' : t === 'probationary' ? 'var(--warn-soft)' : 'var(--accent-soft)') : 'var(--surface-0)',
              color: tierFilter === t ? (t === 'qualified' ? 'var(--up)' : t === 'probationary' ? '#b45309' : 'var(--accent)') : 'var(--text-3)',
              border: '1px solid var(--border-1)'
            }}>
            {t === 'all' ? 'كل الطبقات' : TIER_STYLE[t].label}
          </button>
        ))}
        {(['all', 'target', 'stop', 'open'] as const).map(o => (
          <button key={o} onClick={() => setOutcomeFilter(o)} className="text-[11.5px] font-semibold px-2.5 py-1 rounded-full"
            style={{
              background: outcomeFilter === o ? 'var(--accent-soft)' : 'var(--surface-0)',
              color: outcomeFilter === o ? 'var(--accent)' : 'var(--text-3)',
              border: '1px solid var(--border-1)'
            }}>
            {o === 'all' ? 'كل النتائج' : o === 'open' ? 'قيد المتابعة' : OUTCOME_STYLE[o].label}
          </button>
        ))}
        <span className="text-[11px] num" style={{ color: 'var(--text-3)' }}>{filtered.length} صف</span>
        <button onClick={exportCsv} disabled={filtered.length === 0} className="btn text-[12px] mr-auto">تصدير CSV</button>
      </div>

      {/* الجدول الزمني */}
      <div className="card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-[12px]" style={{ borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border-1)', background: 'var(--surface-0)' }}>
                {['الوقت', 'الرمز', 'فريم', 'الطبقة', 'دخول', 'وقف', 'هدف', 'R:R', 'النتيجة', 'المدة', 'MFE', 'MAE'].map(h => (
                  <th key={h} className="text-right px-2.5 py-2 font-bold whitespace-nowrap" style={{ color: 'var(--text-2)' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.slice(0, 200).map((e, i) => {
                const tier = TIER_STYLE[e.tier ?? 'probationary'] ?? TIER_STYLE.probationary;
                const oc = e.outcome ? OUTCOME_STYLE[e.outcome] : { label: 'قيد المتابعة', color: 'var(--warn)' };
                return (
                  <tr key={`${e.ts}-${e.id ?? i}`} style={{ borderBottom: '1px solid var(--border-1)' }}>
                    <td className="px-2.5 py-2 whitespace-nowrap">
                      <div className="font-semibold num" style={{ color: 'var(--text-1)' }}>{new Date(e.ts).toLocaleString('ar', { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' })}</div>
                    </td>
                    <td className="px-2.5 py-2 font-bold num" style={{ color: 'var(--text-1)' }}>{e.symbol}</td>
                    <td className="px-2.5 py-2 num" style={{ color: 'var(--text-3)' }}>{e.timeframe ?? '—'}</td>
                    <td className="px-2.5 py-2 whitespace-nowrap">
                      <span className="text-[10px] px-2 py-0.5 rounded-full font-semibold" style={{ background: `${tier.color}22`, color: tier.color, border: `1px solid ${tier.color}55` }}>{tier.label}</span>
                    </td>
                    <td className="px-2.5 py-2 num" style={{ color: 'var(--text-2)' }}>{fmtPx(e.entry)}</td>
                    <td className="px-2.5 py-2 num" style={{ color: 'var(--down)' }}>{fmtPx(e.stop)}</td>
                    <td className="px-2.5 py-2 num" style={{ color: 'var(--up)' }}>{fmtPx(e.tp)}</td>
                    <td className="px-2.5 py-2 num" style={{ color: 'var(--text-2)' }}>{fmt(e.rr, 1)}</td>
                    <td className="px-2.5 py-2 whitespace-nowrap">
                      <span className="text-[10.5px] font-bold" style={{ color: oc.color }}>{oc.label}</span>
                    </td>
                    <td className="px-2.5 py-2 num" style={{ color: 'var(--text-3)' }}>{e.durationMs ? `${Math.round(e.durationMs / 60_000)} د` : '—'}</td>
                    <td className="px-2.5 py-2 num" style={{ color: 'var(--up)' }}>{e.mfeR != null ? `${e.mfeR.toFixed(2)}` : '—'}</td>
                    <td className="px-2.5 py-2 num" style={{ color: 'var(--down)' }}>{e.maeR != null ? `${e.maeR.toFixed(2)}` : '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {filtered.length === 0 && !loading && (
          <div className="py-10 text-center text-[12.5px]" style={{ color: 'var(--text-3)' }}>
            {all.length === 0 ? 'لا أحداث بعد — ستُسجَّل الفرص هنا تلقائياً منذ أول نشر.' : 'لا نتائج مطابقة للفلاتر.'}
          </div>
        )}
      </div>
    </div>
  );
}

function KpiCard({ label, value, sub, color }: { label: string; value: string; sub?: string; color: string }) {
  return (
    <div className="rounded-xl px-3 py-2.5" style={{ background: 'var(--surface-1)', border: '1px solid var(--border-1)' }}>
      <div className="text-[10.5px]" style={{ color: 'var(--text-3)' }}>{label}</div>
      <div className="text-[16px] font-bold num mt-0.5" style={{ color }}>
        {value}
        {sub && <span className="text-[10px] font-semibold mr-1.5" style={{ color: 'var(--text-3)' }}>{sub}</span>}
      </div>
    </div>
  );
}
