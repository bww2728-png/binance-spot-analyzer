import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import type { LiquidityV2ZonesResponse } from '../lib/types';

const SYMBOL = 'BTCUSDT';
const TIMEFRAME = '1h';
const KIND_LABELS: Record<string, string> = {
  horizontal_bsl: 'BSL أفقي',
  horizontal_ssl: 'SSL أفقي',
  trendline_bsl: 'خط هابط',
  trendline_ssl: 'خط صاعد',
  supply: 'عرض',
  demand: 'طلب'
};
const STATE_LABELS: Record<string, string> = {
  potential: 'محتملة',
  candidate: 'مرشحة',
  confirmed: 'مؤكدة',
  swept: 'مسحوبة'
};
const formatPrice = (value: number | null | undefined) => value == null ? '—' : value.toPrecision(7);

export default function LiquidityV2Screen() {
  const [data, setData] = useState<LiquidityV2ZonesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void api.getLiquidityV2Zones({ symbol: SYMBOL, timeframe: TIMEFRAME, cap: 200, state: 'all', kind: 'all' }, controller.signal)
      .then((result) => {
        setData(result);
        setError(null);
      })
      .catch((reason) => {
        if (!controller.signal.aborted) setError(String((reason as Error)?.message ?? reason));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, []);

  return (
    <div className="p-3 sm:p-5 space-y-4 max-w-[1500px] mx-auto">
      <div className="rounded-xl p-3 sm:p-4" style={{ background: 'var(--warn-soft)', border: '1px solid rgba(245,158,11,0.35)' }}>
        <div className="text-[13px] font-bold mb-1" style={{ color: '#b45309' }}>محرك السيولة v2 — عرض وقياس فقط</div>
        <div className="text-[11.5px]" style={{ color: 'var(--text-2)' }}>
          هذا محرك موازٍ يعمل بمنطقك الذي وصفته حرفياً. <b>لا يُغذّي أي قرار منشور</b> ولا يعدّل محركك الحالي.
        </div>
      </div>

      <section className="rounded-xl p-3 sm:p-4" style={{ background: 'var(--surface-1)', border: '1px solid var(--border-1)' }}>
        <div className="text-[12.5px] font-bold mb-2" style={{ color: 'var(--text-1)' }}>
          المستويات — مدمجة للعرض <span className="font-normal" style={{ color: 'var(--text-3)' }}>(نفس المستوى على عدة فريمات يظهر سطراً واحداً؛ الحساب يبقى لكل فريم مستقلاً)</span>
        </div>
        {loading && <div className="py-6 text-center text-[12px]" style={{ color: 'var(--text-3)' }}>جارٍ تحميل المستويات…</div>}
        {!loading && error && <div className="py-4 text-[12px]" style={{ color: 'var(--down)' }}>تعذّر تحميل المستويات: {error}</div>}
        {!loading && !error && !data?.merged?.length && <div className="py-4 text-[12px]" style={{ color: 'var(--text-3)' }}>لا توجد مستويات مدمجة للعرض حالياً.</div>}
        {!loading && !error && !!data?.merged?.length && (
          <div className="overflow-x-auto">
            <table className="w-full text-[11px] num" style={{ color: 'var(--text-2)' }}>
              <thead>
                <tr style={{ color: 'var(--text-3)' }}>
                  <th className="px-2 py-1 text-right">النوع</th><th className="px-2 py-1">المستوى</th><th className="px-2 py-1">السيولة</th><th className="px-2 py-1">القمة/القاع الفرعي</th><th className="px-2 py-1">لمسات</th><th className="px-2 py-1">قوة</th><th className="px-2 py-1">الحالة</th><th className="px-2 py-1">الفريمات</th>
                </tr>
              </thead>
              <tbody>
                {data.merged.slice(0, 60).map((level) => (
                  <tr key={level.key} style={{ borderTop: '1px solid var(--border-1)' }}>
                    <td className="px-2 py-1 text-right">{KIND_LABELS[level.kind] ?? level.kind}</td>
                    <td className="px-2 py-1 text-center">{formatPrice(level.price)}</td>
                    <td className="px-2 py-1 text-center">{formatPrice(level.liquidityLevel)}</td>
                    <td className="px-2 py-1 text-center">{formatPrice(level.referenceAlt)}</td>
                    <td className="px-2 py-1 text-center">{level.touches}</td>
                    <td className="px-2 py-1 text-center">{(level.confidence * 100).toFixed(0)}%</td>
                    <td className="px-2 py-1 text-center">{level.states.map((state) => STATE_LABELS[state] ?? state).join(' → ')}</td>
                    <td className="px-2 py-1 text-center">{level.timeframes.join(' · ')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
