import { useMemo, useState } from 'react';
import { useStore, type NotificationCategory, type NotificationSeverity } from '../store/useStore';

/* ═══ مركز الإشعارات — الشاشة المستقلة الوحيدة التي تظهر فيها الإشعارات ═══ */

const CATEGORIES: { id: NotificationCategory; label: string; color: string }[] = [
  { id: 'zones', label: 'مناطق السيولة', color: '#dc2626' },
  { id: 'liveOpps', label: 'الفرص الحية', color: '#0a7f6a' },
  { id: 'shariah', label: 'تنبيه شرعي', color: '#7c3aed' },
  { id: 'system', label: 'قوائم ونظام', color: '#1d4ed8' },
  { id: 'actions', label: 'عمليات', color: '#64748b' }
];

const SEVERITY_STYLE: Record<NotificationSeverity, { label: string; color: string }> = {
  info: { label: 'معلومة', color: '#1d4ed8' },
  alert: { label: 'تنبيه', color: '#b45309' },
  error: { label: 'خطأ', color: '#dc2626' }
};

const RANGES = [
  { id: '1h', label: 'آخر ساعة', ms: 3600_000 },
  { id: '24h', label: 'آخر 24 ساعة', ms: 86_400_000 },
  { id: 'all', label: 'الكل', ms: null }
] as const;

function relTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'الآن';
  if (diff < 3600_000) return `قبل ${Math.floor(diff / 60_000)} د`;
  if (diff < 86_400_000) return `قبل ${Math.floor(diff / 3600_000)} س`;
  return `قبل ${Math.floor(diff / 86_400_000)} ي`;
}

function csvCell(v: string): string {
  return `"${v.replace(/"/g, '""')}"`;
}

export default function NotificationCenter() {
  const notifications = useStore(s => s.notifications);
  const unread = useStore(s => s.unreadNotifications);
  const markAllRead = useStore(s => s.markAllNotificationsRead);
  const clearAll = useStore(s => s.clearNotifications);
  const markRead = useStore(s => s.markNotificationRead);
  const deleteNotification = useStore(s => s.deleteNotification);

  const [catFilter, setCatFilter] = useState<Set<NotificationCategory>>(new Set());
  const [severity, setSeverity] = useState<'all' | NotificationSeverity>('all');
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [range, setRange] = useState<(typeof RANGES)[number]['id']>('all');
  const [query, setQuery] = useState('');
  const [sortAsc, setSortAsc] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);

  const catCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const n of notifications) counts[n.category] = (counts[n.category] ?? 0) + 1;
    return counts;
  }, [notifications]);

  const rows = useMemo(() => {
    const rangeMs = RANGES.find(r => r.id === range)?.ms ?? null;
    const since = rangeMs ? Date.now() - rangeMs : 0;
    const q = query.trim().toLowerCase();
    return notifications
      .filter(n => (catFilter.size === 0 || catFilter.has(n.category)))
      .filter(n => severity === 'all' || n.severity === severity)
      .filter(n => !unreadOnly || !n.read)
      .filter(n => n.ts >= since)
      .filter(n => !q || n.text.toLowerCase().includes(q) || (n.symbol ?? '').toLowerCase().includes(q))
      .sort((a, b) => (sortAsc ? a.ts - b.ts : b.ts - a.ts));
  }, [notifications, catFilter, severity, unreadOnly, range, query, sortAsc]);

  const exportCsv = () => {
    const header = ['الوقت', 'الفئة', 'الخطورة', 'الرمز', 'النص', 'الحالة'];
    const lines = [header.map(csvCell).join(',')];
    for (const n of [...rows].sort((a, b) => a.ts - b.ts)) {
      lines.push([
        new Date(n.ts).toISOString(),
        CATEGORIES.find(c => c.id === n.category)?.label ?? n.category,
        SEVERITY_STYLE[n.severity].label,
        n.symbol ?? '',
        n.text,
        n.read ? 'مقروء' : 'غير مقروء'
      ].map(csvCell).join(','));
    }
    const blob = new Blob(['\ufeff' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `notifications-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const toggleCat = (id: NotificationCategory) => {
    setCatFilter(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="p-4 sm:p-6 space-y-4 max-w-7xl mx-auto">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-[16px] font-bold" style={{ color: 'var(--text-1)' }}>مركز الإشعارات</h2>
          <p className="text-xs mt-0.5" style={{ color: 'var(--text-3)' }}>
            سجل الإشعارات الكامل — مصنَّف ومفلتر. آخر 500 إشعار محفوظة محلياً وتبقى بعد تحديث الصفحة.
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <span className="badge badge-neutral">الإجمالي: {notifications.length}</span>
          {unread > 0 && <span className="badge badge-warn">غير مقروء: {unread}</span>}
        </div>
      </div>

      {/* ------- شريط الفلاتر ------- */}
      <div className="card p-4 space-y-3">
        {/* الفئات */}
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[11.5px] font-bold w-16 shrink-0" style={{ color: 'var(--text-3)' }}>الفئة:</span>
          {CATEGORIES.map(c => {
            const active = catFilter.has(c.id);
            const count = catCounts[c.id] ?? 0;
            return (
              <button
                key={c.id}
                onClick={() => toggleCat(c.id)}
                className="text-[11.5px] font-semibold px-2.5 py-1 rounded-full transition-opacity"
                style={{
                  background: active ? `${c.color}22` : 'var(--surface-0)',
                  color: active ? c.color : 'var(--text-3)',
                  border: `1px solid ${active ? `${c.color}55` : 'var(--border-1)'}`
                }}
                title={count > 0 ? `${c.label}: ${count} إشعار` : c.label}
              >
                {c.label}
                {count > 0 && <span className="num mr-1.5 opacity-80">({count})</span>}
              </button>
            );
          })}
          {catFilter.size > 0 && (
            <button onClick={() => setCatFilter(new Set())} className="text-[11px]" style={{ color: 'var(--accent)' }}>
              إلغاء الفلتر
            </button>
          )}
        </div>

        {/* الخطورة + النطاق + غير المقروء */}
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[11.5px] font-bold w-16 shrink-0" style={{ color: 'var(--text-3)' }}>الخطورة:</span>
          {(['all', 'info', 'alert', 'error'] as const).map(s => (
            <button
              key={s}
              onClick={() => setSeverity(s)}
              className="text-[11.5px] font-semibold px-2.5 py-1 rounded-full"
              style={{
                background: severity === s ? 'var(--accent-soft)' : 'var(--surface-0)',
                color: severity === s ? 'var(--accent)' : 'var(--text-3)',
                border: `1px solid ${severity === s ? 'var(--accent-ring)' : 'var(--border-1)'}`
              }}
            >
              {s === 'all' ? 'الكل' : SEVERITY_STYLE[s].label}
            </button>
          ))}
          <span className="w-px h-5 mx-1" style={{ background: 'var(--border-1)' }} />
          <span className="text-[11.5px] font-bold" style={{ color: 'var(--text-3)' }}>النطاق:</span>
          {RANGES.map(r => (
            <button
              key={r.id}
              onClick={() => setRange(r.id)}
              className="text-[11.5px] font-semibold px-2.5 py-1 rounded-full"
              style={{
                background: range === r.id ? 'var(--accent-soft)' : 'var(--surface-0)',
                color: range === r.id ? 'var(--accent)' : 'var(--text-3)',
                border: `1px solid ${range === r.id ? 'var(--accent-ring)' : 'var(--border-1)'}`
              }}
            >
              {r.label}
            </button>
          ))}
          <span className="w-px h-5 mx-1" style={{ background: 'var(--border-1)' }} />
          <button
            onClick={() => setUnreadOnly(v => !v)}
            className="text-[11.5px] font-semibold px-2.5 py-1 rounded-full"
            style={{
              background: unreadOnly ? 'var(--warn-soft)' : 'var(--surface-0)',
              color: unreadOnly ? '#b45309' : 'var(--text-3)',
              border: `1px solid ${unreadOnly ? 'rgba(245,158,11,0.4)' : 'var(--border-1)'}`
            }}
          >
            غير المقروء فقط{unreadOnly ? ' ✓' : ''}
          </button>
        </div>

        {/* البحث + الأزرار */}
        <div className="flex items-center gap-2 flex-wrap">
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="بحث في النص أو الرمز…"
            className="flex-1 min-w-48 text-[12.5px] px-3 py-1.5 rounded-lg"
            style={{ background: 'var(--surface-0)', border: '1px solid var(--border-1)', color: 'var(--text-1)' }}
          />
          <button onClick={() => void markAllRead()} className="btn text-[12px]" disabled={unread === 0}>
            تعليم الكل كمقروء
          </button>
          <button
            onClick={() => { if (confirmClear) { clearAll(); setConfirmClear(false); } else setConfirmClear(true); }}
            onBlur={() => setConfirmClear(false)}
            className="btn text-[12px]"
            style={confirmClear ? { background: '#dc2626', borderColor: '#dc2626', color: '#fff' } : undefined}
          >
            {confirmClear ? 'تأكيد المسح؟' : 'مسح الكل'}
          </button>
          <button onClick={exportCsv} className="btn text-[12px]" disabled={rows.length === 0}>
            تصدير CSV
          </button>
        </div>
      </div>

      {/* ------- الجدول ------- */}
      <div className="card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-[12.5px]" style={{ borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border-1)', background: 'var(--surface-0)' }}>
                <th
                  onClick={() => setSortAsc(v => !v)}
                  className="text-right px-3 py-2.5 font-bold cursor-pointer select-none whitespace-nowrap"
                  style={{ color: 'var(--text-2)' }}
                  title="ترتيب حسب الوقت"
                >
                  الوقت {sortAsc ? '↑' : '↓'}
                </th>
                <th className="text-right px-3 py-2.5 font-bold" style={{ color: 'var(--text-2)' }}>الفئة</th>
                <th className="text-right px-3 py-2.5 font-bold" style={{ color: 'var(--text-2)' }}>الخطورة</th>
                <th className="text-right px-3 py-2.5 font-bold" style={{ color: 'var(--text-2)' }}>الرمز</th>
                <th className="text-right px-3 py-2.5 font-bold" style={{ color: 'var(--text-2)' }}>النص</th>
                <th className="text-right px-3 py-2.5 font-bold" style={{ color: 'var(--text-2)' }}>إجراء</th>
                <th className="text-center px-3 py-2.5 font-bold" style={{ color: 'var(--text-2)' }}>القراءة</th>
                <th className="px-2 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {rows.map(n => {
                const cat = CATEGORIES.find(c => c.id === n.category) ?? CATEGORIES[4];
                const sev = SEVERITY_STYLE[n.severity];
                return (
                  <tr
                    key={n.id}
                    onClick={() => markRead(n.id)}
                    className="cursor-pointer"
                    style={{
                      borderBottom: '1px solid var(--border-1)',
                      background: n.read ? 'transparent' : 'var(--accent-soft)',
                      borderInlineStart: n.read ? '3px solid transparent' : `3px solid var(--accent)`
                    }}
                    title={n.read ? undefined : 'نقر لتعليمه كمقروء'}
                  >
                    <td className="px-3 py-2.5 whitespace-nowrap" style={{ color: 'var(--text-2)' }}>
                      <div className="font-semibold" style={{ color: 'var(--text-1)' }}>{relTime(n.ts)}</div>
                      <div className="text-[10.5px] num" style={{ color: 'var(--text-3)' }}>{new Date(n.ts).toLocaleString('ar')}</div>
                    </td>
                    <td className="px-3 py-2.5 whitespace-nowrap">
                      <span
                        className="text-[10.5px] px-2 py-0.5 rounded-full font-semibold whitespace-nowrap"
                        style={{ background: `${cat.color}22`, color: cat.color, border: `1px solid ${cat.color}55` }}
                      >
                        {cat.label}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 whitespace-nowrap">
                      <span
                        className="text-[10.5px] px-2 py-0.5 rounded-full font-semibold"
                        style={{ background: `${sev.color}18`, color: sev.color, border: `1px solid ${sev.color}44` }}
                      >
                        {sev.label}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 font-bold num" style={{ color: 'var(--text-1)' }}>
                      {n.symbol ?? <span style={{ color: 'var(--text-3)' }}>—</span>}
                    </td>
                    <td className="px-3 py-2.5" style={{ color: 'var(--text-1)', minWidth: 280 }}>
                      {n.text}
                    </td>
                    <td className="px-3 py-2.5 whitespace-nowrap">
                      {n.action ? (
                        <button
                          onClick={e => { e.stopPropagation(); n.action?.onClick(); markRead(n.id); }}
                          className="text-[11px] font-bold px-2.5 py-1 rounded-lg"
                          style={{ background: 'var(--accent-soft)', color: 'var(--accent)', border: '1px solid var(--accent-ring)' }}
                        >
                          {n.action.label}
                        </button>
                      ) : (
                        <span style={{ color: 'var(--text-3)' }}>—</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-center">
                      <span
                        className="inline-block w-2 h-2 rounded-full"
                        style={{ background: n.read ? 'var(--border-1)' : 'var(--accent)', boxShadow: n.read ? 'none' : '0 0 6px var(--accent-ring)' }}
                        title={n.read ? 'مقروء' : 'غير مقروء'}
                      />
                    </td>
                    <td className="px-2 py-2.5">
                      <button
                        onClick={e => { e.stopPropagation(); deleteNotification(n.id); }}
                        className="text-[11px] px-1.5 py-0.5 rounded"
                        style={{ color: 'var(--text-3)' }}
                        title="حذف الإشعار"
                        onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = '#dc2626'; }}
                        onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = 'var(--text-3)'; }}
                      >
                        ✕
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {rows.length === 0 && (
          <div className="py-12 text-center">
            <div className="text-[13px] font-semibold" style={{ color: 'var(--text-3)' }}>
              {notifications.length === 0 ? 'لا إشعارات بعد — ستظهر هنا عند حدوث أي حدث.' : 'لا نتائج مطابقة للفلاتر الحالية.'}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
