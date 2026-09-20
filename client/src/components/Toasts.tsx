import { useStore } from '../store/useStore';

const KIND_STYLE = {
  alert: { border: 'var(--down)', bg: 'rgba(242,54,69,0.12)', icon: '!', color: 'var(--down)' },
  info:  { border: 'var(--accent)', bg: 'var(--surface-2)', icon: 'i', color: 'var(--accent)' }
} as const;

export default function Toasts() {
  const toasts = useStore(s => s.toasts);
  const dismiss = useStore(s => s.dismissToast);

  return (
    <div className="fixed bottom-4 left-4 z-50 flex flex-col gap-2 max-w-md">
      {toasts.map(t => {
        const st = KIND_STYLE[t.kind as keyof typeof KIND_STYLE] ?? KIND_STYLE.info;
        return (
          <div
            key={t.id}
            onClick={() => dismiss(t.id)}
            role="status"
            className="anim-toast cursor-pointer flex items-start gap-3 rounded-xl px-4 py-3"
            style={{ background: st.bg, border: `1px solid ${st.border}55`, borderInlineStart: `3px solid ${st.border}`, backdropFilter: 'blur(8px)', boxShadow: 'var(--shadow-lg)' }}
          >
            <span
              className="w-5 h-5 rounded-full flex items-center justify-center text-[11px] font-bold flex-shrink-0 mt-0.5"
              style={{ background: `${st.border}33`, color: st.color }}
            >
              {st.icon}
            </span>
            <span className="text-[13px] leading-relaxed flex-1" style={{ color: 'var(--text-1)' }}>{t.text}</span>
            {t.action && (
              <button
                onClick={(e) => { e.stopPropagation(); t.action!.onClick(); dismiss(t.id); }}
                className="btn btn-accent !py-1 !px-2.5 text-[11px] flex-shrink-0"
              >
                {t.action.label}
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
