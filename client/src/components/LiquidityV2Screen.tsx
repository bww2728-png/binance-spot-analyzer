import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import { TIMEFRAMES, type Candle, type LiquidityV2StatusResponse, type LiquidityV2ZonesResponse, type LiquidityZoneV2 } from '../lib/types';
import LiquidityV2Chart, { KIND_COLORS, EVENT_COLORS } from './LiquidityV2Chart';
import LiquidityHistorySection from './LiquidityHistoryChart';

/**
 * شاشة محرك السيولة v2 — **عرض فقط، بلا أي تفعيل**.
 *
 * تعرض:
 *  - حصيلة قياس الظل مقابل المحرك الحالي (نسبة التطابق، الأنواع المضافة، أرقام البنية).
 *  - مناطق (رمز، فريم) محسوبة **عند الطلب** من نفس المخزن، مرسومة بالكامل: مستطيلات
 *    العرض/الطلب، خطوط السيولة والمراجع، نقاط اللمس، خطوات الكسر، وأسهم IDM/BOS/CHoCH.
 *  - جدول المناطق مع تعليل كل منطقة، ودمج المستوى المتطابق على عدة فريمات (للعرض فقط).
 *
 * ولا تحفظ هذه الشاشة شيئاً ولا تُرسل قراراً: كل استدعاءاتها GET.
 */

const STATES = [
  { id: 'all', label: 'الكل' },
  { id: 'confirmed', label: 'مؤكدة' },
  { id: 'candidate', label: 'مرشحة' },
  { id: 'swept', label: 'مسحوبة' }
];

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

export default function LiquidityV2Screen() {
  const [symbol, setSymbol] = useState('BTCUSDT');
  const [timeframe, setTimeframe] = useState('1h');
  const [state, setState] = useState('all');
  const [kind, setKind] = useState('all');
  const [cap, setCap] = useState(200);
  const [showBoxes, setShowBoxes] = useState(true);
  const [showStructure, setShowStructure] = useState(true);
  const [showTouchPoints, setShowTouchPoints] = useState(true);
  const [showTrendlines, setShowTrendlines] = useState(true);
  /**
   * «الفريم المختار فقط» مفعَّل افتراضياً: عرض كل الفريمات معاً (1h→6h) يُنتج مئات
   * خطوط السيولة التي تحجب الشموع. التفعيل الافتراضي يجعل الشارت مقروءاً من أول نظرة،
   * ويمكن إلغاؤه لمن يريد المقارنة بين الفريمات (كل فريم يبقى مستقلاً في الحساب).
   */
  const [onlyTimeframe, setOnlyTimeframe] = useState(true);
  const [data, setData] = useState<LiquidityV2ZonesResponse | null>(null);
  const [status, setStatus] = useState<LiquidityV2StatusResponse | null>(null);
  const [candles, setCandles] = useState<Candle[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [zonesRes, statusRes, bars] = await Promise.all([
        api.getLiquidityV2Zones({ symbol: symbol.trim().toUpperCase(), timeframe, cap, state, kind }),
        api.getLiquidityV2Status().catch(() => null),
        api.getKlines(symbol.trim().toUpperCase(), timeframe, 500).catch(() => [] as Candle[])
      ]);
      setData(zonesRes);
      setStatus(statusRes);
      setCandles(bars);
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    } finally {
      setLoading(false);
    }
  }, [symbol, timeframe, cap, state, kind]);

  useEffect(() => { void load(); }, [load]);

  /** المناطق المعروضة على الشارت: النوع المختار + سقف الشاشة، والمسحوبة تبقى بشفافية */
  const chartZones = useMemo(() => data?.zones ?? [], [data]);
  const byState = useMemo(() => {
    const out: Record<string, number> = { potential: 0, candidate: 0, confirmed: 0, swept: 0 };
    for (const z of chartZones) out[z.state] = (out[z.state] ?? 0) + 1;
    return out;
  }, [chartZones]);

  const byKind = useMemo(() => {
    const out: Record<string, number> = {};
    for (const z of chartZones) out[z.kind] = (out[z.kind] ?? 0) + 1;
    return out;
  }, [chartZones]);

  const structureCount = useMemo(() => {
    const out: Record<string, number> = {};
    for (const e of data?.structure ?? []) out[e.type] = (out[e.type] ?? 0) + 1;
    return out;
  }, [data]);

  return (
    <div className="p-3 sm:p-5 space-y-4 max-w-[1500px] mx-auto">
      {/* تنبيه حالة المحرك: لا تفعيل ما لم يثبت الظل */}
      <div className="rounded-xl p-3 sm:p-4" style={{ background: 'var(--warn-soft)', border: '1px solid rgba(245,158,11,0.35)' }}>
        <div className="text-[13px] font-bold mb-1" style={{ color: '#b45309' }}>محرك السيولة v2 — عرض وقياس فقط</div>
        <div className="text-[11.5px]" style={{ color: 'var(--text-2)' }}>
          هذا محرك موازٍ يعمل بمنطقك الذي وصفته حرفياً. <b>لا يُغذّي أي قرار منشور</b> ولا يعدّل محركك الحالي.
          {status?.activation && <> الحالة: <b>{status.activation.ready ? 'مؤهَّل للتفعيل' : 'بانتظار قرارك'}</b> — {status.activation.reason}.</>}
        </div>
      </div>

      {/* الشارت التاريخي (1m) — في أعلى الشاشة: الميزة الأساسية للتحقق البصري */}
      <LiquidityHistorySection engine="v2" symbol={symbol.trim().toUpperCase() || 'BTCUSDT'} />

      {/* حصيلة قياس الظل */}
      {status && (
        <div className="rounded-xl p-3 sm:p-4" style={{ background: 'var(--surface-1)', border: '1px solid var(--border-1)' }}>
          <div className="text-[12.5px] font-bold mb-2" style={{ color: 'var(--text-1)' }}>قياس الظل مقابل المحرك الحالي</div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-[11px]">
            <Cell label="العيّنات" value={status.samples} />
            <Cell label="تطابق الأنواع المشتركة" value={status.parityPct == null ? '—' : `${status.parityPct}%`} tone={status.parityPct === 100 ? 'up' : 'warn'} />
            <Cell label="تطابق الحالة" value={status.stateParityPct == null ? '—' : `${status.stateParityPct}%`} />
            <Cell label="مناطق المحرك الحالي" value={status.zones.old} />
            <Cell label="مناطق v2" value={status.zones.v2} />
            <Cell label="مُطابَقة" value={status.zones.matched} />
            <Cell label="عندها فقط (لم تُطابَق)" value={status.onlyOld} tone={status.onlyOld ? 'warn' : undefined} />
            <Cell label="زمن v2 / القديم" value={`${status.ms.avgV2} / ${status.ms.avgOld} ms`} />
            <Cell label="أحداث IDM" value={status.structure.idm} tone="accent" />
            <Cell label="BOS صاعد / هابط" value={`${status.structure.bosUp} / ${status.structure.bosDown}`} tone="accent" />
            <Cell label="CHoCH صاعد / هابط" value={`${status.structure.chochUp} / ${status.structure.chochDown}`} tone="accent" />
            <Cell label="فجوات FVG" value={status.fvg} tone="accent" />
          </div>
          {!!Object.keys(status.addedKinds).length && (
            <div className="mt-2 text-[11px]" style={{ color: 'var(--text-2)' }}>
              <b>أنواع أضافها الجديد</b> (لا نظير لها في المحرك الحالي، فلا تُحسب في نسبة التطابق):{' '}
              {Object.entries(status.addedKinds).map(([k, v]) => `${KIND_LABELS[k] ?? k}: ${v.new}`).join(' · ')}
            </div>
          )}
          {!!Object.keys(status.byKind).length && (
            <div className="mt-2 overflow-x-auto">
              <table className="text-[10.5px] num" style={{ color: 'var(--text-2)' }}>
                <thead>
                  <tr style={{ color: 'var(--text-3)' }}>
                    <th className="px-2 py-1 text-right">النوع</th>
                    <th className="px-2 py-1">القديم</th>
                    <th className="px-2 py-1">v2</th>
                    <th className="px-2 py-1">مُطابَق</th>
                    <th className="px-2 py-1">نفس الحالة</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(status.byKind).map(([k, v]) => (
                    <tr key={k}>
                      <td className="px-2 py-0.5 text-right">{KIND_LABELS[k] ?? k}</td>
                      <td className="px-2 py-0.5 text-center">{v.old}</td>
                      <td className="px-2 py-0.5 text-center">{v.new}</td>
                      <td className="px-2 py-0.5 text-center">{v.matched}</td>
                      <td className="px-2 py-0.5 text-center">{v.sameState}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* أدوات التحكم */}
      <div className="rounded-xl p-3 sm:p-4 space-y-3" style={{ background: 'var(--surface-1)', border: '1px solid var(--border-1)' }}>
        <div className="flex flex-wrap items-end gap-2">
          <Field label="الرمز">
            <input value={symbol} onChange={e => setSymbol(e.target.value.toUpperCase())} onKeyDown={e => { if (e.key === 'Enter') void load(); }}
              className="px-2.5 py-1.5 rounded-lg text-[12px] num" style={{ background: 'var(--surface-0)', border: '1px solid var(--border-1)', color: 'var(--text-1)', width: 130 }} />
          </Field>
          <Field label="الفريم">
            <select value={timeframe} onChange={e => setTimeframe(e.target.value)}
              className="px-2.5 py-1.5 rounded-lg text-[12px]" style={{ background: 'var(--surface-0)', border: '1px solid var(--border-1)', color: 'var(--text-1)' }}>
              {TIMEFRAMES.map(tf => <option key={tf} value={tf}>{tf}</option>)}
            </select>
          </Field>
          <Field label="الحالة">
            <select value={state} onChange={e => setState(e.target.value)}
              className="px-2.5 py-1.5 rounded-lg text-[12px]" style={{ background: 'var(--surface-0)', border: '1px solid var(--border-1)', color: 'var(--text-1)' }}>
              {STATES.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
            </select>
          </Field>
          <Field label="النوع">
            <select value={kind} onChange={e => setKind(e.target.value)}
              className="px-2.5 py-1.5 rounded-lg text-[12px]" style={{ background: 'var(--surface-0)', border: '1px solid var(--border-1)', color: 'var(--text-1)' }}>
              <option value="all">الكل</option>
              {Object.entries(KIND_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
          </Field>
          <Field label="سقف العرض">
            <select value={cap} onChange={e => setCap(Number(e.target.value))}
              className="px-2.5 py-1.5 rounded-lg text-[12px] num" style={{ background: 'var(--surface-0)', border: '1px solid var(--border-1)', color: 'var(--text-1)' }}>
              {[100, 200, 300, 500, 1000].map(v => <option key={v} value={v}>{v}</option>)}
            </select>
          </Field>
          <button onClick={() => void load()} disabled={loading}
            className="px-4 py-2 rounded-lg text-[12px] font-bold" style={{ background: 'var(--accent)', color: '#fff', opacity: loading ? 0.6 : 1 }}>
            {loading ? 'يقرأ…' : 'تحديث'}
          </button>
        </div>

        <div className="flex flex-wrap gap-3 text-[11px]" style={{ color: 'var(--text-2)' }}>
          <Toggle label="مستطيلات العرض/الطلب" on={showBoxes} set={setShowBoxes} />
          <Toggle label="أسهم IDM / BOS / CHoCH" on={showStructure} set={setShowStructure} />
          <Toggle label="نقاط اللمس وخطوات الكسر" on={showTouchPoints} set={setShowTouchPoints} />
          <Toggle label="خطوط الاتجاه" on={showTrendlines} set={setShowTrendlines} />
          <Toggle label="الفريم المختار فقط" on={onlyTimeframe} set={setOnlyTimeframe} />
        </div>

        {error && <div className="text-[11.5px]" style={{ color: 'var(--down, #f23645)' }}>{error}</div>}
        {data && (
          <div className="text-[11px]" style={{ color: 'var(--text-3)' }}>
            {data.total} منطقة على {data.group.join(' · ')} — معروض {data.shown}
            {data.hidden > 0 && <> و<b>{data.hidden}</b> مخفي خلف السقف ({data.cap})</>} · زمن الحساب {data.ms}ms
            {Object.entries(data.perTf).filter(([, v]) => v.skipped).map(([tf, v]) => (
              <span key={tf}> · {tf}: {v.skipped}</span>
            ))}
          </div>
        )}
      </div>

      {/* الشارت */}
      <div className="rounded-xl p-2" style={{ background: 'var(--surface-1)', border: '1px solid var(--border-1)' }}>
        <LiquidityV2Chart
          candles={candles}
          zones={chartZones}
          showBoxes={showBoxes}
          showStructure={showStructure}
          showTouchPoints={showTouchPoints}
          showTrendlines={showTrendlines}
          onlyTimeframe={onlyTimeframe ? timeframe : undefined}
        />
        {/* سقوف الرسم مصرَّحة — لا حذف صامت: كل سقف مذكور بعدده هنا وفي تلميحه */}
        <div className="text-[10.5px] px-2 pt-1" style={{ color: 'var(--text-3)' }}>
          سقوف الرسم: مستطيلات العرض/الطلب 30 (الأقوى ثقة، بامتداد محدود حول نشأتها) · خطوط السيولة 12 (المؤكدة ثم الأقوى ثم الأحدث، والأقدم أخفت) ·
          أسهم IDM/BOS/CHoCH 60 (الأحدث) · الارتفاع أو الإخفاء لا يمس أي حساب — القرار يُحسب على كل المناطق.
        </div>
      </div>

      {/* الحصيلة البصرية: كم منطقة لكل نوع ولكل حالة */}
      <div className="flex flex-wrap gap-2 text-[11px]">
        {Object.entries(byKind).map(([k, n]) => (
          <span key={k} className="px-2 py-1 rounded-full num" style={{ background: 'var(--surface-1)', border: `1px solid ${KIND_COLORS[k]?.line ?? 'var(--border-1)'}`, color: 'var(--text-1)' }}>
            {KIND_LABELS[k] ?? k}: {n}
          </span>
        ))}
        {Object.entries(byState).filter(([, n]) => n > 0).map(([s, n]) => (
          <span key={s} className="px-2 py-1 rounded-full num" style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}>
            {STATE_LABELS[s]}: {n}
          </span>
        ))}
        {Object.entries(structureCount).map(([t, n]) => (
          <span key={t} className="px-2 py-1 rounded-full num" style={{ background: 'var(--surface-1)', border: `1px solid ${EVENT_COLORS[t] ?? 'var(--border-1)'}`, color: 'var(--text-1)' }}>
            {t}: {n}
          </span>
        ))}
      </div>

      {/* المستويات المدمجة (عرض فقط) */}
      {!!data?.merged?.length && (
        <div className="rounded-xl p-3 sm:p-4" style={{ background: 'var(--surface-1)', border: '1px solid var(--border-1)' }}>
          <div className="text-[12.5px] font-bold mb-2" style={{ color: 'var(--text-1)' }}>
            المستويات — مدمجة للعرض <span className="font-normal" style={{ color: 'var(--text-3)' }}>(نفس المستوى على عدة فريمات يظهر سطراً واحداً؛ الحساب يبقى لكل فريم مستقلاً)</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-[11px] num" style={{ color: 'var(--text-2)' }}>
              <thead>
                <tr style={{ color: 'var(--text-3)' }}>
                  <Th>النوع</Th><Th>المستوى</Th><Th>السيولة</Th><Th>القمة/القاع الفرعي</Th><Th>لمسات</Th><Th>قوة</Th><Th>الحالة</Th><Th>الفريمات</Th>
                </tr>
              </thead>
              <tbody>
                {data.merged.slice(0, 60).map(m => (
                  <tr key={m.key} style={{ borderTop: '1px solid var(--border-1)' }}>
                    <td className="px-2 py-1 text-right" style={{ color: KIND_COLORS[m.kind]?.line }}>{KIND_LABELS[m.kind] ?? m.kind}</td>
                    <td className="px-2 py-1 text-center">{m.price.toPrecision(7)}</td>
                    <td className="px-2 py-1 text-center">{m.liquidityLevel.toPrecision(7)}</td>
                    <td className="px-2 py-1 text-center">{m.referenceAlt == null ? '—' : m.referenceAlt.toPrecision(7)}</td>
                    <td className="px-2 py-1 text-center">{m.touches}</td>
                    <td className="px-2 py-1 text-center">{(m.confidence * 100).toFixed(0)}%</td>
                    <td className="px-2 py-1 text-center">{m.states.map(s => STATE_LABELS[s] ?? s).join(' → ')}</td>
                    <td className="px-2 py-1 text-center">{m.timeframes.join(' · ')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* تفصيل المناطق وتعليل كل واحدة */}
      {!!chartZones.length && (
        <div className="rounded-xl p-3 sm:p-4" style={{ background: 'var(--surface-1)', border: '1px solid var(--border-1)' }}>
          <div className="text-[12.5px] font-bold mb-2" style={{ color: 'var(--text-1)' }}>المناطق وتعليلها (لماذا وُجدت كل واحدة)</div>
          <div className="space-y-2">
            {chartZones.slice(0, 40).map((z: LiquidityZoneV2) => (
              <div key={z.id} className="rounded-lg p-2.5" style={{ background: 'var(--surface-0)', border: '1px solid var(--border-1)' }}>
                <div className="flex flex-wrap items-center gap-2 text-[11px]">
                  <span className="font-bold" style={{ color: KIND_COLORS[z.kind]?.line }}>{KIND_LABELS[z.kind] ?? z.kind}</span>
                  <span className="num" style={{ color: 'var(--text-1)' }}>{z.referenceLevel.toPrecision(7)}</span>
                  <span className="px-1.5 py-0.5 rounded" style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}>{STATE_LABELS[z.state] ?? z.state}</span>
                  <span style={{ color: 'var(--text-3)' }}>{z.timeframe}</span>
                  {z.htf && <span className="px-1.5 py-0.5 rounded" style={{ background: 'var(--surface-1)', color: 'var(--text-2)' }}>فريم أعلى</span>}
                  <span className="num" style={{ color: 'var(--text-2)' }}>لمسات {z.touches} · قوة {(z.confidence * 100).toFixed(0)}%</span>
                  <span className="num" style={{ color: 'var(--text-3)' }}>سيولة/وقف {z.liquidityLevel.toPrecision(7)}</span>
                </div>
                <div className="mt-1 text-[10.5px]" style={{ color: 'var(--text-2)' }}>
                  {(z.reasons ?? []).join(' · ')}
                </div>
                {(z.touchPoints?.length ?? 0) > 0 && (z.breakSteps?.length ?? 0) > 0 && (
                  <div className="mt-1 text-[10.5px] num" style={{ color: 'var(--text-3)' }}>
                    اللمسات: {z.touchPoints.map(p => p.price.toPrecision(7)).join(' ← ')} | الكسور بعد كل تكرار: {z.breakSteps.map(b => b.reactionPrice.toPrecision(7)).join(' ← ')}
                  </div>
                )}
                {(z.structureEvents?.length ?? 0) > 0 && (
                  <div className="mt-1 text-[10.5px]" style={{ color: 'var(--text-3)' }}>
                    البنية: {[...new Set(z.structureEvents.map(e => e.type))].join(' · ')}
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

function Cell({ label, value, tone }: { label: string; value: string | number; tone?: 'up' | 'warn' | 'accent' }) {
  const color = tone === 'up' ? '#089981' : tone === 'warn' ? '#b45309' : tone === 'accent' ? 'var(--accent)' : 'var(--text-1)';
  return (
    <div className="rounded-lg px-2.5 py-2" style={{ background: 'var(--surface-0)', border: '1px solid var(--border-1)' }}>
      <div className="text-[10px]" style={{ color: 'var(--text-3)' }}>{label}</div>
      <div className="num font-bold" style={{ color }}>{value}</div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[10px]" style={{ color: 'var(--text-3)' }}>{label}</span>
      {children}
    </label>
  );
}

function Toggle({ label, on, set }: { label: string; on: boolean; set: (v: boolean) => void }) {
  return (
    <button onClick={() => set(!on)} className="px-2.5 py-1 rounded-full text-[11px] font-medium"
      style={{
        background: on ? 'var(--accent-soft)' : 'var(--surface-0)',
        color: on ? 'var(--accent)' : 'var(--text-2)',
        border: `1px solid ${on ? 'var(--accent)' : 'var(--border-1)'}`
      }}>
      {on ? '✓ ' : ''}{label}
    </button>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return <th className="px-2 py-1 text-right font-semibold">{children}</th>;
}
