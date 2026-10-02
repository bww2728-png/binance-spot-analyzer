import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useStore } from '../store/useStore';
import type { ChartLevel, Strategy2DirectionRow, Strategy2Opportunity } from '../lib/types';

const fmtPx = (v: number | null | undefined) =>
  v == null || !Number.isFinite(Number(v)) ? '—' : Number(v) >= 100 ? Number(v).toFixed(2) : Number(v).toPrecision(6);
const ago = (ts: number | null | undefined) => {
  if (!ts) return '—';
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s} ث`;
  if (s < 3600) return `${Math.round(s / 60)} د`;
  if (s < 86400) return `${Math.round(s / 3600)} س`;
  return `${Math.round(s / 86400)} ي`;
};

const HTF_LABEL: Record<string, string> = { up: 'صاعد', down: 'هابط', range: 'عرضي' };

/** مستويات الفرصة مرسومة على الشارت في أماكنها */
export function oppLevels(o: Strategy2Opportunity): ChartLevel[] {
  const lv: ChartLevel[] = [];
  const push = (price: number | null | undefined, color: string, title: string) => {
    if (price != null && Number.isFinite(Number(price))) lv.push({ price: Number(price), color, title });
  };
  push(o.entry, '#0ea5e9', 'دخول');
  push(o.stop, '#dc2626', 'وقف');
  push(o.tp1, '#16a34a', 'TP1');
  push(o.tp2, '#16a34a', 'TP2');
  push(o.stopRef, '#7c3aed', 'قاع السويب');
  push(o.tpAlt, '#b45309', 'TP متحفظ (BSL داخلي)');
  return lv;
}

/** درج تفاصيل الفرصة: شرح كامل + تسلسل + مستويات + اتجاه + شارت + تنقل + تعليق بشري */
export default function OppDrawer({ opps, index, onClose, onSelect, dirBySymbol, onJumpDirections }: {
  opps: Strategy2Opportunity[];
  index: number;
  onClose: () => void;
  onSelect: (i: number) => void;
  dirBySymbol: Map<string, Strategy2DirectionRow>;
  onJumpDirections: (symbol: string) => void;
}) {
  const o = opps[index] ?? null;
  const tick = useStore(s => (o ? s.strategy2Rows[o.id] : undefined));
  const openChart = useStore(s => s.openChart);
  const pushToast = useStore(s => s.pushToast);
  const [fbVerdict, setFbVerdict] = useState<'note' | 'valid' | 'invalid'>('note');
  const [fbReason, setFbReason] = useState('');
  const [fbBusy, setFbBusy] = useState(false);
  const [fbDone, setFbDone] = useState(false);

  // تنقل لوحة المفاتيح بين الفرص — القائمة والبث يبقيان ظاهرين
  useEffect(() => {
    if (!o) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') { e.preventDefault(); onSelect((index + 1) % opps.length); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); onSelect((index - 1 + opps.length) % opps.length); }
      else if (e.key === 'Escape') { e.stopPropagation(); onClose(); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [o, index, opps.length, onSelect, onClose]);
  useEffect(() => { setFbVerdict('note'); setFbReason(''); setFbDone(false); }, [o?.id]);

  if (!o) return null;
  const liveDir = dirBySymbol.get(`${o.symbol}|${o.tf}`);
  const px = tick?.price ?? o.price;
  const seq = o.sequence ?? [];
  const reqTotal = seq.filter(s => s.required).length;
  const reqDone = seq.filter(s => s.required && s.status === 'occurred').length;

  const sendFeedback = async () => {
    if (!fbReason.trim() || fbBusy) return;
    setFbBusy(true);
    try {
      await api.sendStrategy2Feedback({
        symbol: o.symbol, tf: o.tf, elementId: `manual:${o.id}`,
        verdict: fbVerdict, reason: fbReason.trim()
      });
      setFbDone(true);
      setFbReason('');
      pushToast('تم حفظ تعليقك — للتوثيق فقط ولا يغيّر قرار المحرك', 'info', undefined, { category: 'liveOpps', symbol: o.symbol });
    } catch (e) {
      pushToast(`تعذر حفظ التعليق: ${e instanceof Error ? e.message : 'خطأ'}`, 'alert', undefined, { category: 'liveOpps', symbol: o.symbol, severity: 'alert' });
    } finally {
      setFbBusy(false);
    }
  };

  const seqColor = (st: string) => st === 'occurred' ? 'var(--up)' : st === 'failed' ? 'var(--down)' : 'var(--text-3)';
  const seqSym = (st: string) => st === 'occurred' ? '✓' : st === 'failed' ? '✗' : st === 'skipped' ? '–' : '…';

  return (
    <div className="anim-overlay fixed inset-0 z-40 flex justify-end" style={{ background: 'rgba(15,23,42,0.45)' }} onClick={onClose}>
      <div className="h-full w-full max-w-[430px] overflow-y-auto p-4 space-y-3" style={{ background: 'var(--surface-1)', borderRight: '1px solid var(--border-1)' }} onClick={e => e.stopPropagation()}>
        {/* الترويسة + تنقل */}
        <div className="flex items-center gap-2 justify-between">
          <div>
            <div className="text-[15px] font-bold num" style={{ color: 'var(--text-1)' }}>{o.symbol} <span style={{ color: 'var(--text-3)' }}>{o.tf}</span></div>
            <div className="text-[11px]" style={{ color: 'var(--text-3)' }}>
              نموذج {o.model ?? '—'} · اتجاه HTF {HTF_LABEL[o.htfDirection ?? 'range'] ?? '—'} · مكتشفة {ago(o.detectedAt)}
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <button onClick={() => onSelect((index - 1 + opps.length) % opps.length)} disabled={opps.length < 2} className="btn text-[12px]" title="السابق">‹</button>
            <span className="text-[11px] num" style={{ color: 'var(--text-3)' }}>{index + 1}/{opps.length}</span>
            <button onClick={() => onSelect((index + 1) % opps.length)} disabled={opps.length < 2} className="btn text-[12px]" title="التالي">›</button>
            <button onClick={onClose} className="btn text-[12px]">✕</button>
          </div>
        </div>

        {/* السعر الحي والموقع */}
        <div className="card p-3">
          <div className="flex items-baseline gap-3 flex-wrap">
            <span className="text-[18px] font-bold num" style={{ color: 'var(--text-1)' }}>{fmtPx(px)}</span>
            {tick?.plPct != null && (
              <span className="text-[13px] font-bold num" style={{ color: tick.plPct >= 0 ? 'var(--up)' : 'var(--down)' }}>
                {tick.plPct > 0 ? '+' : ''}{tick.plPct.toFixed(2)}%
              </span>
            )}
            {tick?.rNow != null && <span className="text-[12px] num" style={{ color: 'var(--text-3)' }}>{tick.rNow.toFixed(2)}R</span>}
          </div>
          <div className="text-[11px] mt-1 num" style={{ color: 'var(--text-3)' }}>
            MFE {tick ? tick.mfeR.toFixed(2) : '—'}R · MAE {o.maeR != null ? o.maeR.toFixed(2) : '—'}R · البعد عن TP1 {tick?.toTp1Pct != null ? `${tick.toTp1Pct.toFixed(2)}%` : '—'}
          </div>
        </div>

        {/* المستويات */}
        <div className="card p-3">
          <div className="text-[12px] font-bold mb-2" style={{ color: 'var(--text-1)' }}>المستويات</div>
          <div className="grid grid-cols-2 gap-1.5 text-[12px] num">
            <span style={{ color: 'var(--text-3)' }}>دخول <b style={{ color: '#0ea5e9' }}>{fmtPx(o.entry)}</b></span>
            <span style={{ color: 'var(--text-3)' }}>وقف <b style={{ color: 'var(--down)' }}>{fmtPx(o.stop)}</b></span>
            <span style={{ color: 'var(--text-3)' }}>TP1 <b style={{ color: 'var(--up)' }}>{fmtPx(o.tp1)}</b></span>
            <span style={{ color: 'var(--text-3)' }}>TP2 <b style={{ color: 'var(--up)' }}>{fmtPx(o.tp2)}</b></span>
            <span style={{ color: 'var(--text-3)' }}>قاع السويب <b style={{ color: '#7c3aed' }}>{fmtPx(o.stopRef)}</b></span>
            <span style={{ color: 'var(--text-3)' }}>R:R <b style={{ color: 'var(--text-1)' }}>{o.rr != null ? o.rr.toFixed(2) : '—'}</b></span>
          </div>
          {o.conservative && o.tpAlt != null && (
            <div className="text-[11.5px] mt-2" style={{ color: 'var(--warn)' }}>هدف متحفظ مقترح (BSL داخلي — شريحة غير مؤكدة): <b className="num">{fmtPx(o.tpAlt)}</b></div>
          )}
          <div className="flex gap-2 mt-2">
            <button onClick={() => openChart(o.symbol, o.tf, null, oppLevels(o))} className="btn text-[12px] flex-1">الشارت مع المستويات</button>
          </div>
        </div>

        {/* لماذا هذه الفرصة */}
        <div className="card p-3">
          <div className="text-[12px] font-bold mb-1.5" style={{ color: 'var(--text-1)' }}>لماذا هذه الفرصة؟ ({reqDone}/{reqTotal} شروط لازمة)</div>
          <div className="text-[12px] space-y-1" style={{ color: 'var(--text-2)' }}>
            {o.reasons.map((r, i) => <div key={i}>• {r}</div>)}
          </div>
          {seq.length > 0 && (
            <div className="mt-2 space-y-1">
              {seq.map(s => (
                <div key={s.key} className="flex items-start gap-2 text-[11.5px]" style={{ opacity: s.status === 'occurred' || s.status === 'failed' ? 1 : 0.65 }}>
                  <span className="font-bold" style={{ color: seqColor(s.status) }}>{seqSym(s.status)}</span>
                  <span style={{ color: 'var(--text-2)' }}>{s.label}{s.required ? '' : ' (اختياري)'}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* السياق */}
        <div className="card p-3 text-[12px]" style={{ color: 'var(--text-2)' }}>
          <div className="font-bold mb-1.5" style={{ color: 'var(--text-1)' }}>السياق</div>
          <div>اتجاه HTF: <b>{HTF_LABEL[o.htfDirection ?? 'range'] ?? '—'}</b> · بعد بريميوم: <b>{o.afterPremium == null ? '—' : o.afterPremium ? 'نعم' : 'لا'}</b></div>
          <div className="num">الشريحة: {o.segmentKey ?? '—'} · معايَرة {o.calibratedWinRate != null ? `${(o.calibratedWinRate * 100).toFixed(1)}%` : '—'}{o.wilsonLB != null ? ` (Wilson ${o.wilsonLB.toFixed(2)})` : ''}</div>
          {liveDir && (
            <div className="mt-1">
              اتجاه {liveDir.tf ?? o.tf} الحالي: <b>{HTF_LABEL[liveDir.dir] ?? '—'}</b> · المرحلة: {liveDir.stage}
              {liveDir.dead ? <span style={{ color: 'var(--warn)' }}> · مات المشوار</span> : null}
              <div><button onClick={() => onJumpDirections(o.symbol)} className="text-[11.5px] mt-1" style={{ color: 'var(--accent)' }}>عرض اتجاه الرمز في سجل الاتجاهات ←</button></div>
            </div>
          )}
        </div>

        {/* تعليق بشري — توثيق فقط */}
        <div className="card p-3">
          <div className="text-[12px] font-bold" style={{ color: 'var(--text-1)' }}>تعليقك (توثيق فقط)</div>
          <div className="text-[11px] mb-2" style={{ color: 'var(--text-3)' }}>يُحفظ بجانب الفرصة ولا يغيّر قرار المحرك أبداً.</div>
          {fbDone && <div className="text-[11.5px] mb-2" style={{ color: 'var(--up)' }}>✓ حُفظ تعليقك.</div>}
          <div className="flex gap-2">
            <select value={fbVerdict} onChange={e => setFbVerdict(e.target.value as 'note' | 'valid' | 'invalid')} className="text-[12px] px-2 py-1.5 rounded-lg" style={{ background: 'var(--surface-0)', border: '1px solid var(--border-1)', color: 'var(--text-1)' }}>
              <option value="note">ملاحظة</option>
              <option value="valid">أراها صحيحة</option>
              <option value="invalid">أراها خاطئة</option>
            </select>
            <input value={fbReason} onChange={e => setFbReason(e.target.value)} placeholder="سببك باختصار…" className="text-[12px] px-2.5 py-1.5 rounded-lg flex-1" style={{ background: 'var(--surface-0)', border: '1px solid var(--border-1)', color: 'var(--text-1)' }} />
            <button onClick={sendFeedback} disabled={fbBusy || !fbReason.trim()} className="btn text-[12px]" style={{ opacity: fbBusy || !fbReason.trim() ? 0.5 : 1 }}>حفظ</button>
          </div>
        </div>
      </div>
    </div>
  );
}
