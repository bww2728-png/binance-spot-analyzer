import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api';
import { useStore } from '../store/useStore';
import LiveDashboard from './LiveDashboard';
import type { BuyHistoryResponse, Strategy2Feed, Strategy2Opportunity } from '../lib/types';

/* ═══ الفرص الحية — استراتيجيتي (محرك SMC مستقل) ═══
 * تبويبات: الفرص (جدول شامل) · قيد التتبع (مراحل الانتظار) · لوحة التحكم · المرفوضة.
 * الفلترة على الخادم قبل القص — والنبضات لحظية عبر WS (strategy2_*).
 */

const fmtPx = (v: number | null | undefined) =>
  v == null || !Number.isFinite(Number(v)) ? '—' : Number(v) >= 100 ? Number(v).toFixed(2) : Number(v).toPrecision(6);
const pct = (v: number | null | undefined) => (v == null ? '—' : `${(v * 100).toFixed(1)}%`);
const ago = (ts: number | null | undefined) => {
  if (!ts) return '—';
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s} ث`;
  if (s < 3600) return `${Math.round(s / 60)} د`;
  if (s < 86400) return `${Math.round(s / 3600)} س`;
  return `${Math.round(s / 86400)} ي`;
};

const TIER_BADGE: Record<string, { label: string; color: string }> = {
  qualified: { label: 'مؤهلة', color: '#0a7f6a' },
  probationary: { label: 'تحت التجربة', color: '#b45309' }
};

const HTF_LABEL: Record<string, string> = { up: 'صاعد', down: 'هابط', range: 'عرضي' };

/** تصنيف المسافة: قريب/متوسط/بعيد من الهدف الأول */
function distanceBand(d: number | null | undefined): { label: string; color: string } {
  if (d == null || !Number.isFinite(d)) return { label: '—', color: 'var(--text-3)' };
  const a = Math.abs(d);
  if (a <= 0.75) return { label: 'قريبة', color: 'var(--up)' };
  if (a <= 2.5) return { label: 'متوسطة', color: 'var(--warn)' };
  return { label: 'بعيدة', color: 'var(--down)' };
}

type Tab = 'feed' | 'tracking' | 'dashboard' | 'rejected';

export default function StrategyScreen() {
  const [tab, setTab] = useState<Tab>('feed');
  const [feed, setFeed] = useState<Strategy2Feed | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const pulse = useStore(s => s.strategy2Pulse);
  const openChart = useStore(s => s.openChart);

  // فلاتر خادمية
  const [symbol, setSymbol] = useState('');
  const [tf, setTf] = useState('');
  const [model, setModel] = useState('');
  const [tier, setTier] = useState('');
  const [htfDir, setHtfDir] = useState('');
  const [sort, setSort] = useState('recent');
  const debounceRef = useRef<number | null>(null);
  const [symbolInput, setSymbolInput] = useState('');

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      setError(null);
      setFeed(await api.getStrategy2Feed({
        symbol: symbol || undefined, tf: tf || undefined,
        model: model || undefined, tier: tier || undefined,
        htfDir: htfDir || undefined, sort: sort || undefined, limit: 200
      }));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'فشل جلب البيانات');
    } finally {
      setLoading(false);
    }
  }, [symbol, tf, model, tier, htfDir, sort]);

  useEffect(() => { void load(); }, [load]);
  // نبضات WS — إعادة جلب صامتة (debounce 1.2 ث) + احتياطي 30 ث
  useEffect(() => {
    if (!pulse) return;
    if (debounceRef.current) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => { void load(true); }, 1200);
    return () => { if (debounceRef.current) window.clearTimeout(debounceRef.current); };
  }, [pulse, load]);
  useEffect(() => {
    const id = window.setInterval(() => { void load(true); }, 30_000);
    return () => window.clearInterval(id);
  }, [load]);

  // بحث الرمز مؤجل
  useEffect(() => {
    const id = window.setTimeout(() => setSymbol(symbolInput.trim().toUpperCase()), 400);
    return () => window.clearTimeout(id);
  }, [symbolInput]);

  const opps = feed?.opportunities ?? [];
  const decided = (feed?.stats.wins ?? 0) + (feed?.stats.losses ?? 0);
  const liveWr = feed?.stats.liveWinRate;
  const waitingTop = useMemo(() =>
    Object.entries(feed?.waitingPhases ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 8),
    [feed?.waitingPhases]);

  const dashboardFetcher = useCallback(async (signal?: AbortSignal): Promise<BuyHistoryResponse> => {
    const h = await api.getStrategy2History(90, signal);
    return {
      days: h.days,
      timeline: h.timeline.map(e => ({
        kind: 'published' as const,
        ts: e.ts,
        id: e.id,
        symbol: e.symbol,
        timeframe: e.tf,
        tier: (e.tier === 'qualified' ? 'qualified' : e.tier === 'probationary' ? 'probationary' : null),
        segmentKey: null,
        entry: e.entry,
        stop: e.stop,
        tp: e.tp1,
        rr: e.rr,
        composite: null,
        calibratedWinRate: null,
        detectedAt: e.detectedAt,
        outcome: (e.outcome === 'target' || e.outcome === 'target2' || e.outcome === 'stop' || e.outcome === 'invalidated' || e.outcome === 'expired') ? e.outcome : null,
        resolvedAt: e.resolvedAt,
        durationMs: e.durationMs,
        mfeR: e.mfeR,
        maeR: e.maeR
      })),
      active: h.active.map(a => ({ id: a.id, symbol: a.symbol, timeframe: a.tf, tier: a.tier, detectedAt: a.detectedAt })),
      generatedAt: h.generatedAt
    };
  }, []);

  const cal = feed?.calibration;
  const qualifiedSegs = (cal?.segments ?? []).filter(s => s.tier === 'qualified').length;
  const probationarySegs = (cal?.segments ?? []).filter(s => s.tier === 'probationary').length;

  return (
    <div className="space-y-4">
      {/* الترويسة */}
      <div className="card p-4">
        <div className="flex flex-wrap items-center gap-3 justify-between">
          <div>
            <div className="text-[15px] font-bold" style={{ color: 'var(--text-1)' }}>الفرص الحية — استراتيجيتي</div>
            <div className="text-[11.5px] mt-1" style={{ color: 'var(--text-3)' }}>
              SMC كامل: قمم/قيعان محمية بخطواتها الخمس · هيكل داخلي/خارجي (فريم ×8) · ديسكاونت إلزامي ·
              نموذج 1 (سويب + choch up داخلي) · نموذج 2 (إخراج مبكرين + ابتلاع) · TP1 قمة choch up · TP2 bsl خارجي
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => void api.runStrategy2Scan().then(() => load(true))} className="btn text-[12px]">دورة مسح الآن</button>
            <button
              onClick={() => void api.runStrategy2Calibration().then(() => load(true))}
              disabled={cal?.busy}
              className="btn text-[12px]"
              style={{ opacity: cal?.busy ? 0.5 : 1 }}
            >تشغيل المعايرة</button>
          </div>
        </div>

        {/* شرائط الحالة */}
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-2 mt-3">
          <Stat label="الدورة" value={String(feed?.cycle ?? 0)} />
          <Stat label="أزواج النطاق" value={String(feed?.pairsTotal ?? 0)} />
          <Stat label="فرص منشورة" value={String(feed?.total ?? 0)} highlight />
          <Stat label="حُسمت" value={`${feed?.stats.wins ?? 0}/${decided}`} />
          <Stat label="نسبة النجاح الحية" value={liveWr != null ? pct(liveWr) : '—'} highlight={liveWr != null && liveWr >= 0.6} />
          <Stat label="استعادة/تسوية" value={`${feed?.stats.restored ?? 0}/${feed?.stats.reconciled ?? 0}`} />
          <Stat label="آخر تحديث" value={feed?.updatedAt ? ago(feed.updatedAt) : '—'} />
        </div>
        {(feed?.busy) && <div className="text-[11px] mt-2" style={{ color: 'var(--warn)' }}>دورة فحص جارية…</div>}
        {feed?.error && <div className="text-[11px] mt-2" style={{ color: 'var(--down)' }}>خطأ: {feed.error}</div>}
        {feed?.failures.length ? (
          <div className="text-[11px] mt-2" style={{ color: 'var(--warn)' }}>
            رموز فاشلة: {feed.failures.length} — {feed.failures.slice(0, 3).map(f => `${f.key} (${f.count})`).join(' · ')}
            {feed.failures.length > 3 ? ' …' : ''}
          </div>
        ) : null}

        {/* المعايرة */}
        <div className="mt-3 flex flex-wrap items-center gap-3 text-[11.5px]" style={{ color: 'var(--text-3)' }}>
          <span>
            المعايرة: {cal?.busy
              ? `جارٍ ${cal.progress?.done ?? 0}/${cal.progress?.total ?? 0}`
              : cal?.at ? `${cal.trades} صفقة · ${qualifiedSegs} مؤهلة · ${probationarySegs} تجريبية (${ago(cal.at)})` : 'لم تشتغل بعد'}
          </span>
          <span>بوابة النشر: {qualifiedSegs + probationarySegs > 0 ? 'شرائح مؤهلة/تجريبية معايَرة' : 'شريحة غير معايَرة → نشر مفتوح حتى اكتمال المعايرة الأولى'}</span>
        </div>
      </div>

      {/* التبويبات */}
      <div className="flex gap-1.5 flex-wrap">
        {([['feed', `الفرص (${opps.length})`], ['tracking', 'قيد التتبع'], ['dashboard', 'لوحة التحكم'], ['rejected', `المرفوضة (${feed?.rejected.length ?? 0})`]] as [Tab, string][]).map(([t, label]) => (
          <button key={t} onClick={() => setTab(t)} className="text-[12px] font-semibold px-3 py-1.5 rounded-lg"
            style={{
              background: tab === t ? 'var(--accent-soft)' : 'var(--surface-1)',
              color: tab === t ? 'var(--accent)' : 'var(--text-2)',
              border: '1px solid var(--border-1)'
            }}>{label}</button>
        ))}
      </div>

      {error && <div className="card p-4 text-[12px]" style={{ color: 'var(--down)' }}>{error}</div>}
      {loading && !feed && <div className="card p-4 text-[12px]" style={{ color: 'var(--text-3)' }}>جارٍ الجلب…</div>}

      {/* ═══ تبويب الفرص: الجدول الشامل ═══ */}
      {tab === 'feed' && (
        <div className="space-y-3">
          <div className="card p-3 flex flex-wrap items-center gap-2">
            <input
              value={symbolInput}
              onChange={e => setSymbolInput(e.target.value)}
              placeholder="بحث رمز…"
              className="text-[12px] px-2.5 py-1.5 rounded-lg w-28"
              style={{ background: 'var(--surface-0)', border: '1px solid var(--border-1)', color: 'var(--text-1)' }}
            />
            <select value={tf} onChange={e => setTf(e.target.value)} className="text-[12px] px-2 py-1.5 rounded-lg" style={{ background: 'var(--surface-0)', border: '1px solid var(--border-1)', color: 'var(--text-1)' }}>
              <option value="">كل الفريمات</option>
              {['5m', '15m'].map(f => <option key={f} value={f}>{f}</option>)}
            </select>
            <select value={model} onChange={e => setModel(e.target.value)} className="text-[12px] px-2 py-1.5 rounded-lg" style={{ background: 'var(--surface-0)', border: '1px solid var(--border-1)', color: 'var(--text-1)' }}>
              <option value="">النموذجان</option>
              <option value="1">نموذج 1 — سويب + choch up</option>
              <option value="2">نموذج 2 — إخراج مبكرين + ابتلاع</option>
            </select>
            <select value={tier} onChange={e => setTier(e.target.value)} className="text-[12px] px-2 py-1.5 rounded-lg" style={{ background: 'var(--surface-0)', border: '1px solid var(--border-1)', color: 'var(--text-1)' }}>
              <option value="">كل الطبقات</option>
              <option value="qualified">مؤهلة</option>
              <option value="probationary">تحت التجربة</option>
            </select>
            <select value={htfDir} onChange={e => setHtfDir(e.target.value)} className="text-[12px] px-2 py-1.5 rounded-lg" style={{ background: 'var(--surface-0)', border: '1px solid var(--border-1)', color: 'var(--text-1)' }}>
              <option value="">كل اتجاهات HTF</option>
              <option value="up">صاعد</option>
              <option value="down">هابط</option>
              <option value="range">عرضي</option>
            </select>
            <select value={sort} onChange={e => setSort(e.target.value)} className="text-[12px] px-2 py-1.5 rounded-lg" style={{ background: 'var(--surface-0)', border: '1px solid var(--border-1)', color: 'var(--text-1)' }}>
              <option value="recent">الأحدث</option>
              <option value="rr">أعلى R:R</option>
              <option value="distance">الأقرب للهدف</option>
            </select>
            <span className="text-[11px] num" style={{ color: 'var(--text-3)' }}>
              {opps.length}{feed?.filtered ? ` (مفلترة من ${feed.total})` : ''} صف
            </span>
          </div>

          <div className="card overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-[12px]" style={{ borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--border-1)', background: 'var(--surface-0)' }}>
                    {['الرمز', 'الفريم', 'النموذج', 'اتجاه HTF', 'بعد بريميوم؟', 'الطبقة', 'معايَرة', 'دخول', 'وقف', 'TP1', 'TP2', 'R:R', 'المسافة', 'الحالة', 'العمر', 'أدلة الدخول', 'الشارت'].map(h => (
                      <th key={h} className="text-right px-2.5 py-2 font-bold whitespace-nowrap" style={{ color: 'var(--text-2)' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {opps.map(o => <OppRow key={o.id} o={o} onChart={() => openChart(o.symbol, o.tf, null)} />)}
                </tbody>
              </table>
            </div>
            {opps.length === 0 && !loading && (
              <div className="py-10 text-center text-[12.5px]" style={{ color: 'var(--text-3)' }}>
                {feed && feed.stats.published > 0
                  ? 'لا فرص نشطة الآن — كل المنشورة حُسمت، والمحرك يراقب باستمرار.'
                  : 'لا فرص منشورة بعد — المحرك يراقب مناطق السيولة ويرصد تكوّن القمم/القيعان المحمية لحظياً.'}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ═══ تبويب قيد التتبع: مراحل الانتظار ═══ */}
      {tab === 'tracking' && (
        <div className="space-y-3">
          <div className="card p-4">
            <div className="text-[13px] font-bold mb-2" style={{ color: 'var(--text-1)' }}>مراحل الانتظار الحالية (آخر دورة)</div>
            {waitingTop.length === 0
              ? <div className="text-[12px]" style={{ color: 'var(--text-3)' }}>لم تُراكم أدوار بعد — تظهر بعد أول دورة مسح.</div>
              : (
                <div className="space-y-1.5">
                  {waitingTop.map(([phase, count]) => (
                    <div key={phase} className="flex items-center gap-2">
                      <div className="text-[12px] flex-1" style={{ color: 'var(--text-2)' }}>{phase}</div>
                      <div className="text-[12px] font-bold num" style={{ color: 'var(--accent)' }}>{count}</div>
                    </div>
                  ))}
                </div>
              )}
            <div className="text-[11px] mt-3" style={{ color: 'var(--text-3)' }}>
              مسار القمة المحمية بخطواتها الخمس: سويب BSL ← كسر قاع فرعي ← sellers induced (اختياري) ← ssl sweep (اختياري) ← عودة + نموذج بيعي.
              فشل الدخول الموثق: سويب ssl ← صعود ← سويب bsl ← كسر قاع السويب.
            </div>
          </div>
          <div className="card p-4">
            <div className="text-[13px] font-bold mb-2" style={{ color: 'var(--text-1)' }}>فشل جلب البيانات (شفافية كاملة — لا فشل صامت)</div>
            {feed?.failures.length
              ? (
                <div className="space-y-1">
                  {feed.failures.map(f => (
                    <div key={f.key} className="flex items-center gap-2 text-[11.5px]">
                      <span className="num font-bold" style={{ color: 'var(--warn)' }}>{f.count}×</span>
                      <span className="num" style={{ color: 'var(--text-2)' }}>{f.key}</span>
                      <span style={{ color: 'var(--text-3)' }}>{f.message}</span>
                    </div>
                  ))}
                </div>
              )
              : <div className="text-[12px]" style={{ color: 'var(--text-3)' }}>لا أعطال مسجلة — كل الرموز تُفحص بنجاح.</div>}
          </div>
        </div>
      )}

      {/* ═══ تبويب لوحة التحكم ═══ */}
      {tab === 'dashboard' && (
        <LiveDashboard refreshKey={pulse?.at ?? 0} fetchHistory={dashboardFetcher} title="لوحة التحكم — استراتيجيتي" csvPrefix="strategy2" />
      )}

      {/* ═══ تبويب المرفوضة ═══ */}
      {tab === 'rejected' && (
        <div className="card p-4">
          <div className="text-[13px] font-bold mb-2" style={{ color: 'var(--text-1)' }}>الفرص التي لم تجتز البوابات — بسبب صريح لكل واحدة</div>
          {(feed?.rejected.length ?? 0) === 0
            ? <div className="text-[12px]" style={{ color: 'var(--text-3)' }}>لا مرفوضات حديثة.</div>
            : (
              <div className="space-y-1">
                {feed!.rejected.map((r, i) => (
                  <div key={`${r.at}-${i}`} className="text-[11.5px] flex flex-wrap gap-2 items-baseline" style={{ borderBottom: '1px solid var(--border-1)', padding: '4px 0' }}>
                    <span className="num" style={{ color: 'var(--text-3)' }}>{new Date(r.at).toLocaleTimeString('ar')}</span>
                    {r.symbol && <span className="num font-bold" style={{ color: 'var(--text-1)' }}>{r.symbol}{r.tf ? ` ${r.tf}` : ''}</span>}
                    <span style={{ color: 'var(--text-2)' }}>{r.reason}</span>
                  </div>
                ))}
              </div>
            )}
        </div>
      )}
    </div>
  );
}

function OppRow({ o, onChart }: { o: Strategy2Opportunity; onChart: () => void }) {
  const tick = useStore(s => s.strategy2Rows[o.id]);
  const px = tick?.price ?? o.price;
  const tier = TIER_BADGE[o.tier ?? 'probationary'] ?? TIER_BADGE.probationary;
  const dist = distanceBand(o.distancePct);
  const modelLabel = o.model === 1 ? '1 — سويب+choch' : o.model === 2 ? '2 — مبكرين+ابتلاع' : '—';
  return (
    <tr style={{ borderBottom: '1px solid var(--border-1)' }}>
      <td className="px-2.5 py-2 font-bold num whitespace-nowrap" style={{ color: 'var(--text-1)' }}>{o.symbol}</td>
      <td className="px-2.5 py-2 num" style={{ color: 'var(--text-3)' }}>{o.tf}</td>
      <td className="px-2.5 py-2 whitespace-nowrap text-[11px]" style={{ color: 'var(--text-2)' }}>{modelLabel}</td>
      <td className="px-2.5 py-2 text-[11.5px]" style={{ color: o.htfDirection === 'up' ? 'var(--up)' : o.htfDirection === 'down' ? 'var(--down)' : 'var(--text-2)' }}>
        {HTF_LABEL[o.htfDirection ?? 'range'] ?? '—'}
      </td>
      <td className="px-2.5 py-2 text-[11.5px]" style={{ color: 'var(--text-3)' }}>
        {o.afterPremium == null ? '—' : o.afterPremium ? 'نعم' : 'لا'}
      </td>
      <td className="px-2.5 py-2 whitespace-nowrap">
        <span className="text-[10px] px-2 py-0.5 rounded-full font-semibold" style={{ background: `${tier.color}22`, color: tier.color, border: `1px solid ${tier.color}55` }}>{tier.label}</span>
      </td>
      <td className="px-2.5 py-2 num text-[11px]" style={{ color: 'var(--text-3)' }}>{pct(o.calibratedWinRate)}</td>
      <td className="px-2.5 py-2 num" style={{ color: 'var(--text-2)' }}>{fmtPx(o.entry)}</td>
      <td className="px-2.5 py-2 num" style={{ color: 'var(--down)' }}>{fmtPx(o.stop)}</td>
      <td className="px-2.5 py-2 num" style={{ color: 'var(--up)' }}>{fmtPx(o.tp1)}</td>
      <td className="px-2.5 py-2 num" style={{ color: 'var(--up)' }}>{fmtPx(o.tp2)}</td>
      <td className="px-2.5 py-2 num font-bold" style={{ color: (o.rr ?? 0) >= 1.5 ? 'var(--up)' : 'var(--text-2)' }}>{o.rr != null ? o.rr.toFixed(2) : '—'}</td>
      <td className="px-2.5 py-2 whitespace-nowrap text-[11px] font-semibold" style={{ color: dist.color }}>{dist.label}</td>
      <td className="px-2.5 py-2 num text-[11px]" style={{ color: 'var(--text-2)' }}>
        {tick ? `${tick.plPct != null ? `${tick.plPct > 0 ? '+' : ''}${tick.plPct.toFixed(2)}%` : '—'}` : `${fmtPx(px)}`}
        {tick?.rNow != null && <span style={{ color: 'var(--text-3)' }}> · {tick.rNow.toFixed(2)}R</span>}
      </td>
      <td className="px-2.5 py-2 num text-[11px]" style={{ color: 'var(--text-3)' }}>{ago(o.detectedAt)}</td>
      <td className="px-2.5 py-2 text-[11px] max-w-[280px]" style={{ color: 'var(--text-3)' }} title={o.reasons.join(' · ')}>
        {o.reasons.slice(0, 2).join(' · ')}{o.reasons.length > 2 ? ` +${o.reasons.length - 2}` : ''}
      </td>
      <td className="px-2.5 py-2">
        <button onClick={onChart} className="text-[11px] px-2 py-1 rounded" style={{ background: 'var(--surface-0)', border: '1px solid var(--border-1)', color: 'var(--accent)' }}>الشارت</button>
      </td>
    </tr>
  );
}

function Stat({ label, value, highlight = false }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className="rounded-lg px-2.5 py-1.5" style={{ background: 'var(--surface-0)', border: `1px solid ${highlight ? 'var(--accent)' : 'var(--border-1)'}` }}>
      <div className="text-[10px]" style={{ color: 'var(--text-3)' }}>{label}</div>
      <div className="text-[13px] font-bold num" style={{ color: highlight ? 'var(--accent)' : 'var(--text-1)' }}>{value}</div>
    </div>
  );
}
