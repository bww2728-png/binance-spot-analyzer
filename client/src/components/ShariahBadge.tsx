import { useEffect, useRef, useState } from 'react';
import { useStore } from '../store/useStore';
import { evaluateShariah, factsForSymbol, type ShariahAssessment, type ShariahFacts, type EvidenceItem } from '../lib/shariah';
import type { CoinShariahRow } from '../lib/types';

const VERDICT_STYLE: Record<string, { cls: string; label: string }> = {
  halal: { cls: 'badge-up', label: 'حلال' },
  haram: { cls: 'badge-down', label: 'حرام' },
  uncertain: { cls: 'badge-warn', label: 'للتحقق' }
};

/** شارة التصنيف الشرعي مع نافذة الأسباب والأدلة */
export default function ShariahBadge({ symbol }: { symbol: string }) {
  const shariah = useStore(s => s.shariah);
  const saveShariah = useStore(s => s.saveShariah);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [localFacts, setLocalFacts] = useState<ShariahFacts | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  const row: CoinShariahRow | undefined = shariah[symbol];

  /* التقييم المحسوب: إذا كان محفوظاً نعرضه، وإلا نحسبه فوراً من الحقائق المرجعية */
  const computed: ShariahAssessment = (() => {
    if (row?.reasons?.length) {
      const storedEvidence: EvidenceItem[] = (row.evidence ?? []).map(ev => ({
        id: ev.id, type: ev.type as EvidenceItem['type'], text: ev.text, ref: ev.ref, grade: ev.grade, topic: 'general'
      }));
      return {
        verdict: row.verdict,
        headline: row.reasons[0],
        reasons: row.reasons,
        evidence: storedEvidence,
        hits: [],
        fiqh_dispute: null,
        disclaimer: 'التصنيف محسوب آلياً بقواعد حتمية على حقائق موثقة، مستنداً إلى أدلة مثبتة من الكتاب والسنة — والحكم الشرعي النهائي لأهل العلم.'
      };
    }
    return evaluateShariah(factsForSymbol(symbol), symbol);
  })();

  const verdict = computed.verdict;
  const vs = VERDICT_STYLE[verdict] ?? VERDICT_STYLE.uncertain;

  // إغلاق عند النقر خارج النافذة
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const toggleFact = (key: keyof ShariahFacts, val: boolean | null) => {
    setLocalFacts(prev => ({ ...(prev ?? factsForSymbol(symbol)), [key]: val }));
  };

  const saveLocal = async () => {
    const facts = localFacts ?? factsForSymbol(symbol);
    const res = evaluateShariah(facts, symbol);
    await saveShariah(symbol, {
      verdict: res.verdict,
      facts: facts as unknown as Record<string, unknown>,
      reasons: res.reasons,
      evidence: res.evidence,
      source: 'نظام التقييم الحتمي (قواعد مثبتة)',
      notes: null
    });
    setEditing(false);
  };

  return (
    <div className="relative inline-flex" ref={boxRef}>
      <button
        onClick={() => setOpen(o => !o)}
        className={`badge ${vs.cls} cursor-pointer`}
        title="افتح التصنيف الشرعي والسبب والدليل"
      >
        {vs.label}
      </button>

      {open && (
        <div
          className="absolute top-full mt-2 z-40 w-[420px] max-w-[85vw] rounded-xl p-4 space-y-3 text-right"
          style={{
            background: 'var(--surface-2)',
            border: '1px solid var(--border-2)',
            boxShadow: 'var(--shadow-lg)',
            insetInlineStart: 0,
            animation: 'modal-in 0.18s ease both'
          }}
          onClick={e => e.stopPropagation()}
        >
          {/* الترويسة */}
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <span className="font-bold text-[14px]" style={{ color: 'var(--text-1)' }}>{symbol}</span>
              <span className={`badge ${vs.cls}`}>{vs.label}</span>
            </div>
            <div className="flex items-center gap-1">
              <button className="btn !py-1 !px-2 text-[11px]" onClick={() => { setEditing(e => !e); setLocalFacts(row?.facts as unknown as ShariahFacts | null ?? factsForSymbol(symbol)); }}>
                {editing ? 'إلغاء' : 'تقييم'}
              </button>
              <button className="btn !py-1 !px-2 text-[11px]" onClick={() => setOpen(false)}>إغلاق</button>
            </div>
          </div>

          {/* الخلاصة والسبب */}
          <p className="text-[12.5px] leading-relaxed" style={{ color: 'var(--text-2)' }}>{computed.headline}</p>

          {/* الأسباب */}
          {computed.reasons.length > 0 && (
            <div className="space-y-1.5">
              <div className="text-[11px] font-bold" style={{ color: 'var(--text-3)' }}>الأسباب:</div>
              {computed.reasons.map((r, i) => (
                <div key={i} className="text-[12px] leading-relaxed flex gap-2" style={{ color: 'var(--text-1)' }}>
                  <span style={{ color: verdict === 'haram' ? 'var(--down)' : verdict === 'halal' ? 'var(--up)' : 'var(--warn)' }}>•</span>
                  {r}
                </div>
              ))}
            </div>
          )}

          {/* الأدلة: نص + مرجع + درجة */}
          {computed.evidence.length > 0 && (
            <div className="space-y-1.5">
              <div className="text-[11px] font-bold" style={{ color: 'var(--text-3)' }}>الدليل ({computed.evidence.length}):</div>
              {computed.evidence.map(ev => (
                <div key={ev.id} className="rounded-lg p-2.5" style={{ background: 'var(--surface-1)', border: '1px solid var(--border-1)' }}>
                  <div className="text-[13px] leading-relaxed" style={{ color: 'var(--text-1)', fontFamily: 'var(--font-ar)' }}>«{ev.text}»</div>
                  <div className="mt-1 flex items-center gap-2 flex-wrap">
                    <span className="text-[10.5px] font-semibold" style={{ color: 'var(--accent)' }}>{ev.ref}</span>
                    <span className="badge badge-neutral">{ev.grade}</span>
                    <span className="badge badge-accent">{ev.type === 'quran' ? 'قرآن' : ev.type === 'hadith' ? 'حديث' : 'قاعدة'}</span>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* خلاف فقهي */}
          {computed.fiqh_dispute && (
            <div className="rounded-lg p-2.5 text-[11.5px] leading-relaxed" style={{ background: 'var(--warn-soft)', border: '1px solid rgba(245,158,11,0.3)', color: 'var(--warn)' }}>
              ⚖ {computed.fiqh_dispute}
            </div>
          )}

          {/* تنبيه */}
          <p className="text-[10.5px] leading-relaxed" style={{ color: 'var(--text-4)' }}>{computed.disclaimer}</p>

          {/* وضع التحرير: إجابات الحقائق */}
          {editing && (
            <div className="space-y-2 border-t pt-3" style={{ borderColor: 'var(--border-1)' }}>
              <div className="text-[11px] font-bold" style={{ color: 'var(--text-3)' }}>إجابات الحقائق (أعد التقييم فوراً):</div>
              {(Object.keys(factsForSymbol(symbol)) as (keyof ShariahFacts)[]).map(key => {
                const val = (localFacts ?? factsForSymbol(symbol))[key];
                return (
                  <div key={key} className="flex items-center justify-between gap-2">
                    <span className="text-[11.5px]" style={{ color: 'var(--text-2)' }}>{FACT_LABELS[key]}</span>
                    <div className="flex gap-1">
                      <button className={`badge ${val === true ? 'badge-up' : 'badge-neutral'}`} onClick={() => toggleFact(key, true)}>نعم</button>
                      <button className={`badge ${val === false ? 'badge-down' : 'badge-neutral'}`} onClick={() => toggleFact(key, false)}>لا</button>
                      <button className={`badge ${val === null ? 'badge-warn' : 'badge-neutral'}`} onClick={() => toggleFact(key, null)}>غير معروف</button>
                    </div>
                  </div>
                );
              })}
              <button className="btn btn-accent w-full justify-center" onClick={() => void saveLocal()}>احفظ التقييم المحسوب</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const FACT_LABELS: Record<keyof ShariahFacts, string> = {
  has_utility: 'منفعة/استخدام حقيقي',
  is_memecoin: 'عملة ميم بلا منفعة',
  has_lending_interest: 'إقراض بفائدة (ربا)',
  has_fixed_yield: 'عائد ثابت مضمون',
  linked_haram_activity: 'ارتباط بأنشطة محرمة',
  is_asset_backed: 'مغطاة بأصل حقيقي',
  pure_speculation: 'مضاربة خالصة/غرر',
  privacy_concern: 'خصوصية/إخفاء عالٍ'
};