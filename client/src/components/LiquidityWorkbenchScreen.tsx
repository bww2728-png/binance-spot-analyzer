import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import LiquidityWorkbenchChart from './LiquidityWorkbenchChart';
import { fetchLiquidityWorkbench, fetchLiquidityWorkbenchPoints, type LiquidityWorkbenchPoint, type LiquidityWorkbenchSnapshot, type LiquidityWorkbenchZone } from '../lib/liquidityWorkbench';
import { useStore } from '../store/useStore';
import { useVisiblePoll } from '../lib/useVisiblePoll';

type ManualNote = { id: string; at: number; timeframe: string; text: string };
const TIMEFRAMES = ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '8h', '12h', '1d', '3d', '1w'];
const NOTES_KEY = 'liquidity-workbench-manual-notes-v1';
const storageKey = (timeframe: string) => `${NOTES_KEY}:${timeframe}`;
const asDate = (value: number | null | undefined) => {
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return 'غير متاح';
  return new Date(timestamp < 1e12 ? timestamp * 1000 : timestamp).toLocaleString('ar');
};
const money = (value: number | null | undefined) => Number.isFinite(Number(value)) ? Number(value).toLocaleString('en-US', { maximumFractionDigits: 8 }) : 'غير متاح';
const stateLabel = (value: string | null | undefined) => ({ potential: 'محتملة', candidate: 'مرشحة', confirmed: 'مؤكدة وفق المحرك', swept: 'تم السحب وفق المحرك' }[String(value)] ?? value ?? 'غير محددة');
const pointTypeLabel = (value: string) => ({ origin_candle: 'شمعة الأصل', liquidity_touch: 'لمسة سيولة', trendline_anchor: 'نقطة ارتكاز خط الاتجاه', fvg: 'فجوة قيمة عادلة', structure_idm: 'حدث IDM', structure_bos_up: 'حدث BOS صاعد', structure_bos_down: 'حدث BOS هابط', structure_choch_up: 'حدث CHoCH صاعد', structure_choch_down: 'حدث CHoCH هابط' }[value] ?? value);
const pointRoleLabel = (value: string) => value === 'zone_origin' ? 'أصل المنطقة' : value === 'first_touch' ? 'اللمسة الأولى' : value === 'cluster_touch' ? 'لمسة ضمن التجميع' : value === 'zone_gap' ? 'فجوة مرتبطة' : value === 'confirmation_or_structure' ? 'حدث بنيوي' : value.replace(/^anchor_/, 'ارتكاز ');
const eventLabel = (value: string) => ({ discovered: 'اكتشاف منطقة', state_changed: 'تغيّر حالة المنطقة', touch_points_changed: 'تغيّرت نقاط التكوين', geometry_changed: 'تغيّر شكل المنطقة أو مستوياتها' }[value] ?? value);
const directionLabel = (zone: LiquidityWorkbenchZone) => {
  if (zone.direction === 'up' || zone.kind.endsWith('ssl') || zone.kind === 'demand') return 'أسفل/صاعدة حسب تسمية المحرك';
  if (zone.direction === 'down' || zone.kind.endsWith('bsl') || zone.kind === 'supply') return 'أعلى/هابطة حسب تسمية المحرك';
  return 'غير محددة في المصدر';
};
const workbenchErrorMessage = (message: string | null | undefined) => {
  if (!message) return null;
  if (message.includes('SUPABASE_SERVICE_ROLE_KEY')) {
    return 'توقّف المختبر بأمان لأن إعداد حفظ البيانات على الخادم غير مكتمل. لن تظهر نتائج المسح حتى يُستكمل إعداد سر الخدمة في إعدادات أسرار مشروع Verdent ثم يُنشر إصدار جديد. لا تضع هذا السر في المتصفح أو ترسله عبر المحادثة.';
  }
  return message;
};
const zoneKey = (zone: LiquidityWorkbenchZone) => `${zone.engine}|${zone.id}`;
const readNotes = (timeframe: string): ManualNote[] => {
  try {
    const parsed = JSON.parse(localStorage.getItem(storageKey(timeframe)) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((note) => note && typeof note.text === 'string') : [];
  } catch {
    return [];
  }
};

function ZoneList({ title, zones, color, selectedKey, points, pointsLoading, pointsError, onTogglePoints }: {
  title: string;
  zones: LiquidityWorkbenchZone[];
  color: string;
  selectedKey: string | null;
  points: LiquidityWorkbenchPoint[];
  pointsLoading: boolean;
  pointsError: string | null;
  onTogglePoints: (zone: LiquidityWorkbenchZone) => void;
}) {
  return (
    <section className="rounded-xl border p-3" style={{ borderColor: 'var(--border-1)', background: 'var(--surface-1)' }}>
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="text-sm font-bold" style={{ color: 'var(--text-1)' }}>{title}</h3>
        <span className="rounded-full px-2 py-0.5 text-xs font-semibold" style={{ background: `${color}18`, color }}>{zones.length}</span>
      </div>
      {!zones.length ? <div className="py-5 text-center text-xs" style={{ color: 'var(--text-3)' }}>لا توجد نتائج محفوظة لهذا الفريم بعد.</div> : (
        <div className="max-h-[420px] space-y-2 overflow-auto">
          {zones.map((zone) => {
            const key = zoneKey(zone);
            const isSelected = selectedKey === key;
            return (
              <article key={key} className="rounded-lg border p-2.5" style={{ borderColor: 'var(--border-1)', background: 'var(--surface-0)' }}>
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="font-mono text-xs font-bold" style={{ color }}>{zone.kind}</div>
                    <div className="mt-1 text-[10px]" style={{ color: 'var(--text-3)' }}>{zone.id}</div>
                  </div>
                  <span className="rounded-md px-1.5 py-1 text-[10px]" style={{ background: 'var(--surface-2)', color: 'var(--text-2)' }}>{stateLabel(zone.state)}</span>
                </div>
                <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
                  <dt style={{ color: 'var(--text-3)' }}>المستوى المرجعي</dt><dd className="text-left font-mono" dir="ltr" style={{ color: 'var(--text-1)' }}>{money(zone.referenceLevel)}</dd>
                  <dt style={{ color: 'var(--text-3)' }}>مستوى السيولة</dt><dd className="text-left font-mono" dir="ltr" style={{ color: 'var(--text-1)' }}>{money(zone.liquidityLevel)}</dd>
                  <dt style={{ color: 'var(--text-3)' }}>الجهة المسجلة</dt><dd className="text-left" style={{ color: 'var(--text-2)' }}>{directionLabel(zone)}</dd>
                  <dt style={{ color: 'var(--text-3)' }}>البعد عن السعر</dt><dd className="text-left font-mono" dir="ltr" style={{ color: 'var(--text-1)' }}>{money(zone.observation.distance)} ({zone.observation.distancePct == null ? 'غير متاح' : `${zone.observation.distancePct.toFixed(4)}%`})</dd>
                  <dt style={{ color: 'var(--text-3)' }}>عدد اللمسات المسجّل</dt><dd className="text-left" style={{ color: 'var(--text-2)' }}>{zone.touches ?? 'غير متاح'}</dd>
                  <dt style={{ color: 'var(--text-3)' }}>وقت الاكتشاف</dt><dd className="text-left text-[10px]" style={{ color: 'var(--text-2)' }}>{asDate(zone.createdAt)}</dd>
                </dl>
                <div className="mt-2 border-t pt-2 text-[9px]" style={{ borderColor: 'var(--border-1)', color: 'var(--text-3)' }}>
                  المسافة = القيمة المطلقة للمستوى المرجعي ناقص آخر سعر حديث. المصدر: {zone.engine}; عمر السعر: {zone.observation.priceAgeMs == null ? 'غير متاح' : `${Math.round(zone.observation.priceAgeMs / 1000)} ث`}.
                </div>
                {zone.reasons?.length ? <ul className="mt-2 space-y-1 text-[10px]" style={{ color: 'var(--text-2)' }}>{zone.reasons.map((reason, index) => <li key={`${zone.id}-${index}`}>• {reason}</li>)}</ul> : null}
                <button type="button" aria-expanded={isSelected} onClick={() => onTogglePoints(zone)} className="mt-2 w-full rounded-md border px-2 py-1.5 text-[10px] font-semibold" style={{ borderColor: 'var(--border-1)', color, background: 'var(--surface-1)' }}>
                  {isSelected ? 'إخفاء سجل نقاط التكوين' : `عرض نقاط التكوين · ${zone.engine}`}
                </button>
                {isSelected && (
                  <div className="mt-2 border-t pt-2" style={{ borderColor: 'var(--border-1)' }}>
                    <div className="mb-2 text-[10px]" style={{ color: 'var(--text-3)' }}>النقاط محفوظة ومفلترة بمعرّف المحرك والمنطقة؛ هذه بيانات تكوين وليست توصية تداول.</div>
                    {pointsLoading && <div role="status" className="text-[10px]" style={{ color: 'var(--text-2)' }}>جارٍ تحميل سجل النقاط من التخزين الدائم…</div>}
                    {pointsError && <div role="alert" className="text-[10px]" style={{ color: '#b91c1c' }}>{pointsError}</div>}
                    {!pointsLoading && !pointsError && !points.length && <div className="text-[10px]" style={{ color: 'var(--text-3)' }}>لا توجد نقاط محفوظة لهذه المنطقة؛ لا يُستنتج من ذلك أن المنطقة لم تكن لها نقاط تكوين.</div>}
                    {!!points.length && <ol className="max-h-48 space-y-1 overflow-auto text-[10px]">{points.map((point) => {
                      const selectedLink = point.zone_links?.find((link) => link.zone_id === zone.id);
                      const otherZones = point.zone_links?.filter((link) => link.zone_id !== zone.id) ?? [];
                      return <li key={point.point_id} className="flex flex-wrap justify-between gap-2 rounded border p-1.5" style={{ borderColor: 'var(--border-1)', color: 'var(--text-2)' }}><span>{pointTypeLabel(point.point_type)} · {pointRoleLabel(selectedLink?.relation_role ?? point.role)} · {asDate(point.point_time)}{otherZones.length > 0 && <span className="block text-[9px]" style={{ color: 'var(--accent)' }}>نقطة مشتركة مرتبطة أيضًا بـ {otherZones.map((link) => `${link.zone_kind} (${link.zone_id})`).join('، ')}</span>}</span><span className="font-mono" dir="ltr">{point.price == null ? `${money(point.price_low)}–${money(point.price_high)}` : money(point.price)}</span></li>;
                    })}</ol>}
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}

export default function LiquidityWorkbenchScreen() {
  const [timeframe, setTimeframe] = useState('1h');
  const [pointsVisible, setPointsVisible] = useState(false);
  const [snapshot, setSnapshot] = useState<LiquidityWorkbenchSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notes, setNotes] = useState<ManualNote[]>(() => readNotes('1h'));
  const [noteDraft, setNoteDraft] = useState('');
  const [selectedPointZone, setSelectedPointZone] = useState<string | null>(null);
  const [storedPoints, setStoredPoints] = useState<LiquidityWorkbenchPoint[]>([]);
  const [pointsLoading, setPointsLoading] = useState(false);
  const [pointsError, setPointsError] = useState<string | null>(null);
  const pushToast = useStore((store) => store.pushToast);
  const previousZones = useRef<Map<string, string> | null>(null);
  const pointFetchRef = useRef<AbortController | null>(null);
  useEffect(() => {
    previousZones.current = null;
    pointFetchRef.current?.abort();
    setSelectedPointZone(null);
    setStoredPoints([]);
    setPointsError(null);
    setNotes(readNotes(timeframe));
  }, [timeframe]);
  const refreshSnapshot = useCallback(async (signal: AbortSignal) => {
    try {
      const next = await fetchLiquidityWorkbench(timeframe, signal);
      setSnapshot(next);
      setError(null);
      const nextZones = new Map([...next.legacy, ...next.v2].map((zone) => [zoneKey(zone), String(zone.state ?? '')]));
      if (previousZones.current) {
        for (const [key, state] of nextZones) {
          const oldState = previousZones.current.get(key);
          if (oldState === undefined) {
            const zone = [...next.legacy, ...next.v2].find((item) => zoneKey(item) === key);
            pushToast(`ظهرت منطقة جديدة ${zone?.symbol ?? 'BTCUSDT'} · ${timeframe} · ${zone?.kind ?? ''} (${zone?.engine ?? ''})`, 'info', undefined, { category: 'zones', symbol: zone?.symbol ?? 'BTCUSDT' });
          } else if (oldState !== state) {
            pushToast(`تغيرت حالة منطقة ${key.split('|').at(-1)}: ${stateLabel(oldState)} ← ${stateLabel(state)}`, 'alert', undefined, { category: 'zones', symbol: 'BTCUSDT', severity: 'alert' });
          }
        }
      }
      previousZones.current = nextZones;
    } catch (fetchError) {
      if (signal.aborted) return;
      setError(String(fetchError instanceof Error ? fetchError.message : fetchError));
    }
  }, [pushToast, timeframe]);
  const toggleZonePoints = useCallback(async (zone: LiquidityWorkbenchZone) => {
    const key = zoneKey(zone);
    pointFetchRef.current?.abort();
    if (selectedPointZone === key) {
      setSelectedPointZone(null);
      setStoredPoints([]);
      setPointsError(null);
      setPointsLoading(false);
      return;
    }
    const controller = new AbortController();
    pointFetchRef.current = controller;
    setSelectedPointZone(key);
    setStoredPoints([]);
    setPointsError(null);
    setPointsLoading(true);
    try {
      setStoredPoints(await fetchLiquidityWorkbenchPoints(timeframe, zone.engine, zone.id, controller.signal));
    } catch (fetchError) {
      if (!controller.signal.aborted) setPointsError(String(fetchError instanceof Error ? fetchError.message : fetchError));
    } finally {
      if (!controller.signal.aborted) setPointsLoading(false);
    }
  }, [selectedPointZone, timeframe]);
  const { busy, refresh } = useVisiblePoll(refreshSnapshot, { intervalMs: 5000, immediate: true });

  const allZones = useMemo(() => [...(snapshot?.legacy ?? []), ...(snapshot?.v2 ?? [])], [snapshot]);
  const sourcePointCount = allZones.reduce((total, zone) => total + (zone.touchPoints?.length ?? 0) + (zone.trendline?.points?.length ?? 0) + (zone.fvgs?.length ?? 0) + (zone.structureEvents?.length ?? 0), 0);
  const loadedFrames = snapshot?.status.timeframes.length ? snapshot.status.timeframes : TIMEFRAMES;

  const addNote = () => {
    const text = noteDraft.trim();
    if (!text) return;
    const next = [{ id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, at: Date.now(), timeframe, text }, ...notes].slice(0, 100);
    setNotes(next);
    try { localStorage.setItem(storageKey(timeframe), JSON.stringify(next)); } catch { /* تعذر حفظ الملاحظات في المتصفح */ }
    setNoteDraft('');
  };

  const recovery = snapshot?.status.recovery ?? 'pending';
  const priceOld = Boolean(snapshot) && (snapshot?.currentPriceAgeMs == null || snapshot.currentPriceAgeMs > 90_000);
  const recoveryLabel = recovery === 'ready' ? 'الاستعادة مكتملة' : recovery === 'loading' ? 'جارٍ تحميل البيانات' : recovery === 'degraded' ? 'تحديث متعثر — تجري إعادة المحاولة' : recovery === 'failed' ? 'الخدمة متوقفة بأمان' : recovery === 'idle' ? 'غير نشطة' : 'بانتظار جاهزية الخادم';

  return (
    <div className="mx-auto max-w-[1700px] space-y-4 p-3 sm:p-5" dir="rtl">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold" style={{ color: 'var(--text-1)' }}>مختبر مناطق السيولة</h1>
          <p className="mt-1 text-xs" style={{ color: 'var(--text-3)' }}>مقارنة مستقلة للمحرك الحالي وv2 · Binance Spot · لا أوامر تداول ولا حكم آلي على صحة المناطق.</p>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-xs" htmlFor="workbench-timeframe" style={{ color: 'var(--text-2)' }}>الفريم</label>
          <select id="workbench-timeframe" className="rounded-lg border px-3 py-2 text-sm" style={{ borderColor: 'var(--border-1)', background: 'var(--surface-1)', color: 'var(--text-1)' }} value={timeframe} onChange={(event) => setTimeframe(event.target.value)}>
            {loadedFrames.map((frame) => <option key={frame} value={frame}>{frame}</option>)}
          </select>
          <button className="btn btn-secondary text-xs" onClick={refresh} disabled={busy}>{busy ? 'جارٍ التحديث…' : 'تحديث'}</button>
        </div>
      </header>

      <section className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <div className="rounded-lg border p-3" style={{ borderColor: 'var(--border-1)', background: 'var(--surface-1)' }}><div className="text-[10px]" style={{ color: 'var(--text-3)' }}>السوق والاتصال</div><div className="mt-1 text-xs font-semibold" style={{ color: priceOld ? '#b45309' : '#059669' }}>{snapshot?.currentPrice == null ? 'السعر غير متاح' : priceOld ? 'بيانات السعر قديمة' : 'السعر حديث'}</div><div className="mt-1 font-mono text-xs" dir="ltr" style={{ color: 'var(--text-1)' }}>{money(snapshot?.currentPrice)}</div></div>
        <div className="rounded-lg border p-3" style={{ borderColor: 'var(--border-1)', background: 'var(--surface-1)' }}><div className="text-[10px]" style={{ color: 'var(--text-3)' }}>حالة الاستعادة</div><div className="mt-1 text-xs font-semibold" style={{ color: recovery === 'ready' ? '#059669' : '#b45309' }}>{recoveryLabel}</div><div className="mt-1 text-[10px]" style={{ color: 'var(--text-3)' }}>{snapshot?.status.seeded ?? 0}/{snapshot?.status.expected ?? loadedFrames.length} فريمات جاهزة</div></div>
        <div className="rounded-lg border p-3" style={{ borderColor: 'var(--border-1)', background: 'var(--surface-1)' }}><div className="text-[10px]" style={{ color: 'var(--text-3)' }}>آخر مسح محفوظ</div><div className="mt-1 text-xs font-semibold" style={{ color: 'var(--text-1)' }}>{asDate(snapshot?.latestScan)}</div><div className="mt-1 text-[10px]" style={{ color: 'var(--text-3)' }}>الشموع المغلقة: {snapshot?.candles.length ?? 0}/500</div></div>
        <div className="rounded-lg border p-3" style={{ borderColor: 'var(--border-1)', background: 'var(--surface-1)' }}><div className="text-[10px]" style={{ color: 'var(--text-3)' }}>المقارنة</div><div className="mt-1 text-xs font-semibold" style={{ color: 'var(--text-1)' }}>{snapshot?.matches.length ?? 0} مرشح تطابق</div><div className="mt-1 text-[10px]" style={{ color: 'var(--text-3)' }}>لا تُدمج المناطق ولا يعني التطابق صحةً</div></div>
      </section>

      {workbenchErrorMessage(error ?? snapshot?.status.error) && <div role="alert" className="rounded-lg border px-3 py-2 text-xs" style={{ borderColor: '#f59e0b55', background: '#f59e0b12', color: '#b45309' }}>{workbenchErrorMessage(error ?? snapshot?.status.error)}</div>}
      {snapshot?.status.persistence === 'unavailable' && <div role="alert" className="rounded-lg border px-3 py-2 text-xs" style={{ borderColor: '#ef444455', background: '#ef444412', color: '#b91c1c' }}>التخزين الدائم غير متاح؛ أوقف الخادم المسح بدل عرض نتائج غير محفوظة على أنها موثوقة. لا توجد ضمانة لاستعادة الحالة حتى يعود التخزين.</div>}
      {priceOld && <div role="status" className="rounded-lg border px-3 py-2 text-xs" style={{ borderColor: '#f59e0b55', background: '#f59e0b12', color: '#b45309' }}>لا يوجد سعر حديث مثبت الآن؛ ستظل المناطق معروضة، لكن قياس المسافة موسوم بأنه قديم أو غير متاح.</div>}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-[10px]" style={{ color: 'var(--text-3)' }}>نقاط/أحداث المصدر المتاحة في بيانات الشارت: {sourcePointCount}؛ قد تتكرر بين المحركين والمناطق.</div>
        <button type="button" aria-pressed={pointsVisible} className="btn btn-secondary text-xs" onClick={() => setPointsVisible((visible) => !visible)}>{pointsVisible ? 'إخفاء نقاط التكوين' : 'إظهار نقاط التكوين'}</button>
      </div>
      <LiquidityWorkbenchChart candles={snapshot?.candles ?? []} zones={allZones} dataSource={snapshot?.dataSource ?? 'unknown'} pointsVisible={pointsVisible} />

      <div className="grid gap-3 xl:grid-cols-2">
        <ZoneList title="نتائج المحرك الحالي — دون تعديل" zones={snapshot?.legacy ?? []} color="#089981" selectedKey={selectedPointZone} points={storedPoints} pointsLoading={pointsLoading} pointsError={pointsError} onTogglePoints={toggleZonePoints} />
        <ZoneList title="نتائج المحرك v2 — دون تعديل" zones={snapshot?.v2 ?? []} color="#2563eb" selectedKey={selectedPointZone} points={storedPoints} pointsLoading={pointsLoading} pointsError={pointsError} onTogglePoints={toggleZonePoints} />
      </div>

      <section className="rounded-xl border p-3" style={{ borderColor: 'var(--border-1)', background: 'var(--surface-1)' }}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-bold" style={{ color: 'var(--text-1)' }}>مرشحو التطابق بين المحركين</h2>
          <span className="text-[10px]" style={{ color: 'var(--text-3)' }}>نفس الزوج والفريم والجهة؛ فرق السعر ≤ tickSize وزمن الاكتشاف ≤ شمعة واحدة.</span>
        </div>
        {!snapshot?.matches.length ? <p className="mt-3 text-xs" style={{ color: 'var(--text-3)' }}>لا توجد مطابقة مرشحة في آخر مسح؛ هذا لا يثبت خللًا أو صحة أحد المحركين.</p> : (
          <div className="mt-3 overflow-x-auto"><table className="w-full min-w-[600px] text-right text-xs"><thead><tr style={{ color: 'var(--text-3)' }}><th className="p-2">معرّف الحالي</th><th className="p-2">معرّف v2</th><th className="p-2">الجهة</th><th className="p-2">فرق السعر</th><th className="p-2">فرق الوقت</th></tr></thead><tbody>{snapshot.matches.map((match) => <tr key={`${match.legacyId}|${match.v2Id}`} className="border-t" style={{ borderColor: 'var(--border-1)', color: 'var(--text-1)' }}><td className="p-2 font-mono">{match.legacyId}</td><td className="p-2 font-mono">{match.v2Id}</td><td className="p-2">{match.direction}</td><td className="p-2 font-mono" dir="ltr">{money(match.priceDelta)}</td><td className="p-2">{Math.round(match.timeDeltaMs / 1000)} ث</td></tr>)}</tbody></table></div>
        )}
      </section>

      <section className="rounded-xl border p-3" style={{ borderColor: 'var(--border-1)', background: 'var(--surface-1)' }}>
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-bold" style={{ color: 'var(--text-1)' }}>أحدث أحداث المناطق</h2>
          <span className="text-[10px]" style={{ color: 'var(--text-3)' }}>سجل وصفي مستعاد من التخزين · {snapshot?.recentEvents.length ?? 0}</span>
        </div>
        {!snapshot?.recentEvents.length ? <p className="mt-3 text-xs" style={{ color: 'var(--text-3)' }}>لا توجد أحداث محفوظة لهذا الفريم بعد.</p> : (
          <div className="mt-3 max-h-72 space-y-2 overflow-auto">
            {snapshot.recentEvents.map((event) => (
              <article key={event.idempotency_key} className="flex flex-wrap items-start justify-between gap-2 rounded-lg border p-2 text-xs" style={{ borderColor: 'var(--border-1)', background: 'var(--surface-0)' }}>
                <div>
                  <div className="font-semibold" style={{ color: 'var(--text-1)' }}>{eventLabel(event.event_type)}</div>
                  <div className="mt-1 font-mono text-[10px]" style={{ color: 'var(--text-3)' }}>{event.engine} · {event.symbol} · {event.timeframe} · {event.zone_id}</div>
                  {event.event_type === 'state_changed' && <div className="mt-1 text-[10px]" style={{ color: 'var(--text-2)' }}>{stateLabel(event.payload.previousState)} ← {stateLabel(event.payload.zone?.state)}</div>}
                </div>
                <time className="text-[10px]" style={{ color: 'var(--text-3)' }}>{asDate(event.event_at)}</time>
              </article>
            ))}
          </div>
        )}
      </section>

      <section className="rounded-xl border p-3" style={{ borderColor: 'var(--border-1)', background: 'var(--surface-1)' }}>
        <h2 className="text-sm font-bold" style={{ color: 'var(--text-1)' }}>ملاحظاتك اليدوية — مستقلة عن نتائج المحرك</h2>
        <p className="mt-1 text-[10px]" style={{ color: 'var(--text-3)' }}>تُحفظ في هذا المتصفح فقط، ولا تعدّل المناطق أو تُرسل للخادم.</p>
        <div className="mt-2 flex flex-col gap-2 sm:flex-row"><input className="min-w-0 flex-1 rounded-lg border px-3 py-2 text-sm" style={{ borderColor: 'var(--border-1)', background: 'var(--surface-0)', color: 'var(--text-1)' }} value={noteDraft} onChange={(event) => setNoteDraft(event.target.value)} maxLength={500} placeholder="اكتب ملاحظة بصرية لنفسك…" onKeyDown={(event) => { if (event.key === 'Enter') addNote(); }} /><button className="btn btn-primary text-xs" onClick={addNote} disabled={!noteDraft.trim()}>حفظ الملاحظة</button></div>
        {!!notes.length && <ul className="mt-3 space-y-2">{notes.map((note) => <li key={note.id} className="flex items-start justify-between gap-3 rounded-lg border p-2 text-xs" style={{ borderColor: 'var(--border-1)', color: 'var(--text-2)' }}><span>{note.text}</span><time className="shrink-0 text-[10px]" style={{ color: 'var(--text-3)' }}>{asDate(note.at)}</time></li>)}</ul>}
      </section>
      <footer className="text-[10px]" style={{ color: 'var(--text-3)' }}>الملاحظات الآلية وصفية فقط؛ السعر والمسافة والطابع الزمني مصادرها Binance Spot. لا تنشئ هذه الشاشة توصية تداول أو تقيم صحة المنطقة.</footer>
    </div>
  );
}
