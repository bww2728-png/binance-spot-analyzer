import { create } from 'zustand';
import { api } from '../lib/api';
import type { Analysis, CoinFlag, CoinShariahRow, Candle, Settings } from '../lib/types';
import type { SortResultRow, SortInput } from '../lib/sorting';
import { sortAnalyses } from '../lib/sorting';
import { BinanceStreams, syncSymbols as syncSymbolsApi, fetchSpotSymbols, priceStreamName, klineStreamName, connectSymbolsSocket, pollSymbolsMeta, detectBarcode, type MiniTicker, type KlineMsg, type SpotSymbol } from '../lib/binance';

const API = '/api';

export type Screen = 'board' | 'dashboard' | 'settings';
export type Theme = 'dark' | 'light';

function initialTheme(): Theme {
  const t = document.documentElement.dataset.theme;
  return t === 'light' ? 'light' : 'dark';
}

interface StoreState {
  symbols: SpotSymbol[];
  symbolsLoaded: boolean;
  flags: Record<string, CoinFlag>;
  shariah: Record<string, CoinShariahRow>;
  shariahLoaded: boolean;
  analyses: Analysis[];
  prices: Record<string, number>;
  settings: Settings | null;
  screen: Screen;
  chartModal: { symbol: string; tfLower: string | null; tfUpper: string | null } | null;
  toasts: { id: number; text: string; kind: 'info' | 'alert' }[];
  streams: BinanceStreams | null;
  soundEnabled: boolean;
  syncing: boolean;
  lastSync: number;
  theme: Theme;

  init: () => Promise<void>;
  syncSymbols: () => Promise<void>;
  setScreen: (s: Screen) => void;
  openChart: (symbol: string, tfLower: string | null, tfUpper: string | null) => void;
  closeChart: () => void;
  addAnalysis: (symbol: string) => Promise<void>;
  updateAnalysis: (id: number, patch: Partial<Analysis>) => Promise<void>;
  deleteAnalysis: (id: number) => Promise<void>;
  setFlag: (symbol: string, patch: { halal?: boolean; barcode?: boolean }) => Promise<void>;
  refreshSymbols: (opts?: { silent?: boolean }) => Promise<void>;
  saveShariah: (symbol: string, row: Partial<CoinShariahRow>) => Promise<void>;
  deleteShariah: (symbol: string) => Promise<void>;
  saveSettings: (patch: Partial<Settings>) => Promise<void>;
  toggleTheme: () => void;
  pushToast: (text: string, kind?: 'info' | 'alert') => void;
  dismissToast: (id: number) => void;
  subscribePrice: (symbol: string) => void;
  unsubscribePrice: (symbol: string) => void;
  subscribeKline: (symbol: string, interval: string, cb: (candle: Candle, closed: boolean) => void) => () => void;
  livePrice: (symbol: string) => number | null;
}

let streams: BinanceStreams | null = null;
let toastId = 0;
let symbolsChannelStarted = false;
const priceUnsubs = new Map<string, () => void>();

export const useStore = create<StoreState>((set, get) => ({
  symbols: [],
  symbolsLoaded: false,
  flags: {},
  shariah: {},
  shariahLoaded: false,
  analyses: [],
  prices: {},
  settings: null,
  screen: 'board',
  chartModal: null,
  toasts: [],
  streams: null,
  soundEnabled: true,
  syncing: false,
  lastSync: 0,
  theme: initialTheme(),

  init: async () => {
    if (!streams) {
      streams = new BinanceStreams();
      set({ streams });
    }
    const [flags, analyses, settings] = await Promise.all([
      api.getCoinFlags(),
      api.getAnalyses(),
      api.getSettings()
    ]);
    const flagMap: Record<string, CoinFlag> = {};
    for (const f of flags) flagMap[f.symbol] = f;
    set({ flags: flagMap, analyses, settings: settings ?? null });
    // شريعة: لا تُفشل init إذا تعذر الجدول
    try {
      const sh = await api.getShariah();
      const shMap: Record<string, CoinShariahRow> = {};
      for (const r of sh) shMap[r.symbol] = r;
      set({ shariah: shMap, shariahLoaded: true });
    } catch { set({ shariahLoaded: true }); }
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
      get().pushToast(`تعذر جلب قائمة العملات المخزنة: ${String(e)}`, 'alert');
    }
    // قناة التحديث الآني: بث WebSocket + احتياطي دوري (الثنائي يضمن الوصول دائماً)
    if (!symbolsChannelStarted) {
      symbolsChannelStarted = true;
      connectSymbolsSocket((msg) => {
        if (msg.type === 'symbols_updated') void get().refreshSymbols({ silent: false });
      });
      pollSymbolsMeta(60, () => void get().refreshSymbols({ silent: true }));
    }
    // اشتراك بأسعار كل العملات المحللة
    for (const a of analyses) get().subscribePrice(a.symbol);
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
          `أُضيفت ${newBases.length} عملة جديدة إلى القائمة: ${shown}${newBases.length > 8 ? '…' : ''}`
        );
      } else if (!opts?.silent) {
        get().pushToast('القائمة محدثة بالفعل — لا عملات جديدة');
      }
    } catch (e) {
      if (!opts?.silent) get().pushToast(`تعذر تحديث القائمة: ${String(e)}`, 'alert');
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
      get().pushToast(`تم تحديث القائمة: ${r.saved}/${r.total} زوج`);
    } catch (e) {
      get().pushToast(`فشل تحديث القائمة من بينانس: ${String(e)}`, 'alert');
    } finally {
      set({ syncing: false });
    }
  },

  setScreen: (s) => set({ screen: s }),

  openChart: (symbol, tfLower, tfUpper) => set({ chartModal: { symbol, tfLower, tfUpper } }),
  closeChart: () => set({ chartModal: null }),

  addAnalysis: async (symbol) => {
    const row = await api.createAnalysis({ symbol: symbol.toUpperCase() });
    set((st) => ({ analyses: [row, ...st.analyses] }));
    get().subscribePrice(row.symbol);
    // فحص باركود تلقائي فور الإضافة: الوسم الحتمي إن وُجد النمط (بلا تدخل يدوي)
    void detectBarcode(row.symbol).then(({ barcode }) => {
      if (barcode) {
        void get().setFlag(row.symbol, { barcode: true });
        get().pushToast(`${row.symbol}: نمط «باركود» على فريم الدقيقة — وُسمت تلقائياً (يمكن مراجعة الوسم من الإعدادات)`);
      }
    }).catch(() => { /* الفحص لا يمنع الإضافة */ });
  },

  updateAnalysis: async (id, patch) => {
    set((st) => ({
      analyses: st.analyses.map(a => a.id === id ? { ...a, ...patch } : a)
    }));
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
    if (a) get().unsubscribePrice(a.symbol);
    await api.deleteAnalysis(id);
  },

  setFlag: async (symbol, patch) => {
    const row = await api.setCoinFlag(symbol, patch);
    set((st) => ({ flags: { ...st.flags, [symbol]: row } }));
  },

  saveShariah: async (symbol, row) => {
    const saved = await api.setShariah(symbol, row);
    set((st) => ({ shariah: { ...st.shariah, [symbol]: saved } }));
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

  pushToast: (text, kind = 'info') => {
    const id = ++toastId;
    set((st) => ({ toasts: [...st.toasts, { id, text, kind }] }));
    setTimeout(() => get().dismissToast(id), 8000);
  },
  dismissToast: (id) => set((st) => ({ toasts: st.toasts.filter(t => t.id !== id) })),

  subscribePrice: (symbol) => {
    const s = get().streams;
    if (!s) return;
    const name = priceStreamName(symbol);
    if (priceUnsubs.has(name)) return;
    const unsub = s.subscribe(name, (data) => {
      const d = data as MiniTicker;
      const price = parseFloat(d.c);
      if (Number.isFinite(price)) {
        set((st) => ({ prices: { ...st.prices, [d.s]: price } }));
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
