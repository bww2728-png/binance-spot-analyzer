interface SkeletonProps {
  width?: string;
  height?: number;
  className?: string;
}

/** هيكل تحميل موحد — يقلل زمن الانتظار المُدرَك */
export default function Skeleton({ width = '100%', height = 16, className = '' }: SkeletonProps) {
  return (
    <div
      className={`skeleton ${className}`}
      style={{ width, height }}
      aria-hidden="true"
    />
  );
}

/** هيكل تحميل لصف كامل في لوحة التحليل */
export function SkeletonRow({ width = '100%', height = 100 }: { width?: string; height?: number }) {
  return (
    <div className="flex items-stretch gap-3 px-3 py-2" style={{ width }} aria-hidden="true">
      <Skeleton width="70px" height={36} />
      <Skeleton width="90px" height={26} />
      <Skeleton width="70px" height={26} />
      <Skeleton width="90px" height={26} />
      <Skeleton width="70px" height={26} />
      <div className="flex-1"><Skeleton width="100%" height={height} /></div>
    </div>
  );
}
