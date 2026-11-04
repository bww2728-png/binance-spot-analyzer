import Skeleton from './ui/Skeleton';
import { useServerHealth } from '../lib/serverHealth';

/**
 * صفحة الفحص المخفي — تُفتح برابط #/syscheck فقط ولا تظهر في التبويبات.
 * تعرض ما يقوله الخادم عن نفسه: المحركات ودوراتها، عمر آخر سعر، التخزين، الذاكرة.
 * حلّت محل «لوحة التحكم» بعد حذفها، بلا أي إحصاءات لوحة التحليل القديمة.
 */
function SystemHealthCard() {
  const { status, health, title, worstLagMs } = useServerHealth(10_000);
  if (status === 'loading') {
    return <div className="card p-5 max-w-3xl space-y-2">{Array.from({ length: 3 }, (_, i) => <Skeleton key={i} height={26} />)}</div>;
  }
  if (!health) {
    return (
      <div className="card p-5 max-w-3xl" style={{ borderColor: 'rgba(239,68,68,0.35)' }}>
        <div className="text-sm font-semibold" style={{ color: 'var(--down)' }}>تعذّر قراءة حالة الخادم</div>
        <div className="text-xs mt-1" style={{ color: 'var(--text-2)' }}>{title}</div>
      </div>
    );
  }
  const mk = health.market;
  const upMin = Math.floor(health.uptimeSec / 60);
  const engines = (health.engines ?? []).filter(e => e.cycles > 0 || e.stalled || Object.keys(e.extra ?? {}).length > 0);
  const lagSec = (ms: number | null) => (ms === null ? '—' : `${Math.round(ms / 1000)}ث`);
  /**
   * المحرك ذو الدورة الطويلة (فحص السيولة) لا تُكمل دورة إلا كل ~36 دقيقة، فـ«دورات 0»
   * لا تعني تعطلاً. نعرض تقدّمه بدل رقم الدورة حتى لا تبدو الحلقة ميتة وهي تعمل.
   */
  const progressOf = (e: { extra?: Record<string, unknown> }): string | null => {
    const done = Number(e.extra?.pairsDone);
    const total = Number(e.extra?.pairsTotal);
    if (!Number.isFinite(done) || !Number.isFinite(total) || total <= 0) return null;
    return `${done}/${total}`;
  };
  return (
    <div className="card p-5 max-w-4xl space-y-4">
      <div className="flex flex-wrap gap-x-6 gap-y-2 text-xs">
        <div><span style={{ color: 'var(--text-3)' }}>الحالة: </span>
          <span className="font-semibold" style={{ color: status === 'live' ? 'var(--up)' : 'var(--warn)' }}>
            {status === 'live' ? 'سليمة' : title}
          </span>
        </div>
        <div><span style={{ color: 'var(--text-3)' }}>مدة التشغيل: </span><span className="num">{upMin} دقيقة</span></div>
        <div><span style={{ color: 'var(--text-3)' }}>عمر آخر سعر: </span>
          <span className="num" style={{ color: (mk?.priceAgeMs ?? 0) > 10_000 ? 'var(--warn)' : 'var(--up)' }}>
            {lagSec(mk?.priceAgeMs ?? null)}
          </span>
        </div>
        <div><span style={{ color: 'var(--text-3)' }}>رموز التحليل: </span><span className="num">{mk?.analyzedSymbols ?? '—'}</span>
          <span style={{ color: 'var(--text-3)' }}> (بسعر حديث: </span><span className="num">{mk?.analyzedPriced ?? '—'}</span><span style={{ color: 'var(--text-3)' }}>)</span>
        </div>
        <div><span style={{ color: 'var(--text-3)' }}>المستهدفة: </span><span className="num">{health.targets?.count ?? '—'}</span></div>
        <div><span style={{ color: 'var(--text-3)' }}>اتصالات البث: </span><span className="num">{mk?.streams ?? '—'}</span></div>
        <div><span style={{ color: 'var(--text-3)' }}>الذاكرة: </span>
          <span className="num">{health.mem.rssMb}MB{health.mem.limitMb ? ` / ${health.mem.limitMb}MB` : ''}</span>
        </div>
        <div><span style={{ color: 'var(--text-3)' }}>سقف الـheap: </span>
          <span className="num">{health.heapLimitMb ? `${health.heapLimitMb}MB` : '—'}</span>
        </div>
        <div><span style={{ color: 'var(--text-3)' }}>تأخّر حلقة الأحداث: </span>
          <span className="num">p99 {health.lagMs?.p99 ?? '—'}ms</span>
        </div>
        <div><span style={{ color: 'var(--text-3)' }}>إخفاقات الحفظ: </span>
          <span className="num" style={{ color: health.persist?.persistFailures ? 'var(--down)' : 'var(--text-1)' }}>{health.persist?.persistFailures ?? 0}</span>
        </div>
      </div>

      {worstLagMs !== null && (
        <div className="text-[11px]" style={{ color: 'var(--text-3)' }}>
          أطول محرك بلا دورة منذ {lagSec(worstLagMs)} — تظهر «متعطل» تحته عند تجاوز مهلة المحرك.
        </div>
      )}

      <div className="overflow-auto">
        <table className="w-full text-xs">
          <thead>
            <tr>
              {['المحرك', 'دورات', 'آخر دورة', 'مدتها', 'الحالة'].map(h => (
                <th key={h} className="p-2 text-right font-semibold" style={{ color: 'var(--text-2)', borderBottom: '1px solid var(--border-2)' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {engines.length === 0 && (
              <tr><td colSpan={5} className="p-4 text-center" style={{ color: 'var(--text-3)' }}>لا محركات مُسجَّلة بعد</td></tr>
            )}
            {engines.map(e => {
              const prog = progressOf(e);
              return (
              <tr key={e.name} style={{ borderTop: '1px solid var(--border-1)' }}>
                <td className="p-2 font-semibold" style={{ color: 'var(--text-1)' }}>{e.name}</td>
                <td className="num p-2" style={{ color: prog ? 'var(--text-3)' : 'var(--text-1)' }}>{prog ?? e.cycles}</td>
                <td className="num p-2" style={{ color: 'var(--text-2)' }}>{lagSec(e.sinceCycleMs)}</td>
                <td className="num p-2" style={{ color: 'var(--text-2)' }}>{e.lastCycleMs === null ? (prog ? 'قيد الدورة' : '—') : `${e.lastCycleMs}ms`}</td>
                <td className="p-2">
                  <span className={`badge ${e.stalled ? 'badge-warn' : e.lastError ? 'badge-accent' : 'badge-up'}`}>
                    {e.stalled ? 'متعطل' : e.lastError ? 'أخطاء' : prog ? 'قيد الدورة' : 'يعمل'}
                  </span>
                </td>
              </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function Dashboard() {
  return (
    <div className="p-6 space-y-6 max-w-5xl">
      <div>
        <h2 className="text-[15px] font-bold" style={{ color: 'var(--text-1)' }}>فحص النظام</h2>
        <p className="text-xs mt-1" style={{ color: 'var(--text-3)' }}>
          صفحة تشخيص مخفية — تُفتح برابط <span className="num">#/syscheck</span> فقط وتقرأ حالة الخادم مباشرة دون تعديل أي شيء.
        </p>
      </div>
      <SystemHealthCard />
    </div>
  );
}
