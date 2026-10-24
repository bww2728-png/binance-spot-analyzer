import { useEffect, useState } from 'react';

/**
 * حالة الخادم الحقيقية من `/api/health/deep`.
 *
 * السبب: شارة «مباشر» كانت تعكس بث المتصفح من بينانس فقط، فقد تظهر «مباشر» والمحركات
 * على الخادم متوقفة أو بياناتها متقادمة. المرجع الصحيح لحالة النظام هو الخادم نفسه.
 * استطلاع كل 15 ثانية — أخف من دورة التحليل نفسها ولا يضيف حملاً معتبراً.
 */
export interface ServerEngine {
  name: string;
  cycles: number;
  sinceCycleMs: number | null;
  lastCycleMs: number | null;
  stalled: boolean;
  lastError: string | null;
  /** تفاصيل المحرك: تقدّم الدورة الطويلة (أزواج/إجمالي) وعدد النتائج الحيّة */
  extra?: Record<string, unknown>;
}

export interface ServerHealth {
  ok: boolean;
  up: number;
  uptimeSec: number;
  mem: { rssMb: number; heapUsedMb: number; limitMb: number | null; headroomMb: number | null };
  heapLimitMb?: number;
  lagMs: { p50: number; p95: number; p99: number; max: number };
  persist: { persistFailures: number; persistWrites: number; lastPersistError: string | null };
  engines: ServerEngine[];
  marks: Record<string, unknown>;
  market?: {
    connected: boolean;
    streams: number;
    priceAgeMs: number | null;
    stalePriceRatio: number | null;
    analyzedSymbols: number;
    analyzedPriced: number;
    staleCandles?: number;
    tradingStaleCandles?: number;
    silentConns: number;
  };
  targets?: { count: number };
  dataFresh?: { ok: boolean | null; reason: string };
}

export type ServerStatus = 'loading' | 'live' | 'stale' | 'stalled' | 'down';

export interface ServerHealthState {
  status: ServerStatus;
  health: ServerHealth | null;
  label: string;
  title: string;
  error: string | null;
  /** أعلى تأخّر لدورة أي محرك (ms) — مؤشر التعليق */
  worstLagMs: number | null;
}

/** تلخيص الحالة من الرد الخام: النظام «حي» فقط إن كان البث متصلاً والبيانات حديثة ولا محرك متعطل */
export function summarize(health: ServerHealth | null, error: string | null, loading: boolean): ServerHealthState {
  if (loading && !health) {
    return { status: 'loading', health: null, label: 'جارٍ الفحص', title: 'جارٍ قراءة حالة الخادم…', error: null, worstLagMs: null };
  }
  if (!health) {
    return {
      status: 'down', health: null, label: 'الخادم لا يستجيب',
      title: error ? `تعذّر قراءة حالة الخادم: ${error}` : 'تعذّر قراءة حالة الخادم',
      error, worstLagMs: null
    };
  }
  const stalled = (health.engines ?? []).filter(e => e.stalled);
  const stalledAll = (health.engines ?? []).filter(e => e.stalled && e.cycles > 0);
  const lags = (health.engines ?? []).filter(e => e.sinceCycleMs !== null).map(e => e.sinceCycleMs as number);
  const worstLagMs = lags.length ? Math.max(...lags) : null;
  const fresh = health.dataFresh;
  const portions: string[] = [];
  if (stalled.length) portions.push(`محركات متعطلة: ${stalled.map(e => e.name).join('، ')}`);
  if (fresh?.reason) portions.push(fresh.reason);
  if (health.mem?.limitMb) portions.push(`ذاكرة ${health.mem.rssMb}MB من ${health.mem.limitMb}MB`);
  if (health.persist?.persistFailures) portions.push(`إخفاقات حفظ: ${health.persist.persistFailures}`);
  const title = portions.join(' · ') || 'كل المحركات تعمل والبيانات حديثة';

  // التعطل الحقيقي: صحة الخادم نفسه لا تُقرأ، أو البث غير متصل
  if (health.market && health.market.connected === false) {
    return { status: 'down', health, label: 'البث متوقف', title, error, worstLagMs };
  }
  if (stalledAll.length > 0) return { status: 'stalled', health, label: 'محرك متعطل', title, error, worstLagMs };
  if (fresh && fresh.ok === false) return { status: 'stale', health, label: 'بيانات قديمة', title, error, worstLagMs };
  return { status: 'live', health, label: 'مباشر', title, error, worstLagMs };
}

/**
 * كاش صحة الخادم المشترك: طلب واحد لكل الفترات، والمشتركون يقرؤون نفس اللقطة.
 *
 * السبب: كانت كل شاشة (الشارة، لوحة التحكم، الفرص الحية) تستدعي `/api/health/deep`
 * بدورتها الخاصة، فيتكرر الطلب نفسه عدة مرات في الثانية الواحدة. هنا دورة واحدة
 * بأقصر فترة مطلوبة، وتُوقف عند إخفاء التبويب، ويُشارَك ناتجها مع كل المشتركين.
 */
type HealthListener = (state: ServerHealthState) => void;

const healthListeners = new Set<HealthListener>();
let healthTimer: ReturnType<typeof setInterval> | null = null;
let healthInFlight = false;
let healthIntervalMs = 15_000;
let healthState: ServerHealthState = summarize(null, null, true);

function emitHealth() {
  for (const l of healthListeners) l(healthState);
}

function isServerHealth(data: unknown): data is ServerHealth {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
  const value = data as Record<string, unknown>;
  const mem = value.mem;
  return Number.isFinite(value.uptimeSec) &&
    !!mem && typeof mem === 'object' && !Array.isArray(mem) &&
    Number.isFinite((mem as Record<string, unknown>).rssMb) &&
    Array.isArray(value.engines);
}

async function fetchHealthOnce() {
  if (healthInFlight) return;
  healthInFlight = true;
  try {
    const res = await fetch('/api/health/deep');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data: unknown = await res.json();
    if (!isServerHealth(data)) throw new Error('استجابة صحة الخادم لا تطابق المخطط المتوقع');
    healthState = summarize(data, null, false);
  } catch (e) {
    healthState = summarize(healthState.health, e instanceof Error ? e.message : String(e), false);
  } finally {
    healthInFlight = false;
    emitHealth();
  }
}

function ensureHealthLoop(intervalMs: number) {
  // أقصر فترة مطلوبة تحكم الدورة الواحدة — لا دورة لكل مشترك
  if (intervalMs < healthIntervalMs) healthIntervalMs = intervalMs;
  if (healthTimer != null) return;
  const tick = () => { if (document.visibilityState !== 'hidden') void fetchHealthOnce(); };
  void fetchHealthOnce();
  healthTimer = setInterval(tick, healthIntervalMs);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void fetchHealthOnce();
  });
}

function releaseHealthLoop() {
  if (healthListeners.size > 0) return;
  if (healthTimer != null) { clearInterval(healthTimer); healthTimer = null; }
  healthIntervalMs = 15_000;
}

export function useServerHealth(intervalMs = 15_000): ServerHealthState {
  const [state, setState] = useState<ServerHealthState>(healthState);

  useEffect(() => {
    const listener: HealthListener = (s) => setState(s);
    healthListeners.add(listener);
    ensureHealthLoop(intervalMs);
    setState(healthState);
    return () => {
      healthListeners.delete(listener);
      releaseHealthLoop();
    };
  }, [intervalMs]);

  return state;
}
