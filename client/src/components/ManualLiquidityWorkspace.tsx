import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { TIMEFRAMES } from '../lib/types';
import {
  calculateAtr,
  deleteManualDrawing,
  fetchManualCandles,
  fetchManualDrawings,
  saveManualDrawing,
  type ManualCandle,
  type ManualDrawing,
  type ManualDrawingType,
  type ManualPoint
} from '../lib/manualLiquidity';
import { clearPendingManualMutation, listPendingManualMutations, queueManualMutation } from '../lib/manualDrawingOutbox';
import ManualLiquidityChart from './ManualLiquidityChart';
import './ManualLiquidityWorkspace.css';

type SaveState = 'idle' | 'loading' | 'saved' | 'saving' | 'failed' | 'unsaved';
type HistoryEntry = { before: ManualDrawing[]; after: ManualDrawing[] };
type Mutation = { operation: 'save' | 'delete'; drawingId: string; drawing: ManualDrawing | null };

const SYMBOL_KEY = 'legacy-manual-liquidity-symbol-v1';
const TIMEFRAME_KEY = 'legacy-manual-liquidity-timeframe-v1';
const COLOR_DEFAULTS: Record<string, string> = { BSL: '#f23645', SSL: '#089981', breakWick: '#f59e0b', breakClose: '#2563eb', note: '#94a3b8' };
const makeId = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
const sameDrawing = (a: ManualDrawing, b: ManualDrawing) => JSON.stringify(a) === JSON.stringify(b);
const timeframeSeconds = (timeframe: string) => {
  const value = Number(timeframe.slice(0, -1));
  const unit = timeframe.slice(-1);
  return value * (unit === 'm' ? 60 : unit === 'h' ? 3600 : unit === 'd' ? 86400 : unit === 'w' ? 604800 : 60);
};
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const samePoint = (a: ManualPoint, b: ManualPoint) => a.time === b.time && Math.abs(a.price - b.price) < Math.max(1e-9, Math.abs(a.price) * 1e-9);

export default function ManualLiquidityWorkspace() {
  const [open, setOpen] = useState(false);
  const [symbolInput, setSymbolInput] = useState(() => localStorage.getItem(SYMBOL_KEY) ?? 'BTCUSDT');
  const [symbol, setSymbol] = useState(() => (localStorage.getItem(SYMBOL_KEY) ?? 'BTCUSDT').toUpperCase());
  const [timeframe, setTimeframe] = useState(() => {
    const saved = localStorage.getItem(TIMEFRAME_KEY);
    return TIMEFRAMES.includes(saved as (typeof TIMEFRAMES)[number]) ? saved as string : '15m';
  });
  const [candleData, setCandleData] = useState<{ candles: ManualCandle[]; pages: number; gaps: number; incompleteBars: number; hasOlder: boolean; nextBefore: number | null } | null>(null);
  const [candlesLoading, setCandlesLoading] = useState(false);
  const [olderLoading, setOlderLoading] = useState(false);
  const [candlesError, setCandlesError] = useState('');
  const [drawings, setDrawings] = useState<ManualDrawing[]>([]);
  const [drawingsLoading, setDrawingsLoading] = useState(false);
  const [drawingsError, setDrawingsError] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [activeTool, setActiveTool] = useState<ManualDrawingType | 'select'>('select');
  const [liquidityType, setLiquidityType] = useState<'BSL' | 'SSL'>('BSL');
  const [breakType, setBreakType] = useState<'wick' | 'close'>('wick');
  const [activeColor, setActiveColor] = useState(COLOR_DEFAULTS.note);
  const [labelDraft, setLabelDraft] = useState('');
  const [noteDraft, setNoteDraft] = useState('');
  const [atrPeriod, setAtrPeriod] = useState(14);
  const [atrMultiplier, setAtrMultiplier] = useState(2);
  const [zoneBoundary, setZoneBoundary] = useState('');
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [saveMessage, setSaveMessage] = useState('');
  const [hoverCandle, setHoverCandle] = useState<ManualCandle | null>(null);
  const [historyRevision, setHistoryRevision] = useState(0);
  const historyRef = useRef<{ undo: HistoryEntry[]; redo: HistoryEntry[] }>({ undo: [], redo: [] });
  const pendingRef = useRef(new Map<string, Mutation>());
  const inFlightRef = useRef(new Map<string, { mutation: Mutation; promise: Promise<boolean> }>());
  const scheduledRef = useRef(new Map<string, { symbol: string; timeframe: string; mutation: Mutation }>());
  const timersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const drawingsRef = useRef(drawings);
  const moveOriginRef = useRef(new Map<string, ManualDrawing>());
  drawingsRef.current = drawings;
  const activeContextRef = useRef({ symbol, timeframe });
  activeContextRef.current = { symbol, timeframe };

  const selectedDrawing = useMemo(() => drawings.find((drawing) => drawing.id === selectedId) ?? null, [drawings, selectedId]);
  const closedCandles = useMemo(() => (candleData?.candles ?? []).filter((candle) => candle.complete), [candleData]);
  const atr = useMemo(() => calculateAtr(closedCandles, atrPeriod), [closedCandles, atrPeriod]);
  const pendingCount = pendingRef.current.size;
  const latestTime = candleData?.candles.at(-1)?.time ?? null;

  const applyMutation = useCallback((currentSymbol: string, currentTimeframe: string, mutation: Mutation) => {
    const key = `${currentSymbol}|${currentTimeframe}|${mutation.drawingId}`;
    const existing = inFlightRef.current.get(key);
    if (existing?.mutation === mutation) return existing.promise;
    const previous = existing?.promise ?? Promise.resolve(true);
    const promise = previous.catch(() => false).then(async () => {
      try {
        if (mutation.operation === 'save' && mutation.drawing) await saveManualDrawing(currentSymbol, currentTimeframe, mutation.drawing);
        else await deleteManualDrawing(currentSymbol, currentTimeframe, mutation.drawingId);
        pendingRef.current.delete(key);
        if (scheduledRef.current.get(key)?.mutation === mutation) scheduledRef.current.delete(key);
        await clearPendingManualMutation(currentSymbol, currentTimeframe, mutation.drawingId).catch(() => undefined);
        if (activeContextRef.current.symbol === currentSymbol && activeContextRef.current.timeframe === currentTimeframe && pendingRef.current.size === 0) {
          setSaveState('saved');
          setSaveMessage('حُفظت التغييرات على الخادم');
        }
        return true;
      } catch (error) {
        pendingRef.current.set(key, mutation);
        await queueManualMutation({ ...mutation, symbol: currentSymbol, timeframe: currentTimeframe }).catch(() => undefined);
        if (activeContextRef.current.symbol === currentSymbol && activeContextRef.current.timeframe === currentTimeframe) {
          setSaveState('failed');
          setSaveMessage(`لم يؤكد الخادم الحفظ؛ ستتم إعادة المحاولة: ${errorText(error)}`);
        }
        return false;
      }
    });
    inFlightRef.current.set(key, { mutation, promise });
    void promise.finally(() => {
      if (inFlightRef.current.get(key)?.promise === promise) inFlightRef.current.delete(key);
    });
    return promise;
  }, []);

  const queuePersist = useCallback((previous: ManualDrawing[], next: ManualDrawing[], currentSymbol = symbol, currentTimeframe = timeframe) => {
    const before = new Map(previous.map((drawing) => [drawing.id, drawing]));
    const after = new Map(next.map((drawing) => [drawing.id, drawing]));
    const mutations: Mutation[] = [];
    for (const [id, drawing] of after) {
      if (!before.has(id) || !sameDrawing(before.get(id)!, drawing)) mutations.push({ operation: 'save', drawingId: id, drawing });
    }
    for (const id of before.keys()) if (!after.has(id)) mutations.push({ operation: 'delete', drawingId: id, drawing: null });
    if (!mutations.length) return;
    setSaveState('saving');
    setSaveMessage(`جارٍ حفظ ${mutations.length} تغيير على الخادم`);
    for (const mutation of mutations) {
      const key = `${currentSymbol}|${currentTimeframe}|${mutation.drawingId}`;
      scheduledRef.current.set(key, { symbol: currentSymbol, timeframe: currentTimeframe, mutation });
      void queueManualMutation({ ...mutation, symbol: currentSymbol, timeframe: currentTimeframe }).catch((error) => {
        if (activeContextRef.current.symbol === currentSymbol && activeContextRef.current.timeframe === currentTimeframe) {
          setSaveState('unsaved');
          setSaveMessage(`تعذر حفظ النسخة المؤقتة؛ جارٍ محاولة الخادم: ${errorText(error)}`);
        }
      });
      const existingTimer = timersRef.current.get(key);
      if (existingTimer) clearTimeout(existingTimer);
      timersRef.current.set(key, setTimeout(() => {
        timersRef.current.delete(key);
        const scheduled = scheduledRef.current.get(key);
        if (!scheduled) return;
        scheduledRef.current.delete(key);
        void applyMutation(scheduled.symbol, scheduled.timeframe, scheduled.mutation);
      }, 300));
    }
  }, [applyMutation, symbol, timeframe]);

  const updateDrawings = useCallback((next: ManualDrawing[], recordUndo = true, persist = true) => {
    const previous = drawingsRef.current;
    if (recordUndo) {
      historyRef.current.undo = [...historyRef.current.undo.slice(-99), { before: previous, after: next }];
      historyRef.current.redo = [];
      setHistoryRevision((revision) => revision + 1);
    }
    if (persist) queuePersist(previous, next);
    drawingsRef.current = next;
    setDrawings(next);
  }, [queuePersist]);

  const loadContext = useCallback(async (currentSymbol: string, currentTimeframe: string) => {
    const controller = new AbortController();
    setCandlesLoading(true);
    setCandlesError('');
    setDrawingsLoading(true);
    setDrawingsError('');
    setSaveState('loading');
    const [candleResult, drawingsResult] = await Promise.allSettled([
      fetchManualCandles(currentSymbol, currentTimeframe, controller.signal),
      fetchManualDrawings(currentSymbol, currentTimeframe, controller.signal)
    ]);
    if (activeContextRef.current.symbol !== currentSymbol || activeContextRef.current.timeframe !== currentTimeframe) return () => controller.abort();
    if (candleResult.status === 'fulfilled') {
      setCandleData({ candles: candleResult.value.candles, pages: candleResult.value.pages, gaps: candleResult.value.gaps, incompleteBars: candleResult.value.incompleteBars, hasOlder: candleResult.value.hasOlder, nextBefore: candleResult.value.nextBefore });
      setCandlesError('');
    } else {
      setCandlesError(errorText(candleResult.reason));
      setCandleData(null);
    }
    setCandlesLoading(false);
    if (drawingsResult.status === 'fulfilled') {
      setDrawings(drawingsResult.value.drawings);
      setSelectedId(null);
      setDrawingsError('');
      setSaveState('saved');
      setSaveMessage(`${drawingsResult.value.drawings.length} رسم مستعاد من التخزين الدائم`);
      const pending = await listPendingManualMutations(currentSymbol, currentTimeframe).catch(() => []);
      for (const record of pending) {
        const mutation: Mutation = { operation: record.operation, drawingId: record.drawingId, drawing: record.drawing };
        pendingRef.current.set(`${currentSymbol}|${currentTimeframe}|${mutation.drawingId}`, mutation);
      }
      if (pending.length) {
        setDrawings((current) => {
          let next = [...current];
          for (const record of pending) {
            if (record.operation === 'delete') next = next.filter((drawing) => drawing.id !== record.drawingId);
            else if (record.drawing) next = [...next.filter((drawing) => drawing.id !== record.drawingId), record.drawing];
          }
          return next;
        });
        await Promise.all(pending.map((record) => applyMutation(currentSymbol, currentTimeframe, { operation: record.operation, drawingId: record.drawingId, drawing: record.drawing })));
      }
    } else {
      setDrawingsError(`تعذرت قراءة الرسومات المحفوظة، ولم تُعامل كقائمة فارغة: ${errorText(drawingsResult.reason)}`);
      setSaveState('failed');
      setSaveMessage('تعذرت استعادة الرسومات؛ لا ترسم قبل نجاح إعادة القراءة لتجنب الكتابة فوق بيانات غير محملة');
    }
    setDrawingsLoading(false);
    return () => controller.abort();
  }, [applyMutation]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void loadContext(symbol, timeframe).then((cleanup) => { if (cancelled) cleanup?.(); });
    return () => { cancelled = true; };
  }, [open, symbol, timeframe, loadContext]);

  useEffect(() => {
    if (!open) return;
    const retry = () => {
      const context = activeContextRef.current;
      for (const [key, mutation] of pendingRef.current) {
        const [pendingSymbol, pendingTimeframe] = key.split('|');
        if (pendingSymbol === context.symbol && pendingTimeframe === context.timeframe) void applyMutation(pendingSymbol, pendingTimeframe, mutation);
      }
    };
    const interval = setInterval(retry, 5000);
    window.addEventListener('online', retry);
    return () => { clearInterval(interval); window.removeEventListener('online', retry); };
  }, [open, applyMutation]);

  useEffect(() => () => {
    for (const timer of timersRef.current.values()) clearTimeout(timer);
    timersRef.current.clear();
  }, []);

  const applyContext = () => {
    const normalized = symbolInput.trim().toUpperCase();
    if (!/^[A-Z0-9]{3,20}$/.test(normalized)) {
      setCandlesError('أدخل رمزاً صحيحاً مثل BTCUSDT');
      return;
    }
    setSymbol(normalized);
    setSymbolInput(normalized);
    localStorage.setItem(SYMBOL_KEY, normalized);
    localStorage.setItem(TIMEFRAME_KEY, timeframe);
  };

  const loadOlder = async () => {
    if (!candleData?.hasOlder || candleData.nextBefore == null || olderLoading) return;
    setOlderLoading(true);
    try {
      const page = await fetchManualCandles(symbol, timeframe, undefined, candleData.nextBefore);
      if (activeContextRef.current.symbol !== symbol || activeContextRef.current.timeframe !== timeframe) return;
      setCandleData((current) => {
        if (!current) return current;
        const byTime = new Map(current.candles.map((candle) => [candle.time, candle]));
        for (const candle of page.candles) byTime.set(candle.time, candle);
        const candles = [...byTime.values()].sort((left, right) => left.time - right.time);
        let gaps = 0;
        for (let index = 1; index < candles.length; index += 1) {
          const delta = candles[index].time - candles[index - 1].time;
          if (delta > timeframeSeconds(timeframe)) gaps += Math.max(1, Math.round(delta / timeframeSeconds(timeframe)) - 1);
        }
        return { candles, pages: current.pages + page.pages, gaps, incompleteBars: candles.filter((candle) => !candle.complete).length, hasOlder: page.hasOlder, nextBefore: page.nextBefore };
      });
    } catch (error) {
      setCandlesError(`تعذر تحميل شموع أقدم: ${errorText(error)}`);
    } finally {
      setOlderLoading(false);
    }
  };

  const addDrawing = (drawing: ManualDrawing) => {
    if (drawingsLoading || Boolean(drawingsError)) {
      setSaveMessage('لم تُقرأ الرسومات المحفوظة بعد؛ أعد تحميل الرسومات قبل بدء الرسم');
      return;
    }
    setSelectedId(drawing.id);
    setLabelDraft(drawing.label);
    setNoteDraft(drawing.note);
    updateDrawings([...drawings, drawing]);
  };

  const updateSelected = (patch: Partial<ManualDrawing>) => {
    if (!selectedDrawing) return;
    updateDrawings(drawings.map((drawing) => drawing.id === selectedDrawing.id ? { ...drawing, ...patch } : drawing));
  };

  const moveAnchor = (drawingId: string, anchorIndex: number, point: ManualPoint) => {
    const current = drawingsRef.current.find((drawing) => drawing.id === drawingId);
    if (!current || !current.anchors[anchorIndex] || samePoint(current.anchors[anchorIndex], point)) return;
    if (!moveOriginRef.current.has(drawingId)) moveOriginRef.current.set(drawingId, current);
    const anchors = current.anchors.map((anchor, index) => index === anchorIndex ? point : anchor);
    const next = { ...current, anchors };
    updateDrawings(drawingsRef.current.map((drawing) => drawing.id === drawingId ? next : drawing), false, false);
    setSaveState('saving');
    setSaveMessage('تغيير موضع الرسم — جارٍ الحفظ عند إتمام السحب');
  };

  const finishMove = (drawingId: string) => {
    const before = moveOriginRef.current.get(drawingId);
    const after = drawingsRef.current.find((drawing) => drawing.id === drawingId);
    moveOriginRef.current.delete(drawingId);
    if (!before || !after || sameDrawing(before, after)) return;
    historyRef.current.undo = [...historyRef.current.undo.slice(-99), { before: drawingsRef.current.map((drawing) => drawing.id === drawingId ? before : drawing), after: drawingsRef.current }];
    historyRef.current.redo = [];
    setHistoryRevision((revision) => revision + 1);
    const key = `${symbol}|${timeframe}|${drawingId}`;
    const timer = timersRef.current.get(key);
    if (timer) clearTimeout(timer);
    timersRef.current.delete(key);
    scheduledRef.current.delete(key);
    void applyMutation(symbol, timeframe, { operation: 'save', drawingId, drawing: after });
  };

  const undo = () => {
    const entry = historyRef.current.undo.at(-1);
    if (!entry) return;
    historyRef.current.undo = historyRef.current.undo.slice(0, -1);
    historyRef.current.redo = [...historyRef.current.redo.slice(-99), entry];
    setHistoryRevision((revision) => revision + 1);
    setSelectedId(null);
    updateDrawings(entry.before, false);
  };
  const redo = () => {
    const entry = historyRef.current.redo.at(-1);
    if (!entry) return;
    historyRef.current.redo = historyRef.current.redo.slice(0, -1);
    historyRef.current.undo = [...historyRef.current.undo.slice(-99), entry];
    setHistoryRevision((revision) => revision + 1);
    setSelectedId(null);
    updateDrawings(entry.after, false);
  };

  const addArrowAt = (point: ManualPoint, method: 'manual' | 'swing' | 'atr', atrValue: number | null = null) => {
    const type: ManualDrawing = {
      id: makeId(), type: 'arrow', anchors: [point], color: liquidityType === 'BSL' ? '#f23645' : '#089981',
      label: liquidityType, note: '', liquidityType, created_at: Date.now(),
      atr: { period: atrPeriod, value: atrValue, multiplier: atrMultiplier, method }
    };
    addDrawing(type);
  };

  const addAtrLevel = () => {
    const boundary = Number(zoneBoundary);
    if (atr == null || !Number.isFinite(boundary) || boundary <= 0 || !latestTime) {
      setSaveMessage('لا يمكن حساب المستوى: تحقق من قيمة حد المنطقة والشموع الكافية لـATR');
      return;
    }
    const price = liquidityType === 'BSL' ? boundary + atr * atrMultiplier : boundary - atr * atrMultiplier;
    if (price <= 0) { setSaveMessage('السعر الناتج غير صالح؛ راجع معامل ATR وحد المنطقة'); return; }
    addArrowAt({ time: latestTime, price }, 'atr', atr);
  };

  const addSwingLevel = () => {
    if (!hoverCandle) { setSaveMessage('حرّك مؤشر الشارت إلى شمعة أولاً'); return; }
    addArrowAt({ time: hoverCandle.time, price: liquidityType === 'BSL' ? hoverCandle.high : hoverCandle.low }, 'swing');
  };

  const deleteSelected = () => {
    if (!selectedId) return;
    updateDrawings(drawings.filter((drawing) => drawing.id !== selectedId));
    setSelectedId(null);
  };
  const clearAll = () => {
    if (!drawings.length || !window.confirm(`تأكيد حذف جميع الرسومات (${drawings.length}) من ${symbol} · ${timeframe}؟`)) return;
    updateDrawings([]);
    setSelectedId(null);
  };

  const statusColor = saveState === 'saved' ? '#059669' : saveState === 'failed' || saveState === 'unsaved' ? '#b91c1c' : '#b45309';
  const historyCanUndo = historyRef.current.undo.length > 0;
  const historyCanRedo = historyRef.current.redo.length > 0;
  void historyRevision;

  return <section className="rounded-xl border p-3 sm:p-4 space-y-3" style={{ borderColor: 'var(--border-1)', background: 'var(--surface-1)' }} dir="rtl">
    <header className="flex flex-wrap items-center justify-between gap-3">
      <div><h2 className="text-base font-bold" style={{ color: 'var(--text-1)' }}>مساحة الرسم والتحليل اليدوي</h2><p className="mt-1 text-[11px]" style={{ color: 'var(--text-3)' }}>الشارت مستقل عن فلاتر المحرك. الرسومات لا تدخل في كشف BSL/SSL. الحفظ على مستوى النظام مشترك لكل زواره.</p></div>
      <div className="flex items-center gap-2"><span className="text-xs font-semibold" role="status" style={{ color: statusColor }}>{saveState === 'saving' ? 'جارٍ الحفظ…' : saveState === 'saved' ? 'تم الحفظ' : saveState === 'failed' ? 'فشل الحفظ' : saveState === 'loading' ? 'جارٍ الاستعادة…' : saveState === 'unsaved' ? 'تغييرات غير محفوظة' : 'الحفظ تلقائي'}</span><button type="button" className="btn btn-secondary text-xs" onClick={() => setOpen((value) => !value)}>{open ? 'إخفاء مساحة الرسم' : 'فتح مساحة الرسم'}</button></div>
    </header>
    {saveMessage && <div className="text-[11px]" role="status" style={{ color: statusColor }}>{saveMessage}{pendingCount > 0 ? ` · ${pendingCount} تغيير بانتظار إعادة المحاولة` : ''}</div>}
    {open && <>
      <div className="manual-chart-controls flex flex-wrap items-end gap-2 rounded-lg p-2" style={{ background: 'var(--surface-0)' }}>
        <label className="grid gap-1 text-[10px]" style={{ color: 'var(--text-3)' }}>الرمز<input value={symbolInput} onChange={(event) => setSymbolInput(event.target.value.toUpperCase())} onKeyDown={(event) => { if (event.key === 'Enter') applyContext(); }} className="w-36 rounded border px-2 text-xs" style={{ borderColor: 'var(--border-1)', background: 'var(--surface-1)', color: 'var(--text-1)' }} /></label>
        <label className="grid gap-1 text-[10px]" style={{ color: 'var(--text-3)' }}>الفريم<select value={timeframe} onChange={(event) => { setTimeframe(event.target.value); localStorage.setItem(TIMEFRAME_KEY, event.target.value); }} className="rounded border px-2 text-xs" style={{ borderColor: 'var(--border-1)', background: 'var(--surface-1)', color: 'var(--text-1)' }}>{TIMEFRAMES.map((frame) => <option key={frame}>{frame}</option>)}</select></label>
        <button type="button" className="btn btn-primary text-xs" onClick={applyContext} disabled={candlesLoading}>تطبيق الشارت</button>
        <button type="button" className="btn btn-secondary text-xs" onClick={() => void loadContext(symbol, timeframe)} disabled={candlesLoading}>{candlesLoading ? 'جارٍ التحميل…' : 'تحديث البيانات'}</button>
        <span>حتى 90 يوماً متاحاً · تحميل أقدم 1,000 شمعة تدريجياً</span>
      </div>
      {candlesError && <div role="alert" className="rounded border p-2 text-xs" style={{ borderColor: '#ef4444', color: '#b91c1c' }}>{candlesError}<button type="button" className="mr-2 underline" onClick={() => void loadContext(symbol, timeframe)}>إعادة المحاولة</button></div>}
      {drawingsError && <div role="alert" className="rounded border p-2 text-xs" style={{ borderColor: '#ef4444', color: '#b91c1c' }}>{drawingsError}<button type="button" className="mr-2 underline" onClick={() => void loadContext(symbol, timeframe)}>إعادة قراءة المحفوظات</button></div>}
      {candleData && <>
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-[10px]" style={{ color: 'var(--text-3)' }}>
          <span dir="ltr">{symbol} · {timeframe}</span><span>{candleData.candles.length.toLocaleString('en-US')} شمعة / {candleData.pages} صفحة</span>
          <span>من {new Date((candleData.candles[0]?.time ?? 0) * 1000).toLocaleString('ar')} إلى {new Date((candleData.candles.at(-1)?.time ?? 0) * 1000).toLocaleString('ar')}</span>
          {candleData.hasOlder && <button type="button" className="underline" style={{ color: 'var(--accent)' }} onClick={() => void loadOlder()} disabled={olderLoading}>{olderLoading ? 'جارٍ تحميل شموع أقدم…' : 'تحميل أقدم 1,000 شمعة'}</button>}
          {candleData.gaps > 0 && <span style={{ color: '#b45309' }}>فجوات مرصودة: {candleData.gaps}</span>}
          {candleData.incompleteBars > 0 && <span style={{ color: '#b45309' }}>شموع جارية: {candleData.incompleteBars} — غير مكتملة</span>}
          {candleData.gaps === 0 && <span style={{ color: '#059669' }}>لا فجوات مرصودة</span>}
        </div>
        <div className="manual-chart-toolbar flex flex-wrap items-center gap-1 rounded-lg p-2" style={{ background: 'var(--surface-0)' }}>
          {([['select', 'تحديد'], ['line', 'خط/تلامسات'], ['circle', 'دائرة/قمة/قاع'], ['arrow', 'سهم BSL/SSL'], ['break', 'خط كسر'], ['rectangle', 'مستطيل'], ['text', 'نص/ملاحظة']] as Array<[ManualDrawingType | 'select', string]>).map(([tool, label]) => <button type="button" key={tool} aria-pressed={activeTool === tool} className="rounded px-2 py-1.5 text-[10px] font-semibold" style={{ background: activeTool === tool ? 'var(--accent-soft)' : 'var(--surface-1)', color: activeTool === tool ? 'var(--accent)' : 'var(--text-2)', border: '1px solid var(--border-1)' }} onClick={() => { setActiveTool(tool); setSelectedId(null); }}>{label}</button>)}
          <button type="button" className="btn btn-secondary text-[10px]" onClick={undo} disabled={!historyCanUndo}>تراجع</button>
          <button type="button" className="btn btn-secondary text-[10px]" onClick={redo} disabled={!historyCanRedo}>إعادة</button>
          <button type="button" className="btn btn-secondary text-[10px]" onClick={deleteSelected} disabled={!selectedId}>حذف المحدد</button>
          <button type="button" className="btn btn-secondary text-[10px]" onClick={clearAll} disabled={!drawings.length}>مسح الكل…</button>
          <label className="flex items-center gap-1 text-[10px]" style={{ color: 'var(--text-3)' }}>اللون<input type="color" aria-label="لون الرسم" value={activeColor} onChange={(event) => { setActiveColor(event.target.value); if (selectedDrawing) updateSelected({ color: event.target.value }); }} /></label>
          {activeTool === 'arrow' && <select aria-label="نوع السيولة" value={liquidityType} onChange={(event) => setLiquidityType(event.target.value as 'BSL' | 'SSL')} className="rounded border px-2 py-1 text-[10px]" style={{ color: 'var(--text-1)', background: 'var(--surface-1)', borderColor: 'var(--border-1)' }}><option value="BSL">BSL · أحمر</option><option value="SSL">SSL · أخضر</option></select>}
          {activeTool === 'break' && <select aria-label="نوع الكسر" value={breakType} onChange={(event) => setBreakType(event.target.value as 'wick' | 'close')} className="rounded border px-2 py-1 text-[10px]" style={{ color: 'var(--text-1)', background: 'var(--surface-1)', borderColor: 'var(--border-1)' }}><option value="wick">كسر ذيل · برتقالي</option><option value="close">كسر إغلاق · أزرق</option></select>}
        </div>
        <ManualLiquidityChart candles={candleData.candles} drawings={drawings} activeTool={activeTool} activeLiquidity={liquidityType} activeBreakType={breakType} activeColor={activeColor} onCreate={addDrawing} onSelect={setSelectedId} onMoveAnchor={moveAnchor} onMoveEnd={finishMove} onHoverCandle={setHoverCandle} timeframeSeconds={timeframeSeconds(timeframe)} />
        <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_300px]">
          <section className="rounded-lg p-3" style={{ background: 'var(--surface-0)' }}>
            <div className="mb-2 flex items-center justify-between"><h3 className="text-xs font-bold" style={{ color: 'var(--text-1)' }}>قائمة الرسومات · {drawings.length}</h3><span className="text-[10px]" style={{ color: 'var(--text-3)' }}>مرتبة بأحدث تعديل</span></div>
            {!drawings.length ? <p className="py-4 text-center text-xs" style={{ color: 'var(--text-3)' }}>لا توجد رسومات محفوظة لهذا الرمز والفريم.</p> : <ul className="max-h-52 space-y-1 overflow-auto">{[...drawings].reverse().map((drawing) => <li key={drawing.id}><button type="button" onClick={() => { setSelectedId(drawing.id); setActiveTool('select'); setLabelDraft(drawing.label); setNoteDraft(drawing.note); setActiveColor(drawing.color); }} className="flex w-full items-center justify-between gap-2 rounded border px-2 py-1.5 text-right text-[10px]" style={{ borderColor: selectedId === drawing.id ? 'var(--accent)' : 'var(--border-1)', color: 'var(--text-2)' }}><span><i className="ml-1 inline-block h-2 w-2 rounded-full" style={{ background: drawing.color }} />{drawing.label || drawing.liquidityType || drawing.type} · {drawing.type}</span><span className="font-mono" dir="ltr">{drawing.anchors[0]?.price.toPrecision(8)}</span></button></li>)}</ul>}
          </section>
          <section className="space-y-3 rounded-lg p-3" style={{ background: 'var(--surface-0)' }}>
            <h3 className="text-xs font-bold" style={{ color: 'var(--text-1)' }}>تعديل المحدد · {selectedDrawing ? selectedDrawing.type : 'لا يوجد'}</h3>
            <label className="grid gap-1 text-[10px]" style={{ color: 'var(--text-3)' }}>التسمية<input value={selectedDrawing?.label ?? labelDraft} onChange={(event) => { setLabelDraft(event.target.value); updateSelected({ label: event.target.value }); }} maxLength={240} className="rounded border px-2 py-1 text-xs" style={{ borderColor: 'var(--border-1)', background: 'var(--surface-1)', color: 'var(--text-1)' }} /></label>
            <label className="grid gap-1 text-[10px]" style={{ color: 'var(--text-3)' }}>ملاحظة<textarea value={selectedDrawing?.note ?? noteDraft} onChange={(event) => { setNoteDraft(event.target.value); updateSelected({ note: event.target.value }); }} maxLength={2000} rows={2} className="rounded border px-2 py-1 text-xs" style={{ borderColor: 'var(--border-1)', background: 'var(--surface-1)', color: 'var(--text-1)' }} /></label>
            {selectedDrawing?.type === 'rectangle' && <label className="grid gap-1 text-[10px]" style={{ color: 'var(--text-3)' }}>شفافية المنطقة<input type="range" min="0.05" max="0.8" step="0.05" value={selectedDrawing.fillOpacity ?? 0.18} onChange={(event) => updateSelected({ fillOpacity: Number(event.target.value) })} /></label>}
            {selectedDrawing?.type === 'circle' && <label className="grid gap-1 text-[10px]" style={{ color: 'var(--text-3)' }}>حجم الدائرة<input type="range" min="1" max="100" step="1" value={selectedDrawing.radiusBars ?? 4} onChange={(event) => updateSelected({ radiusBars: Number(event.target.value) })} /></label>}
            {selectedDrawing && <div className="text-[9px]" style={{ color: 'var(--text-3)' }}>الموضع: {new Date(selectedDrawing.anchors[0].time * 1000).toLocaleString('ar')} · السعر {selectedDrawing.anchors[0].price}</div>}
            <div className="border-t pt-2" style={{ borderColor: 'var(--border-1)' }}><div className="mb-2 text-[10px] font-bold" style={{ color: 'var(--text-1)' }}>تحديد موقع السهم يدوياً أو بمساعدة</div>
              <div className="flex flex-wrap items-center gap-2"><select value={liquidityType} onChange={(event) => setLiquidityType(event.target.value as 'BSL' | 'SSL')} className="rounded border px-2 py-1 text-[10px]" style={{ color: 'var(--text-1)', background: 'var(--surface-1)', borderColor: 'var(--border-1)' }}><option value="BSL">BSL</option><option value="SSL">SSL</option></select><button type="button" className="btn btn-secondary text-[10px]" onClick={addSwingLevel}>ضع عند قمة/قاع الشمعة تحت المؤشر</button></div>
              <div className="mt-2 grid grid-cols-2 gap-2"><label className="grid gap-1 text-[9px]" style={{ color: 'var(--text-3)' }}>حد المقاومة/الدعم<input value={zoneBoundary} onChange={(event) => setZoneBoundary(event.target.value)} inputMode="decimal" placeholder="السعر" className="rounded border px-2 py-1 text-[10px]" style={{ borderColor: 'var(--border-1)', background: 'var(--surface-1)', color: 'var(--text-1)' }} /></label><label className="grid gap-1 text-[9px]" style={{ color: 'var(--text-3)' }}>فترة ATR / المضاعف<div className="flex gap-1"><input type="number" min="2" max="100" value={atrPeriod} onChange={(event) => setAtrPeriod(Number(event.target.value))} className="w-16 rounded border px-1 text-[10px]" style={{ borderColor: 'var(--border-1)', background: 'var(--surface-1)', color: 'var(--text-1)' }} /><input type="number" min="0.1" max="20" step="0.1" value={atrMultiplier} onChange={(event) => setAtrMultiplier(Number(event.target.value))} className="w-16 rounded border px-1 text-[10px]" style={{ borderColor: 'var(--border-1)', background: 'var(--surface-1)', color: 'var(--text-1)' }} /></div></label></div>
              <div className="mt-1 text-[9px]" style={{ color: 'var(--text-3)' }}>ATR({atrPeriod}) على شموع {timeframe} المختارة: {atr == null ? 'غير متاح — شموع غير كافية' : atr.toPrecision(8)}{atr != null && Number.isFinite(Number(zoneBoundary)) ? ` · السعر الناتج: ${(liquidityType === 'BSL' ? Number(zoneBoundary) + atr * atrMultiplier : Number(zoneBoundary) - atr * atrMultiplier).toPrecision(10)}` : ''}</div>
              <button type="button" className="btn btn-secondary mt-2 w-full text-[10px]" onClick={addAtrLevel} disabled={atr == null}>اعتماد مستوى {liquidityType} المحسوب بـATR</button>
            </div>
          </section>
        </div>
      </>}
      {candlesLoading && <div role="status" className="py-6 text-center text-xs" style={{ color: 'var(--accent)' }}>تحميل الشموع التاريخية من Binance على دفعات…</div>}
      {!candlesLoading && !candleData && !candlesError && <div className="py-6 text-center text-xs" style={{ color: 'var(--text-3)' }}>افتح مساحة الرسم لتحميل 90 يوماً من الشموع الحقيقية.</div>}
    </>}
  </section>;
}
