import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api';
import type { BacktestResults, BacktestStatus, BacktestTrade } from '../lib/types';
import Skeleton from './ui/Skeleton';

/* واجهة الباك تيست والفرص الحية — walk-forward + حلقة تعلم مستمرة + أدوات المخاطر (عرض فقط)
 * - ملخص: عدد الصفقات + النجاح النهائي + النجاح بعد قواعد المتعلّم (≥ 0.7 هدف)
 * - تقسيم لكل فريم: نجاح + متوسط rr
 * - الفرص الحية: آخر صفقة غير محسومة لكل (رمز، فريم، منطقة) بخطة كاملة (دخول/وقف/هدف/حجم)
 * - وقف الخسارة: منطق النظام الحالي حرفياً — المستوى المحمي ± نطاق. صخر تعديل.
 */

function pct(n: number | null | undefined) {
  return n == null ? '—' : `${(n * 100).toFixed(1)}%`;
}

function fmtTime(ts: number | null | undefined) {
  return ts == null ? '—' : new Date(ts).toLocaleString('ar');
}

function fmtNum(n: number | null | undefined, digits = 2) {
  return n == null ? '—' : n.toLocaleString('en', { maximumFractionDigits: digits });
}

export default function BacktestScreen() {
  const [status, setStatus] = useState<BacktestStatus | null>(null);
  const [results, setResults] = useState<BacktestResults | null>(null);
  const [loading, setLoading] = useState(true);
  const [launching, setLaunching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [coin, setCoin] = useState('');
  const [frame, setFrame] = useState('');
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const [st, res] = await Promise.all([
        api.getBacktestStatus(signal),
        api.getBacktestResults({
          coin: coin.trim().toUpperCase() || undefined,
          timeframe: frame || undefined
        }, signal).catch(() => null)
      ]);
      if (signal?.aborted) return;
      setStatus(st);
      setResults(res);
      setError(null);
    } catch (e) {
      if (!signal?.aborted) setError(String(e));
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [coin, frame]);

  useEffect(() => {
    const ac = new AbortController();
    void load(ac.signal);
    return () => ac.abort();
  }, [load]);

  // دوري: 15 ثانية — أثناء الجولة أسرع (5 ثوانٍ)
  useEffect(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(() => void load(), status?.busy ? 5000 : 15000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [status?.busy, load]);

  const launch = useCallback(async () => {
    setLaunching(true);
    try {
      await api.runBacktest();
      void load();
    } catch (e) {
      setError(String(e));
    } finally {
      setLaunching(false);
    }
  }, [load]);

  // محسوب: ملخص + تقسيم الفريمات + الفرص الحية (آخر صفقة غير محسومة لكل منطقة)
  const summary = useMemo(() => {
    const all = (results?.results ?? []).flatMap(r => r.trades ?? []);
    const decided = all.filter(t => t.win === 0 || t.win === 1);
    const wins = decided.filter(t => t.win === 1).length;
    return {
      total: all.length,
      decided: decided.length,
      winRate: decided.length ? wins / decided.length : null,
      avgRR: decided.length && decided.filter(t => Number.isFinite(t.rr)).length
        ? decided.reduce((a, t) => a + (Number.isFinite(t.rr) ? t.rr : 0), 0) / decided.filter(t => Number.isFinite(t.rr)).length
        : null,
      avgBars: decided.length ? decided.reduce((a, t) => a + (t.bars || 0), 0) / decided.length : null
    };
  }, [results]);

  const perFrame = useMemo(() => {
    const map = new Map<string, { decided: number; wins: number }>();
    for (const pair of results?.results ?? []) {
      for (const t of pair.trades ?? []) {
        if (t.win !== 0 && t.win !== 1) continue;
        const m = map.get(pair.timeframe) ?? { decided: 0, wins: 0 };
        m.decided += 1;
        if (t.win === 1) m.wins += 1;
        map.set(pair.timeframe, m);
      }
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [results]);

  const live = useMemo(() => {
    // الفرص الحية: صفقة واحدة لكل (رمز، فريم، منطقة) — الأحدث — غير محسومة
    const best = new Map<string, BacktestTrade>();
    for (const pair of results?.results ?? []) {
      for (const t of pair.trades ?? []) {
        if (t.win !== undefined || t.undecided) continue;
        const key = `${t.symbol}|${t.timeframe}|${t.zoneType}|${t.zonePrice}`;
        const prev = best.get(key);
        if (!prev || (t.ts ?? 0) > (prev.ts ?? 0)) best.set(key, t);
      }
    }
    return [...best.values()].sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0)).slice(0, 30);
  }, [results]);

  const goalMet = (summary.winRate ?? 0) >= 0.7;

  return (
    <div className="flex-1 overflow-y-auto px-3 sm:px-6 py-4">
      <div className="max-w-6xl mx-auto flex flex-col gap-4">
        {/* الترويسة */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-bold" style={{ color: 'var(--text-1)' }}>الباك تيست والفرص الحية</h2>
            <p className="text-[12px] mt-0.5" style={{ color: 'var(--text-3)' }}>
              walk-forward على الحلال + غير الباركود × كل الفريمات — تعلم مستمرة بهدف نجاح ≥ 70% — عرض فقط
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => void launch()}
              disabled={launching || status?.busy}
              className="px-4 py-2 rounded-lg text-[13px] font-bold"
              style={{ background: 'var(--accent)', color: '#fff', opacity: launching || status?.busy ? 0.5 : 1 }}
            >
              {status?.busy ? 'الجولة قيد التنفيذ...' : 'إطلاق الجولة'}
            </button>
          </div>
        </div>

        {/* شريط حالة الجولة */}
        {status?.busy && (
          <div className="badge-accent px-4 py-2.5 rounded-lg text-[12px]">
            الجولة قيد التنفيذ: {status.pairsDone}/{status.pairsTotal} زوج — المستهدفات: {status.targetsCount} (الحلال + غير الباركود)
          </div>
        )}
        {status?.error && (
          <div className="badge-warn px-4 py-2.5 rounded-lg text-[12px]">خطأ في الجولة: {status.error}</div>
        )}
        {error && (
          <div className="badge-warn px-4 py-2.5 rounded-lg text-[12px]">تعذر التحميل: {error}</div>
        )}

        {/* ملخص */}
        {loading ? (
          <Skeleton height={96} />
        ) : results && results.exists ? (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {[
                { label: 'الصفقات', value: fmtNum(summary.decided) },
                { label: 'النجاح النهائي', value: pct(summary.winRate), highlight: goalMet },
                { label: 'متوسط rr', value: fmtNum(summary.avgRR) },
                { label: 'متوسط المدة (شمعة)', value: fmtNum(summary.avgBars, 1) }
              ].map(c => (
                <div key={c.label} className="rounded-xl px-4 py-3" style={{ background: 'var(--surface-1)', border: '1px solid var(--border-1)' }}>
                  <div className="text-[11px]" style={{ color: 'var(--text-3)' }}>{c.label}</div>
                  <div className="text-xl font-bold mt-1 num" style={{ color: c.highlight ? 'var(--accent)' : 'var(--text-1)' }}>{c.value}</div>
                </div>
              ))}
            </div>

            {/* طبقة التعلم */}
            {results.learn && (
              <div className="rounded-xl px-4 py-3" style={{ background: 'var(--surface-1)', border: '1px solid var(--border-1)' }}>
                <div className="text-[13px] font-bold mb-1.5" style={{ color: 'var(--text-1)' }}>طبقة التعلم المستمرة</div>
                {results.learn.enough ? (
                  <div className="flex flex-wrap gap-x-6 gap-y-1 text-[12px]" style={{ color: 'var(--text-2)' }}>
                    <span>تدريب: {fmtNum(results.learn.trainCount)} صفقة</span>
                    <span>تحقق: {fmtNum(results.learn.validationCount)}</span>
                    <span>النجاح قبل: {pct(results.learn.evalBefore?.winRate)}</span>
                    <span>النجاح بعد قواعد المتعلّم: {pct(results.learn.evalAfter?.winRate)}</span>
                    {results.learn.rules && (
                      <span>القواعد: درجة ≥ {results.learn.rules.minScore}{results.learn.rules.requireCluster ? ' + عنقود' : ''}{results.learn.rules.requireBubble ? ' + فقاعة' : ''}{!results.learn.rules.allowSwept ? ' + بلا سحب' : ''} (مُختارة: {results.learn.rules.kept})</span>
                    )}
                  </div>
                ) : (
                  <div className="text-[12px]" style={{ color: 'var(--text-3)' }}>{results.learn.message ?? 'بيانات غير كافية للتعلم بعد'}</div>
                )}
              </div>
            )}

            {/* تقسيم الفريمات */}
            {perFrame.length > 0 && (
              <div className="rounded-xl px-4 py-3" style={{ background: 'var(--surface-1)', border: '1px solid var(--border-1)' }}>
                <div className="text-[13px] font-bold mb-2" style={{ color: 'var(--text-1)' }}>النجاح لكل فريم</div>
                <div className="flex flex-wrap gap-2">
                  {perFrame.map(([tf, m]) => {
                    const wr = m.wins / m.decided;
                    return (
                      <div key={tf} className="px-3 py-2 rounded-lg text-center" style={{ background: 'var(--surface-0)', border: '1px solid var(--border-1)' }}>
                        <div className="text-[11px] font-semibold" style={{ color: 'var(--text-2)' }}>{tf}</div>
                        <div className="text-lg font-bold num" style={{ color: wr >= 0.7 ? 'var(--accent)' : wr >= 0.5 ? 'var(--text-1)' : 'var(--text-3)' }}>{pct(wr)}</div>
                        <div className="text-[10px]" style={{ color: 'var(--text-3)' }}>{m.decided} صفقة</div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* الفرص الحية */}
            <div>
              <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
                <div className="text-[13px] font-bold" style={{ color: 'var(--text-1)' }}>الفرص الحية (بخطة كاملة — عرض فقط)</div>
                <div className="flex items-center gap-2">
                  <input
                    value={coin}
                    onChange={e => setCoin(e.target.value)}
                    placeholder="رمز"
                    className="px-3 py-1.5 rounded-lg text-[12px] num w-24"
                    style={{ background: 'var(--surface-1)', border: '1px solid var(--border-1)', color: 'var(--text-1)' }}
                  />
                  <select
                    value={frame}
                    onChange={e => setFrame(e.target.value)}
                    className="px-3 py-1.5 rounded-lg text-[12px]"
                    style={{ background: 'var(--surface-1)', border: '1px solid var(--border-1)', color: 'var(--text-1)' }}
                  >
                    <option value="">كل الفريمات</option>
                    <option value="1h">1h</option>
                    <option value="4h">4h</option>
                    <option value="1d">1d</option>
                  </select>
                </div>
              </div>
              {live.length === 0 ? (
                <div className="text-[12px] px-4 py-6 rounded-xl text-center" style={{ background: 'var(--surface-1)', border: '1px dashed var(--border-1)', color: 'var(--text-3)' }}>
                  لا فرص محسومة حالياً — كل الصفقات المحسومة من جولة الجولة الأخيرة حُسمت (هدف/وقف) أو لم تبدأ جولة بعد
                </div>
              ) : (
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-2">
                  {live.map((t, i) => (
                    <div key={`${t.symbol}-${t.timeframe}-${t.zoneType}-${t.zonePrice}-${i}`} className="rounded-xl px-4 py-3" style={{ background: 'var(--surface-1)', border: '1px solid var(--border-1)' }}>
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <span className="font-bold num" style={{ color: 'var(--text-1)' }}>{t.symbol}</span>
                          <span className="text-[11px] num" style={{ color: 'var(--text-3)' }}>{t.timeframe}</span>
                          <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${t.zoneType === 'BSL' ? 'badge-up' : 'badge-accent'}`}>{t.zoneType}</span>
                          <span className="text-[10px] num" style={{ color: 'var(--text-3)' }}>درجة {fmtNum(t.score, 0)}</span>
                        </div>
                        <span className="text-[10px]" style={{ color: 'var(--text-3)' }}>{fmtTime(t.ts)}</span>
                      </div>
                      <div className="grid grid-cols-3 sm:grid-cols-6 gap-1.5 mt-2 text-center">
                        {[
                          { l: 'دخول', v: fmtNum(t.entry) },
                          { l: 'وقف', v: fmtNum(t.protectedPrice) },
                          { l: 'rr', v: fmtNum(t.rr) },
                          { l: 'كلي', v: fmtNum(t.kelly, 2) },
                          { l: 'كلي مجزأ', v: fmtNum(t.fF, 3) },
                          { l: 'حجم', v: fmtNum(t.units, 3) }
                        ].map(c => (
                          <div key={c.l}>
                            <div className="text-[9px]" style={{ color: 'var(--text-3)' }}>{c.l}</div>
                            <div className="text-[11px] font-semibold num" style={{ color: 'var(--text-1)' }}>{c.v}</div>
                          </div>
                        ))}
                      </div>
                      {t.reasons.length > 0 && (
                        <div className="text-[10px] mt-1.5 truncate" style={{ color: 'var(--text-3)' }} title={t.reasons.join(' · ')}>
                          {t.reasons.slice(0, 3).join(' · ')}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        ) : (
          <div className="text-[13px] px-4 py-10 rounded-xl text-center" style={{ background: 'var(--surface-1)', border: '1px dashed var(--border-1)', color: 'var(--text-3)' }}>
            {results?.message ?? 'لم تُجرَ جولة بعد — اضغط "إطلاق الجولة" لبدء الباك تيست على المستهدفات'}
          </div>
        )}
      </div>
    </div>
  );
}
