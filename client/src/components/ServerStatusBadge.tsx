import { useServerHealth, type ServerStatus } from '../lib/serverHealth';

const STYLE: Record<ServerStatus, { bg: string; color: string; border: string; dot: string }> = {
  live: { bg: 'var(--up-soft)', color: '#0a7f6a', border: 'rgba(8,153,129,0.35)', dot: 'var(--up)' },
  stale: { bg: 'var(--warn-soft)', color: '#b45309', border: 'rgba(245,158,11,0.35)', dot: 'var(--warn)' },
  stalled: { bg: 'var(--warn-soft)', color: '#b45309', border: 'rgba(245,158,11,0.35)', dot: 'var(--warn)' },
  loading: { bg: 'var(--surface-2)', color: 'var(--text-3)', border: 'var(--border-1)', dot: 'var(--text-3)' },
  down: { bg: 'var(--down-soft)', color: 'var(--down)', border: 'rgba(239,68,68,0.35)', dot: 'var(--down)' }
};

/**
 * شارة حالة النظام على الخادم (المحركات + حداثة البيانات + البث).
 * سابقة: كانت الشارة تعكس بث المتصفح فقط فيظهر «مباشر» والمحركات متوقفة.
 */
export default function ServerStatusBadge({ className = '' }: { className?: string }) {
  const { status, label, title } = useServerHealth();
  const s = STYLE[status];
  return (
    <div
      className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-[11px] font-medium ${className}`}
      style={{ background: s.bg, color: s.color, border: `1px solid ${s.border}` }}
      title={`حالة النظام على الخادم: ${label}\n${title}`}
    >
      <span className={`w-2 h-2 rounded-full ${status === 'live' ? 'live-dot' : ''}`} style={{ background: s.dot }} />
      {label}
    </div>
  );
}
