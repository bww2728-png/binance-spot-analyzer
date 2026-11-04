import { create } from 'zustand';
import { api } from '../lib/api';
import type { BarcodeScan, ChartLevel, CoinShariahRow, Candle, Settings, ShariahResearch } from '../lib/types';
import { BinanceStreams, syncSymbols as syncSymbolsApi, fetchSpotSymbols, priceStreamName, klineStreamName, connectSymbolsSocket, pollSymbolsMeta, type MiniTicker, type KlineMsg, type SpotSymbol, type LiveOppTickRow, type LiveWatchTickRow, type SymbolsSocketState } from '../lib/binance';
import { evaluateShariah } from '../lib/shariah';

const API = '/api';

const rowVerdictAr = (v: string) => (v === 'halal' ? 'حلال' : v === 'haram' ? 'حرام' : 'للتحقق');

/** الشاشات الباقية بعد التنظيف + صفحة الفحص المخفي (#/syscheck) */
export type Screen = 'liquidityZones' | 'liquidityV2' | 'customLiquidity' | 'liveOpportunities' | 'strategy2' | 'dashboard';
export type Theme = 'dark' | 'light';

/**
 * شريحة حالة لكل شاشة: تُحفظ عند مغادرتها وتُستعاد عند إعادة فتحها.
 * الغرض أن لا يضيع الفلتر/الرمز/الفريم/التبويب الداخلي/التمرير عند التنقل،
 * حتى لو هُدم المكوّن (تجاوز سقف الشاشات المحمّلة في حاضن الشاشات).
 */
export interface ScreenState {
  filters: Record<string, string>;
  symbol: string;
  timeframe: string;
  tab: string;
  page: number;
  scrollTop: number;
}

const SCREENS: readonly Screen[] = ['liquidityZones', 'liquidityV2', 'customLiquidity', 'liveOpportunities', 'strategy2', 'dashboard'];
const LAST_SCREEN_KEY = 'last_screen';

/** الشاشة الافتتاحية: رابط مباشر > آخر شاشة محفوظة > الفرص الحية */
function initialScreen(): Screen {
  const h = location.hash.replace('#/', '');
  const fromHash = (h === 'syscheck' ? 'dashboard' : h) as Screen;
  if (SCREENS.includes(fromHash)) return fromHash;
  try {
    const saved = localStorage.getItem(LAST_SCREEN_KEY) as Screen | null;
    if (saved && SCREENS.includes(saved)) return saved;
  } catch { /* ignore */ }
  return 'liveOpportunities';
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
  prices: Record<string, number>;
  pricesUpdatedAt: number | null;
  settings: Settings | null;
  bootErrors: { settings: string | null; symbols: string | null };
  bootReady: boolean;
  screen: Screen;
  chartModal: { symbol: string; tfLower: string | null; tfUpper: string | null; levels?: ChartLevel[] } | null;
  streams: BinanceStreams | null;
  soundEnabled: boolean;
  syncing: boolean;
  lastSync: number;
  theme: Theme;
  /* شرائح حالة الشاشات — تُحفظ عند المغادرة وتُستعاد عند العودة */
  screenStates: Partial<Record<Screen, ScreenState>>;
  saveScreenState: (screen: Screen, patch: Partial<ScreenState>) => void;
  getScreenState: (screen: Screen) => ScreenState | undefined;
  /* اللقطة الحية للفرص المنشورة والمناطق قيد المراقبة (tick كل ثانية من الخادم عبر WS) */
  liveOppTick: { at: number; opportunities: Record<string, LiveOppTickRow>; watching: Record<string, LiveWatchTickRow> } | null;
  liveOppSocketState: SymbolsSocketState;
  liveOppEventsRevision: number;
  calibrationProgress: { done: number; total: number } | null;
  /* نبضة محرك «الفرص الحية — استراتيجيتي» عبر WS (تحديث لحظي للشاشة) */
  strategy2Pulse: { at: number; kind: string } | null;
  /* أسعار حية لكل فرصة منشورة من محرك الاستراتيجية (id → صف النبضة) */
  strategy2Rows: Record<string, { price: number | null; plPct: number | null; toTp1Pct: number | null; rNow: number | null; mfeR: number; ageSec: number }>;

  init: () => Promise<void>;
  retryBoot: () => Promise<void>;
  syncSymbols: () => Promise<void>;
  setScreen: (s: Screen) => void;
  openChart: (symbol: string, tfLower: string | null, tfUpper: string | null, levels?: ChartLevel[]) => void;
  closeChart: () => void;
  saveShariah: (symbol: string, row: Partial<CoinShariahRow>) => Promise<void>;
  researchShariahAuto: (symbol: string) => Promise<ShariahResearch>;
  deleteShariah: (symbol: string) => Promise<void>;
  saveSettings: (patch: Partial<Settings>) => Promise<void>;
  refreshSymbols: (opts?: { silent?: boolean }) => Promise<void>;
  toggleTheme: () => void;
  /* ملاحظات التشغيل تُكتب في كونسول المتصفح فقط — لا واجهة إشعارات ولا تخزين */
  pushToast: (text: string, ...rest: unknown[]) => void;
  subscribePrice: (symbol: string) => void;
  unsubscribePrice: (symbol: string) => void;
  subscribeKline: (symbol: string, interval: string, cb: (candle: Candle, closed: boolean) => void) => () => void;
  livePrice: (symbol: string) => number | null;
}

let streams: BinanceStreams | null = null;
let symbolsChannelStarted = false;
let lastLiveSocketState: SymbolsSocketState | null = null;
const priceUnsubs = new Map<string, () => void>();
/* تجميع نبضات الأسعار: الكتابة إلى خريطة مؤقتة ودفعة set() واحدة كل 600ms
 * بدل كتابة كاملة للمخزن عند كل رسالة miniTicker — يخفض إعادة رسم اللوحة من N/ثانية إلى دفعتين */
const pendingPrices = new Map<string, number>();
let priceFlushTimer: ReturnType<typeof setInterval> | null = null;

export const useStore = create<StoreState>((set, get) => ({
  symbols: [],
  symbolsLoaded: false,
  zoneCounts: null,
  barcodeScans: {},
  shariah: {},
  shariahLoaded: false,
  prices: {},
  pricesUpdatedAt: null,
  settings: null,
  bootErrors: { settings: null, symbols: null },
  bootReady: false,
  screen: initialScreen(),
  chartModal: null,
  streams: null,
  soundEnabled: true,
  syncing: false,
  lastSync: 0,
  theme: initialTheme(),
  screenStates: {},
  liveOppTick: null,
  liveOppSocketState: 'connecting',
  liveOppEventsRevision: 0,
  calibrationProgress: null,
  strategy2Pulse: null,
  strategy2Rows: {},

  init: async () => {
    if (!streams) {
      streams = new BinanceStreams();
      set({ streams });
    }
    const [barcodeResult, settingsResult] = await Promise.allSettled([
      api.getBarcodeScans(),
      api.getSettings()
    ]);
    const previous = get();
    const bootErrors = { ...previous.bootErrors };
    const barcodeMap: Record<string, BarcodeScan> = {};
    if (barcodeResult.status === 'fulfilled') {
      for (const scan of barcodeResult.value) barcodeMap[scan.symbol] = scan;
    }
    if (settingsResult.status === 'fulfilled') bootErrors.settings = null;
    else bootErrors.settings = String(settingsResult.reason);
    set({
      ...(barcodeResult.status === 'fulfilled' ? { barcodeScans: barcodeMap } : {}),
      ...(settingsResult.status === 'fulfilled' ? { settings: settingsResult.value ?? null } : {}),
      bootErrors,
      bootReady: true
    });
    const settings = settingsResult.status === 'fulfilled' ? settingsResult.value : get().settings;
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
    // جلب قائمة الأزواج المخزنة + تاريخ آخر مزامنة
    const quote = settings?.quote ?? 'USDT';
    try {
      const [syms, meta] = await Promise.all([
        fetchSpotSymbols(quote),
        fetch(`${API}/symbols/meta`).then(r => r.ok ? r.json() : { last_updated: 0 })
      ]);
      set({ symbols: syms, symbolsLoaded: true, lastSync: meta.last_updated ?? 0, bootErrors: { ...get().bootErrors, symbols: null } });
      // إن كانت القائمة فارغة: مزامنة تلقائية أولى
      if (syms.length === 0) {
        await get().syncSymbols();
      }
    } catch (e) {
      set({ bootErrors: { ...get().bootErrors, symbols: String(e) } });
      get().pushToast(`تعذر جلب قائمة العملات المخزنة: ${String(e)}`, 'alert', undefined, { category: 'system', severity: 'error' });
    }
    // قناة التحديث الآني: بث WebSocket + احتياطي دوري (الثنائي يضمن الوصول دائماً)
    if (!symbolsChannelStarted) {
      symbolsChannelStarted = true;
      connectSymbolsSocket((msg) => {
        if (msg.type === 'symbols_updated') void get().refreshSymbols({ silent: false });
        else if (msg.type === 'zones_changed' || msg.type === 'zones_auto_updated') void get().refreshZoneCounts();
        else if (msg.type === 'zone_near' && msg.zone && msg.symbol) {
          get().pushToast(`${msg.symbol}: السعر يقترب من منطقة ${msg.zone.type}${msg.zone.note ? ` — ${msg.zone.note}` : ''}`, 'alert', undefined, { category: 'zones', symbol: String(msg.symbol), severity: 'alert' });
        } else if (msg.type === 'zone_swept' && msg.zone && msg.symbol) {
          get().pushToast(`${msg.symbol}: سحب سيولة ${msg.zone.type} عند ${msg.zone.price}${msg.zone.note ? ` — ${msg.zone.note}` : ''}`, 'alert', undefined, { category: 'zones', symbol: String(msg.symbol), severity: 'alert' });
        } else if (msg.type === 'live_opportunity_new' && msg.opportunity) {
          const o = msg.opportunity as { symbol: string; timeframe: string; entry: number; stop: number; tp: number; rr: number; composite: number };
          get().pushToast(`فرصة شراء ${o.symbol} (${o.timeframe}) — دخول ${o.entry} · وقف ${o.stop} · هدف ${o.tp} · R:R ${o.rr} · درجة ${o.composite}`, 'alert', undefined, { category: 'liveOpps', symbol: o.symbol, severity: 'alert' });
          set((st) => ({ liveOppEventsRevision: st.liveOppEventsRevision + 1 }));
        } else if (msg.type === 'live_sweep_detected' && msg.symbol) {
          get().pushToast(`${msg.symbol} (${msg.timeframe}): سويب سيولة بيعية مكتشف — بانتظار الاستعادة`, 'info', undefined, { category: 'liveOpps', symbol: String(msg.symbol) });
        } else if (msg.type === 'live_opportunity_closed' && msg.opportunity) {
          const o = msg.opportunity as { symbol: string; timeframe: string; outcome: string };
          const win = o.outcome === 'target';
          get().pushToast(`نتيجة فرصة ${o.symbol} (${o.timeframe}): ${win ? 'وصلت الهدف' : 'ضربت الوقف'}`, win ? 'info' : 'alert', undefined, { category: 'liveOpps', symbol: o.symbol, severity: win ? 'info' : 'alert' });
          set((st) => ({ liveOppEventsRevision: st.liveOppEventsRevision + 1 }));
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
          get().pushToast(msg.persisted === true ? 'اكتملت معايرة الفرص الحية وحُفظت نتائجها' : 'اكتملت معايرة الفرص الحية، لكن لم يُؤكد حفظ نتائجها');
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
          const rows: Record<string, { price: number | null; plPct: number | null; toTp1Pct: number | null; rNow: number | null; mfeR: number; ageSec: number }> = {};
          for (const r of msg.opportunities ?? []) rows[r.id] = { price: r.price ?? null, plPct: r.plPct ?? null, toTp1Pct: (r as { toTp1Pct?: number | null }).toTp1Pct ?? null, rNow: r.rNow ?? null, mfeR: Number(r.mfeR ?? 0), ageSec: Number(r.ageSec ?? 0) };
          set({ strategy2Rows: rows, strategy2Pulse: { at: Date.now(), kind: 'strategy2_tick' } });
        } else if (msg.type === 'strategy2_state' || msg.type === 'strategy2_calibration_progress') {
          set({ strategy2Pulse: { at: Date.now(), kind: String(msg.type) } });
        } else if (msg.type === 'strategy2_calibration_done') {
          set({ strategy2Pulse: { at: Date.now(), kind: String(msg.type) } });
          get().pushToast(msg.persisted === true ? 'اكتملت معايرة استراتيجيتي وحُفظت نتائجها' : 'اكتملت معايرة استراتيجيتي، لكن لم يُؤكد حفظ نتائجها');
        } else if (msg.type === 'strategy2_directions' && Array.isArray(msg.changed)) {
          // نبضة اتجاهات: تُحفّز إعادة الجلب الصامتة في تبويب الاتجاهات (debounce 1 ث)
          set({ strategy2Pulse: { at: Date.now(), kind: 'strategy2_directions' } });
        } else if (msg.type === 'strategy2_feedback' && msg.feedback) {
          set({ strategy2Pulse: { at: Date.now(), kind: 'strategy2_feedback' } });
        } else if (msg.type === 'central_notification' && msg.notification) {
          const n = msg.notification;
          const text = [n.title, n.body].filter(Boolean).join(' — ') || 'إشعار';
          get().pushToast(text, n.severity === 'alert' ? 'alert' : 'info', undefined, { category: 'liveOpps', symbol: n.symbol, severity: n.severity === 'alert' ? 'alert' : 'info' });
          set({ strategy2Pulse: { at: Date.now(), kind: 'central_notification' } });
        } else if (msg.type === 'live_opportunities_control') {
          set((st) => ({ liveOppEventsRevision: st.liveOppEventsRevision + 1 }));
        }
      }, (state) => {
        const previous = lastLiveSocketState;
        lastLiveSocketState = state;
        set({ liveOppSocketState: state });
        if (previous === 'connected' && state === 'reconnecting') {
          get().pushToast('انقطع التحديث الحي مؤقتًا؛ سيعاد الاتصال تلقائيًا', 'alert', undefined, { category: 'liveOpps', severity: 'error' });
        } else if (previous === 'reconnecting' && state === 'connected') {
          get().pushToast('عاد اتصال التحديث الحي', 'info', undefined, { category: 'liveOpps', severity: 'info' });
        }
      });
      pollSymbolsMeta(60, () => void get().refreshSymbols({ silent: true }));
    }
    void get().refreshZoneCounts();
  },

  retryBoot: async () => {
    await get().init();
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
      set({ symbols: syms, symbolsLoaded: true, lastSync: meta.last_updated ?? 0, bootErrors: { ...get().bootErrors, symbols: null } });
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
      set({ symbols: syms, symbolsLoaded: true, lastSync: meta.last_updated ?? Date.now(), bootErrors: { ...get().bootErrors, symbols: null } });
      get().pushToast(`تم تحديث القائمة: ${r.saved}/${r.total} زوج`, 'info', undefined, { category: 'system' });
    } catch (e) {
      set({ bootErrors: { ...get().bootErrors, symbols: String(e) } });
      get().pushToast(`فشل تحديث القائمة من بينانس: ${String(e)}`, 'alert', undefined, { category: 'system', severity: 'error' });
    } finally {
      set({ syncing: false });
    }
  },

  setScreen: (s) => {
    set({ screen: s });
    // تذكّر آخر شاشة + رابط مباشر لكل تبويب (يشارك ويعمل زر الرجوع)
    try { localStorage.setItem(LAST_SCREEN_KEY, s); } catch { /* ignore */ }
    try { history.replaceState(null, '', `#/${s === 'dashboard' ? 'syscheck' : s}`); } catch { /* ignore */ }
  },

  openChart: (symbol, tfLower, tfUpper, levels) => set({ chartModal: { symbol, tfLower, tfUpper, levels } }),
  closeChart: () => set({ chartModal: null }),

  /** دمج جزئي في شريحة الشاشة — لا يمس بقية الحقول */
  saveScreenState: (screen, patch) => set((st) => {
    const prev = st.screenStates[screen] ?? { filters: {}, symbol: '', timeframe: '', tab: '', page: 0, scrollTop: 0 };
    return {
      screenStates: {
        ...st.screenStates,
        [screen]: { ...prev, ...patch, filters: { ...prev.filters, ...(patch.filters ?? {}) } }
      }
    };
  }),

  getScreenState: (screen) => get().screenStates[screen],

  saveShariah: async (symbol, row) => {
    const saved = await api.setShariah(symbol, row);
    set((st) => ({ shariah: { ...st.shariah, [symbol]: saved } }));
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

  /** ملاحظات تشغيلية تُكتب في كونسول المتصفح فقط — نظام الإشعارات حُذف كلياً */
  pushToast: (text, ...rest) => {
    console.info('[note]', text, ...(rest.length ? rest : []));
  },

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
        set((st) => ({ prices: { ...st.prices, ...batch }, pricesUpdatedAt: Date.now() }));
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
