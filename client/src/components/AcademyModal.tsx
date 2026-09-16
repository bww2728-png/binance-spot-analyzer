import { useState } from 'react';
import { ACADEMY_CATEGORIES, ACADEMY_TOTAL, STATUS_META } from '../lib/academy';

/** أكاديمية النظام: دليل كل أدوات السيولة والتلاعب والتنفيذ وعلاقتها بالكشف الآلي */
export default function AcademyModal({ onClose }: { onClose: () => void }) {
  const [openCat, setOpenCat] = useState<string | null>(ACADEMY_CATEGORIES[0].key);

  return (
    <div
      className="anim-overlay fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(4, 6, 10, 0.82)', backdropFilter: 'blur(4px)' }}
      onClick={onClose}
    >
      <div
        className="anim-modal rounded-2xl w-full max-w-3xl max-h-full overflow-auto"
        style={{ background: 'var(--surface-0)', border: '1px solid var(--border-2)', boxShadow: 'var(--shadow-lg)' }}
        onClick={e => e.stopPropagation()}
      >
        <div
          className="flex items-center justify-between px-5 py-3.5 sticky top-0 z-10"
          style={{ background: 'var(--surface-glass)', backdropFilter: 'blur(10px)', borderBottom: '1px solid var(--border-1)' }}
        >
          <div>
            <h2 className="text-lg font-bold" style={{ color: 'var(--text-1)' }}>أكاديمية النظام</h2>
            <p className="text-[11.5px]" style={{ color: 'var(--text-3)' }}>
              {ACADEMY_TOTAL} أداة في 4 فئات — كل أداة وحالتها في محرك الكشف الآلي وعلاقتها بمناطق السيولة
            </p>
          </div>
          <button
            onClick={onClose}
            aria-label="إغلاق"
            className="w-8 h-8 rounded-lg flex items-center justify-center text-xl"
            style={{ color: 'var(--text-2)' }}
          >
            ×
          </button>
        </div>

        <div className="p-5 space-y-3">
          {/* مفتاح الرموز */}
          <div className="flex flex-wrap gap-2 mb-2">
            {Object.entries(STATUS_META).map(([k, m]) => (
              <span key={k} className="text-[10.5px] px-2 py-0.5 rounded-full font-semibold" style={{ color: m.color, background: m.bg }}>
                {m.label}
              </span>
            ))}
          </div>

          {ACADEMY_CATEGORIES.map(cat => (
            <div key={cat.key} className="rounded-xl overflow-hidden" style={{ border: '1px solid var(--border-1)' }}>
              <button
                className="w-full text-right px-4 py-3 flex items-center justify-between gap-3"
                style={{ background: 'var(--surface-1)' }}
                onClick={() => setOpenCat(c => (c === cat.key ? null : cat.key))}
              >
                <div>
                  <div className="text-[13.5px] font-bold" style={{ color: 'var(--text-1)' }}>{cat.title}</div>
                  <div className="text-[11px] mt-0.5" style={{ color: 'var(--text-3)' }}>{cat.intro}</div>
                </div>
                <span className="text-lg" style={{ color: 'var(--text-3)' }}>{openCat === cat.key ? '−' : '+'}</span>
              </button>
              {openCat === cat.key && (
                <div className="divide-y" style={{ borderTop: '1px solid var(--border-1)' }}>
                  {cat.tools.map(t => {
                    const m = STATUS_META[t.status];
                    return (
                      <div key={t.name} className="px-4 py-3" style={{ background: 'var(--surface-0)' }}>
                        <div className="flex items-center justify-between gap-3 flex-wrap">
                          <span className="text-[13px] font-bold" style={{ color: 'var(--text-1)' }}>{t.name}</span>
                          <span className="text-[10px] px-2 py-0.5 rounded-full font-semibold" style={{ color: m.color, background: m.bg }}>
                            {m.label}
                          </span>
                        </div>
                        <div className="text-[11.5px] mt-1 leading-relaxed" style={{ color: 'var(--text-2)' }}>{t.what}</div>
                        <div className="text-[11px] mt-0.5 leading-relaxed" style={{ color: 'var(--text-3)' }}>
                          <b>علاقتها بالسيولة:</b> {t.liquidity}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
