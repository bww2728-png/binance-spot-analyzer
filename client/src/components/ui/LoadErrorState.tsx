import type { ReactNode } from 'react';

type LoadErrorStateProps = {
  title: string;
  detail?: string | null;
  onRetry: () => void;
  children?: ReactNode;
};

export default function LoadErrorState({ title, detail, onRetry, children }: LoadErrorStateProps) {
  return (
    <div className="rounded-xl p-4 space-y-3" role="alert" style={{ background: 'var(--down-soft)', border: '1px solid var(--down)', color: 'var(--text-1)' }}>
      <div className="font-semibold text-[13px]">{title}</div>
      {detail && <div className="text-[11px] leading-relaxed break-words" style={{ color: 'var(--text-2)' }}>{detail}</div>}
      {children}
      <button className="btn btn-secondary text-[12px]" onClick={onRetry}>إعادة المحاولة</button>
    </div>
  );
}
