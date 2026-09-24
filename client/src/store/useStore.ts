import { create } from 'zustand';
import { api } from '../lib/api';
import type { Analysis, BarcodeScan, CaseRow, CoinShariahRow, Candle, Settings, ShariahResearch } from '../lib/types';
import type { SortResultRow, SortInput } from '../lib/sorting';
import { sortAnalyses } from '../lib/sorting';
import { BinanceStreams, syncSymbols as syncSymbolsApi, fetchSpotSymbols, priceStreamName, klineStreamName, connectSymbolsSocket, pollSymbolsMeta, type MiniTicker, type KlineMsg, type SpotSymbol, type LiveOppTickRow, type LiveWatchTickRow } from '../lib/binance';
import { queueZoneCapture } from '../lib/autoCapture';
import { evaluateShariah } from '../lib/shariah';

const API = '/api';

const rowVerdictAr = (v: string) => (v === 'halal' ? 'حلال' : v === 'haram' ? 'حرام' : 'للتحقق');

export type Screen = 'board' | 'dashboard' | 'cases' | 'settings' | 'autoHistory' | 'backtest' | 'liquidityZones' | 'customLiquidity' | 'liveOpportunities' | 'notifications' | 'strategy2';
export type Theme = 'dark' | 'light';
export type ArchiveSection = 'cases' | 'zones' | 'events';

/* ═══ مركز الإشعارات — المكان الوحيد الذي تظهر فيه الإشعارات (بلا نوافذ منبثقة) ═══ */
export type NotificationCategory = 'zones' | 'liveOpps' | 'shariah' | 'system' | 'actions';
export type NotificationSeverity = 'info' | 'alert' | 'error';
export interface AppNotification {
  id: number;
  ts: number;
  category: NotificationCategory;
  severity: NotificationSeverity;
  symbol: string | null;
  text: string;
  action?: { label: string; onClick: () => void };
  read: boolean;
}

const NOTIF_STORAGE_KEY = 'app_notifications_v1';
const NOTIF_CAP = 500;
let toastId = 0;

function loadStoredNotifications(): AppNotification[] {
  try {
    const raw = localStorage.getItem(NOTIF_STORAGE_KEY);
    if (!raw) return [];
    const rows = JSON.parse(raw) as AppNotification[];
    if (!Array.isArray(rows)) return [];
    // الإجراءات (الدوال) لا تنجو من التخزين — تُساق وتُعلَّم السجلات المقروءة
    return rows.slice(0, NOTIF_CAP).map(r => ({ ...r, action: undefined }));
  } catch { return []; }
}

function saveStoredNotifications(rows: AppNotification[]) {
  try {
    const plain = rows.slice(0, NOTIF_CAP).map(r => ({ ...r, action: undefined }));
    localStorage.setItem(NOTIF_STORAGE_KEY, JSON.stringify(plain));
  } catch { /* التخزين ممتلئ أو محجوب — الإشعارات تبقى في الذاكرة */ }
}

function initialTheme(): Theme {
  // الأولوية للاختيار المحفوظ من زر التبديل، والافتراضي أبيض
  try {
    const s = localStorage.getItem('theme');
    if (s === 'dark') return 'dark';
  } catch { /* ignore */ }
  const t = document.documentElement.dataset.theme;
  return t === 'dark' ? 'dark' : 'light';
}

interface StoreState {
  symbols: SpotSymbol[];
  symbolsLoaded: boolean;
  zoneCounts: Record<string, number> | null;
  refreshZoneCounts: () => Promise<void>;
  barcodeScans: Record<string, BarcodeScan>;
  shariah: Record<string, CoinShariahRow>;
  shariahLoaded: boolean;
  analyses: Analysis[];
  prices: Record<string, number>;
  settings: Settings | null;
  screen: Screen;
  chartModal: { symbol: string; tfLower: string | null; tfUpper: string | null } | null;
  notifications: AppNotification[];
  unreadNotifications: number;
  markAllNotificationsRead: () => void;
  clearNotifications: () => void;
  markNotificationRead: (id: number) => void;
  streams: BinanceStreams | null;
  soundEnabled: boolean;
  syncing: boolean;
  lastSync: number;
  theme: Theme;
  cases: CaseRow[];
  casesError: string | null;
  casesLoaded: boolean;
  caseFilter: string | null;
  archiveSection: ArchiveSection;
  /* اللقطة الحية للفرص المنشورة والمناطق قيد المراقبة (tick كل ثانية من الخادم عبر WS) */
  liveOppTick: { at: number; opportunities: Record<string, LiveOppTickRow>; watching: Record<string, LiveWatchTickRow> } | null;
  calibrationProgress: { done: number; total: number } | null;
  /* نبضة محرك «الفرص الحية — استراتيجيتي» عبر WS (تحديث لحظي للشاشة) */
  strategy2Pulse: { at: number; kind: string } | null;
  /* أسعار حية لكل فرصة منشورة من محرك الاستراتيجية (id → صف النبضة) */
  strategy2Rows: Record<string, { price: number | null; plPct: number | null; rNow: number | null; mfeR: number; ageSec: number }>;

  init: () => Promise<void>;
  syncSymbols: () => Promise<void>;
  setScreen: (s: Screen) => void;
  openChart: (symbol: string, tfLower: string | null, tfUpper: string | null) => void;
  closeChart: () => void;
  openCaseLedger: (symbol?: string) => void;
  setCaseFilter: (f: string | null) => void;
  setArchiveSection: (s: ArchiveSection) => void;
  refreshCases: () => Promise<void>;
  addAnalysis: (symbol: string, extras?: Partial<Analysis>) => Promise<void>;
  updateAnalysis: (id: number, patch: Partial<Analysis>) => Promise<void>;
  deleteAnalysis: (id: number) => Promise<void>;
  scanBarcode: (symbol: string) => Promise<BarcodeScan>;
  refreshSymbols: (opts?: { silent?: boolean }) => Promise<void>;
  saveShariah: (symbol: string, row: Partial<CoinShariahRow>) => Promise<void>;
  researchShariahAuto: (symbol: string) => Promise<ShariahResearch>;
  deleteShariah: (symbol: string) => Promise<void>;
  saveSettings: (patch: Partial<Settings>) => Promise<void>;
  toggleTheme: () => void;
  pushToast: (text: string, kind?: 'info' | 'alert', action?: { label: string; onClick: () => void }, meta?: { category?: NotificationCategory; symbol?: string; severity?: NotificationSeverity }) => void;
  deleteNotification: (id: number) => void;
  subscribePrice: (symbol: string) => void;
  unsubscribePrice: (symbol: string) => void;
  subscribeKline: (symbol: string, interval: string, cb: (candle: Candle, closed: boolean) => void) => () => void;
  livePrice: (symbol: string) => number | null;
}

let streams: BinanceStreams | null = null;
let symbolsChannelStarted = false;
const priceUnsubs = new Map<string, () => void>();
/* تجميع نبضات الأسعار: الكتابة إلى خريطة مؤقتة ودفعة set() واحدة كل 600ms
 * بدل كتابة كاملة للمخزن عند كل رسالة miniTicker — يخفض إعادة رسم اللوحة من N/ثانية إلى دفعتين */
const pendingPrices = new Map<string, number>();
let priceFlushTimer: ReturnType<typeof setInterval> | null = null;
const haramAlerted = new Set<string>();

/** تنبيه تحوّل حكم عملة متابَعة إلى «حرام» — مع اقتراح إزالة بضغطة واحدة (القرار للمستخدم) */
function alertIfHaramFollowed(symbol: string, verdict: string) {
  const st = useStore.getState();
  const followed = st.analyses.find(a => a.symbol === symbol);
  if (!followed || verdict !== 'haram' || haramAlerted.has(symbol)) return;
  haramAlerted.add(symbol);
  const id = followed.id;
  useStore.getState().pushToast(
    `${symbol}: تغيّر تصنيفها الشرعي إلى «حرام» حسب البيانات — يُقترح إزالتها من لوحة المتابعة`,
    'alert',
    { label: 'إزالة من اللوحة', onClick: () => void useStore.getState().deleteAnalysis(id) },
    { category: 'shariah', symbol, severity: 'alert' }
  );
}

export const useStore = create<StoreState>((set, get) => ({
  symbols: [],
  symbolsLoaded: false,
  zoneCounts: null,
  barcodeScans: {},
  shariah: {},
  shariahLoaded: false,
  analyses: [],
  prices: {},
  settings: null,
  screen: ((): Screen => {
    // افتتاح مباشر على التبويب من الرابط (#/history مثلاً) — الافتراضي اللوحة
    const h = location.hash.replace('#/', '');
    if (h === 'history') return 'autoHistory';
    return (['board', 'cases', 'autoHistory', 'dashboard', 'settings', 'backtest', 'liquidityZones', 'customLiquidity', 'liveOpportunities', 'notifications', 'strategy2'] as const).includes(h as Screen)
      ? h as Screen
      : 'board';
  })(),
  chartModal: null,
  notifications: ((): AppNotification[] => loadStoredNotifications())(),
  unreadNotifications: ((): number => loadStoredNotifications().filter(n => !n.read).length)(),
  streams: null,
  soundEnabled: true,
  syncing: false,
  lastSync: 0,
  theme: initialTheme(),
  cases: [],
  casesLoaded: false,
  casesError: null,
  caseFilter: null,
  archiveSection: 'cases',
  liveOppTick: null,
  calibrationProgress: null,
  strategy2Pulse: null,
  strategy2Rows: {},

  init: async () => {
    if (!streams) {
      streams = new BinanceStreams();
      set({ streams });
    }
    const [barcodeScans, analyses, settings] = await Promise.all([
      api.getBarcodeScans().catch(() => []),
      api.getAnalyses(),
      api.getSettings()
    ]);
    const barcodeMap: Record<string, BarcodeScan> = {};
    for (const scan of barcodeScans) barcodeMap[scan.symbol] = scan;
    set({ barcodeScans: barcodeMap, analyses, settings: settings ?? null });
    // شريعة: لا تُفشل init إذا تعذر الجدول
    try {
      const sh = await api.getShariah();
      const shMap: Record<string, CoinShariahRow> = {};
      for (const r of sh) {
        /* تسوية الصفوف الآلية: يحسب المحرك الحتمي الحكم من الحقائق المحفوظة،
           ويصحح الصف المخزن ويسجل أي تغيير حكم مرة واحدة — لا حكم قديم معلّق */
        const factVals = r.facts ? Object.values(r.facts) : [];
        if (factVals.some(v => typeof v === 'boolean')) {
          try {
            const res = evaluateShariah(r.facts as never, r.symbol);
            const evidence = res.evidence.map(({ id, type, text, ref, grade }) => ({ id, type, text, ref, grade }));
            const computed: CoinShariahRow = { ...r, verdict: res.verdict, reasons: [res.headline, ...res.reasons], evidence };
            if (res.verdict !== r.verdict) {
              void api.setShariah(r.symbol, {
                verdict: res.verdict, facts: r.facts, reasons: computed.reasons,
                evidence, source: r.source, notes: r.notes
              }).catch(() => undefined);
              void api.logShariahChange({
                symbol: r.symbol,
                message: `تغيّر الحكم من ${rowVerdictAr(r.verdict)} إلى ${rowVerdictAr(res.verdict)} بمحرك القواعد على الحقائق الموثقة`,
                meta: { from: r.verdict, to: res.verdict, source: r.source }
              }).catch(() => undefined);
            }
            shMap[r.symbol] = computed;
            continue;
          } catch { /* يقع على الصف المخزن */ }
        }
        shMap[r.symbol] = r;
      }
      set({ shariah: shMap, shariahLoaded: true });
    } catch { set({ shariahLoaded: true }); }
    // فحص أولي: إن كانت أي عملة متابَعة حكمها المخزن «حرام» ننبّه مرة واحدة
    try {
      for (const a of get().analyses) {
        const row = get().shariah[a.symbol];
        alertIfHaramFollowed(a.symbol, row?.verdict ?? '');
      }
    } catch { /* ignore */ }
    // جلب قائمة الأزواج المخزنة + تاريخ آخر مزامنة
    const quote = settings?.quote ?? 'USDT';
    try {
      const [syms, meta] = await Promise.all([
        fetchSpotSymbols(quote),
        fetch(`${API}/symbols/meta`).then(r => r.ok ? r.json() : { last_updated: 0 })
      ]);
      set({ symbols: syms, symbolsLoaded: true, lastSync: meta.last_updated ?? 0 });
      // إن كانت القائمة فارغة: مزامنة تلقائية أولى
      if (syms.length === 0) {
        await get().syncSymbols();
      }
    } catch (e) {
      get().pushToast(`تعذر جلب قائمة العملات المخزنة: ${String(e)}`, 'alert', undefined, { category: 'system', severity: 'error' });
    }
    // قناة التحديث الآني: بث WebSocket + احتياطي دوري (الثنائي يضمن الوصول دائماً)
    if (!symbolsChannelStarted) {
      symbolsChannelStarted = true;
      connectSymbolsSocket((msg) => {
        if (msg.type === 'symbols_updated') void get().refreshSymbols({ silent: false });
        else if (msg.type === 'zones_changed' || msg.type === 'zones_auto_updated') void get().refreshZoneCounts();
        else if (msg.type === 'zones_auto_updated' && msg.symbol) queueZoneCapture(String(msg.symbol));
        else if (msg.type === 'zone_near' && msg.zone && msg.symbol) {
          get().pushToast(`${msg.symbol}: السعر يقترب من منطقة ${msg.zone.type}${msg.zone.note ? ` — ${msg.zone.note}` : ''}`, 'alert', undefined, { category: 'zones', symbol: String(msg.symbol), severity: 'alert' });
        } else if (msg.type === 'zone_swept' && msg.zone && msg.symbol) {
          get().pushToast(`${msg.symbol}: سحب سيولة ${msg.zone.type} عند ${msg.zone.price}${msg.zone.note ? ` — ${msg.zone.note}` : ''}`, 'alert', undefined, { category: 'zones', symbol: String(msg.symbol), severity: 'alert' });
        } else if (msg.type === 'live_opportunity_new' && msg.opportunity) {
          const o = msg.opportunity as { symbol: string; timeframe: string; entry: number; stop: number; tp: number; rr: number; composite: number };
          get().pushToast(`فرصة شراء ${o.symbol} (${o.timeframe}) — دخول ${o.entry} · وقف ${o.stop} · هدف ${o.tp} · R:R ${o.rr} · درجة ${o.composite}`, 'alert', undefined, { category: 'liveOpps', symbol: o.symbol, severity: 'alert' });
        } else if (msg.type === 'live_sweep_detected' && msg.symbol) {
          get().pushToast(`${msg.symbol} (${msg.timeframe}): سويب سيولة بيعية مكتشف — بانتظار الاستعادة`, 'info', undefined, { category: 'liveOpps', symbol: String(msg.symbol) });
        } else if (msg.type === 'live_opportunity_closed' && msg.opportunity) {
          const o = msg.opportunity as { symbol: string; timeframe: string; outcome: string };
          const win = o.outcome === 'target';
          get().pushToast(`نتيجة فرصة ${o.symbol} (${o.timeframe}): ${win ? 'وصلت الهدف' : 'ضربت الوقف'}`, win ? 'info' : 'alert', undefined, { category: 'liveOpps', symbol: o.symbol, severity: win ? 'info' : 'alert' });
        } else if (msg.type === 'live_opportunities_tick') {
          // لقطة كاملة كل ثانية: الصفقات المنشورة + المناطق قيد المراقبة
          const opportunities: Record<string, LiveOppTickRow> = {};
          for (const r of msg.opportunities ?? []) opportunities[r.id] = r;
          const watching: Record<string, LiveWatchTickRow> = {};
          for (const w of msg.watching ?? []) watching[w.key] = w;
          set({ liveOppTick: { at: msg.at ?? Date.now(), opportunities, watching } });
        } else if (msg.type === 'live_calibration_progress') {
          set({ calibrationProgress: { done: msg.done ?? 0, total: msg.total ?? 0 } });
        } else if (msg.type === 'live_calibration_done') {
          set({ calibrationProgress: null });
        } else if (msg.type === 'strategy2_new' && msg.opportunity) {
          const o = msg.opportunity as unknown as { symbol: string; tf: string; model: number; entry: number; stop: number; tp1: number; rr: number; htfDirection: string };
          get().pushToast(`استراتيجيتي — ${o.symbol} (${o.tf}) نموذج ${o.model}: دخول ${o.entry} · وقف ${o.stop} · هدف ${o.tp1} · R:R ${o.rr} · اتجاه HTF ${o.htfDirection === 'up' ? 'صاعد' : o.htfDirection === 'down' ? 'هابط' : 'عرضي'}`, 'alert', undefined, { category: 'liveOpps', symbol: o.symbol, severity: 'alert' });
          set({ strategy2Pulse: { at: Date.now(), kind: 'new' } });
        } else if (msg.type === 'strategy2_closed' && msg.opportunity) {
          const o = msg.opportunity as unknown as { symbol: string; tf: string; outcome: string };
          const win = o.outcome === 'target' || o.outcome === 'target2';
          const label = o.outcome === 'target' ? 'وصلت الهدف الأول' : o.outcome === 'target2' ? 'وصلت الهدف الثاني' : o.outcome === 'invalidated' ? 'فشل نقطة الدخول' : o.outcome === 'expired' ? 'انتهت دون حسم' : 'ضربت الوقف';
          get().pushToast(`استراتيجيتي — نتيجة ${o.symbol} (${o.tf}): ${label}`, win ? 'info' : 'alert', undefined, { category: 'liveOpps', symbol: o.symbol, severity: win ? 'info' : 'alert' });
          set({ strategy2Pulse: { at: Date.now(), kind: 'closed' } });
        } else if (msg.type === 'strategy2_tick') {
          const rows: Record<string, { price: number | null; plPct: number | null; rNow: number | null; mfeR: number; ageSec: number }> = {};
          for (const r of msg.opportunities ?? []) rows[r.id] = r;
          set({ strategy2Rows: rows, strategy2Pulse: { at: Date.now(), kind: 'strategy2_tick' } });
        } else if (msg.type === 'strategy2_state' || msg.type === 'strategy2_calibration_progress' || msg.type === 'strategy2_calibration_done') {
          set({ strategy2Pulse: { at: Date.now(), kind: String(msg.type) } });
        }
      });
      pollSymbolsMeta(60, () => void get().refreshSymbols({ silent: true }));
    }
    // اشتراك بأسعار كل العملات المحللة
    for (const a of analyses) get().subscribePrice(a.symbol);
    void get().refreshZoneCounts();
  },

  /** عدّادات مناطق السيولة لكل عملة (تُحدَّث عند أي تغيير عبر البث) */
  refreshZoneCounts: async () => {
    try {
      const { zones } = await api.getZones();
      const counts: Record<string, number> = {};
      for (const z of zones) counts[z.symbol] = (counts[z.symbol] ?? 0) + 1;
      set({ zoneCounts: counts });
    } catch { /* العدادات تُحدَّث لاحقاً */ }
  },

  /** إعادة جلب القائمة من قاعدة البيانات + إشعار بالأصول الجديدة إن وُجدت */
  refreshSymbols: async (opts) => {
    try {
      const quote = get().settings?.quote ?? 'USDT';
      const prevBases = new Set(get().symbols.map(s => s.base));
      const [syms, meta] = await Promise.all([
        fetchSpotSymbols(quote),
        fetch(`${API}/symbols/meta`).then(r => r.ok ? r.json() : { last_updated: 0 })
      ]);
      const newBases = [...new Set(syms.filter(s => !prevBases.has(s.base)).map(s => s.base))];
      set({ symbols: syms, symbolsLoaded: true, lastSync: meta.last_updated ?? 0 });
      if (newBases.length > 0) {
        const shown = newBases.slice(0, 8).join('، ');
        get().pushToast(
          `أُضيفت ${newBases.length} عملة جديدة إلى القائمة: ${shown}${newBases.length > 8 ? '…' : ''}`,
          'info', undefined, { category: 'system' }
        );
      } else if (!opts?.silent) {
        get().pushToast('القائمة محدثة بالفعل — لا عملات جديدة', 'info', undefined, { category: 'system' });
      }
    } catch (e) {
      if (!opts?.silent) get().pushToast(`تعذر تحديث القائمة: ${String(e)}`, 'alert', undefined, { category: 'system', severity: 'error' });
    }
  },

  syncSymbols: async () => {
    if (get().syncing) return;
    set({ syncing: true });
    try {
      const r = await syncSymbolsApi();
      const quote = get().settings?.quote ?? 'USDT';
      const [syms, meta] = await Promise.all([
        fetchSpotSymbols(quote),
        fetch(`${API}/symbols/meta`).then(x => x.ok ? x.json() : { last_updated: Date.now() })
      ]);
      set({ symbols: syms, symbolsLoaded: true, lastSync: meta.last_updated ?? Date.now() });
      get().pushToast(`تم تحديث القائمة: ${r.saved}/${r.total} زوج`, 'info', undefined, { category: 'system' });
    } catch (e) {
      get().pushToast(`فشل تحديث القائمة من بينانس: ${String(e)}`, 'alert', undefined, { category: 'system', severity: 'error' });
    } finally {
      set({ syncing: false });
    }
  },

  setScreen: (s) => {
    set({ screen: s });
    // رابط مباشر لكل تبويب: يشارك ويعمل زر الرجوع
    try { history.replaceState(null, '', `#/${s === 'autoHistory' ? 'history' : s}`); } catch { /* ignore */ }
  },

  openChart: (symbol, tfLower, tfUpper) => set({ chartModal: { symbol, tfLower, tfUpper } }),
  closeChart: () => set({ chartModal: null }),

  /** فتح شاشة الأرشيف — مع تصفية لعملة محددة إن وُجدت (يُغلق الشارت أولاً) */
  openCaseLedger: (symbol) => {
    set({ chartModal: null, screen: 'cases', caseFilter: symbol?.toUpperCase() ?? null, archiveSection: 'cases' });
    void get().refreshCases();
  },

  setCaseFilter: (f) => {
    set({ caseFilter: f?.toUpperCase() ?? null });
    void get().refreshCases();
  },

  setArchiveSection: (s) => set({ archiveSection: s }),

  refreshCases: async () => {
    const symbol = get().caseFilter ?? undefined;
    try {
      const rows = await api.getCases(symbol);
      set({ cases: rows, casesLoaded: true, casesError: null });
    } catch (e) {
      // فشل واضح بدل skeleton لا نهائي — لا يُفشل التنقل
      set({ cases: [], casesLoaded: true, casesError: String(e) });
    }
  },

  addAnalysis: async (symbol, extras) => {
    const row = await api.createAnalysis({ symbol: symbol.toUpperCase(), ...(extras ?? {}) });
    set((st) => ({ analyses: [row, ...st.analyses] }));
    get().subscribePrice(row.symbol);
    void import('../lib/cases/collect').then(m => m.shipCoinEvent(row.symbol, 'coin_add', null, row));
  },

  updateAnalysis: async (id, patch) => {
    const before = get().analyses.find(a => a.id === id) ?? null;
    set((st) => ({
      analyses: st.analyses.map(a => a.id === id ? { ...a, ...patch } : a)
    }));
    const after = get().analyses.find(a => a.id === id) ?? null;
    if (before && after) {
      void import('../lib/cases/collect').then(m => m.shipAnalysisEdit(before.symbol, before, after));
    }
    try {
      const row = await api.updateAnalysis(id, patch);
      set((st) => ({ analyses: st.analyses.map(a => a.id === id ? row : a) }));
    } catch (e) {
      get().pushToast(`فشل الحفظ: ${String(e)}`, 'alert');
      const fresh = await api.getAnalyses();
      set({ analyses: fresh });
    }
  },

  deleteAnalysis: async (id) => {
    const a = get().analyses.find(x => x.id === id);
    set((st) => ({ analyses: st.analyses.filter(x => x.id !== id) }));
    if (a) {
      get().unsubscribePrice(a.symbol);
      void import('../lib/cases/collect').then(m => m.shipCoinEvent(a.symbol, 'coin_remove', a, null));
    }
    await api.deleteAnalysis(id);
  },

  scanBarcode: async (symbol) => {
    const row = await api.scanBarcode(symbol);
    set((st) => ({ barcodeScans: { ...st.barcodeScans, [symbol]: row } }));
    if (row.status !== 'success') throw new Error(row.reason || 'تعذر فحص الباركود');
    return row;
  },

  saveShariah: async (symbol, row) => {
    const saved = await api.setShariah(symbol, row);
    set((st) => ({ shariah: { ...st.shariah, [symbol]: saved } }));
    alertIfHaramFollowed(symbol, saved.verdict);
  },

  researchShariahAuto: async (symbol) => {
    const research = await api.researchShariah(symbol);
    if (research.status === 'documented') {
      const res = evaluateShariah(research.gated as never, symbol);
      await get().saveShariah(symbol, {
        verdict: res.verdict,
        facts: research.gated,
        reasons: [res.headline, ...res.reasons],
        evidence: res.evidence.map(({ id, type, text, ref, grade }) => ({ id, type, text, ref, grade })),
        source: `بحث آلي: CoinGecko${research.geckoId ? ` — ${research.geckoId}` : ''}`,
        notes: JSON.stringify({ confidence: research.confidence, sources: research.sources, checked_at: Date.now(), coin_name: research.coinName })
      });
    }
    return research;
  },

  deleteShariah: async (symbol) => {
    await api.deleteShariah(symbol);
    set((st) => {
      const next = { ...st.shariah };
      delete next[symbol];
      return { shariah: next };
    });
  },

  saveSettings: async (patch) => {
    const s = await api.updateSettings(patch);
    set({ settings: s, soundEnabled: !!s.sound_enabled });
  },

  toggleTheme: () => {
    const theme: Theme = get().theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem('theme', theme); } catch { /* ignore */ }
    set({ theme });
  },

  /** تسجيل إشعار في مركز الإشعارات — المكان الوحيد الذي يظهر فيه (بلا نوافذ منبثقة) */
  pushToast: (text, kind = 'info', action, meta) => {
    const id = ++toastId;
    if (toastId > 1_000_000) toastId = 1; // تجنب تضخم المعرّف عبر الجلسات الطويلة
    const notification: AppNotification = {
      id,
      ts: Date.now(),
      category: meta?.category ?? 'actions',
      severity: meta?.severity ?? (kind === 'alert' ? 'alert' : 'info'),
      symbol: meta?.symbol?.toUpperCase() ?? null,
      text,
      action,
      read: false
    };
    set((st) => {
      const notifications = [notification, ...st.notifications].slice(0, NOTIF_CAP);
      saveStoredNotifications(notifications);
      return {
        notifications,
        unreadNotifications: notifications.filter(n => !n.read).length
      };
    });
  },
  /** حذف إشعار واحد من جدول المركز */
  deleteNotification: (id) => set((st) => {
    const notifications = st.notifications.filter(n => n.id !== id);
    saveStoredNotifications(notifications);
    return { notifications, unreadNotifications: notifications.filter(n => !n.read).length };
  }),

  markAllNotificationsRead: () => set((st) => {
    if (st.unreadNotifications === 0) return st;
    const notifications = st.notifications.map(n => (n.read ? n : { ...n, read: true }));
    saveStoredNotifications(notifications);
    return { notifications, unreadNotifications: 0 };
  }),

  clearNotifications: () => {
    saveStoredNotifications([]);
    set({ notifications: [], unreadNotifications: 0 });
  },

  markNotificationRead: (id) => set((st) => {
    const target = st.notifications.find(n => n.id === id);
    if (!target || target.read) return st;
    const notifications = st.notifications.map(n => (n.id === id ? { ...n, read: true } : n));
    saveStoredNotifications(notifications);
    return { notifications, unreadNotifications: notifications.filter(n => !n.read).length };
  }),

  subscribePrice: (symbol) => {
    const s = get().streams;
    if (!s) return;
    const name = priceStreamName(symbol);
    if (priceUnsubs.has(name)) return;
    if (!priceFlushTimer) {
      priceFlushTimer = setInterval(() => {
        if (pendingPrices.size === 0) return;
        const batch = Object.fromEntries(pendingPrices);
        pendingPrices.clear();
        set((st) => ({ prices: { ...st.prices, ...batch } }));
      }, 600);
    }
    const unsub = s.subscribe(name, (data) => {
      const d = data as MiniTicker;
      const price = parseFloat(d.c);
      if (Number.isFinite(price)) {
        pendingPrices.set(d.s, price);
      }
    });
    priceUnsubs.set(name, unsub);
  },

  unsubscribePrice: (symbol) => {
    const name = priceStreamName(symbol);
    const unsub = priceUnsubs.get(name);
    if (unsub) {
      unsub();
      priceUnsubs.delete(name);
    }
  },

  subscribeKline: (symbol, interval, cb) => {
    const s = get().streams;
    if (!s) return () => {};
    const name = klineStreamName(symbol, interval);
    return s.subscribe(name, (data) => {
      const d = data as KlineMsg;
      if (!d?.k) return;
      cb({
        time: Math.floor(d.k.t / 1000),
        open: parseFloat(d.k.o),
        high: parseFloat(d.k.h),
        low: parseFloat(d.k.l),
        close: parseFloat(d.k.c)
      }, d.k.x);
    });
  },

  livePrice: (symbol) => get().prices[symbol] ?? null
}));

export function selectSortedRows(state: StoreState): SortResultRow[] {
  const inputs: SortInput[] = state.analyses.map(a => ({
    analysis: a,
    livePrice: state.prices[a.symbol] ?? null
  }));
  return sortAnalyses(inputs);
}
