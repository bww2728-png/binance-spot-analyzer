import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../store/useStore';
import { api } from '../lib/api';
import { classify, GROUP_LABELS, GROUP_ORDER, isUptrend, isDowntrend } from '../lib/sorting';
import type { EventLog } from '../lib/types';
import Skeleton from './ui/Skeleton';

const GROUP_COLORS: Record<string, string> = {
  up_to_ssl: 'var(--up)',
  down_touched_bsl_then_ssl: 'var(--down)',
  down_touched_bsl_only: 'var(--warn)',
  down_not_touched_bsl: 'var(--group-purple)',
  incomplete: 'var(--text-3)'
};

const EVENT_BADGE: Record<string, { cls: string; icon: string; label: string }> = {
  zone_touch: { cls: 'badge-up', icon: '◎', label: 'لمس منطقة' },
  timeout: { cls: 'badge-warn', icon: '⏱', label: 'مهلة' },
  choch_check: { cls: 'badge-accent', icon: '↗', label: 'تعدّي BSL' }
};

function StatCard({ label, value, color, icon, accent }: { label: string; value: string | number; color?: string; icon: string; accent?: string }) {
  return (
    <div
      className="rounded-xl p-4 min-w-[152px] flex-1 relative overflow-hidden"
      style={{ background: 'var(--surface-1)', border: '1px solid var(--border-1)', transition: 'border-color var(--transition), transform var(--transition)' }}
      onMouseEnter={e => { (e.currentTarget as HTMLElement).style.borderColor = accent ?? 'var(--border-2)'; }}
      onMouseLeave={e => { (e.currentTarget as HTMLElement).style.borderColor = 'var(--border-1)'; }}
    >
      <div className="absolute top-0 inset-x-0 h-0.5" style={{ background: accent ?? 'var(--border-2)' }} />
      <div className="flex items-center justify-between">
        <div className="text-[11px]" style={{ color: 'var(--text-2)' }}>{label}</div>
        <span className="text-[15px]" style={{ color: accent ?? 'var(--text-3)' }}>{icon}</span>
      </div>
      <div className="num text-2xl font-bold mt-1.5" style={{ color: color ?? 'var(--text-1)' }}>{value}</div>
    </div>
  );
}

export default function Dashboard() {
  const analyses = useStore(s => s.analyses);
  const settings = useStore(s => s.settings);
  const shariah = useStore(s => s.shariah);
  const [events, setEvents] = useState<EventLog[]>([]);

  useEffect(() => {
    const load = () => void api.getEvents({ limit: 300 }).then(setEvents).catch(() => { /* ignore */ });
    load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, []);

  const stats = useMemo(() => {
    const up = analyses.filter(isUptrend).length;
    const down = analyses.filter(isDowntrend).length;
    const incomplete = analyses.length - up - down;
    const groups: Record<string, number> = {};
    for (const g of GROUP_ORDER) groups[g] = 0;
    for (const a of analyses) groups[classify(a)] = (groups[classify(a)] ?? 0) + 1;
    const bslTouched = analyses.filter(a => a.bsl_touched === 1).length;
    const sslTouched = analyses.filter(a => a.ssl_touched === 1).length;
    const chochYes = analyses.filter(a => a.choch_up === 'yes').length;
    const chochNo = analyses.filter(a => a.choch_up === 'no').length;
    const touchEvents = events.filter(e => e.type === 'zone_touch').length;
    const timeoutEvents = events.filter(e => e.type === 'timeout').length;

    // عدادات التصنيف الشرعي: من المخزن أو محسوبة فوراً
    let shHalal = 0, shHaram = 0, shUncertain = 0;
    for (const a of analyses) {
      const verdict = shariah[a.symbol]?.verdict;
      if (verdict === 'halal') shHalal += 1;
      else if (verdict === 'haram') shHaram += 1;
      else shUncertain += 1;
    }

    return { up, down, incomplete, groups, bslTouched, sslTouched, chochYes, chochNo, touchEvents, timeoutEvents, shHalal, shHaram, shUncertain };
  }, [analyses, events, shariah]);

  const maxGroup = Math.max(1, ...GROUP_ORDER.map(g => stats.groups[g] ?? 0));

  return (
    <div className="p-6 space-y-8 max-w-6xl">
      <section>
        <h2 className="text-[15px] font-bold mb-4" style={{ color: 'var(--text-1)' }}>ملخص عام</h2>
        <div className="flex flex-wrap gap-3">
          <StatCard label="عملات محللة" value={analyses.length} icon="◎" accent="var(--accent)" />
          <StatCard label="صاعدة" value={stats.up} icon="▲" color="var(--up)" accent="var(--up)" />
          <StatCard label="هابطة" value={stats.down} icon="▼" color="var(--down)" accent="var(--down)" />
          <StatCard label="غير محددة" value={stats.incomplete} icon="○" accent="var(--text-3)" />
          <StatCard label="لمست BSL" value={stats.bslTouched} icon="⚑" color="var(--warn)" accent="var(--warn)" />
          <StatCard label="لمست SSL" value={stats.sslTouched} icon="⚑" color="var(--up)" accent="var(--up)" />
          <StatCard label="CHoCH up نعم" value={stats.chochYes} icon="↗" color="var(--up)" accent="var(--up)" />
          <StatCard label="CHoCH up لا" value={stats.chochNo} icon="↘" color="var(--down)" accent="var(--down)" />
          <StatCard label="إشعارات لمس" value={stats.touchEvents} icon="◉" accent="var(--accent)" />
          <StatCard label="إشعارات مهلة" value={stats.timeoutEvents} icon="⏱" color="var(--warn)" accent="var(--warn)" />
          <StatCard label="حلال (شرعاً)" value={stats.shHalal} icon="✓" color="var(--up)" accent="var(--up)" />
          <StatCard label="حرام (شرعاً)" value={stats.shHaram} icon="✕" color="var(--down)" accent="var(--down)" />
          <StatCard label="للتحقق شرعياً" value={stats.shUncertain} icon="⚠" color="var(--warn)" accent="var(--warn)" />
        </div>
      </section>

      <section>
        <h2 className="text-[15px] font-bold mb-4" style={{ color: 'var(--text-1)' }}>توزيع المجموعات</h2>
        <div className="card p-5 max-w-3xl space-y-3">
          {GROUP_ORDER.map(g => {
            const count = stats.groups[g] ?? 0;
            const pct = Math.round((count / Math.max(1, analyses.length)) * 100);
            return (
              <div key={g} className="flex items-center gap-4">
                <div className="w-56 text-xs shrink-0" style={{ color: 'var(--text-2)' }}>{GROUP_LABELS[g]}</div>
                <div className="flex-1 h-6 rounded-lg overflow-hidden" style={{ background: 'var(--surface-2)' }}>
                  <div
                    className="h-full rounded-lg flex items-center justify-end"
                    style={{
                      width: `${Math.max(count === 0 ? 0 : 4, (count / maxGroup) * 100)}%`,
                      background: `linear-gradient(90deg, ${GROUP_COLORS[g]}44, ${GROUP_COLORS[g]}88)`,
                      borderInlineEnd: `2px solid ${GROUP_COLORS[g]}`,
                      transition: 'width 0.4s ease'
                    }}
                  />
                </div>
                <div className="w-16 text-left shrink-0">
                  <span className="num text-sm font-semibold" style={{ color: 'var(--text-1)' }}>{count}</span>
                  <span className="num text-[10px] mr-1" style={{ color: 'var(--text-3)' }}>{pct}%</span>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <section>
        <h2 className="text-[15px] font-bold mb-4" style={{ color: 'var(--text-1)' }}>سجل الأحداث الأخيرة</h2>
        <div className="card overflow-auto max-h-96">
          {!settings ? (
            <div className="p-4 space-y-2">{Array.from({ length: 3 }, (_, i) => <Skeleton key={i} height={32} />)}</div>
          ) : (
            <table className="w-full text-xs">
              <thead className="sticky top-0" style={{ background: 'var(--surface-2)' }}>
                <tr>
                  {['الوقت', 'العملة', 'النوع', 'التفاصيل'].map(h => (
                    <th key={h} className="p-2.5 text-right font-semibold" style={{ color: 'var(--text-2)', borderBottom: '1px solid var(--border-2)' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {events.length === 0 && (
                  <tr>
                    <td colSpan={4} className="p-8 text-center" style={{ color: 'var(--text-3)' }}>
                      لا أحداث بعد — ستظهر هنا اللمسات والمهل تلقائياً
                    </td>
                  </tr>
                )}
                {events.map(e => {
                  const badge = EVENT_BADGE[e.type] ?? { cls: 'badge-neutral', icon: '•', label: e.type };
                  return (
                    <tr key={e.id} style={{ borderTop: '1px solid var(--border-1)', transition: 'background var(--transition)' }}
                      onMouseEnter={ev => { (ev.currentTarget as HTMLElement).style.background = 'var(--surface-2)'; }}
                      onMouseLeave={ev => { (ev.currentTarget as HTMLElement).style.background = 'transparent'; }}
                    >
                      <td className="num p-2.5 text-[11px]" style={{ color: 'var(--text-3)' }}>{new Date(e.ts).toLocaleString('ar')}</td>
                      <td className="p-2.5 font-bold" style={{ color: 'var(--text-1)' }}>{e.symbol.replace('USDT', '')}</td>
                      <td className="p-2.5">
                        <span className={`badge ${badge.cls}`}>{badge.icon} {badge.label}</span>
                      </td>
                      <td className="p-2.5" style={{ color: 'var(--text-2)' }}>{e.message}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </section>
    </div>
  );
}
