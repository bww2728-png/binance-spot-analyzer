import { useState } from 'react';
import type { LiquidityZone } from '../lib/types';
import { api } from '../lib/api';
import { useStore } from '../store/useStore';
import { zoneRange, MAX_AUTO_BANDS } from './ZoneBands';

type Tab = 'auto' | 'manual' | 'rejected';

/**
 * القائمة الجانبية بالمناطق: مركز تحكم تفاعلي —
 * آلية (تأكيد/رفض سريع + نافذة تفاصيل) · تعليمك (تعديل/حذف) · المرفوضة (استعادة).
 * النقر على الصف يميّز نطاق المنطقة على الشارت + ينقل الشارت إلى شمعة اكتشافها.
 */
export default function ZoneListPanel({
  zones,
  onPick
}: {
  zones: LiquidityZone[];
  onPick: (z: LiquidityZone) => void;
}) {
  const pushToast = useStore(s => s.pushToast);
  const refreshZoneCounts = useStore(s => s.refreshZoneCounts);
  const [tab, setTab] = useState<Tab>('auto');
  const [busyId, setBusyId] = useState<string | null>(null);

  const active = zones
    .filter(z => z.source === 'auto' && z.feedback !== 'reject')
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const manual = zones.filter(z => z.source !== 'auto');
  const rejected = zones
    .filter(z => z.source === 'auto' && z.feedback === 'reject')
    .sort((a, b) => (b.updated_at ?? b.created_at ?? 0) - (a.updated_at ?? a.created_at ?? 0));
  const list = tab === 'auto' ? active : tab === 'manual' ? manual : rejected;
  const hiddenAuto = Math.max(0, active.length - MAX_AUTO_BANDS);

  const send = async (z: LiquidityZone, verdict: 'confirm' | 'reject' | 'clear') => {
    setBusyId(z.id);
    try {
      await api.zoneFeedback(z.id, verdict);
      await refreshZoneCounts();
      pushToast(
        verdict === 'confirm' ? `أُكدت منطقة ${z.type} — Band دائم على الشارت`
        : verdict === 'reject' ? `رُفضت منطقة ${z.type} — نُقلت إلى «المرفوضة»`
        : 'استُعيدت المنطقة'
      );
    } catch (e) {
      pushToast(`فشل إرسال الرأي: ${String(e)}`, 'alert');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="rounded-xl p-3" style={{ background: 'var(--surface-1)', border: '1px solid var(--border-1)' }}>
      <div className="flex items-center justify-between gap-2 mb-2 flex-wrap">
        <div className="text-[12.5px] font-bold" style={{ color: 'var(--text-1)' }}>
          مناطق السيولة — انقر صفّاً لتمييز نطاقه على الشارت
        </div>
        <div className="flex gap-1">
          {([
            ['auto', `آلية (${active.length})`],
            ['manual', `تعليمك (${manual.length})`],
            ['rejected', `المرفوضة (${rejected.length})`]
          ] as const).map(([key, label]) => (
            <button
              key={key}
              className="text-[11px] px-2.5 py-1 rounded-full font-semibold"
              style={{
                background: tab === key ? 'var(--accent)' : 'var(--surface-2)',
                color: tab === key ? '#fff' : 'var(--text-2)'
              }}
              onClick={() => setTab(key)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {list.length === 0 ? (
        <div className="text-[11.5px] py-2" style={{ color: 'var(--text-3)' }}>
          {tab === 'auto' ? 'لا مناطق آلية بعد — أول دورة كشف قادمة ستظهر هنا.'
            : tab === 'manual' ? 'لم تعلّم مناطق بعد — فعّل «وضع التعليم» وانقر على الشارت.'
            : 'لا مناطق مرفوضة — كل ما رفضته سابقاً يظهر هنا مع إمكانية الاستعادة.'}
        </div>
      ) : (
        <div className="flex flex-col gap-1 max-h-48 overflow-auto">
          {list.slice(0, tab === 'auto' ? MAX_AUTO_BANDS : undefined).map(z => {
            const rgb = z.source === 'auto' ? (z.type === 'BSL' ? '242,54,69' : '8,153,129') : '59,130,246';
            const r = zoneRange(z);
            const busy = busyId === z.id;
            return (
              <div
                key={z.id}
                className="flex items-center gap-2 text-right px-2.5 py-1.5 rounded-lg"
                style={{
                  background: `rgba(${rgb},0.08)`,
                  border: '1px solid rgba(' + rgb + ',0.25)',
                  cursor: 'pointer',
                  opacity: busy ? 0.6 : 1
                }}
                onClick={() => onPick(z)}
                title={z.note ? `ملاحظتك: ${z.note}` : z.reasons?.join(' · ') ?? ''}
              >
                <span
                  className="text-[10px] font-bold px-1.5 py-0.5 rounded"
                  style={{ background: `rgba(${rgb},0.85)`, color: '#fff' }}
                >
                  {z.type}
                </span>
                <span className="num text-[11px]" style={{ color: 'var(--text-2)' }}>
                  {z.price.toLocaleString('en', { maximumFractionDigits: 6 })}
                </span>
                <span className="num text-[10.5px]" style={{ color: 'var(--text-3)' }}>
                  ({r.low.toLocaleString('en', { maximumFractionDigits: 6 })} – {r.high.toLocaleString('en', { maximumFractionDigits: 6 })})
                </span>
                {z.source === 'auto' ? (
                  <span className="num text-[10.5px] font-bold" style={{ color: 'var(--text-1)' }}>{z.score}٪</span>
                ) : (
                  <span className="text-[10.5px]" style={{ color: 'var(--text-3)' }}>{z.note?.slice(0, 18) ?? 'تعليمك'}</span>
                )}
                {z.feedback === 'confirm' && (
                  <span className="text-[9.5px] font-bold px-1.5 py-0.5 rounded" style={{ background: 'rgba(34,197,94,0.2)', color: '#22c55e' }}>
                    مؤكدة ✓
                  </span>
                )}
                {z.note && z.source === 'auto' && (
                  <span className="text-[9.5px] font-bold px-1.5 py-0.5 rounded" style={{ background: 'var(--surface-2)', color: 'var(--text-2)' }} title={z.note}>
                    ملاحظة
                  </span>
                )}
                <span className="text-[10.5px] truncate flex-1" style={{ color: 'var(--text-3)' }}>
                  {z.timeframe}{z.reasons?.[0] ? ` · ${z.reasons[0]}` : ''}
                </span>
                {z.source === 'auto' && z.anchorTime != null && (
                  <span className="num text-[10px]" style={{ color: 'var(--text-3)' }} title="زمن شمعة الاكتشاف — النقر ينقل الشارت إليها">
                    {new Date(z.anchorTime * 1000).toLocaleDateString('en', { month: 'short', day: 'numeric' })}
                  </span>
                )}
                {z.source === 'auto' && tab === 'auto' && (
                  <span className="flex gap-1 shrink-0">
                    {z.feedback !== 'confirm' && (
                      <button
                        className="text-[10px] font-bold w-5 h-5 rounded"
                        style={{ background: 'rgba(34,197,94,0.18)', color: '#22c55e' }}
                        disabled={busy}
                        title="تأكيد — Band دائم + تعلّم النظام"
                        onClick={e => { e.stopPropagation(); void send(z, 'confirm'); }}
                      >✓</button>
                    )}
                    {z.feedback !== 'reject' && (
                      <button
                        className="text-[10px] font-bold w-5 h-5 rounded"
                        style={{ background: 'rgba(242,54,69,0.15)', color: '#f23645' }}
                        disabled={busy}
                        title="رفض — نقل إلى «المرفوضة» + تعلّم النظام"
                        onClick={e => { e.stopPropagation(); void send(z, 'reject'); }}
                      >✗</button>
                    )}
                  </span>
                )}
                {tab === 'rejected' && (
                  <button
                    className="text-[10px] font-bold px-1.5 py-0.5 rounded shrink-0"
                    style={{ background: 'var(--surface-2)', color: 'var(--text-2)' }}
                    disabled={busy}
                    title="استعادة — إلغاء الرفض"
                    onClick={e => { e.stopPropagation(); void send(z, 'clear'); }}
                  >استعادة</button>
                )}
              </div>
            );
          })}
          {tab === 'auto' && hiddenAuto > 0 && (
            <div className="text-[10.5px] px-2 pt-1" style={{ color: 'var(--text-3)' }}>
              +{hiddenAuto} منطقة أخرى أقل درجة — تُعرض الأقوى 5 فقط على الشارت (المؤكدة تظهر دائماً)
            </div>
          )}
        </div>
      )}
    </div>
  );
}
