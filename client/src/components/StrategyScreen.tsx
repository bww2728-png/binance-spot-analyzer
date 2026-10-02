import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api';
import { useStore } from '../store/useStore';
import LiveDashboard from './LiveDashboard';
import OppDrawer, { oppLevels } from './OppDrawer';
import type { BuyHistoryResponse, Strategy2DirectionsResponse, Strategy2DirectionRow, Strategy2Feed, Strategy2Opportunity } from '../lib/types';

/* ═══ الفرص الحية — استراتيجيتي (محرك SMC مستقل) ═══
 * تبويبات: الفرص (جدول + درج تفاصيل) · الاتجاهات · قيد التتبع · لوحة التحكم · المرفوضة.
 * الفلترة على الخادم قبل القص — والنبضات لحظية عبر WS (strategy2_*).
 * مبادئ ملزمة: لا حذف لمعلومة استراتيجية (طبقات وتوسعة بدل الحذف) · لا لغة يقين ·
 * لا قرار نيابة عن المحلل (إبراز محايد بقواعد معلنة) · ثبات تام أثناء البث الحي.
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
const htfColor = (d: string | null | undefined) => (d === 'up' ? 'var(--up)' : d === 'down' ? 'var(--down)' : 'var(--text-2)');

/** تصنيف المسافة: قريب/متوسط/بعيد من الهدف الأول */
function distanceBand(d: number | null | undefined): { label: string; color: string } {
  if (d == null || !Number.isFinite(d)) return { label: '—', color: 'var(--text-3)' };
  const a = Math.abs(d);
  if (a <= 0.75) return { label: 'قريبة', color: 'var(--up)' };
  if (a <= 2.5) return { label: 'متوسطة', color: 'var(--warn)' };
  return { label: 'بعيدة', color: 'var(--down)' };
}

/** عتبة التقلب المفرط: انقلابات الاتجاه منذ الإقلاع */
const VOLATILE_CHANGES = 10;

/** صياغة عربية ودية لأخطاء الجلب — تخفي المضيفين الداخليين وتركز على المعنى */
function friendlyFailure(f: { key: string; message?: string | null }): { symbol: string; reason: string } {
  const [sym, tf] = String(f.key ?? '').split('|');
  const msg = String(f.message ?? '');
  const reason = /451/.test(msg) ? 'غير مدعوم في المنطقة (451)' : msg.slice(0, 120) || 'تعذر الجلب';
  return { symbol: [sym, tf].filter(Boolean).join(' '), reason };
}

/** مستويات سجل الاتجاه مرسومة على الشارت في أماكنها */
function dirLevels(d: Strategy2DirectionRow) {
  const lv: { price: number; color: string; title: string }[] = [];
  const push = (price: number | null | undefined, color: string, title: string) => {
    if (price != null && Number.isFinite(Number(price))) lv.push({ price: Number(price), color, title });
  };
  push(d.anchorHigh ?? d.anchorLow, '#0ea5e9', d.anchorHigh != null ? 'قمة محمية' : 'قاع محمي');
  push(d.discountLevel, '#0a7f6a', 'ديسكاونت');
  push(d.deathLevel, '#f23645', 'موت المشوار');
  push(d.externalNext, '#b45309', 'العرض الخارجي');
  return lv;
}

/** اكتمال الشروط اللازمة من التسلسل (0..1) — أساس الفرز المحايد */
function completenessOf(o: Strategy2Opportunity): number | null {
  const req = (o.sequence ?? []).filter(s => s.required);
  if (!req.length) return null;
  return req.filter(s => s.status === 'occurred').length / req.length;
}

/** قاعدة الإبراز المحايد المعلنة: شريحة مؤهلة + قريبة من الهدف — ليست توصية دخول */
function attentionOf(o: Strategy2Opportunity): { on: boolean; score: number } {
  let score = 0;
  if (o.tier === 'qualified') score += 2;
  else if (o.tier === 'probationary') score += 1;
  if (o.distancePct != null && Number.isFinite(o.distancePct) && Math.abs(o.distancePct) <= 0.75) score += 1;
  const c = completenessOf(o);
  if (c != null && c >= 1) score += 1;
  return { on: score >= 3, score };
}

/** شريط موقع السعر الحي بين الوقف والدخول والهدف */
function PriceBar({ stop, entry, tp1, live }: { stop: number | null; entry: number | null; tp1: number | null; live: number | null }) {
  if (stop == null || entry == null || tp1 == null || !Number.isFinite(stop) || !Number.isFinite(entry) || !Number.isFinite(tp1) || tp1 <= stop) {
    return <span className="text-[11px]" style={{ color: 'var(--text-3)' }}>—</span>;
  }
  const pctOf = (v: number) => Math.max(0, Math.min(100, ((v - stop) / (tp1 - stop)) * 100));
  const entryPct = pctOf(entry);
  const livePct = live != null && Number.isFinite(live) ? pctOf(live) : null;
  return (
    <span className="block w-28" title={`وقف ${fmtPx(stop)} · دخول ${fmtPx(entry)} · هدف ${fmtPx(tp1)}${live != null ? ` · حي ${fmtPx(live)}` : ''}`}>
      <span className="relative block h-1.5 rounded-full" style={{ background: 'linear-gradient(to left, var(--up) 0%, var(--up) 100%)', opacity: 0.9 }}>
        <span className="absolute top-[-2px] h-[10px] w-[2px]" style={{ right: `${entryPct}%`, background: '#0ea5e9' }} title={`دخول ${fmtPx(entry)}`} />
        {livePct != null && (
          <span className="absolute top-[-3px] h-[12px] w-[2px]" style={{ right: `${livePct}%`, background: 'var(--text-1)' }} title={`السعر الحي ${fmtPx(live)}`} />
        )}
      </span>
    </span>
  );
}

type Tab = 'feed' | 'directions' | 'tracking' | 'dashboard' | 'rejected';

/* ذاكرة الواجهة محلياً: التبويب والفلاتر والفرز — استمرارية الجلسة */
const UI_KEY = 'strategy2-ui-v1';
function loadUI(): Record<string, string> {
  try {
    const raw = JSON.parse(localStorage.getItem(UI_KEY) ?? '{}');
    return raw && typeof raw === 'object' ? raw : {};
  } catch { return {}; }
}

const PRESETS: { id: string; label: string; hint: string }[] = [
  { id: 'all', label: 'الكل', hint: 'إظهار كل الفرص النشطة' },
  { id: 'qualified', label: 'مؤكدة', hint: 'الشريحة المؤهلة إحصائياً فقط' },
  { id: 'near', label: 'قريبة من الدخول', hint: 'مرتبة بالأقرب للهدف الأول' },
  { id: 'rr', label: 'عالية R:R', hint: 'مرتبة بأعلى مخاطرة/عائد' },
  { id: 'up', label: 'HTF صاعد', hint: 'الاتجاه الأكبر صاعد فقط' },
  { id: 'attention', label: 'تحتاج انتباه', hint: 'مؤهلة + قريبة + مكتملة الشروط' }
];

export default function StrategyScreen() {
  const savedUI = useMemo(loadUI, []);
  const [tab, setTab] = useState<Tab>((savedUI.tab as Tab) || 'feed');
  const [feed, setFeed] = useState<Strategy2Feed | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const pulse = useStore(s => s.strategy2Pulse);
  const openChart = useStore(s => s.openChart);

  // فلاتر خادمية (+preset)
  const [symbol, setSymbol] = useState(savedUI.symbol ?? '');
  const [tf, setTf] = useState(savedUI.tf ?? '');
  const [model, setModel] = useState(savedUI.model ?? '');
  const [tier, setTier] = useState(savedUI.tier ?? '');
  const [htfDir, setHtfDir] = useState(savedUI.htfDir ?? '');
  const [sort, setSort] = useState(savedUI.sort ?? 'recent');
  const [preset, setPreset] = useState('all');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [drawerIdx, setDrawerIdx] = useState<number | null>(null);
  const [rejReason, setRejReason] = useState('');
  const debounceRef = useRef<number | null>(null);
  const [symbolInput, setSymbolInput] = useState(savedUI.symbol ?? '');

  // ═══ سجل الاتجاهات الحي ═══
  const [dirData, setDirData] = useState<Strategy2DirectionsResponse | null>(null);
  const [dirLoading, setDirLoading] = useState(false);
  const [dirError, setDirError] = useState<string | null>(null);
  const [dirSymbolInput, setDirSymbolInput] = useState('');
  const [dirSymbol, setDirSymbol] = useState('');
  const [dirTf, setDirTf] = useState(savedUI.dirTf ?? '1m');
  const [dir, setDir] = useState('');
  const [dirStage, setDirStage] = useState('');
  const [dirDead, setDirDead] = useState('');
  const [dirAgreement, setDirAgreement] = useState('');
  const [dirSort, setDirSort] = useState('symbol');
  const [dirExpanded, setDirExpanded] = useState<string | null>(null);
  const [hideVolatile, setHideVolatile] = useState(false);

  // حفظ التفضيلات محلياً
  useEffect(() => {
    try {
      localStorage.setItem(UI_KEY, JSON.stringify({ tab, symbol, tf, model, tier, htfDir, sort, dirTf }));
    } catch { /* التخزين اختياري */ }
  }, [tab, symbol, tf, model, tier, htfDir, sort, dirTf]);

  const loadDirections = useCallback(async (silent = false) => {
    if (!silent) setDirLoading(true);
    try {
      setDirError(null);
      setDirData(await api.getStrategy2Directions({
        symbol: dirSymbol || undefined, tf: dirTf || undefined, dir: dir || undefined, stage: dirStage || undefined,
        dead: dirDead || undefined, agreement: dirAgreement || undefined,
        sort: dirSort || undefined, limit: 500
      }));
    } catch (e) {
      setDirError(e instanceof Error ? e.message : 'فشل جلب الاتجاهات');
    } finally {
      setDirLoading(false);
    }
  }, [dirSymbol, dirTf, dir, dirStage, dirDead, dirAgreement, dirSort]);

  useEffect(() => { if (tab === 'directions') void loadDirections(); }, [tab, loadDirections]);
  // نبضات الاتجاهات عبر WS — إعادة جلب صامتة (debounce 1 ث) + احتياطي 30 ث
  // تُعاد القراءة فقط عند نبضات الاتجاهات/النشر/الحسم — نبضات tick الثانية لا تمس هذا السجل
  const dirDebounceRef = useRef<number | null>(null);
  useEffect(() => {
    if (tab !== 'directions' || !pulse) return;
    if (!['strategy2_directions', 'new', 'closed', 'central_notification'].includes(pulse.kind)) return;
    if (dirDebounceRef.current) window.clearTimeout(dirDebounceRef.current);
    dirDebounceRef.current = window.setTimeout(() => { void loadDirections(true); }, 1000);
    return () => { if (dirDebounceRef.current) window.clearTimeout(dirDebounceRef.current); };
  }, [pulse, tab, loadDirections]);
  useEffect(() => {
    if (tab !== 'directions') return;
    const id = window.setInterval(() => { void loadDirections(true); }, 30_000);
    return () => window.clearInterval(id);
  }, [tab, loadDirections]);
  // بحث الرمز في تبويب الاتجاهات مؤجل
  useEffect(() => {
    const id = window.setTimeout(() => setDirSymbol(dirSymbolInput.trim().toUpperCase()), 400);
    return () => window.clearTimeout(id);
  }, [dirSymbolInput]);

  // خريطة الاتجاهات الحية — مطابقة رمز+فريم لتلوين عمود الاتجاه لحظياً
  const dirBySymbol = useMemo(() => {
    const m = new Map<string, Strategy2DirectionRow>();
    for (const d of dirData?.directions ?? []) m.set(`${d.symbol}|${d.tf ?? '1m'}`, d);
    return m;
  }, [dirData]);

  const exportDirectionsCsv = useCallback(() => {
    const rows = dirData?.directions ?? [];
    const header = ['symbol', 'tf', 'dir', 'dirTF', 'dirHTF', 'agreement', 'stage', 'afterPremium', 'externalNext', 'distPct', 'deathLevel', 'dead', 'discountLevel', 'price', 'since', 'changeCount'];
    const lines = [header.join(',')];
    for (const d of rows) {
      lines.push([d.symbol, d.tf ?? '1m', d.dir, d.dirTF ?? d.dir1m ?? '', d.dirHTF ?? d.dir40m ?? '', d.agreement,
        `"${d.stage.replace(/"/g, '""')}"`,
        d.afterPremium == null ? '' : (d.afterPremium ? 'yes' : 'no'),
        d.externalNext ?? '', d.distToExternalPct ?? '', d.deathLevel ?? '',
        d.dead ? 'yes' : 'no', d.discountLevel ?? '', d.price ?? '',
        d.since ? new Date(d.since).toISOString() : '', d.changeCount].join(','));
    }
    const blob = new Blob(['\ufeff' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'strategy2-directions.csv';
    a.click();
    URL.revokeObjectURL(a.href);
  }, [dirData]);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      setError(null);
      setFeed(await api.getStrategy2Feed({
        symbol: symbol || undefined, tf: tf || undefined,
        model: model || undefined, tier: tier || undefined,
        htfDir: htfDir || undefined, sort: sort === 'completeness' || sort === 'attention' ? 'recent' : (sort || undefined), limit: 200
      }));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'فشل جلب البيانات');
    } finally {
      setLoading(false);
    }
  }, [symbol, tf, model, tier, htfDir, sort]);

  useEffect(() => { void load(); }, [load]);
  // نبضات WS — إعادة جلب صامتة (debounce 1.2 ث) + احتياطي 30 ث
  // تخطي نبضات tick والاتجاهات: بياناتها حية أصلاً في المخزن — إعادة الجلب الكامل كل ثانية هدر بلا فائدة
  useEffect(() => {
    if (!pulse || pulse.kind === 'strategy2_tick' || pulse.kind === 'strategy2_directions') return;
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

  // الفرز المحايد على العميل (الاكتمال/الانتباه) — الخادم يرتب البقية
  const opps = useMemo(() => {
    const rows = [...(feed?.opportunities ?? [])];
    if (sort === 'completeness') rows.sort((a, b) => (completenessOf(b) ?? -1) - (completenessOf(a) ?? -1) || b.detectedAt - a.detectedAt);
    else if (sort === 'attention') rows.sort((a, b) => attentionOf(b).score - attentionOf(a).score || b.detectedAt - a.detectedAt);
    return rows;
  }, [feed?.opportunities, sort]);
  const decided = (feed?.stats.wins ?? 0) + (feed?.stats.losses ?? 0);
  const liveWr = feed?.stats.liveWinRate;
  const waitingTop = useMemo(() =>
    Object.entries(feed?.waitingPhases ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 8),
    [feed?.waitingPhases]);
  const rejectedGroups = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of feed?.rejected ?? []) m.set(r.reason, (m.get(r.reason) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [feed?.rejected]);
  const rejectedShown = useMemo(() =>
    (feed?.rejected ?? []).filter(r => !rejReason || r.reason === rejReason),
    [feed?.rejected, rejReason]);
  const deadRejected = (feed?.rejected ?? []).filter(r => String(r.reason ?? '').includes('المشوار')).length;
  const pulseLive = pulse != null && Date.now() - pulse.at < 8000;

  const applyPreset = (id: string) => {
    setPreset(id);
    if (id === 'all') { setSymbol(''); setSymbolInput(''); setTf(''); setModel(''); setTier(''); setHtfDir(''); setSort('recent'); }
    else if (id === 'qualified') setTier('qualified');
    else if (id === 'near') setSort('distance');
    else if (id === 'rr') setSort('rr');
    else if (id === 'up') setHtfDir('up');
    else if (id === 'attention') setSort('attention');
  };
  const touchFilter = () => setPreset('custom');

  const jumpToDirections = (sym: string) => {
    setTab('directions');
    setDirSymbolInput(sym);
  };

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
  const drawerOpp = drawerIdx != null ? opps[drawerIdx] ?? null : null;

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
            <span className="text-[11px] flex items-center gap-1.5" style={{ color: 'var(--text-3)' }} title="المحرك يعمل لحظياً عبر WebSocket بلا مسح يدوي — كل إغلاق شمعة يُحلَّل فوراً">
              <span className="inline-block w-2 h-2 rounded-full" style={{ background: pulseLive ? 'var(--up)' : 'var(--text-3)' }} />
              {pulseLive ? 'بث حي' : 'بانتظار النبض'}
            </span>
            <button
              onClick={() => void api.runStrategy2Calibration().then(() => load(true))}
              disabled={cal?.busy}
              className="btn text-[12px]"
              title={!cal?.at && !cal?.busy ? 'المعايرة لم تشتغل بعد — الإشارات حالياً بلا تصفية إحصائية' : 'إعادة تشغيل المعايرة الإحصائية'}
              style={{
                opacity: cal?.busy ? 0.5 : 1,
                ...(!cal?.at && !cal?.busy
                  ? { border: '2px solid var(--warn)', fontWeight: 800 }
                  : {})
              }}
            >تشغيل المعايرة{!cal?.at && !cal?.busy ? ' ⚠' : ''}</button>
          </div>
        </div>

        {/* ماذا يحدث الآن؟ */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-3">
          <Stat label="فرص نشطة الآن" value={String(feed?.total ?? 0)} highlight={(feed?.total ?? 0) > 0} />
          <Stat label="آخر نشر" value={opps[0] ? `${opps[0].symbol} ${opps[0].tf} (منذ ${ago(opps[0].detectedAt)})` : '—'} />
          <Stat label="آخر حدث مرفوض" value={feed?.rejected?.[0] ? feed.rejected[0].reason.slice(0, 42) : '—'} />
          <Stat label="الدورة / التحديث" value={feed ? `#${feed.cycle} · ${feed.updatedAt ? ago(feed.updatedAt) : '—'}` : '—'} />
        </div>

        {/* شرائط الحالة */}
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-2 mt-2">
          <Stat label="الدورة" value={String(feed?.cycle ?? 0)} />
          <Stat label="أزواج النطاق" value={String(feed?.pairsTotal ?? 0)} />
          <Stat label="فرص منشورة" value={String(feed?.total ?? 0)} highlight />
          <Stat label="حُسمت" value={`${feed?.stats.wins ?? 0}/${decided}`} />
          <Stat label="نسبة النجاح الحية" value={liveWr != null ? pct(liveWr) : '—'} highlight={liveWr != null && liveWr >= 0.6} />
          <Stat label="استعادة/تسوية" value={`${feed?.stats.restored ?? 0}/${feed?.stats.reconciled ?? 0}`} />
          <Stat label="آخر تحديث" value={feed?.updatedAt ? ago(feed.updatedAt) : '—'} />
        </div>
        <div className="text-[11px] mt-1.5" style={{ color: 'var(--text-3)' }} title="سجل الاتجاهات يُبنى من إغلاقات الشموع لكل فريم، فيكتمل تدريجياً بعد كل إقلاع وقد يكون أقل من النطاق مؤقتاً">
          أزواج النطاق تُفحص دورياً؛ وسجل الاتجاهات يكتمل تدريجياً بعد الإقلاع فقد يكون أقل مؤقتاً.
        </div>
        {(feed?.busy) && <div className="text-[11px] mt-2" style={{ color: 'var(--warn)' }}>دورة فحص جارية…</div>}
        {feed?.error && <div className="text-[11px] mt-2" style={{ color: 'var(--down)' }}>خطأ: {feed.error}</div>}
        {feed?.failures.length ? (
          <div className="text-[11px] mt-2" style={{ color: 'var(--warn)' }}>
            <span>تعذر جلب {feed.failures.length} رمزاً غير مدعوم في المنطقة — البيانات المعروضة لما تبقى فقط.</span>
            <details className="mt-1">
              <summary className="cursor-pointer" style={{ color: 'var(--text-3)' }}>تفاصيل تقنية ({feed.failures.length})</summary>
              <div className="mt-1 space-y-0.5">
                {feed.failures.slice(0, 12).map(f => {
                  const fr = friendlyFailure(f);
                  return <div key={f.key}>{fr.symbol} — {fr.reason} (×{f.count})</div>;
                })}
                {feed.failures.length > 12 ? <div>… +{feed.failures.length - 12} أخرى</div> : null}
              </div>
            </details>
          </div>
        ) : null}

        {/* المعايرة — تحذير بارز قبل أول معايرة: النشر مفتوح بلا تصفية إحصائية */}
        {!cal?.at && !cal?.busy ? (
          <div className="mt-3 p-2.5 rounded-lg text-[12px] font-bold" style={{ background: 'var(--surface-1)', border: '2px solid var(--warn)', color: 'var(--text-1)' }}>
            ⚠ المعايرة لم تشتغل بعد — أي فرصة منشورة حالياً بلا تصفية إحصائية (tier فارغ). شغّل «تشغيل المعايرة» أولاً قبل الاعتماد على الإشارات.
          </div>
        ) : null}
        <div className="mt-3 flex flex-wrap items-center gap-3 text-[11.5px]" style={{ color: 'var(--text-3)' }}>
          <span>
            المعايرة: {cal?.busy
              ? `جارٍ ${cal.progress?.done ?? 0}/${cal.progress?.total ?? 0}`
              : cal?.at ? `${cal.trades} صفقة · ${qualifiedSegs} مؤهلة · ${probationarySegs} تجريبية (${ago(cal.at)})` : 'لم تشتغل بعد'}
          </span>
          <span>بوابة النشر: {qualifiedSegs + probationarySegs > 0 ? 'شرائح مؤهلة/تجريبية معايَرة' : 'شريحة غير معايَرة → نشر مفتوح حتى اكتمال المعايرة الأولى'}</span>
        </div>
      </div>

      {/* التبويبات — عدّاد الاتجاهات (…) قبل أول جلب حتى لا يوحي بالفراغ */}
      <div className="flex gap-1.5 flex-wrap">
        {([['feed', `الفرص (${opps.length})`], ['directions', `الاتجاهات (${dirData ? dirData.summary.total : '…'})`], ['tracking', 'قيد التتبع'], ['dashboard', 'لوحة التحكم'], ['rejected', `المرفوضة (${feed?.rejected.length ?? 0})`]] as [Tab, string][]).map(([t, label]) => (
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

      {/* ═══ تبويب الفرص ═══ */}
      {tab === 'feed' && (
        <div className="space-y-3">
          {/* وجهات نظر جاهزة */}
          <div className="card p-3 flex flex-wrap items-center gap-2">
            {PRESETS.map(p => (
              <button key={p.id} onClick={() => applyPreset(p.id)} title={p.hint} className="text-[12px] font-semibold px-3 py-1.5 rounded-lg"
                style={{
                  background: preset === p.id ? 'var(--accent-soft)' : 'var(--surface-1)',
                  color: preset === p.id ? 'var(--accent)' : 'var(--text-2)',
                  border: '1px solid var(--border-1)'
                }}>{p.label}</button>
            ))}
            {preset === 'custom' && <span className="text-[11px]" style={{ color: 'var(--text-3)' }}>عرض مخصص</span>}
          </div>

          <div className="card p-3 flex flex-wrap items-center gap-2">
            <input
              value={symbolInput}
              onChange={e => { setSymbolInput(e.target.value); touchFilter(); }}
              placeholder="بحث رمز…"
              className="text-[12px] px-2.5 py-1.5 rounded-lg w-28"
              style={{ background: 'var(--surface-0)', border: '1px solid var(--border-1)', color: 'var(--text-1)' }}
            />
            <select value={tf} onChange={e => { setTf(e.target.value); touchFilter(); }} className="text-[12px] px-2 py-1.5 rounded-lg" style={{ background: 'var(--surface-0)', border: '1px solid var(--border-1)', color: 'var(--text-1)' }}>
              <option value="">كل الفريمات</option>
              {['1m', '5m', '15m'].map(f => <option key={f} value={f}>{f}</option>)}
            </select>
            <select value={model} onChange={e => { setModel(e.target.value); touchFilter(); }} className="text-[12px] px-2 py-1.5 rounded-lg" style={{ background: 'var(--surface-0)', border: '1px solid var(--border-1)', color: 'var(--text-1)' }}>
              <option value="">النموذجان</option>
              <option value="1">نموذج 1 — سويب + choch up</option>
              <option value="2">نموذج 2 — إخراج مبكرين + ابتلاع</option>
            </select>
            <select value={tier} onChange={e => { setTier(e.target.value); touchFilter(); }} className="text-[12px] px-2 py-1.5 rounded-lg" style={{ background: 'var(--surface-0)', border: '1px solid var(--border-1)', color: 'var(--text-1)' }}>
              <option value="">كل الطبقات</option>
              <option value="qualified">مؤهلة</option>
              <option value="probationary">تحت التجربة</option>
            </select>
            <select value={htfDir} onChange={e => { setHtfDir(e.target.value); touchFilter(); }} className="text-[12px] px-2 py-1.5 rounded-lg" style={{ background: 'var(--surface-0)', border: '1px solid var(--border-1)', color: 'var(--text-1)' }}>
              <option value="">كل اتجاهات HTF</option>
              <option value="up">صاعد</option>
              <option value="down">هابط</option>
              <option value="range">عرضي</option>
            </select>
            <select value={sort} onChange={e => { setSort(e.target.value); touchFilter(); }} className="text-[12px] px-2 py-1.5 rounded-lg" style={{ background: 'var(--surface-0)', border: '1px solid var(--border-1)', color: 'var(--text-1)' }} title="الاكتمال والانتباه فرز محايد على العميل من التسلسل">
              <option value="recent">الأحدث</option>
              <option value="completeness">الأكثر اكتمالاً</option>
              <option value="attention">تحتاج انتباه</option>
              <option value="rr">أعلى R:R</option>
              <option value="distance">الأقرب للهدف</option>
            </select>
            <span className="text-[11px] num" style={{ color: 'var(--text-3)' }}>
              {opps.length}{feed?.filtered ? ` (مفلترة من ${feed.total})` : ''} صف
            </span>
          </div>

          {/* بطاقات الهاتف */}
          <div className="space-y-2 md:hidden">
            {opps.map((o, i) => <OppCard key={o.id} o={o} liveDir={dirBySymbol.get(`${o.symbol}|${o.tf}`)} onDetail={() => setDrawerIdx(i)} onChart={() => openChart(o.symbol, o.tf, null, oppLevels(o))} />)}
          </div>

          <div className="card overflow-hidden hidden md:block">
            <div className="overflow-x-auto">
              <table className="w-full text-[12px]" style={{ borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--border-1)', background: 'var(--surface-0)' }}>
                    {['الفرصة', 'الاتجاه', 'الدخول والموقع', 'الأهداف', 'R:R', 'الحالة', 'العمر', ''].map(h => (
                      <th key={h} className="text-right px-2.5 py-2 font-bold whitespace-nowrap" style={{ color: 'var(--text-2)' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {opps.map((o, i) => (
                    <OppRow key={o.id} o={o} liveDir={dirBySymbol.get(`${o.symbol}|${o.tf}`)}
                      expanded={expandedId === o.id}
                      onToggle={() => setExpandedId(expandedId === o.id ? null : o.id)}
                      onDetail={() => setDrawerIdx(i)}
                      onChart={() => openChart(o.symbol, o.tf, null, oppLevels(o))}
                      onJumpDirections={jumpToDirections} />
                  ))}
                </tbody>
              </table>
            </div>
            {opps.length === 0 && !loading && (
              <div className="py-8 px-4">
                <div className="text-center text-[13px] font-bold mb-3" style={{ color: 'var(--text-1)' }}>
                  {feed && feed.stats.published > 0
                    ? 'لا فرص نشطة الآن — كل المنشورة حُسمت، والمحرك يراقب باستمرار.'
                    : 'لا فرص منشورة بعد — المحرك يراقب ويرصد تكوّن القمم/القيعان المحمية لحظياً.'}
                </div>
                {/* لوحة تفسير الفراغ الكاملة: أسباب الرفض + الموت + الانتظار */}
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-[12px]">
                  <div className="rounded-lg p-3" style={{ background: 'var(--surface-0)', border: '1px solid var(--border-1)' }}>
                    <div className="font-bold mb-1.5" style={{ color: 'var(--text-1)' }}>لماذا لا توجد فرص؟ ({rejectedGroups.length} أسباب)</div>
                    {rejectedGroups.length === 0
                      ? <span style={{ color: 'var(--text-3)' }}>لا رفض مسجل — الشروط لم تكتمل بعد.</span>
                      : rejectedGroups.slice(0, 4).map(([reason, n]) => (
                        <div key={reason} className="flex justify-between gap-2 py-0.5" style={{ color: 'var(--text-2)' }}>
                          <span className="truncate" title={reason}>{reason}</span>
                          <b className="num" style={{ color: 'var(--accent)' }}>{n}</b>
                        </div>
                      ))}
                  </div>
                  <div className="rounded-lg p-3" style={{ background: 'var(--surface-0)', border: '1px solid var(--border-1)' }}>
                    <div className="font-bold mb-1.5" style={{ color: 'var(--text-1)' }}>الحماية النشطة</div>
                    <div style={{ color: 'var(--text-2)' }}>
                      {deadRejected > 0
                        ? <>أُسقطت <b className="num" style={{ color: 'var(--warn)' }}>{deadRejected}</b> إشارة لموت المشوار (بلوغ العرض الخارجي) — حماية لا غياب إشارات.</>
                        : 'لا إسقاط بموت المشوار حالياً.'}
                    </div>
                  </div>
                  <div className="rounded-lg p-3" style={{ background: 'var(--surface-0)', border: '1px solid var(--border-1)' }}>
                    <div className="font-bold mb-1.5" style={{ color: 'var(--text-1)' }}>ماذا ينتظر المحرك؟</div>
                    {waitingTop.length === 0
                      ? <span style={{ color: 'var(--text-3)' }}>بانتظار أول دورة مسح.</span>
                      : waitingTop.slice(0, 3).map(([phase, count]) => (
                        <div key={phase} className="flex justify-between gap-2 py-0.5" style={{ color: 'var(--text-2)' }}>
                          <span className="truncate" title={phase}>{phase}</span>
                          <b className="num" style={{ color: 'var(--accent)' }}>{count}</b>
                        </div>
                      ))}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ═══ تبويب الاتجاهات: سجل حي لكل العملات ═══ */}
      {tab === 'directions' && (
        <div className="space-y-3">
          {/* الملخص العلوي — شرائح نقرتُها تفلتر الجدول */}
          <div className="card p-3 flex flex-wrap items-center gap-2">
            {(['1m', '5m', '15m'] as const).map(f => (
              <DirChip key={f} label={f} active={dirTf === f} onClick={() => setDirTf(f)} color="var(--accent)" />
            ))}
            <span className="text-[11px]" style={{ color: 'var(--text-3)' }}>← الفريم (والأكبر ×8 تلقائياً)</span>
            <span className="w-2" />
            <DirChip label={`الكل (${dirData?.summary.total ?? 0})`} active={!dir && !dirDead && !dirAgreement} onClick={() => { setDir(''); setDirDead(''); setDirAgreement(''); }} color="var(--text-2)" />
            <DirChip label={`صاعد (${dirData?.summary.up ?? 0})`} active={dir === 'up'} onClick={() => setDir(dir === 'up' ? '' : 'up')} color="var(--up)" />
            <DirChip label={`هابط (${dirData?.summary.down ?? 0})`} active={dir === 'down'} onClick={() => setDir(dir === 'down' ? '' : 'down')} color="var(--down)" />
            <DirChip label={`عرضي (${dirData?.summary.range ?? 0})`} active={dir === 'range'} onClick={() => setDir(dir === 'range' ? '' : 'range')} color="var(--text-2)" />
            <DirChip label={`متعارض (${dirData?.summary.conflicted ?? 0})`} active={dirAgreement === 'conflicted'} onClick={() => setDirAgreement(dirAgreement === 'conflicted' ? '' : 'conflicted')} color="var(--warn)" />
            <DirChip label={`مشوار مات (${dirData?.summary.dead ?? 0})`} active={dirDead === '1'} onClick={() => setDirDead(dirDead === '1' ? '' : '1')} color="var(--warn)" />
            <span className="text-[11px] num mr-auto" style={{ color: 'var(--text-3)' }}>
              {dirData ? `آخر تحديث ${ago(dirData.updatedAt)}` : ''}
            </span>
          </div>

          {/* فلاتر خادمة */}
          <div className="card p-3 flex flex-wrap items-center gap-2">
            <input
              value={dirSymbolInput}
              onChange={e => setDirSymbolInput(e.target.value)}
              placeholder="بحث رمز…"
              className="text-[12px] px-2.5 py-1.5 rounded-lg w-28"
              style={{ background: 'var(--surface-0)', border: '1px solid var(--border-1)', color: 'var(--text-1)' }}
            />
            <select value={dirStage} onChange={e => setDirStage(e.target.value)} className="text-[12px] px-2 py-1.5 rounded-lg" style={{ background: 'var(--surface-0)', border: '1px solid var(--border-1)', color: 'var(--text-1)' }}>
              <option value="">كل المراحل</option>
              {Object.entries(dirData?.summary.stages ?? {}).sort((a, b) => b[1] - a[1]).map(([ph, c]) => (
                <option key={ph} value={ph}>{ph} ({c})</option>
              ))}
            </select>
            <select value={dirAgreement} onChange={e => setDirAgreement(e.target.value)} className="text-[12px] px-2 py-1.5 rounded-lg" style={{ background: 'var(--surface-0)', border: '1px solid var(--border-1)', color: 'var(--text-1)' }}>
              <option value="">كل التوافقات</option>
              <option value="confirmed">مؤكد (الفريم + الأكبر)</option>
              <option value="conflicted">متعارض</option>
              <option value="single">الفريم فقط</option>
            </select>
            <select value={dirDead} onChange={e => setDirDead(e.target.value)} className="text-[12px] px-2 py-1.5 rounded-lg" style={{ background: 'var(--surface-0)', border: '1px solid var(--border-1)', color: 'var(--text-1)' }}>
              <option value="">حالة المشوار: الكل</option>
              <option value="0">حي</option>
              <option value="1">مات</option>
            </select>
            <select value={dirSort} onChange={e => setDirSort(e.target.value)} className="text-[12px] px-2 py-1.5 rounded-lg" style={{ background: 'var(--surface-0)', border: '1px solid var(--border-1)', color: 'var(--text-1)' }}>
              <option value="symbol">رمزياً</option>
              <option value="recent">آخر تغيّر</option>
              <option value="changes">الأكثر تغيّراً</option>
              <option value="distance">الأقرب للعرض الخارجي</option>
            </select>
            <button onClick={exportDirectionsCsv} className="btn text-[12px]">تصدير CSV</button>
            <label className="flex items-center gap-1.5 text-[12px] cursor-pointer" style={{ color: 'var(--text-2)' }} title={`إخفاء الرموز ذات ${VOLATILE_CHANGES}+ انقلاباً منذ الإقلاع (ضجيج فريم الدقيقة)`}>
              <input type="checkbox" checked={hideVolatile} onChange={e => setHideVolatile(e.target.checked)} />
              إخفاء كثيرة التقلب (≥{VOLATILE_CHANGES})
            </label>
            <span className="text-[11px] num" style={{ color: 'var(--text-3)' }}>
              {(dirData?.directions.filter(d => !hideVolatile || (d.changeCount ?? 0) < VOLATILE_CHANGES).length ?? 0)}{dirData?.filtered ? ` (مفلترة من ${dirData.total})` : ''} صف
            </span>
          </div>

          {dirError && <div className="card p-4 text-[12px]" style={{ color: 'var(--down)' }}>{dirError}</div>}
          {dirLoading && !dirData && <div className="card p-4 text-[12px]" style={{ color: 'var(--text-3)' }}>جارٍ جلب سجل الاتجاهات…</div>}

          {/* الجدول الكامل */}
          <div className="card overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-[12px]" style={{ borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--border-1)', background: 'var(--surface-0)' }}>
                    {['الرمز', 'الفريم', 'الحاكم (×8)', 'الأساسي', 'التوافق', 'المرحلة', 'المرساة المحمية', 'بعد بريميوم؟', 'العرض الخارجي التالي', 'المسافة', 'منذ متى', 'تغيّرات', 'الشارت'].map(h => (
                      <th key={h} className="text-right px-2.5 py-2 font-bold whitespace-nowrap" style={{ color: 'var(--text-2)' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {(dirData?.directions ?? []).filter(d => !hideVolatile || (d.changeCount ?? 0) < VOLATILE_CHANGES).map(d => (
                    <DirRow
                      key={`${d.symbol}|${d.tf ?? '1m'}`} d={d}
                      expanded={dirExpanded === `${d.symbol}|${d.tf ?? '1m'}`}
                      onToggle={() => setDirExpanded(dirExpanded === `${d.symbol}|${d.tf ?? '1m'}` ? null : `${d.symbol}|${d.tf ?? '1m'}`)}
                      onChart={() => openChart(d.symbol, d.tf ?? '1m', null, dirLevels(d))}
                    />
                  ))}
                </tbody>
              </table>
            </div>
            {dirData && dirData.directions.length === 0 && !dirLoading && (
              <div className="py-10 text-center text-[12.5px]" style={{ color: 'var(--text-3)' }}>
                لا صفوف — المحرك يكوّن سجل الاتجاهات من إغلاقات الشموع (تكتمل اللقطة بعد أول دورة).
              </div>
            )}
          </div>
          <div className="text-[11px] px-1" style={{ color: 'var(--text-3)' }}>
            اتجاه كل عملة حاكم من بنية فريمها الأكبر (×8)، والتوافق من الفريم الثاني عند توفره. آلة المراحل: صاعد ← تعدي bsl؟ نعم: ديسكاونت + ssl / لا: ديسكاونت فقط ← ثم بانتظار تأكيد الدخول · هابط: رصد نهاية الهبوط · عرضي: رصد تكوّن هيكل. انقر صف لسجل انتقالاته.
          </div>
        </div>
      )}

      {/* ═══ تبويب قيد التتبع: مراحل الانتظار + ما الذي ننتظره ═══ */}
      {tab === 'tracking' && (
        <div className="space-y-3">
          <div className="card p-4">
            <div className="text-[13px] font-bold mb-2" style={{ color: 'var(--text-1)' }}>ما الذي ينتظره المحرك؟ (آخر دورة)</div>
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
            {dirData && Object.keys(dirData.summary.stages ?? {}).length > 0 && (
              <div className="mt-3 pt-2" style={{ borderTop: '1px solid var(--border-1)' }}>
                <div className="text-[12px] font-bold mb-1.5" style={{ color: 'var(--text-1)' }}>مراحل الاتجاهات ({dirData.summary.total} عملة)</div>
                <div className="flex flex-wrap gap-1.5">
                  {Object.entries(dirData.summary.stages).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([st, n]) => (
                    <span key={st} className="text-[11px] px-2 py-0.5 rounded-full" style={{ background: 'var(--surface-0)', border: '1px solid var(--border-1)', color: 'var(--text-2)' }} title={st}>{st.length > 34 ? `${st.slice(0, 34)}…` : st}: <b className="num">{n}</b></span>
                  ))}
                </div>
              </div>
            )}
            <div className="text-[11px] mt-3" style={{ color: 'var(--text-3)' }}>
              مسار القمة المحمية بخطواتها الخمس: سويب BSL ← كسر قاع فرعي ← sellers induced (اختياري) ← ssl sweep (اختياري) ← عودة + نموذج بيعي.
              فشل الدخول الموثق: سويب ssl ← صعود ← سويب bsl ← كسر قاع السويب.
            </div>
          </div>
          <div className="card p-4">
            <div className="text-[13px] font-bold mb-2" style={{ color: 'var(--text-1)' }}>ذاكرة التتبع المستمر للشارت (CSSE) — حية لكل (رمز|فريم)</div>
            {(() => {
              const csse = feed?.csse;
              if (!csse) return <div className="text-[12px]" style={{ color: 'var(--text-3)' }}>لا بيانات تتبع بعد — تظهر بعد أول دورة مسح.</div>;
              const labels: Record<string, string> = { WAIT: 'انتظار', OPPORTUNITY: 'فرصة منشورة', CONFIRMED: 'إشارة مؤكدة', RESOLVED: 'محسومة', INVALIDATED: 'ملغاة' };
              const entries = Object.entries(csse.setups ?? {}).sort((a, b) => b[1] - a[1]);
              return (
                <div>
                  <div className="text-[12px] mb-2" style={{ color: 'var(--text-2)' }}>حالات مُتتبعة: <b className="num" style={{ color: 'var(--accent)' }}>{csse.tracked}</b></div>
                  <div className="flex flex-wrap gap-1.5">
                    {entries.length === 0
                      ? <span className="text-[12px]" style={{ color: 'var(--text-3)' }}>لا حالات بعد.</span>
                      : entries.map(([st, n]) => (
                        <span key={st} className="text-[11px] px-2 py-0.5 rounded-full font-semibold" style={{ background: 'var(--surface-0)', border: '1px solid var(--border-1)', color: 'var(--text-2)' }}>{labels[st] ?? st}: <b className="num">{n}</b></span>
                      ))}
                  </div>
                </div>
              );
            })()}
            <div className="text-[11px] mt-3" style={{ color: 'var(--text-3)' }}>
              كل حالة تحمل عناصر الشارت بهويات حتمية (تبقى بعد إعادة التشغيل) + قائمة تسلسل ما تحقق وما لم يتحقق — تُعرض القائمة لكل فرصة في تبويب الفرص.
            </div>
          </div>
          <div className="card p-4">
            <div className="text-[13px] font-bold mb-2" style={{ color: 'var(--text-1)' }}>فشل جلب البيانات (شفافية كاملة — لا فشل صامت)</div>
            {feed?.failures.length
              ? (
                <div className="text-[12px]" style={{ color: 'var(--text-2)' }}>
                  <span>{feed.failures.length} رمزاً غير مدعوم في المنطقة — تُفحص بقية الرموز بنجاح.</span>
                  <details className="mt-2">
                    <summary className="cursor-pointer text-[11.5px]" style={{ color: 'var(--text-3)' }}>تفاصيل تقنية</summary>
                    <div className="mt-1 space-y-1">
                      {feed.failures.map(f => {
                        const fr = friendlyFailure(f);
                        return (
                          <div key={f.key} className="flex items-center gap-2 text-[11.5px]">
                            <span className="num font-bold" style={{ color: 'var(--warn)' }}>{f.count}×</span>
                            <span className="num" style={{ color: 'var(--text-2)' }}>{fr.symbol}</span>
                            <span style={{ color: 'var(--text-3)' }}>{fr.reason}</span>
                          </div>
                        );
                      })}
                    </div>
                  </details>
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

      {/* ═══ تبويب المرفوضة: إحصاءات + فلترة + قائمة ═══ */}
      {tab === 'rejected' && (
        <div className="space-y-3">
          <div className="card p-4">
            <div className="text-[13px] font-bold mb-2" style={{ color: 'var(--text-1)' }}>أسباب الرفض مجمعة ({rejectedGroups.length})</div>
            {rejectedGroups.length === 0
              ? <div className="text-[12px]" style={{ color: 'var(--text-3)' }}>لا مرفوضات حديثة.</div>
              : (
                <div className="flex flex-wrap gap-1.5">
                  <button onClick={() => setRejReason('')} className="text-[11.5px] px-2.5 py-1 rounded-full font-semibold"
                    style={{ background: !rejReason ? 'var(--accent-soft)' : 'var(--surface-0)', color: !rejReason ? 'var(--accent)' : 'var(--text-2)', border: '1px solid var(--border-1)' }}>
                    الكل ({feed?.rejected.length ?? 0})
                  </button>
                  {rejectedGroups.map(([reason, n]) => (
                    <button key={reason} onClick={() => setRejReason(rejReason === reason ? '' : reason)} title={reason} className="text-[11.5px] px-2.5 py-1 rounded-full font-semibold"
                      style={{ background: rejReason === reason ? 'var(--accent-soft)' : 'var(--surface-0)', color: rejReason === reason ? 'var(--accent)' : 'var(--text-2)', border: '1px solid var(--border-1)' }}>
                      {reason.length > 40 ? `${reason.slice(0, 40)}…` : reason} ({n})
                    </button>
                  ))}
                </div>
              )}
          </div>
          <div className="card p-4">
            <div className="text-[13px] font-bold mb-2" style={{ color: 'var(--text-1)' }}>الفرص التي لم تجتز البوابات — بسبب صريح لكل واحدة</div>
            {rejectedShown.length === 0
              ? <div className="text-[12px]" style={{ color: 'var(--text-3)' }}>لا مرفوضات {rejReason ? 'بهذا السبب' : 'حديثة'}.</div>
              : (
                <div className="space-y-1">
                  {rejectedShown.map((r, i) => (
                    <div key={`${r.at}-${i}`} className="text-[11.5px] flex flex-wrap gap-2 items-baseline" style={{ borderBottom: '1px solid var(--border-1)', padding: '4px 0' }}>
                      <span className="num" style={{ color: 'var(--text-3)' }}>{new Date(r.at).toLocaleTimeString('ar')}</span>
                      {r.symbol && <span className="num font-bold" style={{ color: 'var(--text-1)' }}>{r.symbol}{r.tf ? ` ${r.tf}` : ''}</span>}
                      <span style={{ color: 'var(--text-2)' }}>{r.reason}</span>
                    </div>
                  ))}
                </div>
              )}
          </div>
        </div>
      )}

      {/* درج تفاصيل الفرصة */}
      {drawerOpp && (
        <OppDrawer opps={opps} index={opps.indexOf(drawerOpp)} onClose={() => setDrawerIdx(null)}
          onSelect={(i) => setDrawerIdx(i)} dirBySymbol={dirBySymbol} onJumpDirections={jumpToDirections} />
      )}
    </div>
  );
}

function OppRow({ o, liveDir, expanded, onToggle, onDetail, onChart, onJumpDirections }: {
  o: Strategy2Opportunity; liveDir?: Strategy2DirectionRow;
  expanded: boolean; onToggle: () => void; onDetail: () => void; onChart: () => void;
  onJumpDirections: (symbol: string) => void;
}) {
  const tick = useStore(s => s.strategy2Rows[o.id]);
  const px = tick?.price ?? o.price;
  const tier = o.tier ? (TIER_BADGE[o.tier] ?? null) : null;
  const modelLabel = o.model === 1 ? '1 — سويب+choch' : o.model === 2 ? '2 — مبكرين+ابتلاع' : '—';
  const att = attentionOf(o);
  const comp = completenessOf(o);
  return (
    <>
      <tr onClick={onToggle} title={att.on ? 'تحتاج انتباه: شريحة مؤهلة + قريبة من الهدف + مكتملة الشروط (إبراز محايد — ليست توصية دخول)' : 'انقر للتوسيع'}
        style={{
          borderBottom: '1px solid var(--border-1)', cursor: 'pointer',
          background: att.on ? 'var(--accent-soft)' : undefined,
          borderRight: att.on ? '3px solid var(--accent)' : undefined
        }}>
        <td className="px-2.5 py-2 whitespace-nowrap">
          <span className="font-bold num" style={{ color: 'var(--text-1)' }}>{o.symbol}</span>
          <span className="num text-[11px] mr-1.5" style={{ color: 'var(--text-3)' }}>{o.tf} · نموذج {o.model ?? '—'}</span>
          <div className="text-[10.5px]" style={{ color: 'var(--text-3)' }}>{modelLabel}</div>
        </td>
        <td className="px-2.5 py-2 text-[11.5px] whitespace-nowrap" style={{ color: htfColor(liveDir?.dir ?? o.htfDirection ?? 'range') }}>
          {HTF_LABEL[liveDir?.dir ?? o.htfDirection ?? 'range'] ?? '—'}
          {liveDir?.dead && <span style={{ color: 'var(--warn)' }}> · مات</span>}
          <div className="text-[10.5px]" style={{ color: 'var(--text-3)' }}>
            توافق: {liveDir ? (liveDir.agreement === 'confirmed' ? 'مؤكد' : liveDir.agreement === 'conflicted' ? 'متعارض' : 'الفريم فقط') : '—'}
          </div>
        </td>
        <td className="px-2.5 py-2 num">
          <div style={{ color: 'var(--text-2)' }}>{fmtPx(o.entry)}</div>
          <div className="mt-1"><PriceBar stop={o.stop} entry={o.entry} tp1={o.tp1} live={px} /></div>
          <div className="text-[10.5px]" style={{ color: tick?.plPct != null && tick.plPct < 0 ? 'var(--down)' : 'var(--text-3)' }}>
            حي {fmtPx(px)}{tick?.plPct != null ? ` · ${tick.plPct > 0 ? '+' : ''}${tick.plPct.toFixed(2)}%` : ''}
          </div>
        </td>
        <td className="px-2.5 py-2 num" style={{ color: 'var(--up)' }} title={o.conservative && o.tpAlt != null ? `شريحة غير مؤكدة — الهدف المتحفظ المقترح (BSL داخلي): ${fmtPx(o.tpAlt)}` : undefined}>
          {fmtPx(o.tp1)}
          <div className="text-[10.5px]" style={{ color: 'var(--text-3)' }}>وقف {fmtPx(o.stop)}</div>
          {o.conservative && o.tpAlt != null ? <div className="text-[10px] font-semibold" style={{ color: 'var(--warn)' }}>متحفظ: {fmtPx(o.tpAlt)}</div> : null}
        </td>
        <td className="px-2.5 py-2 num">
          <span className="font-bold" style={{ color: (o.rr ?? 0) >= 1.5 ? 'var(--up)' : 'var(--text-1)' }}>{o.rr != null ? o.rr.toFixed(2) : '—'}</span>
          <div className="mt-0.5">
            {tier
              ? <span className="text-[10px] px-2 py-px rounded-full font-semibold" style={{ background: `${tier.color}22`, color: tier.color, border: `1px solid ${tier.color}55` }}>{tier.label}</span>
              : <span className="text-[10px] px-2 py-px rounded-full font-semibold" title="نُشرت قبل اكتمال المعايرة — بلا تصفية إحصائية" style={{ background: 'transparent', color: 'var(--text-3)', border: '1px dashed var(--border-1)' }}>بلا معايرة</span>}
          </div>
        </td>
        <td className="px-2.5 py-2 text-[11px] max-w-[240px]">
          <div className="flex items-center gap-1.5" title={comp != null ? `اكتمال الشروط اللازمة: ${(comp * 100).toFixed(0)}%` : 'لا شروط لازمة مسجلة'}>
            <span className="inline-block h-1.5 rounded-full" style={{ width: 56, background: 'var(--surface-0)', border: '1px solid var(--border-1)' }}>
              <span className="block h-full rounded-full" style={{ width: `${Math.round((comp ?? 0) * 100)}%`, background: 'var(--accent)' }} />
            </span>
            <span className="num" style={{ color: 'var(--text-3)' }}>{comp != null ? `${Math.round(comp * 100)}%` : '—'}</span>
          </div>
          <div className="mt-1 flex flex-wrap gap-1" title={(o.sequence ?? []).map(s => `${s.status === 'occurred' ? '✓' : s.status === 'failed' ? '✗' : s.status === 'skipped' ? '–' : '…'} ${s.label}`).join(' · ')}>
            {(o.sequence ?? []).slice(0, 6).map(s => (
              <span key={s.key} className="px-1.5 py-px rounded-full font-semibold" style={{
                fontSize: 10,
                background: s.status === 'occurred' ? 'var(--up)' : s.status === 'failed' ? 'var(--down)' : 'transparent',
                opacity: s.status === 'occurred' || s.status === 'failed' ? 0.16 : 1,
                color: s.status === 'occurred' ? 'var(--up)' : s.status === 'failed' ? 'var(--down)' : 'var(--text-3)',
                border: `1px solid ${s.status === 'occurred' ? 'var(--up)' : s.status === 'failed' ? 'var(--down)' : 'var(--border-1)'}`
              }}>{s.status === 'occurred' ? '✓' : s.status === 'failed' ? '✗' : s.status === 'skipped' ? '–' : '…'} {s.label}</span>
            ))}
          </div>
          <div className="mt-0.5" style={{ color: 'var(--text-3)' }} title={o.reasons.join(' · ')}>
            {o.reasons.slice(0, 2).join(' · ')}{o.reasons.length > 2 ? ` +${o.reasons.length - 2}` : ''}
          </div>
        </td>
        <td className="px-2.5 py-2 num text-[11px] whitespace-nowrap" style={{ color: 'var(--text-3)' }}>
          {ago(o.detectedAt)}
          {tick ? <div>عمر {tick.ageSec} ث</div> : null}
        </td>
        <td className="px-2.5 py-2 whitespace-nowrap">
          <button onClick={(e) => { e.stopPropagation(); onDetail(); }} className="text-[11px] px-2 py-1 rounded ml-1" style={{ background: 'var(--accent-soft)', border: '1px solid var(--border-1)', color: 'var(--accent)' }}>تفاصيل</button>
          <button onClick={(e) => { e.stopPropagation(); onChart(); }} className="text-[11px] px-2 py-1 rounded" style={{ background: 'var(--surface-0)', border: '1px solid var(--border-1)', color: 'var(--accent)' }}>الشارت</button>
        </td>
      </tr>
      {expanded && (
        <tr style={{ background: 'var(--surface-0)' }}>
          <td colSpan={8} className="px-6 py-3">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-[12px]">
              <div>
                <div className="font-bold mb-1" style={{ color: 'var(--text-1)' }}>لماذا هذه الفرصة؟</div>
                {o.reasons.map((r, i) => <div key={i} style={{ color: 'var(--text-2)' }}>• {r}</div>)}
                <div className="mt-2 text-[11.5px]" style={{ color: 'var(--text-3)' }}>
                  بعد بريميوم: {o.afterPremium == null ? '—' : o.afterPremium ? 'نعم' : 'لا'} · الشريحة: <span className="num">{o.segmentKey ?? '—'}</span> ·
                  معايَرة {pct(o.calibratedWinRate)}{o.wilsonLB != null ? ` (Wilson ${o.wilsonLB.toFixed(2)})` : ''} ·
                  المسافة عن TP1: {o.distancePct != null && Number.isFinite(o.distancePct) ? `${Math.abs(o.distancePct).toFixed(2)}% (${distanceBand(o.distancePct).label})` : '—'}
                </div>
              </div>
              <div>
                <div className="font-bold mb-1" style={{ color: 'var(--text-1)' }}>التسلسل الكامل</div>
                {(o.sequence ?? []).map(s => (
                  <div key={s.key} className="flex gap-2 py-px text-[11.5px]" style={{ color: 'var(--text-2)' }}>
                    <b style={{ color: s.status === 'occurred' ? 'var(--up)' : s.status === 'failed' ? 'var(--down)' : 'var(--text-3)' }}>
                      {s.status === 'occurred' ? '✓' : s.status === 'failed' ? '✗' : s.status === 'skipped' ? '–' : '…'}
                    </b>
                    <span>{s.label}{s.required ? '' : ' (اختياري)'}</span>
                  </div>
                ))}
                <div className="mt-2 flex gap-2 flex-wrap">
                  <button onClick={onDetail} className="text-[11.5px] px-2.5 py-1 rounded" style={{ background: 'var(--accent-soft)', border: '1px solid var(--border-1)', color: 'var(--accent)' }}>الدرج الكامل ←</button>
                  <button onClick={() => onJumpDirections(o.symbol)} className="text-[11.5px] px-2.5 py-1 rounded" style={{ background: 'var(--surface-1)', border: '1px solid var(--border-1)', color: 'var(--text-2)' }}>اتجاه الرمز</button>
                  <button onClick={onChart} className="text-[11.5px] px-2.5 py-1 rounded" style={{ background: 'var(--surface-1)', border: '1px solid var(--border-1)', color: 'var(--accent)' }}>الشارت بالمستويات</button>
                </div>
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function OppCard({ o, liveDir, onDetail, onChart }: { o: Strategy2Opportunity; liveDir?: Strategy2DirectionRow; onDetail: () => void; onChart: () => void }) {
  const tick = useStore(s => s.strategy2Rows[o.id]);
  const px = tick?.price ?? o.price;
  const att = attentionOf(o);
  return (
    <div className="card p-3" style={att.on ? { borderRight: '3px solid var(--accent)' } : undefined}>
      <div className="flex items-center justify-between gap-2">
        <span className="font-bold num text-[13px]" style={{ color: 'var(--text-1)' }}>{o.symbol} <span style={{ color: 'var(--text-3)' }}>{o.tf} · نموذج {o.model ?? '—'}</span></span>
        <span className="text-[11.5px] font-semibold" style={{ color: htfColor(liveDir?.dir ?? o.htfDirection ?? 'range') }}>
          {HTF_LABEL[liveDir?.dir ?? o.htfDirection ?? 'range'] ?? '—'}
        </span>
      </div>
      <div className="flex items-center justify-between mt-2 text-[12px] num" style={{ color: 'var(--text-2)' }}>
        <span>دخول {fmtPx(o.entry)}</span>
        <span style={{ color: tick?.plPct != null && tick.plPct < 0 ? 'var(--down)' : 'var(--up)' }}>
          حي {fmtPx(px)}{tick?.plPct != null ? ` (${tick.plPct > 0 ? '+' : ''}${tick.plPct.toFixed(2)}%)` : ''}
        </span>
        <span>TP1 {fmtPx(o.tp1)}</span>
        <span>وقف {fmtPx(o.stop)}</span>
      </div>
      <div className="flex gap-2 mt-2">
        <button onClick={onDetail} className="btn text-[12px] flex-1">تفاصيل</button>
        <button onClick={onChart} className="btn text-[12px] flex-1">الشارت</button>
      </div>
    </div>
  );
}

function DirChip({ label, active, onClick, color }: { label: string; active: boolean; onClick: () => void; color: string }) {
  return (
    <button onClick={onClick} className="text-[12px] font-semibold px-3 py-1.5 rounded-lg"
      style={{
        background: active ? `${color}22` : 'var(--surface-1)',
        color: active ? color : 'var(--text-2)',
        border: `1px solid ${active ? color : 'var(--border-1)'}`
      }}>{label}</button>
  );
}

const AGREEMENT_LABEL: Record<string, { label: string; color: string }> = {
  confirmed: { label: 'مؤكد', color: 'var(--up)' },
  conflicted: { label: 'متعارض', color: 'var(--warn)' },
  single: { label: 'الفريم فقط', color: 'var(--text-3)' }
};

function DirRow({ d, expanded, onToggle, onChart }: { d: Strategy2DirectionRow; expanded: boolean; onToggle: () => void; onChart: () => void }) {
  const ag = AGREEMENT_LABEL[d.agreement] ?? AGREEMENT_LABEL.single;
  return (
    <>
      <tr onClick={onToggle} style={{ borderBottom: '1px solid var(--border-1)', cursor: 'pointer', background: expanded ? 'var(--surface-0)' : undefined }}>
        <td className="px-2.5 py-2 font-bold num whitespace-nowrap" style={{ color: 'var(--text-1)' }}>{d.symbol}</td>
        <td className="px-2.5 py-2 num text-[11px]" style={{ color: 'var(--text-3)' }}>{d.tf ?? '1m'}</td>
        <td className="px-2.5 py-2 text-[11.5px] font-semibold whitespace-nowrap" style={{ color: htfColor(d.dir) }} title={d.htfTf ? `الفريم الأكبر: ${d.htfTf}` : undefined}>
          {HTF_LABEL[d.dir] ?? '—'}{d.htfTf ? <span className="num" style={{ color: 'var(--text-3)' }}> ·{d.htfTf}</span> : null}{d.dead && <span style={{ color: 'var(--warn)' }}> · مات</span>}
        </td>
        <td className="px-2.5 py-2 text-[11.5px]" style={{ color: htfColor(d.dirTF ?? d.dir1m ?? 'range') }}>{HTF_LABEL[d.dirTF ?? d.dir1m ?? 'range'] ?? '—'}</td>
        <td className="px-2.5 py-2 whitespace-nowrap">
          <span className="text-[10px] px-2 py-0.5 rounded-full font-semibold" style={{ background: `${ag.color}22`, color: ag.color, border: `1px solid ${ag.color}55` }}>{ag.label}</span>
        </td>
        <td className="px-2.5 py-2 text-[11px] max-w-[260px]" style={{ color: 'var(--text-2)' }} title={d.stage}>{d.stage}</td>
        <td className="px-2.5 py-2 num text-[11px]" style={{ color: 'var(--text-3)' }}>
          {d.anchorHigh != null ? `قمة ${fmtPx(d.anchorHigh)}` : d.anchorLow != null ? `قاع ${fmtPx(d.anchorLow)}` : '—'}
        </td>
        <td className="px-2.5 py-2 text-[11px]" style={{ color: 'var(--text-3)' }}>{d.afterPremium == null ? '—' : d.afterPremium ? 'نعم' : 'لا'}</td>
        <td className="px-2.5 py-2 num text-[11px]" style={{ color: 'var(--text-2)' }}>{fmtPx(d.externalNext)}</td>
        <td className="px-2.5 py-2 num text-[11px]" style={{ color: d.distToExternalPct != null && Math.abs(d.distToExternalPct) <= 0.75 ? 'var(--up)' : 'var(--text-2)' }}>
          {d.distToExternalPct != null ? `${d.distToExternalPct > 0 ? '+' : ''}${d.distToExternalPct.toFixed(2)}%` : '—'}
        </td>
        <td className="px-2.5 py-2 num text-[11px]" style={{ color: 'var(--text-3)' }}>{ago(d.since)}</td>
        <td className="px-2.5 py-2 num text-[11px]" style={{ color: d.changeCount >= VOLATILE_CHANGES ? 'var(--down)' : d.changeCount > 2 ? 'var(--warn)' : 'var(--text-2)' }} title={d.changeCount >= VOLATILE_CHANGES ? `تقلب مفرط: ${d.changeCount} انقلاباً منذ الإقلاع — قراراتها عالية المخاطر` : `${d.changeCount} انقلاباً منذ الإقلاع`}>
          {d.changeCount}{d.changeCount >= VOLATILE_CHANGES ? ' ⚠' : ''}
        </td>
        <td className="px-2.5 py-2">
          <button onClick={(e) => { e.stopPropagation(); onChart(); }} className="text-[11px] px-2 py-1 rounded" style={{ background: 'var(--surface-0)', border: '1px solid var(--border-1)', color: 'var(--accent)' }}>الشارت</button>
        </td>
      </tr>
      {expanded && (
        <tr style={{ background: 'var(--surface-0)' }}>
          <td colSpan={13} className="px-6 py-3">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-[11px] num" style={{ color: 'var(--text-2)' }}>
              <span>سعر: {fmtPx(d.price)}</span>
              <span>اتجاه {d.tf ?? '1m'}: <b style={{ color: htfColor(d.dirTF ?? d.dir1m ?? 'range') }}>{HTF_LABEL[d.dirTF ?? d.dir1m ?? 'range'] ?? '—'}</b></span>
              <span>ديسكاونت: {fmtPx(d.discountLevel)}</span>
              <span>نطاق الرِجل: {fmtPx(d.legLow)} → {fmtPx(d.legHigh)}</span>
              <span>مستوى الموت: {fmtPx(d.deathLevel)}</span>
            </div>
            <div className="mt-2 text-[11px] font-bold" style={{ color: 'var(--text-2)' }}>سجل الانتقالات (الأحدث أولاً)</div>
            {d.transitions.length === 0
              ? <div className="text-[11px] mt-1" style={{ color: 'var(--text-3)' }}>لا انتقالات مسجلة منذ الإقلاع.</div>
              : (
                <div className="mt-1 space-y-0.5">
                  {d.transitions.map((t, i) => (
                    <div key={`${t.at}-${i}`} className="flex flex-wrap gap-2 items-baseline text-[11px]">
                      <span className="num" style={{ color: 'var(--text-3)' }}>{new Date(t.at).toLocaleTimeString('ar')}</span>
                      <span className="num font-bold" style={{ color: t.kind === 'flip' ? 'var(--accent)' : t.kind === 'dead' ? 'var(--warn)' : 'var(--text-2)' }}>
                        {t.kind === 'flip' ? 'انقلاب' : t.kind === 'dead' ? 'موت مشوار' : t.kind === 'stage' ? 'مرحلة' : t.kind}
                      </span>
                      <span style={{ color: 'var(--text-2)' }}>{t.label}</span>
                      <span className="num" style={{ color: 'var(--text-3)' }}>{t.stage}</span>
                    </div>
                  ))}
                </div>
              )}
          </td>
        </tr>
      )}
    </>
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
