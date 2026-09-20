import { useMemo } from 'react';
import { useStore } from '../store/useStore';
import { sortAnalyses, GROUP_LABELS, GROUP_ORDER } from '../lib/sorting';
import AddCoinBar from './AddCoinBar';
import AnalysisRow from './AnalysisRow';
import Skeleton from './ui/Skeleton';

const COLS = [92, 92, 84, 92, 84, 100, 96, 104, 100, 100, 110, 110, 64, 64, 88, 196, 132, 40];
const HEADERS = [
  'العملة', 'اتجاه الفريم الأصغر', 'الفريم الأصغر', 'اتجاه الفريم الأكبر', 'الفريم الأكبر',
  'BSL sweep خارجي', 'لمس Supply خارجي', 'BSL sweep داخلي', 'Sellers induced', 'SSL sweep داخلي',
  'سعر SSL', 'سعر BSL', 'لمس BSL', 'لمس SSL', 'CHoCH up', 'الشارت', 'الحالة والمسافة', ''
];

const GROUP_COLORS: Record<string, string> = {
  up_to_ssl: 'var(--up)',
  down_touched_bsl_then_ssl: 'var(--down)',
  down_touched_bsl_only: 'var(--warn)',
  down_not_touched_bsl: 'var(--group-purple)',
  incomplete: 'var(--text-4)'
};

export default function AnalysisBoard() {
  const analyses = useStore(s => s.analyses);
  const prices = useStore(s => s.prices);
  const settings = useStore(s => s.settings);
  const symbolsLoaded = useStore(s => s.symbolsLoaded);
  const loading = !settings || !symbolsLoaded;

  // محددات Zustand يجب أن تُرجع مرجعاً مستقراً — النتيجة تُحسب هنا بـ useMemo
  const rows = useMemo(
    () => sortAnalyses(analyses.map(a => ({ analysis: a, livePrice: prices[a.symbol] ?? null }))),
    [analyses, prices]
  );

  return (
    <div>
      <AddCoinBar />

      {loading ? (
        /* هيكل تحميل بحجم الصفوف المتوقع */
        <div className="p-4 space-y-3">
          {Array.from({ length: 4 }, (_, i) => <Skeleton key={i} height={96} />)}
        </div>
      ) : rows.length === 0 ? (
        /* حالة فارغة إرشادية */
        <div className="py-20 flex flex-col items-center gap-3 text-center">
          <div
            className="w-14 h-14 rounded-2xl flex items-center justify-center text-2xl"
            style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}
          >
            ⌕
          </div>
          <div className="text-base font-semibold" style={{ color: 'var(--text-1)' }}>لم تُضف أي عملة بعد</div>
          <div className="text-[13px] max-w-sm leading-relaxed" style={{ color: 'var(--text-2)' }}>
            ابحث عن عملة من الشريط أعلاه لتبدأ التحليل — القائمة تشمل كل أزواج السبوت المتداول في بينانس،
            وكل إدراج يمر عبر تقرير الفحص (سبوت؟ حكم شرعي بالأدلة؟ اتجاه مقترح؟) ثم تأكيدك.
          </div>
        </div>
      ) : (
        <div className="overflow-x-auto scroll-contain">
          <div className="min-w-max">
            {/* الترويسة الثابتة */}
            <div
              className="flex sticky top-0 z-10"
              style={{ background: 'var(--surface-2)', borderBottom: '1px solid var(--border-2)', boxShadow: 'var(--shadow-sm)' }}
            >
              {HEADERS.map((h, i) => (
                <div
                  key={`${h}${i}`}
                  style={{ width: COLS[i], color: 'var(--text-2)', borderColor: 'var(--border-1)' }}
                  className="shrink-0 px-1 py-2.5 text-[11px] font-semibold text-center border-l"
                >
                  {h}
                </div>
              ))}
            </div>
            {rows.map(row => <AnalysisRow key={row.analysis.id} row={row} />)}
          </div>
        </div>
      )}

      {!loading && rows.length > 0 && (
        <div className="px-4 py-3 flex items-center gap-2 flex-wrap" style={{ color: 'var(--text-3)', fontSize: 11 }}>
          <span>الترتيب التلقائي المُحدّث لحظياً:</span>
          {GROUP_ORDER.filter(g => g !== 'incomplete').map((g, i) => (
            <span key={g} className="flex items-center gap-2">
              {i > 0 && <span style={{ color: 'var(--text-4)' }}>←</span>}
              <span className="badge" style={{ background: `${GROUP_COLORS[g]}1f`, color: GROUP_COLORS[g], border: `1px solid ${GROUP_COLORS[g]}44` }}>
                {GROUP_LABELS[g]}
              </span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
