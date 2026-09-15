import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../store/useStore';
import {
  evaluateShariah, factsForSymbol, FACT_QUESTIONS, factsFromAnswers,
  type ShariahAssessment, type EvidenceItem, type FactAnswers
} from '../lib/shariah';
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
  const scanBarcode = useStore(s => s.scanBarcode);
  const saveShariah = useStore(s => s.saveShariah);

  const [adding, setAdding] = useState(false);
  const [docOpen, setDocOpen] = useState(false);
  const [docAnswers, setDocAnswers] = useState<FactAnswers>({});
  const [docSource, setDocSource] = useState('');
  const [docNotes, setDocNotes] = useState('');
  const [savingDoc, setSavingDoc] = useState(false);
  const [tfLower, setTfLower] = useState<Timeframe>('15m');
  const [tfUpper, setTfUpper] = useState<Timeframe>('4h');
  const [trendLower, setTrendLower] = useState<Trend | null>(null);
  const [trendUpper, setTrendUpper] = useState<Trend | null>(null);
  const [basisLower, setBasisLower] = useState('');
  const [basisUpper, setBasisUpper] = useState('');
  const [suggesting, setSuggesting] = useState(false);
  const [barcodeScan, setBarcodeScan] = useState<Awaited<ReturnType<typeof scanBarcode>> | null>(null);
  const [barcodeScanning, setBarcodeScanning] = useState(false);
  const [barcodeError, setBarcodeError] = useState('');

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
  const shariahBlocked = verdict !== 'halal' || undocumented || assessment.evidence.length === 0;
  const docEligible = shariahBlocked && verdict !== 'haram';

  const openDoc = () => {
    const row = shariah[upSymbol];
    if (row?.facts) {
      const pre: FactAnswers = {};
      for (const q of FACT_QUESTIONS) {
        const v = (row.facts as Record<string, unknown>)[q.key];
        if (typeof v === 'boolean') pre[q.key] = v;
      }
      setDocAnswers(pre);
      setDocSource(row.source ?? '');
      setDocNotes(row.notes ?? '');
    } else {
      setDocAnswers({});
      setDocSource('');
      setDocNotes('');
    }
    setDocOpen(true);
  };

  const docAnswered = FACT_QUESTIONS.some(q => docAnswers[q.key] === true || docAnswers[q.key] === false);
  const canSaveDoc = docSource.trim().length >= 3 && docAnswered;

  const saveDoc = async () => {
    setSavingDoc(true);
    try {
      const facts = factsFromAnswers(docAnswers);
      const res = evaluateShariah(facts, upSymbol);
      await saveShariah(upSymbol, {
        verdict: res.verdict,
        facts: facts as unknown as Record<string, unknown>,
        reasons: [res.headline, ...res.reasons],
        evidence: res.evidence.map(({ id, type, text, ref, grade }) => ({ id, type, text, ref, grade })),
        source: `توثيق المستخدم: ${docSource.trim()}`,
        notes: docNotes.trim() || null
      });
      setDocOpen(false);
      pushToast(res.verdict === 'halal'
        ? `اعتبر المحرك ${upSymbol} حلالاً حسب التوثيق — فُتح الإدراج`
        : `حُفظ التوثيق — حكم المحرك: ${VERDICT_STYLE[res.verdict].label}`);
    } catch (e) {
      pushToast(`فشل حفظ التوثيق: ${String(e)}`, 'alert');
    } finally {
      setSavingDoc(false);
    }
  };

  useEffect(() => {
    if (!isSpot) return;
    let disposed = false;
    setBarcodeScanning(true);
    setBarcodeError('');
    setBarcodeScan(null);
    void (async () => {
      let lastError: unknown;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          const result = await scanBarcode(upSymbol);
          if (!disposed) setBarcodeScan(result);
          return;
        } catch (error) {
          lastError = error;
          if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 700 * (attempt + 1)));
        }
      }
      if (!disposed) setBarcodeError(String(lastError ?? 'تعذر فحص الباركود'));
    })()
      .finally(() => { if (!disposed) setBarcodeScanning(false); });
    return () => { disposed = true; };
  }, [isSpot, scanBarcode, upSymbol]);

  const confirm = async () => {
    setAdding(true);
    try {
      await addAnalysis(upSymbol, {
        trend_lower: trendLower,
        trend_upper: trendUpper,
        tf_lower: tfLower,
        tf_upper: tfUpper
      });
      pushToast(`أُضيفت ${upSymbol}`);
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
            {docEligible && !docOpen && (
              <div
                className="rounded-lg p-2.5 flex items-center justify-between gap-2 flex-wrap"
                style={{ background: 'var(--warn-soft)', border: '1px solid rgba(245,158,11,0.3)' }}
              >
                <span className="text-[12px] leading-relaxed" style={{ color: '#fbbf24' }}>
                  {undocumented
                    ? 'لا توجد بيانات موثقة عن هذا المشروع — وثّقه الآن لفتح الإدراج.'
                    : 'الحكم «للتحقق» حسب التوثيق الحالي — يمكنك استكمال التوثيق أو تعديله.'}
                </span>
                <button className="btn !py-1 !px-2.5 text-[11px]" onClick={openDoc}>وثّق الآن</button>
              </div>
            )}
            {docOpen && (
              <div className="rounded-xl p-3 space-y-2.5" style={{ background: 'var(--surface-1)', border: '1px solid var(--border-2)' }}>
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <span className="text-[12.5px] font-bold" style={{ color: 'var(--text-1)' }}>
                    نموذج توثيق المشروع — الحقائق الثمانية التي يفحصها المحرك
                  </span>
                  <button className="btn !py-1 !px-2.5 text-[11px]" onClick={() => setDocOpen(false)}>إغلاق النموذج</button>
                </div>
                <div className="space-y-1.5">
                  {FACT_QUESTIONS.map(q => {
                    const val = docAnswers[q.key] ?? null;
                    const pill = (v: boolean | null, label: string, activeBg: string) => (
                      <button
                        key={label}
                        type="button"
                        onClick={() => setDocAnswers(a => ({ ...a, [q.key]: v }))}
                        className="text-[10.5px] px-2 py-0.5 rounded-full font-semibold"
                        style={{
                          background: val === v ? activeBg : 'var(--surface-2)',
                          color: val === v ? '#fff' : 'var(--text-2)',
                          border: `1px solid ${val === v ? activeBg : 'var(--border-1)'}`,
                          transition: 'background var(--transition), color var(--transition)'
                        }}
                      >
                        {label}
                      </button>
                    );
                    return (
                      <div
                        key={q.key}
                        className="rounded-lg p-2.5 space-y-1"
                        style={{ background: 'var(--surface-0)', border: '1px solid var(--border-1)' }}
                      >
                        <div className="flex items-center justify-between gap-2 flex-wrap">
                          <span className="text-[12px] font-bold" style={{ color: 'var(--text-1)' }}>{q.label}</span>
                          <div className="flex gap-1">
                            {pill(true, 'نعم', 'var(--up)')}
                            {pill(false, 'لا', 'var(--down)')}
                            {pill(null, 'لا أعرف', 'var(--text-3)')}
                          </div>
                        </div>
                        <div className="text-[10.5px] leading-relaxed" style={{ color: 'var(--text-3)' }}>{q.hint}</div>
                      </div>
                    );
                  })}
                </div>
                <div className="space-y-1.5">
                  <input
                    value={docSource}
                    onChange={e => setDocSource(e.target.value)}
                    placeholder="المصدر إلزامي: اسم الموقع أو الوثيقة + الرابط إن أمكن"
                    className="w-full rounded-lg px-3 py-2 text-[12px]"
                    style={{ background: 'var(--surface-2)', border: '1px solid var(--border-1)', color: 'var(--text-1)' }}
                  />
                  <input
                    value={docNotes}
                    onChange={e => setDocNotes(e.target.value)}
                    placeholder="ملاحظات إضافية (اختياري)"
                    className="w-full rounded-lg px-3 py-2 text-[12px]"
                    style={{ background: 'var(--surface-2)', border: '1px solid var(--border-1)', color: 'var(--text-1)' }}
                  />
                </div>
                <p className="text-[10.5px] leading-relaxed" style={{ color: 'var(--text-4)' }}>
                  التوثيق مسؤوليتك في الدقة والأمانة؛ المحرك يطبق قواعده الحتمية على ما تُدخله فقط — لا يخمّن النظام شيئاً، والحكم الشرعي النهائي لأهل العلم.
                </p>
                <button
                  className="btn btn-accent w-full"
                  onClick={() => void saveDoc()}
                  disabled={savingDoc || !canSaveDoc}
                >
                  {savingDoc ? '…يُحفظ ويُقيَّم' : 'احفظ التوثيق وقيّم الآن'}
                </button>
                {!canSaveDoc && (
                  <div className="text-[10.5px]" style={{ color: 'var(--text-3)' }}>
                    يلزم للاكتمال: ذكر المصدر + الإجابة عن سؤال واحد على الأقل (نعم/لا).
                  </div>
                )}
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

          {/* 3) فحص الباركود */}
          <section className="card p-4 space-y-2.5">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <span className="text-[13px] font-bold" style={{ color: 'var(--text-1)' }}>3) فحص الباركود — شموع الدقيقة</span>
              {barcodeScanning && <span className="badge badge-neutral">جارٍ الفحص تلقائياً…</span>}
              {!barcodeScanning && barcodeScan?.is_barcode && <span className="badge badge-warn">باركود — تحذير فقط</span>}
              {!barcodeScanning && barcodeScan && !barcodeScan.is_barcode && <span className="badge badge-up">ليست باركود</span>}
              {!barcodeScanning && barcodeError && <span className="badge badge-down">تعذر الفحص — ستتم إعادة المحاولة</span>}
            </div>
            {barcodeScan && (
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-[11px]" style={{ color: 'var(--text-2)' }}>
                <span>الدرجة: <b className="num">{barcodeScan.score}</b></span>
                <span>الشموع: <b className="num">{barcodeScan.candles_count}</b></span>
                <span>الفجوات: <b className="num">{barcodeScan.gap_count}</b></span>
                <span>الظلال: <b className="num">{barcodeScan.big_wick_count}</b></span>
              </div>
            )}
            {barcodeScan && <p className="text-[11.5px]" style={{ color: 'var(--text-3)' }}>{barcodeScan.reason} — آخر فحص: {new Date(barcodeScan.scanned_at).toLocaleString('ar')}</p>}
            {barcodeError && <p className="text-[11.5px]" style={{ color: 'var(--down)' }}>تعذر إكمال الفحص بعد المحاولات التلقائية؛ لن يتم تمكين الإضافة حتى ينجح الفحص.</p>}
          </section>

          {/* 4) الاتجاه المقترح */}
          <section className="card p-4 space-y-3">
            <span className="text-[13px] font-bold" style={{ color: 'var(--text-1)' }}>4) الاتجاه المقترح آلياً (قابل للتعديل)</span>
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
            {haramBlocked || shariahBlocked ? (
              <div className="flex items-center gap-2">
                <span className="text-[12px]" style={{ color: verdict === 'haram' ? '#fb7185' : '#fbbf24' }}>
                  {verdict === 'haram'
                    ? 'محرّمة حسب البيانات الموثقة'
                    : 'لا يوجد حكم حلال موثق — وثّق المشروع من النموذج أعلاه لفتح الإدراج'}
                </span>
                <button className="btn btn-accent" disabled>تأكيد الإضافة</button>
              </div>
            ) : (
              <button
                className="btn btn-accent"
                onClick={() => void confirm()}
                disabled={adding || alreadyAdded || !isSpot || barcodeScanning || !barcodeScan || !!barcodeError}
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
