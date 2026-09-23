import { useState } from 'react';
import { api } from '../lib/api';
import ZoneChart from './ZoneChart';
import type { LiquidityDetection } from '../lib/types';

export const kindLabel: Record<string, string> = {
  horizontal_bsl: 'BSL أفقي',
  horizontal_ssl: 'SSL أفقي',
  trendline_bsl: 'BSL خط اتجاه',
  trendline_ssl: 'SSL خط اتجاه'
};

export const stateLabel: Record<string, string> = {
  potential: 'محتمل',
  candidate: 'مرشح',
  confirmed: 'مؤكد',
  swept: 'مسحوب'
};

export const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
export const price = (n: number | null | undefined) => n == null ? '—' : Number(n).toPrecision(8);
export const date = (n: number | null | undefined) => n ? new Date(n > 1e12 ? n : n * 1000).toLocaleString('ar-SA') : '—';

export function ZoneCard({ zone, onOpen }: { zone: LiquidityDetection; onOpen: (zone: LiquidityDetection) => void }) {
  const bullish = zone.kind.includes('ssl');
  return (
    <button
      onClick={() => onOpen(zone)}
      className="text-right rounded-xl p-3 transition-colors"
      style={{ background: 'var(--surface-1)', border: `1px solid ${bullish ? 'rgba(8,153,129,.35)' : 'rgba(242,54,69,.35)'}` }}
    >
      <div className="flex items-center justify-between gap-2 mb-2">
        <div className="flex items-center gap-2">
          <span className="num font-bold" style={{ color: bullish ? 'var(--up)' : 'var(--down)' }}>{zone.symbol}</span>
          <span className="num text-[11px]" style={{ color: 'var(--text-3)' }}>{zone.timeframe}</span>
        </div>
        <span className="px-2 py-0.5 rounded-full text-[10px]" style={{ background: bullish ? 'var(--up-soft)' : 'var(--down-soft)', color: bullish ? 'var(--up)' : 'var(--down)' }}>
          {kindLabel[zone.kind] ?? zone.kind}
        </span>
      </div>
      <div className="flex items-center justify-between gap-2 text-[11px]">
        <span style={{ color: 'var(--text-2)' }}>{stateLabel[zone.state] ?? zone.state}</span>
        <span className="num font-bold" style={{ color: zone.confidence >= .7 ? 'var(--accent)' : 'var(--text-1)' }}>{pct(zone.confidence)} ثقة</span>
      </div>
      <div className="grid grid-cols-3 gap-1 mt-2 text-center">
        <div><div className="text-[9px]" style={{ color: 'var(--text-3)' }}>المرجع</div><div className="num text-[11px]">{price(zone.referenceLevel)}</div></div>
        <div><div className="text-[9px]" style={{ color: 'var(--text-3)' }}>السيولة</div><div className="num text-[11px]">{price(zone.liquidityLevel)}</div></div>
        <div><div className="text-[9px]" style={{ color: 'var(--text-3)' }}>اللمسات</div><div className="num text-[11px]">{zone.touches}</div></div>
      </div>
    </button>
  );
}

export function ZoneDetail({ zone, onClose, onReviewed }: { zone: LiquidityDetection; onClose: () => void; onReviewed: (zone: LiquidityDetection) => void }) {
  const [note, setNote] = useState(zone.review?.note ?? '');
  const [saving, setSaving] = useState(false);
  const [phase, setPhase] = useState<'at' | 'after'>('at');
  const review = async (verdict: 'accept' | 'reject') => {
    setSaving(true);
    try {
      const r = await api.reviewLiquidityZone(zone.id, { verdict, note });
      onReviewed(r.zone);
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3" style={{ background: 'rgba(15,23,42,.35)' }} onClick={onClose}>
      <div className="w-full max-w-5xl max-h-[92vh] overflow-auto rounded-2xl p-4" style={{ background: 'var(--surface-0)', border: '1px solid var(--border-1)', boxShadow: 'var(--shadow-lg)' }} onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between gap-3 mb-3">
          <div>
            <div className="flex items-center gap-2"><span className="num font-bold">{zone.symbol}</span><span className="num text-[12px]" style={{ color: 'var(--text-3)' }}>{zone.timeframe}</span><span className="text-[12px]" style={{ color: 'var(--accent)' }}>{kindLabel[zone.kind]}</span></div>
            <div className="text-[11px] mt-1" style={{ color: 'var(--text-3)' }}>الحالة: {stateLabel[zone.state]} · اكتُشف: {date(zone.detectedAt)}</div>
          </div>
          <button onClick={onClose} className="px-3 py-1.5 rounded-lg text-[12px]" style={{ background: 'var(--surface-2)', color: 'var(--text-2)' }}>إغلاق</button>
        </div>
        <div className="grid lg:grid-cols-[1.2fr_1fr] gap-4">
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <button onClick={() => setPhase('at')} className="px-3 py-1.5 rounded-lg text-[11px]" style={{ background: phase === 'at' ? 'var(--accent-soft)' : 'var(--surface-1)', color: phase === 'at' ? 'var(--accent)' : 'var(--text-2)' }}>عند الكشف</button>
              <button onClick={() => setPhase('after')} className="px-3 py-1.5 rounded-lg text-[11px]" style={{ background: phase === 'after' ? 'var(--accent-soft)' : 'var(--surface-1)', color: phase === 'after' ? 'var(--accent)' : 'var(--text-2)' }}>بعد الكشف</button>
              <span className="text-[10px]" style={{ color: 'var(--text-3)' }}>شارت حي تفاعلي من بينانس مباشرة</span>
            </div>
            <div className="rounded-xl overflow-hidden" style={{ background: '#fff', border: '1px solid var(--border-1)' }}>
              <ZoneChart zone={zone} phase={phase} height={360} />
            </div>
            <div className="rounded-lg p-2 flex flex-wrap gap-x-4 gap-y-1" style={{ background: 'var(--surface-1)' }}>
              <span className="text-[10px]"><span title="المرجع" style={{ color: '#64748b' }}>— —</span> المرجع (المقاومة/الدعم)</span>
              <span className="text-[10px]"><span style={{ color: '#7c3aed' }}>◯</span> نقطة لمس (قمة/قاع بنّت المنطقة)</span>
              <span className="text-[10px]"><span style={{ color: '#f59e0b' }}>━</span> خط الاتجاه</span>
              <span className="text-[10px]"><span style={{ color: '#7c3aed' }}>تظليل</span> Premium</span>
              <span className="text-[10px]"><span style={{ color: '#d97706' }}>· ·</span> وقف Retail</span>
            </div>
            <div className="text-[10px] rounded-lg p-2" style={{ background: 'var(--surface-1)', color: 'var(--text-3)' }}>
              لتحقيق منطقك: راقب النقاط ◯ والمستويات فوق الشموع الحقيقية. إن كان التحديد خاطئاً ارفضه واكتب ملاحظتك — ملاحظتك تدخل تعلّم المحرك.
            </div>
          </div>
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-2">
              {[
                ['Reference', price(zone.referenceLevel)],
                ['Liquidity', price(zone.liquidityLevel)],
                ['Retail Stop', price(zone.retailStop)],
                ['ATR', price(zone.atr)],
                ['المسافة ATR', String(zone.distanceAtr)],
                ['البروز ATR', String(zone.prominenceAtr)],
                ['اللمسات', String(zone.touches)],
                ['الثقة', pct(zone.confidence)]
              ].map(([label, value]) => <div key={label} className="rounded-lg px-2.5 py-2" style={{ background: 'var(--surface-1)' }}><div className="text-[9px]" style={{ color: 'var(--text-3)' }}>{label}</div><div className="num text-[12px] font-semibold">{value}</div></div>)}
            </div>
            <div className="rounded-lg p-3" style={{ background: 'var(--surface-1)' }}>
              <div className="text-[11px] font-bold mb-1.5">سبب التحديد</div>
              <ul className="space-y-1">{zone.reasons.map(reason => <li key={reason} className="text-[11px]" style={{ color: 'var(--text-2)' }}>• {reason}</li>)}</ul>
            </div>
            <textarea value={note} onChange={e => setNote(e.target.value)} placeholder="ملاحظتك على التحديد…" className="w-full min-h-20 rounded-lg p-2 text-[12px] resize-y" style={{ background: 'var(--surface-1)', border: '1px solid var(--border-1)', color: 'var(--text-1)' }} />
            <div className="flex gap-2">
              <button disabled={saving} onClick={() => void review('accept')} className="flex-1 px-3 py-2 rounded-lg text-[12px] font-bold" style={{ background: 'var(--up-soft)', color: 'var(--up)', opacity: saving ? .5 : 1 }}>قبول وتعلم</button>
              <button disabled={saving} onClick={() => void review('reject')} className="flex-1 px-3 py-2 rounded-lg text-[12px] font-bold" style={{ background: 'var(--down-soft)', color: 'var(--down)', opacity: saving ? .5 : 1 }}>رفض وتعلم</button>
            </div>
            <div className="text-[10px]" style={{ color: 'var(--text-3)' }}>المستويات تحليلية فقط وليست أوامر تنفيذ. كل فريم وكل نوع محفوظ كسجل مستقل.</div>
          </div>
        </div>
      </div>
    </div>
  );
}
