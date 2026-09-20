import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import { TIMEFRAMES } from '../lib/types';
import type { AutoHistoryRow, AutoZoneScreenshot } from '../lib/types';
import Skeleton from './ui/Skeleton';

const TYPE_BADGE = {
  BSL: { cls: 'badge-up', label: 'BSL سيولة شرائية' },
  SSL: { cls: 'badge-accent', label: 'SSL سيولة بيعية' }
} as const;

function fmtTime(ts: number) {
  return new Date(ts).toLocaleString('ar');
}

export default function AutoHistory() {
  const [rows, setRows] = useState<AutoHistoryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [symbol, setSymbol] = useState('');
  const [timeframe, setTimeframe] = useState('');
  const [type, setType] = useState<'' | 'BSL' | 'SSL'>('');
  const [minScore, setMinScore] = useState('');
  const [fabioOnly, setFabioOnly] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [shots, setShots] = useState<Map<string, AutoZoneScreenshot>>(new Map());
  const [viewer, setViewer] = useState<AutoZoneScreenshot | null>(null);
  const [total, setTotal] = useState(0);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    try {
      const sym = symbol.trim().toUpperCase() || undefined;
      const [res, shotRes] = await Promise.all([
        api.getAutoHistory({
          symbol: sym,
          timeframe: timeframe || undefined,
          type: type || undefined,
          minScore: minScore !== '' ? Number(minScore) : undefined,
          fabioOnly,
          limit: 200
        }, signal),
        api.getAutoScreenshots({ symbol: sym }, signal).catch(() => ({ screenshots: [] as AutoZoneScreenshot[] }))
      ]);
      if (signal?.aborted) return;
      setRows(res.rows);
      setTotal(res.total ?? res.rows.length);
      setShots(new Map(shotRes.screenshots.map(s => [s.zoneKey, s])));
    } catch (e) {
      if (!signal?.aborted) setError(String(e));
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [symbol, timeframe, type, minScore, fabioOnly]);

  useEffect(() => {
    const ac = new AbortController();
    void load(ac.signal);
    // تحديث دوري: السجل آلي يتحرك مع جولات الكشف (كل 60 ثانية — خفيف على الشبكة)
    const t = setInterval(() => void load(ac.signal), 60000);
    return () => { ac.abort(); clearInterval(t); };
  }, [load]);

  const stats = useMemo(() => {
    const symbols = [...new Set(rows.map(r => r.symbol))].length;
    const swept = rows.filter(r => r.swept).length;
    const scored = rows.filter(r => r.score != null);
    const avgScore = scored.length
      ? scored.reduce((s, r) => s + (r.score ?? 0), 0) / scored.length
      : 0;
    return { total: rows.length, symbols, swept, avgScore };
  }, [rows]);

  return (
    <div className="p-6 space-y-6 max-w-7xl">
      <section>
        <h2 className="text-[15px] font-bold mb-1" style={{ color: 'var(--text-1)' }}>السجل التاريخي للتحديد الآلي</h2>
        <p className="text-[11px] mb-4" style={{ color: 'var(--text-3)' }}>
          كل لقطات الكشف الآلي المُفككة من أحداث auto_zones_snapshot — مع فلاتر ونافذة تحديث دوري (30 ثانية)
        </p>

        {/* الفلاتر */}
        <div className="flex flex-wrap items-center gap-2 mb-4">
          <input
            value={symbol}
            onChange={e => setSymbol(e.target.value)}
            placeholder="الرمز (BTCUSDT)"
            className="input w-40"
            aria-label="فلتر الرمز"
          />
          <select value={timeframe} onChange={e => setTimeframe(e.target.value)} className="input w-28" aria-label="فلتر الفريم">
            <option value="">كل الفريمات</option>
            {TIMEFRAMES.map(tf => <option key={tf} value={tf}>{tf}</option>)}
          </select>
          <select value={type} onChange={e => setType(e.target.value as '' | 'BSL' | 'SSL')} className="input w-36" aria-label="فلتر نوع المنطقة">
            <option value="">كل الأنواع</option>
            <option value="BSL">BSL</option>
            <option value="SSL">SSL</option>
          </select>
          <input
            value={minScore}
            onChange={e => setMinScore(e.target.value)}
            placeholder="أدنى حيوية"
            className="input w-28"
            inputMode="decimal"
            aria-label="فلتر أدنى حيوية"
          />
          <label className="flex items-center gap-1.5 text-[12px] cursor-pointer select-none" style={{ color: 'var(--text-2)' }} title="قصّ المناطق الهيكلية وإبقاء مناطق منطق المزاد فقط">
            <input type="checkbox" checked={fabioOnly} onChange={e => setFabioOnly(e.target.checked)} />
            مناطق المزاد فقط
          </label>
          <button onClick={() => void load()} className="btn btn-secondary text-[12px]">تحديث الآن</button>
        </div>

        {/* ملخص */}
        <div className="flex flex-wrap gap-3 mb-4">
          <div className="card px-4 py-2.5 text-center min-w-[110px]">
            <div className="num text-xl font-bold" style={{ color: 'var(--text-1)' }}>{total || stats.total}</div>
            <div className="text-[10px]" style={{ color: 'var(--text-3)' }}>مناطق مرصودة</div>
          </div>
          <div className="card px-4 py-2.5 text-center min-w-[110px]">
            <div className="num text-xl font-bold" style={{ color: 'var(--accent)' }}>{stats.symbols}</div>
            <div className="text-[10px]" style={{ color: 'var(--text-3)' }}>رموز نشطة</div>
          </div>
          <div className="card px-4 py-2.5 text-center min-w-[110px]">
            <div className="num text-xl font-bold" style={{ color: 'var(--warn)' }}>{stats.swept}</div>
            <div className="text-[10px]" style={{ color: 'var(--text-3)' }}>سحبت السيولة</div>
          </div>
          <div className="card px-4 py-2.5 text-center min-w-[110px]">
            <div className="num text-xl font-bold" style={{ color: 'var(--up)' }}>{stats.avgScore ? stats.avgScore.toFixed(2) : '—'}</div>
            <div className="text-[10px]" style={{ color: 'var(--text-3)' }}>متوسط الحيوية</div>
          </div>
        </div>

        {error && (
          <div className="badge badge-warn mb-3">تعذر جلب السجل: {error}</div>
        )}

        {/* الجدول */}
        <div className="card overflow-auto max-h-[65vh] scroll-contain">
          {loading && rows.length === 0 ? (
            <div className="p-4 space-y-2">
              {Array.from({ length: 5 }, (_, i) => <Skeleton key={i} height={32} />)}
            </div>
          ) : (
            <table className="w-full text-xs">
              <thead className="sticky top-0" style={{ background: 'var(--surface-2)' }}>
                <tr>
                  {['الوقت', 'الرمز', 'الفريم', 'النوع', 'السعر', 'الحيوية', 'عناقيد', 'الحالة'].map(h => (
                    <th key={h} className="p-2.5 text-right font-semibold" style={{ color: 'var(--text-2)', borderBottom: '1px solid var(--border-2)' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={8} className="p-10 text-center" style={{ color: 'var(--text-3)' }}>
                      لا سجل بعد — ستظهر اللقطات تلقائياً مع جولات الكشف الآلي
                    </td>
                  </tr>
                )}
                {rows.flatMap(r => {
                  const badge = TYPE_BADGE[r.type] ?? { cls: 'badge-neutral', label: r.type };
                  const rowId = `${r.zoneKey}-${r.eventId}-${r.id}`;
                  const isOpen = expanded === rowId;
                  const cells = (
                    <tr
                      key={rowId}
                      onClick={() => setExpanded(isOpen ? null : rowId)}
                      className="row-hover-soft"
                      style={{ borderTop: '1px solid var(--border-1)', cursor: 'pointer' }}
                    >
                      <td className="num p-2.5 text-[11px]" style={{ color: 'var(--text-3)' }}>{fmtTime(r.snapshotTs)}</td>
                      <td className="p-2.5 font-bold" style={{ color: 'var(--text-1)' }}>{r.symbol.replace('USDT', '')}</td>
                      <td className="num p-2.5" style={{ color: 'var(--text-2)' }}>{r.timeframe}</td>
                      <td className="p-2.5"><span className={`badge ${badge.cls}`}>{badge.label}</span></td>
                      <td className="num p-2.5 font-semibold" style={{ color: 'var(--text-1)' }}>{r.price}</td>
                      <td className="num p-2.5" style={{ color: (r.score ?? 0) >= 0.7 ? 'var(--up)' : 'var(--text-2)' }}>{r.score != null ? r.score.toFixed(2) : '—'}</td>
                      <td className="num p-2.5" style={{ color: 'var(--text-2)' }}>{r.clusterCount ?? '—'}</td>
                      <td className="p-2.5">
                        {r.swept
                          ? <span className="badge badge-warn">⚡ سُحبت</span>
                          : r.feedback === 'confirm'
                            ? <span className="badge badge-up">✓ مؤكدة</span>
                            : r.feedback === 'reject'
                              ? <span className="badge badge-neutral">✕ مرفوضة</span>
                              : <span className="badge badge-neutral">• نشطة</span>}
                      </td>
                    </tr>
                  );
                  const causes = isOpen && r.reasons.length ? [(
                    <tr key={`causes-${rowId}`}>
                      <td colSpan={8} className="p-3" style={{ background: 'var(--surface-2)' }}>
                        <div className="text-[11px] leading-relaxed mb-2" style={{ color: 'var(--text-2)' }}>
                          <span className="font-bold" style={{ color: 'var(--text-1)' }}>الأسباب:</span>{' '}
                          {r.reasons.join(' — ')}
                          {r.note && <> <span className="font-bold" style={{ color: 'var(--text-1)' }}>| الملاحظة:</span> {r.note}</>}
                          {r.sweptAt && <> <span className="num" style={{ color: 'var(--text-3)' }}>(سحبت عند {fmtTime(r.sweptAt)})</span></>}
                        </div>
                        {(() => {
                          const shot = shots.get(r.zoneKey);
                          if (!shot) {
                            return (
                              <div className="text-[10.5px]" style={{ color: 'var(--text-3)' }}>
                                لا صورة محفوظة لهذه المنطقة — تُلتقط تلقائياً لحظة التحديد من الآن
                              </div>
                            );
                          }
                          return (
                            <button
                              onClick={e => { e.stopPropagation(); setViewer(shot); }}
                              className="block text-right cursor-pointer border-0 bg-transparent p-0"
                              title="فتح صورة الشارت المحفوظة لحظة التحديد"
                            >
                              <img
                                src={shot.dataUrl}
                                alt={`شارت ${r.symbol} لحظة تحديد ${r.type} عند ${r.price}`}
                                className="rounded max-w-full"
                                style={{ maxHeight: 160, border: '1px solid var(--border-1)' }}
                              />
                              <div className="text-[10px] mt-1" style={{ color: 'var(--accent)' }}>
                                صورة الشارت لحظة التحديد — اضغط للتكبير ({fmtTime(shot.capturedAt)})
                              </div>
                            </button>
                          );
                        })()}
                      </td>
                    </tr>
                  )] : [];
                  return [cells, ...causes];
                })}
              </tbody>
            </table>
          )}
        </div>

        {/* عارض الصورة المكبرة */}
        {viewer && (
          <div
            onClick={() => setViewer(null)}
            className="fixed inset-0 z-50 flex items-center justify-center p-8 cursor-zoom-out"
            style={{ background: 'rgba(2, 6, 14, 0.85)', backdropFilter: 'blur(3px)' }}
          >
            <div
              onClick={e => e.stopPropagation()}
              className="card max-w-4xl w-full p-3 cursor-default"
            >
              <div className="flex items-center justify-between mb-2">
                <div className="text-[12px] font-bold" style={{ color: 'var(--text-1)' }}>
                  {viewer.symbol} · {viewer.timeframe} · {viewer.type} @ {viewer.price}
                </div>
                <button onClick={() => setViewer(null)} className="btn btn-secondary !py-1 text-[12px]">إغلاق</button>
              </div>
              <img
                src={viewer.dataUrl}
                alt={`شارت ${viewer.symbol} لحظة تحديد ${viewer.type}`}
                className="rounded w-full"
                style={{ border: '1px solid var(--border-1)' }}
              />
              <div className="text-[10.5px] mt-2" style={{ color: 'var(--text-3)' }}>
                التُقطت لحظة التحديد الآلي: {fmtTime(viewer.capturedAt)}
              </div>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
