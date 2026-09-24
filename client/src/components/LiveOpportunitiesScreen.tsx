import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api';
import { useStore } from '../store/useStore';
import type { BuyFeed, BuyOpportunity, BuyWatchRow, BuyCalibrationSegment } from '../lib/types';
import type { LiveOppTickRow, LiveWatchTickRow } from '../lib/binance';
import LiveDashboard from './LiveDashboard';
import { TIMEFRAMES } from '../lib/types';

/**
 * واجهة «الفرص الحية» — دخول شراء فقط عبر سويب مناطق SSL + أدوات الأوردر فلو.
 *
 * مصدر المناطق: محرك مناطق السيولة (القمم/القيعان) — لا إعادة كشف هنا.
 * كل فرصة معروضة تجاوزت: سويب SSL ← استعادة فوق المستوى المرجعي ← تأكيد تدفق ←
 * خطة كاملة (دخول/وقف/هدف/R:R) ← شريحة معايرة تاريخية بنسبة نجاح ≥ 60%.
 */

const phaseLabel: Record<string, string> = {
  idle: 'خامل',
  armed: 'مسلّح',
  approaching: 'يقترب',
  swept: 'مسحوب',
  reclaimed: 'استُعيد',
  published: 'منشور',
  invalidated: 'أُبطل'
};

const phaseColor: Record<string, string> = {
  idle: 'var(--text-3)',
  armed: 'var(--text-2)',
  approaching: 'var(--accent)',
  swept: 'var(--warn)',
  reclaimed: 'var(--up)',
  published: 'var(--up)',
  invalidated: 'var(--down)'
};

const tierLabel: Record<string, string> = { high: 'قوي', mid: 'متوسط', low: 'ضعيف' };
const sessionLabel: Record<string, string> = { prime: 'جلسة ندرة', normal: 'جلسة عادية', lull: 'فتكة سيولة' };
const locationLabel: Record<string, string> = {
  balance: 'توازن',
  imbalance_up: 'خارج التوازن صعوداً',
  imbalance_down: 'خارج التوازن هبوطاً'
};

const fmt = (v: number | null | undefined, digits = 6) =>
  v == null || !Number.isFinite(Number(v)) ? '—' : Number(v).toPrecision(digits);

const pct = (v: number | null | undefined) =>
  v == null || !Number.isFinite(Number(v)) ? '—' : `${(Number(v) * 100).toFixed(1)}%`;

const ago = (ts: number | null | undefined, now: number) => {
  if (!ts) return '—';
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return `${s} ث`;
  if (s < 3600) return `${Math.round(s / 60)} د`;
  return `${Math.round(s / 3600)} س`;
};

export default function LiveOpportunitiesScreen() {
  const [feed, setFeed] = useState<BuyFeed | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tfFilter, setTfFilter] = useState('');
  const [scopeFilter, setScopeFilter] = useState<'all' | 'halal'>('halal');
  const [section, setSection] = useState<'opps' | 'dashboard' | 'watch' | 'results' | 'rejected'>('opps');
  const [chartId, setChartId] = useState<string | null>(null);
  const [busyMsg, setBusyMsg] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const timer = useRef<number | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await api.getBuyFeed({ timeframe: tfFilter || undefined });
      setFeed(data);
      setError(data.error ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'تعذر جلب الفرص الحية');
    }
  }, [tfFilter]);

  useEffect(() => { void load(); }, [load]);

  // احتياطي بطيء فقط — التحديث اللحظي يأتي عبر بث tick (كل ثانية) من قناة الخادم
  useEffect(() => {
    const id = window.setInterval(() => { void load(); }, 60_000);
    return () => window.clearInterval(id);
  }, [load]);

  useEffect(() => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    let ws: WebSocket | null = null;
    let reloadTimer: number | null = null;
    // نبضات البث تصل عنقودياً (حتى 30 نبضة سويب في العناقيد) — جلب واحد كل 1.5 ث كحد أقصى
    const scheduleReload = () => {
      if (reloadTimer != null) return;
      reloadTimer = window.setTimeout(() => { reloadTimer = null; void load(); }, 1500);
    };
    try {
      ws = new WebSocket(`${proto}://${location.host}/ws`);
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data as string);
          const t = String(msg?.type ?? '');
          if (t.startsWith('live_opportunity') || t.startsWith('live_sweep') || t.startsWith('live_calibration')) {
            scheduleReload();
          }
        } catch { /* رسالة غير JSON */ }
      };
    } catch { /* بلا بث — الاعتماد على التحديث الدوري */ }
    return () => {
      if (reloadTimer != null) window.clearTimeout(reloadTimer);
      ws?.close();
    };
  }, [load]);

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    timer.current = id;
    return () => window.clearInterval(id);
  }, []);

  const runScan = async () => {
    setBusyMsg('جارٍ تشغيل دورة مسح الآن…');
    try {
      await api.runBuyScan();
      window.setTimeout(() => { void load(); setBusyMsg(null); }, 4000);
    } catch (e) {
      setBusyMsg(null);
      setError(e instanceof Error ? e.message : 'تعذر تشغيل الدورة');
    }
  };

  const runCalibration = async () => {
    setBusyMsg('بدأت المعايرة التاريخية — ستُحدَّث الشرائح تدريجياً…');
    try {
      await api.runBuyCalibration();
      window.setTimeout(() => { void load(); setBusyMsg(null); }, 6000);
    } catch (e) {
      setBusyMsg(null);
      setError(e instanceof Error ? e.message : 'تعذر تشغيل المعايرة');
    }
  };

  const opportunities = feed?.opportunities ?? [];
  const watching = feed?.watching ?? [];
  const rejected = feed?.rejected ?? [];
  const segments: BuyCalibrationSegment[] = feed?.calibration.segments ?? [];

  /* اللقطة الحية من قناة WebSocket — تُدمج فوق بيانات الجلب */
  const liveTick = useStore(s => s.liveOppTick);
  const calibProgress = useStore(s => s.calibrationProgress);
  const tickOpp = (id: string) => liveTick?.opportunities?.[id] ?? null;
  const tickWatch = (key: string) => liveTick?.watching?.[key] ?? null;
  const tickAge = liveTick ? Math.max(0, Math.round((now - liveTick.at) / 1000)) : null;

  const byTf = useMemo(() => {
    const map = new Map<string, number>();
    for (const o of opportunities) map.set(o.timeframe, (map.get(o.timeframe) ?? 0) + 1);
    return [...map.entries()].sort((a, b) => TIMEFRAMES.indexOf(a[0] as never) - TIMEFRAMES.indexOf(b[0] as never));
  }, [opportunities]);

  const liveRate = feed?.stats.liveWinRate ?? null;
  const targetRate = feed?.calibration.targetWinRate ?? 0.6;

  return (
    <section className="max-w-[1600px] mx-auto px-3 sm:px-5 py-4 space-y-4" dir="rtl">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold" style={{ color: 'var(--text-1)' }}>الفرص الحية — دخول شراء</h2>
          <p className="text-[11px] mt-1" style={{ color: 'var(--text-3)' }}>
            مناطق SSL من محرك مناطق السيولة (قمم/قيعان) ← انتظار سويب ← تأكيد بالأوردر فلو ← خطة كاملة.
            الفرص تُنشر بطبقتين شفافتين: «مؤهلة» (شريحتها مثبتة إحصائياً بـ{pct(targetRate)}+) و«تحت التجربة» (إعداد تقنياً سليم، شريحته لم تُثبت بعد) — ونتائج كل فرصة تُغذّي ترقية شريحتها تلقائياً.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span
            className="px-3 py-1.5 rounded-full text-[11px] font-bold"
            style={{
              background: tickAge != null && tickAge < 5 ? 'var(--up-soft)' : 'var(--surface-1)',
              color: tickAge != null && tickAge < 5 ? 'var(--up)' : 'var(--text-3)',
              border: '1px solid var(--border-1)'
            }}
            title="بث WebSocket لحظي من الخادم"
          >
            {tickAge != null && tickAge < 5 ? 'بث حي' : 'بلا نبضات'}{tickAge != null ? ` · ${tickAge} ث` : ''}
          </span>
          <button onClick={() => void runScan()} className="px-4 py-2 rounded-lg text-[12px] font-bold" style={{ background: 'var(--accent)', color: '#fff' }}>دورة مسح الآن</button>
          <button onClick={() => void runCalibration()} className="px-4 py-2 rounded-lg text-[12px] font-bold" style={{ background: 'var(--surface-1)', border: '1px solid var(--border-1)', color: 'var(--text-1)' }}>تشغيل المعايرة</button>
        </div>
      </div>

      {/* شريط التقدم الحي */}
      <div className="grid grid-cols-2 lg:grid-cols-6 gap-2">
        <div className="rounded-xl p-3" style={{ background: 'var(--surface-1)' }}>
          <div className="text-[10px]" style={{ color: 'var(--text-3)' }}>الدورة</div>
          <div className="num font-bold">{feed?.cycle ?? 0}</div>
        </div>
        <div className="rounded-xl p-3" style={{ background: 'var(--surface-1)' }}>
          <div className="text-[10px]" style={{ color: 'var(--text-3)' }}>أزواج النطاق</div>
          <div className="num font-bold">{feed?.pairsTotal ?? 0}</div>
        </div>
        <div className="rounded-xl p-3" style={{ background: 'var(--surface-1)' }}>
          <div className="text-[10px]" style={{ color: 'var(--text-3)' }}>مناطق SSL مُتتبَّعة</div>
          <div className="num font-bold">{feed?.zonesTracked ?? 0}</div>
        </div>
        <div className="rounded-xl p-3" style={{ background: 'var(--surface-1)' }}>
          <div className="text-[10px]" style={{ color: 'var(--text-3)' }}>فرص منشورة</div>
          <div className="num font-bold" style={{ color: 'var(--up)' }}>{feed?.total ?? 0}</div>
        </div>
        <div className="rounded-xl p-3" style={{ background: 'var(--surface-1)' }}>
          <div className="text-[10px]" style={{ color: 'var(--text-3)' }}>النتائج الفعلية</div>
          <div className="num font-bold">{feed?.stats.wins ?? 0} / {(feed?.stats.wins ?? 0) + (feed?.stats.losses ?? 0)}</div>
          <div className="text-[10px]" style={{ color: liveRate != null && liveRate >= targetRate ? 'var(--up)' : 'var(--text-3)' }}>{liveRate == null ? 'لا نتائج محسومة بعد' : `نسبة نجاح ${pct(liveRate)}`}</div>
        </div>
        <div className="rounded-xl p-3" style={{ background: 'var(--surface-1)' }}>
          <div className="text-[10px]" style={{ color: 'var(--text-3)' }}>المعايرة</div>
          <div className="text-[12px] font-bold" style={{ color: feed?.calibration.busy ? 'var(--accent)' : 'var(--up)' }}>
            {feed?.calibration.busy
              ? `جارٍ ${calibProgress ? `${calibProgress.done}/${calibProgress.total}` : feed.calibration.progress ? `${feed.calibration.progress.done}/${feed.calibration.progress.total}` : ''}`
              : feed?.calibration.at ? `جاهزة · ${feed.calibration.trades} صفقة` : 'بانتظار أول معايرة'}
          </div>
          <div className="text-[10px]" style={{ color: 'var(--text-3)' }}>آخر تحديث {ago(feed?.calibration.at, now)}</div>
        </div>
      </div>

      {busyMsg && <div className="rounded-lg px-3 py-2 text-[12px]" style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}>{busyMsg}</div>}
      {error && <div className="rounded-lg px-3 py-2 text-[12px]" style={{ background: 'var(--down-soft)', color: 'var(--down)' }}>{error}</div>}

      {/* الفلاتر */}
      <div className="flex flex-wrap items-center gap-2">
        <select value={tfFilter} onChange={e => setTfFilter(e.target.value)} className="px-3 py-2 rounded-lg text-[12px]" style={{ background: 'var(--surface-1)', border: '1px solid var(--border-1)', color: 'var(--text-1)' }}>
          <option value="">كل الفريمات</option>
          {TIMEFRAMES.map(tf => <option key={tf} value={tf}>{tf}</option>)}
        </select>
        <div className="flex items-center gap-1 rounded-lg p-1" style={{ background: 'var(--surface-1)' }}>
          <button onClick={() => setScopeFilter('halal')} className="px-3 py-1.5 rounded-md text-[11px] font-bold" style={{ background: scopeFilter === 'halal' ? 'var(--accent-soft)' : 'transparent', color: scopeFilter === 'halal' ? 'var(--accent)' : 'var(--text-2)' }}>حلال بلا باركود</button>
          <button onClick={() => setScopeFilter('all')} className="px-3 py-1.5 rounded-md text-[11px] font-bold" style={{ background: scopeFilter === 'all' ? 'var(--accent-soft)' : 'transparent', color: scopeFilter === 'all' ? 'var(--accent)' : 'var(--text-2)' }}>كل العملات</button>
        </div>
        <span className="text-[11px]" style={{ color: 'var(--text-3)' }}>
          النطاق الحالي للنظام: حلال بلا باركود — لتوسيعه لكل العملات يُعدَّل من مصدر القائمة في الخادم.
        </span>
      </div>

      {byTf.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[11px]" style={{ color: 'var(--text-3)' }}>التوزيع:</span>
          {byTf.map(([tf, n]) => (
            <button key={tf} onClick={() => setTfFilter(tf)} className="px-2.5 py-1 rounded-md text-[11px] num" style={{ background: 'var(--surface-1)', color: 'var(--text-2)', border: '1px solid var(--border-1)' }}>{tf} · {n}</button>
          ))}
        </div>
      )}

      {/* الأقسام */}
      <div className="flex flex-wrap items-center gap-2">
        <button onClick={() => setSection('opps')} className="px-3 py-2 rounded-lg text-[12px]" style={{ background: section === 'opps' ? 'var(--accent-soft)' : 'var(--surface-1)', color: section === 'opps' ? 'var(--accent)' : 'var(--text-2)' }}>الفرص المنشورة ({opportunities.length})</button>
        <button onClick={() => setSection('dashboard')} className="px-3 py-2 rounded-lg text-[12px]" style={{ background: section === 'dashboard' ? 'var(--accent-soft)' : 'var(--surface-1)', color: section === 'dashboard' ? 'var(--accent)' : 'var(--text-2)' }}>لوحة التحكم</button>
        <button onClick={() => setSection('watch')} className="px-3 py-2 rounded-lg text-[12px]" style={{ background: section === 'watch' ? 'var(--accent-soft)' : 'var(--surface-1)', color: section === 'watch' ? 'var(--accent)' : 'var(--text-2)' }}>قيد المراقبة ({feed?.watchingTotal ?? 0})</button>
        <button onClick={() => setSection('results')} className="px-3 py-2 rounded-lg text-[12px]" style={{ background: section === 'results' ? 'var(--accent-soft)' : 'var(--surface-1)', color: section === 'results' ? 'var(--accent)' : 'var(--text-2)' }}>المعايرة والنتائج ({segments.length})</button>
        <button onClick={() => setSection('rejected')} className="px-3 py-2 rounded-lg text-[12px]" style={{ background: section === 'rejected' ? 'var(--accent-soft)' : 'var(--surface-1)', color: section === 'rejected' ? 'var(--accent)' : 'var(--text-2)' }}>لم تجتز البوابات ({rejected.length})</button>
      </div>

      {section === 'dashboard' && <LiveDashboard refreshKey={Math.floor(now / 60_000)} />}

      {section === 'opps' && (
        <>
          {!opportunities.length && (
            <div className="rounded-xl py-16 text-center text-sm" style={{ background: 'var(--surface-1)', color: 'var(--text-3)' }}>
              {feed?.busy ? 'الدورة قيد التنفيذ — تُضاف الفرص تدريجياً…' : 'لا فرص منشورة حالياً — المحرك يراقب مناطق SSL ويرصد السويب لحظياً'}
            </div>
          )}
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-2">
            {opportunities.map(o => <OpportunityCard key={o.id} op={o} now={now} targetRate={targetRate} onChart={() => setChartId(o.id)} tick={tickOpp(o.id)} />)}
          </div>
        </>
      )}

      {section === 'watch' && (
        <>
          {!watching.length && (
            <div className="rounded-xl py-16 text-center text-sm" style={{ background: 'var(--surface-1)', color: 'var(--text-3)' }}>لا مناطق SSL قريبة من السعر حالياً — المراقبة مستمرة بلا انقطاع</div>
          )}
          {watching.length > 0 && (
            <div className="rounded-xl overflow-hidden" style={{ background: 'var(--surface-1)' }}>
              <table className="w-full text-[12px]">
                <thead>
                  <tr style={{ color: 'var(--text-3)' }}>
                    <th className="text-right px-3 py-2">العملة</th>
                    <th className="text-right px-3 py-2">الفريم</th>
                    <th className="text-right px-3 py-2">الحالة</th>
                    <th className="text-right px-3 py-2">المرجع</th>
                    <th className="text-right px-3 py-2">السيولة</th>
                    <th className="text-right px-3 py-2">المسافة (ATR)</th>
                    <th className="text-right px-3 py-2">المحاولات</th>
                    <th className="text-right px-3 py-2">السبب</th>
                  </tr>
                </thead>
                <tbody>
                  {watching.map(w => <WatchRow key={`${w.symbol}|${w.timeframe}|${w.zoneId}`} row={w} tick={tickWatch(`${w.symbol}|${w.timeframe}|${w.zoneId}`)} />)}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {section === 'results' && (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
            <div className="rounded-xl p-3" style={{ background: 'var(--surface-1)' }}>
              <div className="text-[10px]" style={{ color: 'var(--text-3)' }}>صفقات المعايرة</div>
              <div className="num font-bold">{feed?.calibration.trades ?? 0}</div>
            </div>
            <div className="rounded-xl p-3" style={{ background: 'var(--surface-1)' }}>
              <div className="text-[10px]" style={{ color: 'var(--text-3)' }}>أزواج المعايرة</div>
              <div className="num font-bold">{feed?.calibration.samplePairs ?? 0}</div>
            </div>
            <div className="rounded-xl p-3" style={{ background: 'var(--surface-1)' }}>
              <div className="text-[10px]" style={{ color: 'var(--text-3)' }}>شرائح مؤهَّلة (≥ {pct(targetRate)})</div>
              <div className="num font-bold" style={{ color: 'var(--up)' }}>{segments.filter(s => s.smoothedWinRate >= targetRate).length} / {segments.length}</div>
            </div>
            <div className="rounded-xl p-3" style={{ background: 'var(--surface-1)' }}>
              <div className="text-[10px]" style={{ color: 'var(--text-3)' }}>النتائج الفعلية الحية</div>
              <div className="num font-bold">{feed?.stats.wins ?? 0} هدف · {feed?.stats.losses ?? 0} وقف</div>
            </div>
          </div>
          {!segments.length && (
            <div className="rounded-xl py-16 text-center text-sm" style={{ background: 'var(--surface-1)', color: 'var(--text-3)' }}>
              لا شرائح بعد — شغّل المعايرة لتوليد إحصاء تاريخي بنفس منطق الفرص
            </div>
          )}
          {segments.length > 0 && (
            <div className="rounded-xl overflow-hidden" style={{ background: 'var(--surface-1)' }}>
              <table className="w-full text-[12px]">
                <thead>
                  <tr style={{ color: 'var(--text-3)' }}>
                    <th className="text-right px-3 py-2">الشريحة (فريم | تدفق | ثقة)</th>
                    <th className="text-right px-3 py-2">صفقات</th>
                    <th className="text-right px-3 py-2">نجاح</th>
                    <th className="text-right px-3 py-2">نسبة النجاح</th>
                    <th className="text-right px-3 py-2">المُعايَرة</th>
                    <th className="text-right px-3 py-2">متوسط R:R</th>
                    <th className="text-right px-3 py-2">الأهلية</th>
                  </tr>
                </thead>
                <tbody>
                  {segments.map(s => {
                    const ok = s.smoothedWinRate >= targetRate;
                    return (
                      <tr key={s.key} style={{ borderTop: '1px solid var(--border-1)' }}>
                        <td className="px-3 py-2 num" style={{ color: 'var(--text-1)' }}>{s.key}</td>
                        <td className="px-3 py-2 num" style={{ color: 'var(--text-2)' }}>{s.trades}</td>
                        <td className="px-3 py-2 num" style={{ color: 'var(--text-2)' }}>{s.wins}</td>
                        <td className="px-3 py-2 num" style={{ color: 'var(--text-2)' }}>{pct(s.winRate)}</td>
                        <td className="px-3 py-2 num font-bold" style={{ color: ok ? 'var(--up)' : 'var(--down)' }}>{pct(s.smoothedWinRate)}</td>
                        <td className="px-3 py-2 num" style={{ color: 'var(--text-2)' }}>{s.avgRR ?? '—'}</td>
                        <td className="px-3 py-2 text-[11px]" style={{ color: ok ? 'var(--up)' : 'var(--text-3)' }}>{ok ? 'مؤهَّلة للنشر' : 'دون الهدف'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {section === 'rejected' && (
        <>
          {!rejected.length && (
            <div className="rounded-xl py-16 text-center text-sm" style={{ background: 'var(--surface-1)', color: 'var(--text-3)' }}>لا مرشحين مرفوضين في هذه الفترة</div>
          )}
          <div className="space-y-1.5">
            {rejected.map((r, i) => (
              <div key={`${r.symbol}|${r.zoneId}|${i}`} className="rounded-lg px-3 py-2 flex flex-wrap items-center gap-3 text-[12px]" style={{ background: 'var(--surface-1)' }}>
                <span className="font-bold num" style={{ color: 'var(--text-1)' }}>{r.symbol}</span>
                <span className="num" style={{ color: 'var(--text-3)' }}>{r.timeframe}</span>
                {r.composite != null && <span className="num" style={{ color: 'var(--text-3)' }}>درجة {r.composite}</span>}
                {r.flowScore != null && <span className="num" style={{ color: 'var(--text-3)' }}>تدفق {r.flowScore}</span>}
                {r.rr != null && <span className="num" style={{ color: 'var(--text-3)' }}>R:R {r.rr}</span>}
                <span style={{ color: 'var(--down)' }}>{r.reason}</span>
                <span className="text-[10px] mr-auto" style={{ color: 'var(--text-3)' }}>{ago(r.at, now)}</span>
              </div>
            ))}
          </div>
        </>
      )}

      {chartId && <ChartModal id={chartId} onClose={() => setChartId(null)} />}
    </section>
  );
}

function WatchRow({ row, tick }: { row: BuyWatchRow; tick: LiveWatchTickRow | null }) {
  // الطور اللحظي من البث يتقدم على المرجع الثابت — يُستخدم متى وصلت نبضة أحدث
  const livePhase = tick?.phase ?? row.phase;
  const liveAtr = tick?.toLiquidityAtr ?? row.toLiquidityAtr;
  return (
    <tr style={{ borderTop: '1px solid var(--border-1)' }}>
      <td className="px-3 py-2 font-bold num" style={{ color: 'var(--text-1)' }}>{row.symbol}</td>
      <td className="px-3 py-2 num" style={{ color: 'var(--text-3)' }}>{row.timeframe}</td>
      <td className="px-3 py-2 text-[11px] font-bold" style={{ color: phaseColor[livePhase] ?? 'var(--text-2)' }}>
        {phaseLabel[livePhase] ?? livePhase}
        {tick && <span className="text-[10px]" style={{ color: 'var(--up)' }} title="تحديث لحظي من البث"> ●</span>}
        {row.staleSweep && <span className="text-[10px]" style={{ color: 'var(--text-3)' }}> · سويب قديم</span>}
      </td>
      <td className="px-3 py-2 num" style={{ color: 'var(--text-2)' }}>{fmt(row.referenceLevel)}</td>
      <td className="px-3 py-2 num" style={{ color: 'var(--text-2)' }}>{fmt(row.liquidityLevel)}</td>
      <td className="px-3 py-2 num" style={{ color: 'var(--text-2)' }}>{liveAtr?.toFixed(2) ?? '—'}</td>
      <td className="px-3 py-2 num" style={{ color: row.attempts > 0 ? 'var(--warn)' : 'var(--text-3)' }}>{row.attempts}</td>
      <td className="px-3 py-2 text-[11px]" style={{ color: 'var(--text-3)' }}>{row.reason ?? '—'}</td>
    </tr>
  );
}

function OpportunityCard({ op, now, targetRate, onChart, tick }: { op: BuyOpportunity; now: number; targetRate: number; onChart: () => void; tick: LiveOppTickRow | null }) {
  const rateOk = op.calibratedWinRate >= targetRate;
  const outcomeColor = op.outcome === 'target' ? 'var(--up)' : op.outcome === 'stop' ? 'var(--down)' : 'var(--accent)';
  // الحالة اللحظية من البث (كل ثانية): السعر الحالي ومسافة الهدف/الوقف وR الحالي
  const price = tick?.price ?? op.entry;
  const plPct = tick?.plPct ?? 0;
  const toTp = tick?.toTpPct ?? 100;
  const toStop = tick?.toStopPct ?? 100;
  const rNow = tick?.rNow ?? 0;
  const plColor = plPct >= 0 ? 'var(--up)' : 'var(--down)';
  return (
    <div className="rounded-xl p-3 space-y-2" style={{ background: 'var(--surface-1)', border: '1px solid var(--border-1)' }}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="font-bold num text-[14px]" style={{ color: 'var(--text-1)' }}>{op.symbol}</span>
          <span className="px-2 py-0.5 rounded-md text-[10px] num" style={{ background: 'var(--surface-0)', color: 'var(--text-2)' }}>{op.timeframe}</span>
          <span className="px-2 py-0.5 rounded-md text-[10px]" style={{ background: 'var(--up-soft)', color: 'var(--up)' }}>شراء</span>
          {op.tier && (
            <span className="px-2 py-0.5 rounded-md text-[10px] font-bold" style={{ background: op.tier === 'qualified' ? 'var(--up-soft)' : 'var(--warn-soft)', color: op.tier === 'qualified' ? 'var(--up)' : '#b45309' }} title={`الشريحة ${op.segmentKey} — نسبة معايَرة ${pct(op.calibratedWinRate)} من ${op.segmentTrades} صفقة${op.wilsonLB != null ? ` · حد Wilson ${pct(op.wilsonLB)}` : ''}`}>
              {op.tier === 'qualified' ? 'مؤهلة' : 'تحت التجربة'} {pct(op.calibratedWinRate)}
            </span>
          )}
          {tick && <span className="text-[10px]" style={{ color: 'var(--up)' }} title="بث لحظي كل ثانية">●</span>}
        </div>
        <span className="num font-bold text-[13px]" style={{ color: outcomeColor }}>
          {op.outcome === 'target' ? 'وصل الهدف' : op.outcome === 'stop' ? 'ضرب الوقف' : `درجة ${op.composite}`}
        </span>
      </div>

      {/* الشريط اللحظي: السعر الحالي بين الوقف والهدف */}
      <div className="rounded-lg px-2.5 py-2 space-y-1.5" style={{ background: 'var(--surface-0)' }}>
        <div className="flex items-center justify-between text-[11px] num">
          <span style={{ color: 'var(--down)' }}>وقف {fmt(op.stop)}</span>
          <span className="font-bold" style={{ color: plColor }}>
            {fmt(price)} · {plPct >= 0 ? '+' : ''}{plPct.toFixed(2)}%{tick ? ` · ${rNow >= 0 ? '+' : ''}${rNow.toFixed(2)}R` : ''}
          </span>
          <span style={{ color: 'var(--up)' }}>هدف {fmt(op.tp)}</span>
        </div>
        <div className="h-1.5 rounded-full overflow-hidden" style={{ background: 'var(--down-soft)', direction: 'ltr' }}>
          <div className="h-full rounded-full" style={{ width: `${Math.min(100, Math.max(0, 100 - toTp))}%`, background: 'var(--up)' }} />
        </div>
        <div className="flex justify-between text-[10px] num" style={{ color: 'var(--text-3)', direction: 'ltr' }}>
          <span>{toTp.toFixed(2)}% للهدف</span>
          <span>{toStop.toFixed(2)}% للوقف</span>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-2 text-[11px]">
        <div><div style={{ color: 'var(--text-3)' }}>الدخول</div><div className="num font-bold" style={{ color: 'var(--text-1)' }}>{fmt(op.entry)}</div></div>
        <div><div style={{ color: 'var(--text-3)' }}>الوقف</div><div className="num font-bold" style={{ color: 'var(--down)' }}>{fmt(op.stop)}</div></div>
        <div><div style={{ color: 'var(--text-3)' }}>الهدف</div><div className="num font-bold" style={{ color: 'var(--up)' }}>{fmt(op.tp)}</div></div>
      </div>

      <div className="grid grid-cols-4 gap-2 text-[11px]">
        <div><div style={{ color: 'var(--text-3)' }}>R:R</div><div className="num font-bold" style={{ color: op.rr >= 2 ? 'var(--up)' : 'var(--warn)' }}>{op.rr}</div></div>
        <div><div style={{ color: 'var(--text-3)' }}>وقف (ATR)</div><div className="num" style={{ color: 'var(--text-2)' }}>{op.stopAtr}</div></div>
        <div><div style={{ color: 'var(--text-3)' }}>تدفق</div><div className="num" style={{ color: 'var(--text-2)' }}>{op.flowScore} · {tierLabel[op.flowTier] ?? op.flowTier}</div></div>
        <div><div style={{ color: 'var(--text-3)' }}>مسافة السويب</div><div className="num" style={{ color: 'var(--text-2)' }}>{op.distancePct}%</div></div>
      </div>

      <div className="rounded-lg px-2.5 py-2 text-[11px] flex items-center justify-between gap-2" style={{ background: rateOk ? 'var(--up-soft)' : 'var(--down-soft)' }}>
        <span style={{ color: rateOk ? 'var(--up)' : 'var(--down)' }}>ثقة الشريحة المُعايَرة</span>
        <span className="num font-bold" style={{ color: rateOk ? 'var(--up)' : 'var(--down)' }}>{pct(op.calibratedWinRate)} · {op.segmentTrades} صفقة</span>
      </div>

      <div className="text-[10px] flex flex-wrap gap-x-3 gap-y-1" style={{ color: 'var(--text-3)' }}>
        <span>{sessionLabel[op.session] ?? op.session}</span>
        <span>الموقع: {locationLabel[op.location] ?? op.location}</span>
        <span>لمسات المنطقة: {op.zoneTouches}</span>
        {op.profile && <span>VAH {fmt(op.profile.vah, 6)} · POC {fmt(op.profile.poc, 6)}</span>}
        <span>قاع السويب {fmt(op.sweepLow)}</span>
        {tick && <span>MFE {tick.mfeR.toFixed(2)}R · MAE {tick.maeR.toFixed(2)}R</span>}
        {tick && <span>عمر الصفقة {tick.ageSec < 60 ? `${tick.ageSec} ث` : `${Math.round(tick.ageSec / 60)} د`}</span>}
      </div>

      {tick?.earlyExit && (
        <div className="rounded-lg px-2.5 py-1.5 text-[11px] font-bold" style={{ background: 'var(--down-soft)', color: 'var(--down)' }}>
          إشارة خروج مبكر: شمعة أُغلقت تحت قاع السويب المحمي
        </div>
      )}

      <ul className="text-[11px] space-y-0.5 list-disc pr-4" style={{ color: 'var(--text-2)' }}>
        {op.reasons.slice(0, 5).map((r, i) => <li key={i}>{r}</li>)}
      </ul>

      <div className="flex items-center justify-between gap-2 pt-1">
        <span className="text-[10px]" style={{ color: 'var(--text-3)' }}>اكتُشفت قبل {ago(op.detectedAt, now)}</span>
        <button onClick={onChart} className="px-3 py-1.5 rounded-md text-[11px] font-bold" style={{ background: 'var(--surface-0)', border: '1px solid var(--border-1)', color: 'var(--text-1)' }}>الشارت</button>
      </div>
    </div>
  );
}

function ChartModal({ id, onClose }: { id: string; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.6)' }} onClick={onClose}>
      <div className="rounded-xl p-3 max-w-[1000px] w-full" style={{ background: 'var(--surface-0)' }} onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-2">
          <span className="text-[13px] font-bold" style={{ color: 'var(--text-1)' }}>شارت الفرصة — الشموع الحقيقية وخطوط الخطة</span>
          <button onClick={onClose} className="px-3 py-1.5 rounded-md text-[11px] font-bold" style={{ background: 'var(--surface-1)', color: 'var(--text-1)' }}>إغلاق</button>
        </div>
        <img src={api.buyOpportunityChartUrl(id)} alt="شارت الفرصة" className="w-full rounded-lg" style={{ background: '#fff' }} />
      </div>
    </div>
  );
}
