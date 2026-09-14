import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../store/useStore';
import { evaluateShariah, factsForSymbol, type ShariahAssessment, type EvidenceItem } from '../lib/shariah';
import { suggestTrend } from '../lib/trend';
import { TIMEFRAMES } from '../lib/types';
import type { Trend, Timeframe } from '../lib/types';

const VERDICT_STYLE: Record<string, { cls: string; label: string }> = {
  halal: { cls: 'badge-up', label: 'حلال' },
  haram: { cls: 'badge-down', label: 'حرام' },
  uncertain: { cls: 'badge-warn', label: 'للتحقق' }
};

/**
 * نافذة تقرير الفحص قبل الإدراج:
 * سبوت؟ حكم المحرك الشرعي بالأسباب والأدلة؟ اقتراح الاتجاهين؟ — لا إدراج بلا تأكيد المستخدم.
 */
export default function AddReviewModal({ symbol, onClose }: { symbol: string; onClose: () => void }) {
  const symbols = useStore(s => s.symbols);
  const shariah = useStore(s => s.shariah);
  const analyses = useStore(s => s.analyses);
  const addAnalysis = useStore(s => s.addAnalysis);
  const syncSymbols = useStore(s => s.syncSymbols);
  const pushToast = useStore(s => s.pushToast);

  const [adding, setAdding] = useState(false);
  const [tfLower, setTfLower] = useState<Timeframe>('15m');
  const [tfUpper, setTfUpper] = useState<Timeframe>('4h');
  const [trendLower, setTrendLower] = useState<Trend | null>(null);
  const [trendUpper, setTrendUpper] = useState<Trend | null>(null);
  const [basisLower, setBasisLower] = useState('');
  const [basisUpper, setBasisUpper] = useState('');
  const [suggesting, setSuggesting] = useState(false);

  const upSymbol = symbol.toUpperCase();
  const spotRow = useMemo(() => symbols.find(s => s.symbol === upSymbol), [symbols, upSymbol]);
  const isSpot = !!spotRow;
  const alreadyAdded = useMemo(() => analyses.some(a => a.symbol === upSymbol), [analyses, upSymbol]);

  /* حكم المحرك: من المخزن أو محسوب فوراً */
  const assessment: ShariahAssessment = useMemo(() => {
    const row = shariah[upSymbol];
    if (row?.reasons?.length) {
      const evidence: EvidenceItem[] = (row.evidence ?? []).map(ev => ({
        id: ev.id, type: ev.type as EvidenceItem['type'], text: ev.text, ref: ev.ref, grade: ev.grade, topic: 'general'
      }));
      return {
        verdict: row.verdict,
        headline: row.reasons[0],
        reasons: row.reasons,
        evidence,
        hits: [],
        fiqh_dispute: null,
        disclaimer: 'التصنيف محسوب آلياً بقواعد حتمية على حقائق موثقة — والحكم الشرعي النهائي لأهل العلم.'
      };
    }
    return evaluateShariah(factsForSymbol(upSymbol), upSymbol);
  }, [shariah, upSymbol]);

  /* غير الموثق: كل الحقائق غير معروفة — يُسمح بالإضافة بوسم برتقالي، ولا يُغفل أي عملة */
  const undocumented = useMemo(
    () => !shariah[upSymbol] && Object.values(factsForSymbol(upSymbol)).every(v => v === null),
    [shariah, upSymbol]
  );

  const verdict = assessment.verdict;
  const vs = VERDICT_STYLE[verdict] ?? VERDICT_STYLE.uncertain;

  /* جلب اقتراحات الاتجاه عند الفتح وعند تغيير الفريم */
  useEffect(() => {
    if (!isSpot) return;
    let disposed = false;
    setSuggesting(true);
    void (async () => {
      const [low, up] = await Promise.all([
        suggestTrend(upSymbol, tfLower),
        suggestTrend(upSymbol, tfUpper)
      ]);
      if (disposed) return;
      setTrendLower(low.trend);
      setTrendUpper(up.trend);
      setBasisLower(low.basis);
      setBasisUpper(up.basis);
      setSuggesting(false);
    })();
    return () => { disposed = true; };
  }, [isSpot, upSymbol, tfLower, tfUpper]);

  const haramBlocked = verdict === 'haram' && !undocumented;

  const confirm = async () => {
    setAdding(true);
    try {
      await addAnalysis(upSymbol, {
        trend_lower: trendLower,
        trend_upper: trendUpper,
        tf_lower: tfLower,
        tf_upper: tfUpper
      });
      pushToast(`أُضيفت ${upSymbol}${undocumented ? ' بوسم «قيد التوثيق»' : ''}`);
      onClose();
    } catch (e) {
      pushToast(`فشل الإدراج: ${String(e)}`, 'alert');
    } finally {
      setAdding(false);
    }
  };

  const trendBadge = (t: Trend | null, basis: string) => {
    if (t === 'up') return <span className="badge badge-up" title={basis}>صاعد (مقترح)</span>;
    if (t === 'down') return <span className="badge badge-down" title={basis}>هابط (مقترح)</span>;
    return <span className="badge badge-neutral" title={basis}>غير حاسم — حدّده يدوياً</span>;
  };

  const tfPills = (value: Timeframe, set: (t: Timeframe) => void, prefix: string) => (
    <div className="flex gap-1 flex-wrap">
      {TIMEFRAMES.map(tf => (
        <button
          key={`${prefix}${tf}`}
          onClick={() => set(tf)}
          className="num text-[10.5px] px-2 py-0.5 rounded-full font-semibold"
          style={{
            background: value === tf ? 'var(--accent)' : 'var(--surface-2)',
            color: value === tf ? '#fff' : 'var(--text-2)',
            border: `1px solid ${value === tf ? 'var(--accent)' : 'var(--border-1)'}`,
            transition: 'background var(--transition), color var(--transition)'
          }}
        >
          {tf}
        </button>
      ))}
    </div>
  );

  return (
    <div
      className="anim-overlay fixed inset-0 z-40 flex items-center justify-center p-4"
      style={{ background: 'rgba(4, 6, 10, 0.82)', backdropFilter: 'blur(4px)' }}
      onClick={onClose}
    >
      <div
        className="anim-modal rounded-2xl w-full max-w-2xl max-h-full overflow-auto"
        style={{ background: 'var(--surface-0)', border: '1px solid var(--border-2)', boxShadow: 'var(--shadow-lg)' }}
        onClick={e => e.stopPropagation()}
      >
        {/* الترويسة */}
        <div
          className="flex items-center justify-between px-5 py-3.5 sticky top-0 z-10"
          style={{ background: 'var(--surface-glass)', backdropFilter: 'blur(10px)', borderBottom: '1px solid var(--border-1)' }}
        >
          <h2 className="text-base font-bold" style={{ color: 'var(--text-1)' }}>
            تقرير فحص: <span className="num">{upSymbol}</span>
          </h2>
          <button
            onClick={onClose}
            aria-label="إغلاق"
            className="w-8 h-8 rounded-lg flex items-center justify-center text-xl"
            style={{ color: 'var(--text-2)', transition: 'background var(--transition)' }}
            onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'var(--surface-3)'; }}
            onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
          >
            ×
          </button>
        </div>

        <div className="p-5 space-y-5">
          {/* 1) فحص السبوت */}
          <section className="card p-4 space-y-2">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <span className="text-[13px] font-bold" style={{ color: 'var(--text-1)' }}>1) هل هو زوج سبوت متداول؟</span>
              {isSpot
                ? <span className="badge badge-up">نعم — سبوت متداول في بينانس</span>
                : <span className="badge badge-down">لا — غير موجود في قائمة السبوت المتداول</span>}
            </div>
            {isSpot && spotRow && (
              <div className="text-[12px] num" style={{ color: 'var(--text-2)' }}>
                {spotRow.symbol} — دقة السعر: {spotRow.tickSize}
              </div>
            )}
            {!isSpot && (
              <div className="text-[12px] leading-relaxed" style={{ color: 'var(--text-2)' }}>
                قد تكون القائمة محلية قديمة — جرّب تحديثها من بينانس ثم أعد الفحص.
                <button className="btn !py-1 !px-2.5 text-[11px] mr-2" onClick={() => void syncSymbols()}>تحديث القائمة</button>
              </div>
            )}
            {alreadyAdded && (
              <div className="text-[12px]" style={{ color: '#fbbf24' }}>
                ملاحظة: هذه العملة مُدرجة بالفعل في لوحة المتابعة.
              </div>
            )}
          </section>

          {/* 2) الحكم الشرعي */}
          <section className="card p-4 space-y-2.5">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <span className="text-[13px] font-bold" style={{ color: 'var(--text-1)' }}>2) حكم المحرك الشرعي</span>
              <span className={`badge ${vs.cls}`}>{vs.label}</span>
            </div>
            {undocumented && (
              <div className="rounded-lg p-2.5 text-[12px] leading-relaxed" style={{ background: 'var(--warn-soft)', border: '1px solid rgba(245,158,11,0.3)', color: '#fbbf24' }}>
                لا توجد بيانات شرعية موثقة عن هذا المشروع في قاعدة المعرفة — سيُدرج بوسم برتقالي
                «قيد التوثيق» حتى يُستكمل توثيقه (النظام لا يغفل أي عملة، والتحقق مسؤوليتك).
              </div>
            )}
            <p className="text-[12.5px] leading-relaxed" style={{ color: 'var(--text-2)' }}>{assessment.headline}</p>

            {assessment.reasons.length > 0 && (
              <div className="space-y-1">
                <div className="text-[11px] font-bold" style={{ color: 'var(--text-3)' }}>الأسباب:</div>
                {assessment.reasons.map((r, i) => (
                  <div key={i} className="text-[12px] leading-relaxed flex gap-2" style={{ color: 'var(--text-1)' }}>
                    <span style={{ color: verdict === 'haram' ? 'var(--down)' : verdict === 'halal' ? 'var(--up)' : 'var(--warn)' }}>•</span>
                    {r}
                  </div>
                ))}
              </div>
            )}

            {assessment.evidence.length > 0 && (
              <div className="space-y-1.5">
                <div className="text-[11px] font-bold" style={{ color: 'var(--text-3)' }}>الأدلة ({assessment.evidence.length}):</div>
                {assessment.evidence.map(ev => (
                  <div key={ev.id} className="rounded-lg p-2.5" style={{ background: 'var(--surface-1)', border: '1px solid var(--border-1)' }}>
                    <div className="text-[12.5px] leading-relaxed" style={{ color: 'var(--text-1)', fontFamily: 'var(--font-ar)' }}>«{ev.text}»</div>
                    <div className="mt-1 flex items-center gap-2 flex-wrap">
                      <span className="text-[10.5px] font-semibold" style={{ color: 'var(--accent)' }}>{ev.ref}</span>
                      <span className="badge badge-neutral">{ev.grade}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
            <p className="text-[10.5px] leading-relaxed" style={{ color: 'var(--text-4)' }}>{assessment.disclaimer}</p>
          </section>

          {/* 3) الاتجاه المقترح */}
          <section className="card p-4 space-y-3">
            <span className="text-[13px] font-bold" style={{ color: 'var(--text-1)' }}>3) الاتجاه المقترح آلياً (قابل للتعديل)</span>
            {suggesting && <div className="text-[12px]" style={{ color: 'var(--text-3)' }}>…يحسب الاقتراح من الشموع</div>}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <div className="text-[11.5px] font-bold" style={{ color: 'var(--up)' }}>الفريم الأصغر</div>
                {trendBadge(trendLower, basisLower)}
                <div className="text-[11px]" style={{ color: 'var(--text-3)' }}>{basisLower}</div>
                <select
                  value={trendLower ?? ''}
                  onChange={e => setTrendLower((e.target.value || null) as Trend | null)}
                  style={{ width: 120 }}
                  aria-label="اتجاه الفريم الأصغر"
                >
                  <option value="">—</option>
                  <option value="up">صاعد</option>
                  <option value="down">هابط</option>
                </select>
                {tfPills(tfLower, setTfLower, 'l')}
              </div>
              <div className="space-y-2">
                <div className="text-[11.5px] font-bold" style={{ color: 'var(--warn)' }}>الفريم الأكبر</div>
                {trendBadge(trendUpper, basisUpper)}
                <div className="text-[11px]" style={{ color: 'var(--text-3)' }}>{basisUpper}</div>
                <select
                  value={trendUpper ?? ''}
                  onChange={e => setTrendUpper((e.target.value || null) as Trend | null)}
                  style={{ width: 120 }}
                  aria-label="اتجاه الفريم الأكبر"
                >
                  <option value="">—</option>
                  <option value="up">صاعد</option>
                  <option value="down">هابط</option>
                </select>
                {tfPills(tfUpper, setTfUpper, 'u')}
              </div>
            </div>
          </section>

          {/* أزرار القرار */}
          <div className="flex items-center justify-between gap-3 flex-wrap pt-1">
            <button className="btn" onClick={onClose} disabled={adding}>إلغاء</button>
            {haramBlocked ? (
              <div className="flex items-center gap-2">
                <span className="text-[12px]" style={{ color: '#fb7185' }}>محرّمة حسب البيانات الموثقة — الإدراج مقفول</span>
                <button className="btn btn-accent" disabled>تأكيد الإضافة</button>
              </div>
            ) : (
              <button
                className="btn btn-accent"
                onClick={() => void confirm()}
                disabled={adding || alreadyAdded || (!isSpot && !undocumented)}
                title={(!isSpot && !undocumented) ? 'غير متوفر في قائمة السبوت — حدّث القائمة أولاً' : ''}
              >
                {adding ? '…يُدرج' : 'تأكيد الإضافة'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
