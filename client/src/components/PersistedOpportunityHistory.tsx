import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import type { PersistedOpportunityHistoryItem, PersistedRejectionReason } from '../lib/types';
import LoadErrorState from './ui/LoadErrorState';

type Props = { engine: 'live' | 'strategy2' };

const outcomeLabel = (value: string | null) => {
  if (!value) return 'قيد النتيجة';
  if (value === 'target' || value === 'target2') return value === 'target2' ? 'الهدف الثاني' : 'الهدف';
  if (value === 'stop' || value === 'invalidated') return value === 'invalidated' ? 'إبطال' : 'وقف';
  return value;
};

export default function PersistedOpportunityHistory({ engine }: Props) {
  const [items, setItems] = useState<PersistedOpportunityHistoryItem[]>([]);
  const [total, setTotal] = useState(0);
  const [nextCursor, setNextCursor] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reasons, setReasons] = useState<PersistedRejectionReason[]>([]);
  const [reasonError, setReasonError] = useState<string | null>(null);
  const sentinel = useRef<HTMLDivElement | null>(null);
  const loadingRef = useRef(false);

  const loadPage = useCallback(async (reset = false) => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    setError(null);
    try {
      const page = await api.getPersistedOpportunityHistory(engine, {
        beforeId: reset ? null : nextCursor,
        limit: 30
      });
      setItems(current => {
        const base = reset ? [] : current;
        const seen = new Set(base.map(item => item.eventId));
        return [...base, ...page.items.filter(item => !seen.has(item.eventId))];
      });
      setTotal(page.total);
      setNextCursor(page.nextCursor);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'تعذر جلب السجل الدائم');
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  }, [engine, nextCursor]);

  const loadReasons = useCallback(async () => {
    try {
      const response = await api.getRejectedOpportunitySummary(engine);
      setReasons(response.reasons);
      setReasonError(null);
    } catch (cause) {
      setReasonError(cause instanceof Error ? cause.message : 'تعذر تحميل أسباب الرفض');
    }
  }, [engine]);

  useEffect(() => {
    setItems([]);
    setNextCursor(null);
    setTotal(0);
    void loadPage(true);
    void loadReasons();
  }, [engine]);

  useEffect(() => {
    const node = sentinel.current;
    if (!node || nextCursor == null || loading || error) return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) void loadPage();
    }, { rootMargin: '320px' });
    observer.observe(node);
    return () => observer.disconnect();
  }, [error, loadPage, loading, nextCursor]);

  const title = engine === 'live' ? 'أحدث فرص المحرك الحي المحفوظة' : 'أحدث فرص استراتيجيتي المحفوظة';

  return (
    <section className="card p-4 space-y-3" aria-label={title}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="font-bold text-[14px]" style={{ color: 'var(--text-1)' }}>{title}</h3>
          <p className="text-[11px] mt-1" style={{ color: 'var(--text-3)' }}>سجل دائم من قاعدة البيانات · {total.toLocaleString('ar')} فرصة محفوظة · يعرض الأحدث أولًا</p>
        </div>
        <button className="btn btn-secondary text-[11px]" onClick={() => void loadPage(true)} disabled={loading}>تحديث السجل</button>
      </div>

      {reasons.length > 0 && (
        <details className="rounded-lg p-3" style={{ background: 'var(--surface-1)' }}>
          <summary className="text-[12px] font-semibold cursor-pointer" style={{ color: 'var(--text-2)' }}>أسباب الرفض المسجلة (أعلى 12 سببًا)</summary>
          <div className="mt-2 space-y-1.5">
            {reasons.map(item => (
              <div key={item.reason} className="flex justify-between gap-3 text-[11px]">
                <span className="break-words" style={{ color: 'var(--text-2)' }}>{item.reason}</span>
                <span className="num shrink-0 font-bold" style={{ color: 'var(--text-1)' }}>{item.count.toLocaleString('ar')}</span>
              </div>
            ))}
          </div>
        </details>
      )}
      {reasonError && <div className="text-[11px]" role="status" style={{ color: 'var(--warn)' }}>تعذر جلب ملخص الرفض: {reasonError}</div>}

      {error && items.length === 0 && <LoadErrorState title="تعذر تحميل التاريخ الدائم" detail={error} onRetry={() => void loadPage(true)} />}
      {error && items.length > 0 && <div className="text-[11px]" role="status" style={{ color: 'var(--warn)' }}>تعذر تحميل الصفحة التالية: {error} <button className="underline" onClick={() => void loadPage()}>إعادة المحاولة</button></div>}
      {items.length === 0 && !loading && !error && <div className="rounded-lg p-5 text-center text-[12px]" style={{ background: 'var(--surface-1)', color: 'var(--text-3)' }}>لا توجد فرص منشورة في السجل الدائم.</div>}

      {items.length > 0 && (
        <div className="space-y-2">
          {items.map(item => (
            <article key={item.eventId} className="rounded-lg p-3 grid grid-cols-2 md:grid-cols-6 gap-x-3 gap-y-1 text-[11px]" style={{ background: 'var(--surface-1)', border: '1px solid var(--border-1)' }}>
              <div><span style={{ color: 'var(--text-3)' }}>الرمز </span><strong className="num">{item.symbol}</strong></div>
              <div><span style={{ color: 'var(--text-3)' }}>الفريم </span><strong className="num">{item.timeframe}</strong></div>
              <div><span style={{ color: 'var(--text-3)' }}>الدخول </span><strong className="num">{item.entry ?? '—'}</strong></div>
              <div><span style={{ color: 'var(--text-3)' }}>وقف/هدف </span><strong className="num">{item.stop ?? '—'} / {item.target ?? '—'}</strong></div>
              <div><span style={{ color: 'var(--text-3)' }}>R:R </span><strong className="num">{item.rr ?? '—'}</strong></div>
              <div><span style={{ color: 'var(--text-3)' }}>الحالة </span><strong style={{ color: item.outcome ? 'var(--text-1)' : 'var(--accent)' }}>{outcomeLabel(item.outcome)}</strong></div>
              <div className="col-span-2 md:col-span-6 text-[10px]" style={{ color: 'var(--text-3)' }}>{new Date(item.publishedAt).toLocaleString('ar')}</div>
            </article>
          ))}
        </div>
      )}

      {loading && <div className="text-center text-[11px] py-2" style={{ color: 'var(--text-3)' }}>جارٍ تحميل السجل المحفوظ…</div>}
      {nextCursor != null && !loading && <div ref={sentinel} className="h-2" aria-hidden="true" />}
      {nextCursor == null && items.length > 0 && <div className="text-center text-[10px] py-2" style={{ color: 'var(--text-3)' }}>وصلت إلى نهاية السجل · {items.length.toLocaleString('ar')} من {total.toLocaleString('ar')}</div>}
    </section>
  );
}
