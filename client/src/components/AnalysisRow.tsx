import { memo } from 'react';
import { useStore } from '../store/useStore';
import { classify, isUptrend } from '../lib/sorting';
import { TIMEFRAMES } from '../lib/types';
import type { Analysis, Trend, Timeframe } from '../lib/types';
import type { SortResultRow } from '../lib/sorting';
import MiniChart from './MiniChart';
import Toggle from './ui/Toggle';
import ShariahBadge from './ShariahBadge';

const COLS = [
  92, 92, 84, 92, 84, 100, 96, 104, 100, 100, 110, 110, 64, 64, 88, 196, 132, 40
];

const GROUP_STYLE: Record<string, { color: string; label: string }> = {
  up_to_ssl: { color: 'var(--up)', label: 'صاعدة → SSL' },
  down_touched_bsl_then_ssl: { color: 'var(--down)', label: 'لمست BSL+SSL' },
  down_touched_bsl_only: { color: 'var(--warn)', label: 'لمست BSL فقط' },
  down_not_touched_bsl: { color: 'var(--group-purple)', label: 'قبل BSL' },
  incomplete: { color: 'var(--text-4)', label: 'غير مكتمل' }
};

function TriSelect({ value, onChange, disabled }: { value: 0 | 1 | null; onChange: (v: 0 | 1 | null) => void; disabled?: boolean }) {
  if (disabled) return <span style={{ color: 'var(--text-4)', fontSize: 12 }}>—</span>;
  return (
    <select
      value={value === null ? '' : String(value)}
      onChange={e => onChange(e.target.value === '' ? null : Number(e.target.value) as 0 | 1)}
      aria-label="نعم/لا"
      style={{ width: 64, textAlign: 'center' }}
      className={value === null ? '' : 'font-semibold'}
    >
      <option value="">—</option>
      <option value="1">نعم</option>
      <option value="0">لا</option>
    </select>
  );
}

function YesNoSelect({ value, onChange }: { value: string | null; onChange: (v: string | null) => void }) {
  return (
    <select value={value ?? ''} onChange={e => onChange(e.target.value === '' ? null : e.target.value)} style={{ width: 72 }}>
      <option value="">—</option>
      <option value="yes">نعم</option>
      <option value="no">لا</option>
    </select>
  );
}

function PriceInput({ value, onChange, disabled, accent }: { value: number | null; onChange: (v: number | null) => void; disabled?: boolean; accent?: string }) {
  if (disabled) return <span style={{ color: 'var(--text-4)', fontSize: 12 }}>—</span>;
  return (
    <input
      type="number" step="any" inputMode="decimal" className="num"
      style={{ width: 96, borderColor: accent ? `${accent}66` : undefined }}
      value={value ?? ''}
      onChange={e => onChange(e.target.value === '' ? null : Number(e.target.value))}
      placeholder="السعر"
      aria-label="سعر المنطقة"
    />
  );
}

function AnalysisRowInner({ row }: { row: SortResultRow }) {
  const a = row.analysis;
  const update = useStore(s => s.updateAnalysis);
  const remove = useStore(s => s.deleteAnalysis);
  const price = useStore(s => s.prices[a.symbol]);
  const openChart = useStore(s => s.openChart);

  const up = isUptrend(a);
  const down = a.trend_lower === 'down' && a.trend_upper === 'down';
  const intBsl = a.int_bsl_sweep;
  const showSellers = up && intBsl !== null;
  const showIntSsl = up && intBsl === 1;
  const showSslInput = up || (down && a.bsl_touched === 1);
  const showBslInput = down;
  const showChoch = down && a.bsl_touched === 1 && a.ssl_touched === 1 && a.passed_bsl_after_ssl === 1;
  const group = classify(a);
  const dist = row.distancePct;
  const gs = GROUP_STYLE[group];

  const zones = [
    ...(a.ssl_price != null ? [{ price: a.ssl_price, color: '#089981', title: 'SSL' }] : []),
    ...(a.bsl_price != null ? [{ price: a.bsl_price, color: '#f23645', title: 'BSL' }] : [])
  ];
  const tfLower = a.tf_lower ?? '15m';

  const patch = (p: Partial<Analysis>) => void update(a.id, p);

  const cell = (width: number, key: string, content: React.ReactNode) => (
    <div key={key} style={{ width }} className="shrink-0 flex items-center justify-center px-1 self-stretch">
      {content}
    </div>
  );

  const trendSel = (val: Trend | null, set: (v: Trend | null) => void, label: string) => {
    const cls = val === 'up' ? 'badge-up' : val === 'down' ? 'badge-down' : '';
    return (
      <select
        value={val ?? ''}
        onChange={e => set((e.target.value || null) as Trend | null)}
        className={cls || undefined}
        style={{ width: 72, textAlign: 'center', fontWeight: val ? 600 : 400 }}
        aria-label={label}
      >
        <option value="">—</option>
        <option value="up">صاعد</option>
        <option value="down">هابط</option>
      </select>
    );
  };

  const tfSel = (val: Timeframe | null, set: (v: Timeframe | null) => void, label: string) => (
    <select
      value={val ?? ''}
      onChange={e => set((e.target.value || null) as Timeframe | null)}
      style={{ width: 66 }}
      aria-label={label}
    >
      <option value="">—</option>
      {TIMEFRAMES.map(tf => <option key={tf} value={tf}>{tf}</option>)}
    </select>
  );

  return (
    <div
      className="group flex items-stretch min-w-max"
      style={{
        borderBottom: '1px solid var(--border-1)',
        borderInlineStart: `3px solid ${gs.color}`,
        transition: 'background var(--transition)'
      }}
      onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'var(--surface-1)'; }}
      onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
    >
      {cell(COLS[0], 'sym', (
        <div className="text-center py-1 space-y-1">
          <div className="font-bold text-[14px] tracking-tight" style={{ color: 'var(--text-1)' }}>
            {a.symbol.replace('USDT', '')}
          </div>
          <div className="flex justify-center"><ShariahBadge symbol={a.symbol} /></div>
          {price !== undefined
            ? <div className="num text-[11px]" style={{ color: 'var(--text-2)' }}>{price.toLocaleString('en', { maximumFractionDigits: 8 })}</div>
            : <div className="text-[10px]" style={{ color: 'var(--text-4)' }}>…</div>}
        </div>
      ))}
      {cell(COLS[1], 'tl', trendSel(a.trend_lower, v => patch({ trend_lower: v }), 'اتجاه الفريم الأصغر'))}
      {cell(COLS[2], 'fl', tfSel(a.tf_lower, v => patch({ tf_lower: v }), 'الفريم الأصغر'))}
      {cell(COLS[3], 'tu', trendSel(a.trend_upper, v => patch({ trend_upper: v }), 'اتجاه الفريم الأكبر'))}
      {cell(COLS[4], 'fu', tfSel(a.tf_upper, v => patch({ tf_upper: v }), 'الفريم الأكبر'))}
      {cell(COLS[5], 'extbsl', <TriSelect value={a.ext_bsl_sweep} onChange={v => patch({ ext_bsl_sweep: v })} />)}
      {cell(COLS[6], 'extsup', <TriSelect value={a.ext_supply_touch} onChange={v => patch({ ext_supply_touch: v })} />)}
      {cell(COLS[7], 'intbsl', (
        <TriSelect value={a.int_bsl_sweep} disabled={!up} onChange={v => {
          const p: Partial<Analysis> = { int_bsl_sweep: v };
          if (v !== 1) p.int_ssl_sweep = null;
          patch(p);
        }} />
      ))}
      {cell(COLS[8], 'sellers', <TriSelect value={a.sellers_induced} disabled={!showSellers} onChange={v => patch({ sellers_induced: v })} />)}
      {cell(COLS[9], 'intssl', <TriSelect value={a.int_ssl_sweep} disabled={!showIntSsl} onChange={v => patch({ int_ssl_sweep: v })} />)}
      {cell(COLS[10], 'sslprice', (
        <PriceInput value={a.ssl_price} disabled={!showSslInput} accent="var(--up)" onChange={v => patch({ ssl_price: v })} />
      ))}
      {cell(COLS[11], 'bslprice', (
        <PriceInput value={a.bsl_price} disabled={!showBslInput} accent="var(--down)" onChange={v => patch({ bsl_price: v })} />
      ))}
      {cell(COLS[12], 'btouch', (
        <Toggle on={a.bsl_touched === 1} label="لمس BSL" onChange={v => patch({ bsl_touched: v ? 1 : 0 })} />
      ))}
      {cell(COLS[13], 'stouch', (
        <Toggle on={a.ssl_touched === 1} label="لمس SSL" onChange={v => patch({ ssl_touched: v ? 1 : 0 })} />
      ))}
      {cell(COLS[14], 'choch', showChoch
        ? <YesNoSelect value={a.choch_up} onChange={v => patch({ choch_up: v as 'yes' | 'no' | null })} />
        : <span style={{ color: 'var(--text-4)', fontSize: 12 }}>—</span>)}
      {cell(COLS[15], 'chart', (
        <div
          onClick={() => openChart(a.symbol, a.tf_lower, a.tf_upper)}
          className="cursor-pointer rounded-lg overflow-hidden self-center"
          style={{ border: '1px solid var(--border-1)', transition: 'border-color var(--transition), box-shadow var(--transition)' }}
          title="افتح الشارت الكامل"
          onMouseEnter={e => { (e.currentTarget as HTMLElement).style.borderColor = 'var(--accent)'; (e.currentTarget as HTMLElement).style.boxShadow = 'var(--shadow-md)'; }}
          onMouseLeave={e => { (e.currentTarget as HTMLElement).style.borderColor = 'var(--border-1)'; (e.currentTarget as HTMLElement).style.boxShadow = 'none'; }}
        >
          {price !== undefined
            ? <MiniChart symbol={a.symbol} timeframe={tfLower} zones={zones} height={88} />
            : <div className="flex items-center justify-center text-[11px]" style={{ height: 88, color: 'var(--text-4)' }}>بانتظار السعر…</div>}
        </div>
      ))}
      {cell(COLS[16], 'info', (
        <div className="text-[11px] leading-5 text-center py-1">
          <span className="badge" style={{ background: `${gs.color}1f`, color: gs.color, border: `1px solid ${gs.color}44` }}>
            {gs.label}
          </span>
          {dist !== null
            ? <div className="num text-[11px] mt-1" style={{ color: 'var(--text-2)' }}>{dist.toFixed(2)}%</div>
            : <div className="text-[10px] mt-1" style={{ color: 'var(--text-4)' }}>لا منطقة</div>}
          <div className="mt-1 flex justify-center">
            <Toggle
              on={a.notify_enabled === 1}
              label="إشعارات هذه العملة"
              onChange={v => patch({ notify_enabled: v ? 1 : 0 })}
            />
          </div>
        </div>
      ))}
      {cell(COLS[17], 'del', (
        <button
          onClick={() => void remove(a.id)}
          aria-label={`حذف ${a.symbol}`}
          title="حذف"
          className="opacity-0 group-hover:opacity-100 w-7 h-7 rounded-md flex items-center justify-center text-base"
          style={{ color: 'var(--down)', transition: 'opacity var(--transition), background var(--transition)' }}
          onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'var(--down-soft)'; }}
          onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
        >
          ×
        </button>
      ))}
    </div>
  );
}

const AnalysisRow = memo(AnalysisRowInner);
export default AnalysisRow;
