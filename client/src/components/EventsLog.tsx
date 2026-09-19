import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useStore } from '../store/useStore';
import { fmtPrice } from '../lib/binance';
import type { EventLog } from '../lib/types';
import SkeletonRow from './ui/Skeleton';

const PAGE = 200;

const TYPE_STYLE: Record<string, string> = {
  liquidity_zone: '#089981',
  zone_feedback: '#fbbf24',
  auto_zones_snapshot: '#8b5cf6',
  zone_calibration: '#f97316',
  zone_touch: '#38bdf8',
  barcode_scan: '#e879f9',
  timeout: '#f23645',
  start: '#26a69a',
  manual: '#64748b'
};

function typeColor(t: string) {
  if (TYPE_STYLE[t]) return TYPE_STYLE[t];
  if (t.startsWith('zone')) return '#38bdf8';
  if (t.startsWith('shariah')) return '#a78bfa';
  return '#94a3b8';
}

function Row({ e }: { e: EventLog }) {
  const [open, setOpen] = useState(false);
  let metaPreview = '';
  let metaFull = '';
  if (e.meta) {
    try {
      const parsed = JSON.parse(e.meta) as unknown;
      const text = JSON.stringify(parsed, null, 2);
      metaFull = text;
      metaPreview = JSON.stringify(parsed);
      if (metaPreview.length > 160) metaPreview = metaPreview.slice(0, 160) + '…';
    } catch {
      metaPreview = e.meta;
      metaFull = e.meta;
    }
  }
  const color = typeColor(e.type);
  return (
    <div className="rounded-xl px-3.5 py-2.5 space-y-1.5" style={{ background: 'var(--surface-1)', border: '1px solid var(--border-1)' }}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="shrink-0 text-[10px] px-2 py-0.5 rounded-full font-semibold num" style={{ background: `${color}22`, color, border: `1px solid ${color}55` }}>
            {e.type}
          </span>
          <span className="text-[12px] font-bold num" style={{ color: 'var(--text-1)' }}>{e.symbol}</span>
          {e.type === 'zone_touch' && e.meta && (() => {
            try {
              const z = JSON.parse(e.meta) as { price?: number; side?: string };
              if (typeof z.price === 'number') return <span className="num text-[10.5px]" style={{ color: 'var(--text-3)' }}>{z.side ?? ''} {fmtPrice(z.price)}</span>;
            } catch { /* ignore */ }
            return null;
          })()}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className="num text-[10px]" style={{ color: 'var(--text-3)' }}>
            #{e.id} · {new Date(e.ts).toLocaleString('en', { dateStyle: 'medium', timeStyle: 'short' })}
          </span>
          {e.meta && (
            <button type="button" className="text-[10px] px-1.5 py-0.5 rounded" style={{ border: '1px solid var(--border-1)', color: 'var(--text-2)' }} onClick={() => setOpen(o => !o)}>
              {open ? 'إخفاء البيانات' : 'البيانات'}
            </button>
          )}
        </div>
      </div>
      {e.message && <div className="text-[11.5px] leading-relaxed" style={{ color: 'var(--text-2)' }}>{e.message}</div>}
      {!open && metaPreview && (
        <div className="num text-[10.5px] truncate" style={{ color: 'var(--text-3)' }} dir="ltr">{metaPreview}</div>
      )}
      {open && metaFull && (
        <pre className="num text-[10px] leading-relaxed overflow-auto max-h-48 rounded-lg p-2" style={{ background: 'var(--surface-2)', border: '1px solid var(--border-1)', color: 'var(--text-2)' }} dir="ltr">{metaFull}</pre>
      )}
    </div>
  );
}

export default function EventsLog() {
  const caseFilter = useStore(s => s.caseFilter);
  const [events, setEvents] = useState<EventLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [typeFilter, setTypeFilter] = useState('');

  const load = async (more = false) => {
    const next = more ? offset : 0;
    setLoading(true);
    try {
      const rows = await api.getEvents({
        symbol: caseFilter ?? undefined,
        type: typeFilter || undefined,
        limit: PAGE,
        offset: next
      });
      if (!more) {
        setEvents(rows);
      } else {
        const seen = new Set(rows.map(e => e.id));
        setEvents(prev => [...prev, ...rows.filter(e => !seen.has(e.id))]);
      }
      setOffset(next + rows.length);
      setHasMore(rows.length >= PAGE);
    } catch {
      /* لا يُفشل العرض */
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [caseFilter, typeFilter]);

  const exportJson = () => {
    const blob = new Blob([JSON.stringify(events, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `events-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <input
            className="num px-2 py-1.5 text-[11px] w-36"
            placeholder="فلتر النوع… (مثال: zone_feedback)"
            value={typeFilter}
            onChange={e => setTypeFilter(e.target.value)}
          />
          <button className="btn !py-1.5 !px-3 text-[11px]" onClick={() => void load()}>تحديث</button>
          <button className="btn !py-1.5 !px-3 text-[11px]" onClick={exportJson}>تصدير JSON</button>
        </div>
        <span className="num text-[11px]" style={{ color: 'var(--text-3)' }}>{events.length} حدث معروض</span>
      </div>

      <p className="text-[10.5px] leading-relaxed" style={{ color: 'var(--text-3)' }}>
        سجل append-only: كل تعديل في النظام يُضاف صفاً جديداً ولا يُحذف شيء — مناطق يدوية، تغذية راجعة، لقطات
        آلية، معايرة، باركود، أخطاء تلخيص، وانطلاقات.
      </p>

      {loading && !events.length ? (
        <SkeletonRow height={64} />
      ) : events.length === 0 ? (
        <div className="text-center text-[12px] py-10" style={{ color: 'var(--text-3)' }}>
          لا أحداث لهذه التصفية.
        </div>
      ) : (
        <div className="space-y-1.5">
          {events.map(e => <Row key={e.id} e={e} />)}
        </div>
      )}

      {hasMore && (
        <button className="btn w-full !py-2 text-[11.5px]" onClick={() => void load(true)} disabled={loading}>
          {loading ? 'جاري التحميل…' : 'تحميل المزيد'}
        </button>
      )}
    </div>
  );
}