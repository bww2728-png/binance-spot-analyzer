import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import { fmtPrice } from '../lib/binance';
import { useStore } from '../store/useStore';
import type { EventLog, ZoneHistoryGroup } from '../lib/types';
import SkeletonRow from './ui/Skeleton';

const ZONE_COLOR: Record<'BSL' | 'SSL', string> = { BSL: '#f23645', SSL: '#089981' };
const ACTION_STYLE: Record<string, { label: string; bg: string; color: string }> = {
  create: { label: 'إنشاء', bg: 'rgba(38,166,154,0.15)', color: '#26a69a' },
  edit: { label: 'تعديل', bg: 'rgba(251,191,36,0.15)', color: '#fbbf24' },
  delete: { label: 'حذف', bg: 'rgba(242,54,69,0.15)', color: '#f23645' }
};
const PAGE = 500;

export default function ZonesHistory() {
  const caseFilter = useStore(s => s.caseFilter);
  const [groups, setGroups] = useState<ZoneHistoryGroup[]>([]);
  const [events, setEvents] = useState<EventLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [status, setStatus] = useState<'all' | 'active' | 'deleted'>('all');
  const [search, setSearch] = useState('');

  const load = async (more = false) => {
    const next = more ? offset : 0;
    setLoading(true);
    try {
      const res = await api.getZonesHistory({
        symbol: caseFilter ?? undefined,
        limit: PAGE,
        offset: next
      });
      if (!more) {
        setGroups(res.groups);
        setEvents(res.events);
      } else {
        const seen = new Set(res.groups.map(g => g.zoneId));
        setGroups(prev => [...prev, ...res.groups.filter(g => !seen.has(g.zoneId))]);
        const seenEv = new Set(res.events.map(e => e.id));
        setEvents(prev => [...prev, ...res.events.filter(e => !seenEv.has(e.id))]);
      }
      setOffset(next + res.events.length);
      setHasMore(res.events.length >= PAGE);
    } catch {
      /* لا يُفشل العرض */
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [caseFilter]);

  const filtered = useMemo(() => groups.filter(g => {
    if (status === 'active' && g.deleted) return false;
    if (status === 'deleted' && !g.deleted) return false;
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return g.symbol.toLowerCase().includes(q) || g.zoneId.toLowerCase().includes(q);
  }), [groups, status, search]);

  const counts = useMemo(() => ({
    total: groups.length,
    active: groups.filter(g => !g.deleted).length,
    deleted: groups.filter(g => g.deleted).length
  }), [groups]);

  const exportJson = () => {
    const blob = new Blob([JSON.stringify(events, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `zones-history-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          {(['all', 'active', 'deleted'] as const).map(s => (
            <button
              key={s}
              type="button"
              onClick={() => setStatus(s)}
              className="px-2.5 py-1 rounded-lg text-[11px] font-semibold"
              style={status === s
                ? { background: 'var(--accent)', color: '#fff' }
                : { background: 'var(--surface-1)', border: '1px solid var(--border-1)', color: 'var(--text-2)' }}
            >
              {s === 'all' ? `الكل ${counts.total}` : s === 'active' ? `نشط ${counts.active}` : `محذوف ${counts.deleted}`}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <input className="num px-2 py-1.5 text-[11px] w-36" placeholder="بحث رمز/معرّف…" value={search} onChange={e => setSearch(e.target.value)} />
          <button className="btn !py-1.5 !px-3 text-[11px]" onClick={() => void load()}>تحديث</button>
          <button className="btn !py-1.5 !px-3 text-[11px]" onClick={exportJson}>تصدير JSON</button>
        </div>
      </div>

      <p className="text-[10.5px] leading-relaxed" style={{ color: 'var(--text-3)' }}>
        سجل إلحاقي: كل تحديد يدوي يُضيف نسخة كاملة — فتُعرض هنا كل التعديلات والمحذوفات، بينما تعرض لوحة
        المناطق النشاط الحالي فقط.
      </p>

      {loading && !groups.length ? (
        <SkeletonRow height={64} />
      ) : filtered.length === 0 ? (
        <div className="text-center text-[12px] py-10" style={{ color: 'var(--text-3)' }}>
          لا مناطق يدوية لهذه التصفية حتى الآن.
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map(g => {
            const lastZone = g.lastVersion.zone;
            return (
              <div key={g.zoneId} className="rounded-xl px-3.5 py-3 space-y-2" style={{ background: 'var(--surface-1)', border: `1px solid ${g.deleted ? 'rgba(242,54,69,0.35)' : 'var(--border-1)'}` }}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="text-[13px] font-bold num" style={{ color: 'var(--text-1)' }}>{g.symbol}</span>
                    <span className="num text-[10.5px] px-2 py-0.5 rounded-full" style={{
                      background: lastZone.type === 'BSL' ? 'rgba(242,54,69,0.12)' : 'rgba(8,153,129,0.12)',
                      color: ZONE_COLOR[lastZone.type],
                      border: `1px solid ${ZONE_COLOR[lastZone.type]}44`
                    }}>
                      {lastZone.type} {fmtPrice(lastZone.price)}
                    </span>
                    {!g.deleted && (
                      <span className="text-[10px] px-2 py-0.5 rounded-full" style={{ background: 'rgba(38,166,154,0.12)', color: '#26a69a' }}>نشطة</span>
                    )}
                    {g.deleted && (
                      <span className="text-[10px] px-2 py-0.5 rounded-full" style={{ background: 'rgba(242,54,69,0.12)', color: '#f23645' }}>محذوفة</span>
                    )}
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="num text-[10.5px]" style={{ color: 'var(--text-3)' }}>{g.versions.length} نسخة</span>
                    <span className="num text-[10.5px]" style={{ color: 'var(--text-3)' }}>
                      آخر تحديث: {new Date(g.lastVersion.ts).toLocaleString('en', { dateStyle: 'medium', timeStyle: 'short' })}
                    </span>
                  </div>
                </div>

                <div className="space-y-1">
                  {g.versions.map(v => {
                    const s = ACTION_STYLE[v.action];
                    return (
                      <div key={v.eventId} className="flex items-start gap-2 text-[11px] rounded-lg px-2.5 py-1.5"
                        style={{ background: 'var(--surface-2)' }}>
                        <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded-full font-semibold" style={{ background: s.bg, color: s.color }}>{s.label}</span>
                        <span className="num shrink-0 text-[10px]" style={{ color: 'var(--text-3)' }}>
                          {new Date(v.ts).toLocaleString('en', { dateStyle: 'short', timeStyle: 'short' })}
                        </span>
                        <span className="num" style={{ color: 'var(--text-1)' }}>
                          {ZONE_COLOR[v.zone.type] && <span style={{ color: ZONE_COLOR[v.zone.type] }}>{v.zone.type}</span>} {fmtPrice(v.zone.price)}
                          {v.zone.timeframe ? ` · ${v.zone.timeframe}` : ''}
                        </span>
                        {v.zone.note && <span className="truncate max-w-56 text-[10.5px]" style={{ color: 'var(--text-2)' }}>{v.zone.note}</span>}
                        {v.zone.swept && <span className="text-[10px]" style={{ color: 'var(--text-3)' }}>مسحوبة</span>}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
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