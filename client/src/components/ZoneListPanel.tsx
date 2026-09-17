import { useState } from 'react';
import type { LiquidityZone } from '../lib/types';
import { zoneRange, MAX_AUTO_BANDS } from './ZoneBands';

/**
 * القائمة الجانبية بالمناطق: تعالج «لا أدري أين حدد» —
 * صف لكل منطقة (نوع · فريم · درجة · أول سبب)، والنقر يُبرزها على الشارت بوميض.
 */
export default function ZoneListPanel({
  zones,
  onPick
}: {
  zones: LiquidityZone[];
  onPick: (z: LiquidityZone) => void;
}) {
  const [tab, setTab] = useState<'auto' | 'manual'>('auto');
  const auto = zones
    .filter(z => z.source === 'auto')
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const manual = zones.filter(z => z.source !== 'auto');
  const list = tab === 'auto' ? auto : manual;
  const hiddenAuto = Math.max(0, auto.length - MAX_AUTO_BANDS);

  return (
    <div className="rounded-xl p-3" style={{ background: 'var(--surface-1)', border: '1px solid var(--border-1)' }}>
      <div className="flex items-center justify-between gap-2 mb-2 flex-wrap">
        <div className="text-[12.5px] font-bold" style={{ color: 'var(--text-1)' }}>
          مناطق السيولة — انقر صفّاً لتمييزه على الشارت
        </div>
        <div className="flex gap-1">
          <button
            className="text-[11px] px-2.5 py-1 rounded-full font-semibold"
            style={{
              background: tab === 'auto' ? 'var(--accent)' : 'var(--surface-2)',
              color: tab === 'auto' ? '#fff' : 'var(--text-2)'
            }}
            onClick={() => setTab('auto')}
          >
            آلية ({auto.length})
          </button>
          <button
            className="text-[11px] px-2.5 py-1 rounded-full font-semibold"
            style={{
              background: tab === 'manual' ? 'var(--accent)' : 'var(--surface-2)',
              color: tab === 'manual' ? '#fff' : 'var(--text-2)'
            }}
            onClick={() => setTab('manual')}
          >
            تعليمك ({manual.length})
          </button>
        </div>
      </div>

      {list.length === 0 ? (
        <div className="text-[11.5px] py-2" style={{ color: 'var(--text-3)' }}>
          {tab === 'auto' ? 'لا مناطق آلية بعد — أول دورة كشف قادمة ستظهر هنا.' : 'لم تعلّم مناطق بعد — فعّل «وضع التعليم» وانقر على الشارت.'}
        </div>
      ) : (
        <div className="flex flex-col gap-1 max-h-40 overflow-auto">
          {list.slice(0, tab === 'auto' ? MAX_AUTO_BANDS : undefined).map(z => {
            const rgb = z.source === 'auto' ? (z.type === 'BSL' ? '242,54,69' : '8,153,129') : '59,130,246';
            const r = zoneRange(z);
            return (
              <button
                key={z.id}
                className="flex items-center gap-2 text-right px-2.5 py-1.5 rounded-lg"
                style={{ background: `rgba(${rgb},0.08)`, border: '1px solid rgba(' + rgb + ',0.25)' }}
                onClick={() => onPick(z)}
                title={z.reasons?.join(' · ') ?? z.note ?? ''}
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
                <span className="text-[10.5px] truncate flex-1" style={{ color: 'var(--text-3)' }}>
                  {z.timeframe}{z.reasons?.[0] ? ` · ${z.reasons[0]}` : ''}
                </span>
                {z.source === 'auto' && z.anchorTime != null && (
                  <span className="num text-[10px]" style={{ color: 'var(--text-3)' }} title="زمن شمعة الاكتشاف — النقر ينقل الشارت إليها">
                    {new Date(z.anchorTime * 1000).toLocaleDateString('en', { month: 'short', day: 'numeric' })}
                  </span>
                )}
              </button>
            );
          })}
          {tab === 'auto' && hiddenAuto > 0 && (
            <div className="text-[10.5px] px-2 pt-1" style={{ color: 'var(--text-3)' }}>
              +{hiddenAuto} منطقة أخرى أقل درجة — تُعرض الأقوى 5 فقط على الشارت
            </div>
          )}
        </div>
      )}
    </div>
  );
}
