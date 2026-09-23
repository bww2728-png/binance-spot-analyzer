import { useState } from 'react';
import { api, type MarketReadResponse } from '../lib/api';

const biasColor = (bias: string) => bias === 'شرائي' ? 'var(--up)' : bias === 'بيعي' ? 'var(--down)' : 'var(--text-2)';

/** لوحة "مساعد قراءة السوق" — كل جملة هنا محسوبة من أرقام محرك مناطق السيولة عبر /api/market-read
 * (هيكلة، مناطق فوق/تحت السعر، سلوك مرجعي لإغلاق الشمعة، تحيّز موحد عبر الفريمات، خطوات تفكير مرقمة).
 * لا يوجد أي نص مولَّد — كل بند مصدره رقم من المحرك. */
export default function MarketReadPanel({ symbol, currentTimeframe }: { symbol: string; currentTimeframe: string }) {
  const [read, setRead] = useState<MarketReadResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [openTf, setOpenTf] = useState<string | null>(null);

  const fetchRead = async () => {
    const sym = symbol.trim().toUpperCase();
    if (!sym) { setError('شغّل جولة على عملة أولاً — القراءة تحتاج رمزاً'); return; }
    setLoading(true);
    setError('');
    try {
      // فريم الجولة الحالي + 15د/1س/4س (فريد ومرتب)
      const tfs = [...new Set([currentTimeframe, '15m', '1h', '4h'])].join(',');
      const r = await api.getMarketRead(sym, tfs);
      setRead(r);
      setOpenTf(r.reads[0]?.timeframe ?? null);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="rounded-2xl p-3 sm:p-4 space-y-3" style={{ background: 'var(--surface-1)', border: '1px solid var(--border-1)' }}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-[13px] font-bold" style={{ color: 'var(--text-1)' }}>مساعد قراءة السوق</h3>
          <p className="text-[10px] mt-0.5" style={{ color: 'var(--text-3)' }}>قراءة حتمية من أرقام محرك مناطق السيولة — بلا أي تخمين: هيكلة، مناطق، سلوك مرجعي، تحيّز عبر الفريمات</p>
        </div>
        <button disabled={loading} onClick={() => void fetchRead()} className="px-4 py-2 rounded-lg text-[12px] font-bold" style={{ background: 'var(--accent)', color: '#fff', opacity: loading ? .5 : 1 }}>
          {loading ? 'يقرأ…' : read ? 'إعادة القراءة' : 'اقرأ السوق الآن'}
        </button>
      </div>

      {error && <div className="rounded-lg px-3 py-2 text-[12px]" style={{ background: 'var(--down-soft)', color: 'var(--down)' }}>{error}</div>}

      {read && (
        <div className="space-y-3">
          {/* التحيّز الموحد */}
          <div className="rounded-xl px-4 py-3 flex items-center justify-between gap-3" style={{ background: 'var(--surface-0)', border: `1px solid ${biasColor(read.bias)}55` }}>
            <div>
              <div className="text-[10px]" style={{ color: 'var(--text-3)' }}>التحيّز الموحد عبر الفريمات ({read.reads.length} فريمات)</div>
              <div className="text-lg font-bold" style={{ color: biasColor(read.bias) }}>{read.bias}</div>
            </div>
            <div className="text-[11px] text-left" style={{ color: 'var(--text-2)' }}>{read.summary}</div>
          </div>

          {/* بطاقات الفريمات */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-2">
            {read.reads.map(r => (
              <div key={r.timeframe} className="rounded-xl overflow-hidden" style={{ background: 'var(--surface-0)', border: '1px solid var(--border-1)' }}>
                <button onClick={() => setOpenTf(p => p === r.timeframe ? null : r.timeframe)} className="w-full text-right px-3 py-2 flex items-center justify-between gap-2" style={{ background: openTf === r.timeframe ? 'var(--accent-soft)' : 'transparent' }}>
                  <span className="flex items-center gap-2">
                    <span className="num text-[12px] font-bold">{r.timeframe}</span>
                    <span className="text-[11px]" style={{ color: r.direction === 'صاعد' ? 'var(--up)' : r.direction === 'هابط' ? 'var(--down)' : 'var(--text-2)' }}>{r.direction}</span>
                  </span>
                  <span className="num text-[10px]" style={{ color: 'var(--text-3)' }}>آخر سعر {r.lastPrice.toPrecision(8)} {openTf === r.timeframe ? '▲' : '▼'}</span>
                </button>
                {openTf === r.timeframe && (
                  <div className="px-3 pb-3 space-y-2">
                    {/* خطوات التفكير — كل رقم مصدره المحرك */}
                    <div className="rounded-lg p-2 space-y-1" style={{ background: 'var(--surface-1)' }}>
                      <div className="text-[10px] font-bold" style={{ color: 'var(--text-3)' }}>خطوات القراءة (كل رقم من المحرك)</div>
                      {r.steps.map((s, i) => <div key={i} className="text-[10px] leading-relaxed" style={{ color: 'var(--text-2)' }}>{i + 1}. {s}</div>)}
                    </div>
                    {/* مناطق فوق/تحت السعر */}
                    <div className="grid grid-cols-2 gap-2">
                      {[['فوق السعر', r.above, 'var(--down)'], ['تحت السعر', r.below, 'var(--up)']].map(([label, list, color]) => (
                        <div key={label as string} className="rounded-lg p-2" style={{ background: 'var(--surface-1)' }}>
                          <div className="text-[10px] font-bold mb-1" style={{ color: color as string }}>{label as string} ({(list as typeof r.above).length})</div>
                          {(list as typeof r.above).length === 0 && <div className="text-[10px]" style={{ color: 'var(--text-3)' }}>لا مناطق نشطة</div>}
                          {(list as typeof r.above).map(z => (
                            <div key={z.id} className="text-[10px] flex justify-between gap-1 py-0.5" style={{ color: 'var(--text-2)' }}>
                              <span className="num">{z.level.toPrecision(7)}</span>
                              <span>{z.kind.replace('horizontal_', '').replace('trendline_', '')} · {(z.confidence * 100).toFixed(0)}% · {z.touches} لمسات</span>
                            </div>
                          ))}
                        </div>
                      ))}
                    </div>
                    {/* السلوك المرجعي */}
                    <div className="rounded-lg p-2 flex items-center justify-between gap-2" style={{ background: 'var(--surface-1)' }}>
                      <span className="text-[10px]" style={{ color: 'var(--text-3)' }}>السلوك المرجعي لإغلاق الشمعة الحالية</span>
                      <span className="num text-[11px] font-bold" style={{ color: 'var(--text-1)' }}>{r.baseCase.low.toPrecision(7)} ← {r.baseCase.high.toPrecision(7)}{r.baseCase.capped != null ? ' (مقيّد بأقرب سيولة)' : ''}</span>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
