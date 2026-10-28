/**
 * تقييم جاهزية النظام — يفصل «العملية تعمل» عن «النظام قادر على خدمة بيانات صحيحة».
 *
 * العيب الذي يعالجه: `/healthz` كانت تعيد `{ok:true}` دائماً (وهذا صحيح بوصفها فحص حياة
 * liveness)، لكنها هي `healthcheckPath` في `railway.json`، و`/readyz` كانت تفحص وجود
 * `client/dist/index.html` فقط. النتيجة: نظام فاقد الاستعادة أو بلا تخزين مُهيّأ أو بلا
 * حزمة واجهة يُعتبر «سليماً» عند المنصة وعند أي مراقب خارجي.
 *
 * المبدأ: الجاهزية لا تُسقط النظام بسبب بيانات سوق قديمة (سوق هادئ أو مسار REST احتياطي
 * سلوك مشروع)، لكنها تُسقطه إذا كان الشرط **الصحّي** مفقوداً: حزمة الواجهة، تهيئة التخزين،
 * أو فشل استعادة الفرص الحية (لأن المحرك حينها لا يبدأ إطلاقاً).
 *
 * وحدة نقية بلا اعتماديات: كل المدخلات تُحقن، فتُختبر كل الحالات بلا خدمة حقيقية.
 */

export const READINESS_STATE = Object.freeze({
  READY: 'ready',
  STARTING: 'starting',
  DEGRADED: 'degraded',
  FAILED: 'failed'
});

const DEFAULT_MARKET_STALE_MS = 5 * 60_000;

/**
 * @param {object} input
 * @param {boolean|null} [input.dist] حزمة الواجهة موجودة؟ (null = غير معروف)
 * @param {{configured?:boolean, persistFailures?:number, lastPersistError?:string|null}|null} [input.storage]
 * @param {{required?:boolean, state?:string, error?:string|null}|null} [input.live]
 * @param {{available?:boolean, connected?:boolean, priceAgeMs?:number|null}|null} [input.market]
 * @param {boolean} [input.lightMode]
 * @param {number} [input.marketStaleMs]
 * @returns {{ready:boolean, state:string, reasons:Array<{code:string,severity:string,detail:string|null}>, checks:object}}
 */
export function evaluateReadiness({
  dist = null,
  storage = null,
  live = null,
  market = null,
  lightMode = false,
  marketStaleMs = DEFAULT_MARKET_STALE_MS
} = {}) {
  const reasons = [];
  const add = (code, severity, detail = null) => reasons.push({ code, severity, detail });

  const checks = {
    dist: { ok: dist === null ? null : Boolean(dist) },
    storage: { configured: storage?.configured ?? null, persistFailures: Number(storage?.persistFailures) || 0 },
    live: { required: lightMode ? false : Boolean(live?.required), state: live?.state ?? null, error: live?.error ?? null },
    market: {
      available: market?.available ?? null,
      connected: market?.connected ?? null,
      priceAgeMs: Number.isFinite(market?.priceAgeMs) ? market.priceAgeMs : null
    }
  };

  if (dist === false) add('bundle_missing', 'critical', 'client/dist/index.html مفقود');
  else if (dist === null) add('bundle_unknown', 'warning', null);

  if (storage?.configured === false) add('storage_unconfigured', 'critical', 'SUPABASE_URL/SUPABASE_ANON_KEY غير مضبوطين');
  if (checks.storage.persistFailures > 0) {
    add('persist_failures', 'warning', storage?.lastPersistError ?? null);
  }

  if (lightMode) {
    checks.live.state = 'disabled';
  } else if (checks.live.required) {
    if (checks.live.state === 'failed') add('live_recovery_failed', 'critical', checks.live.error);
  }

  if (market?.available === false) add('market_stream_unavailable', 'warning', 'مسار REST/الاستطلاع فقط');
  else if (market?.available === true && market?.connected === false) add('market_disconnected', 'warning', null);
  if (checks.market.priceAgeMs != null && checks.market.priceAgeMs > marketStaleMs) {
    add('market_stale', 'warning', `${checks.market.priceAgeMs}ms`);
  }

  const critical = reasons.some(r => r.severity === 'critical');
  const starting = !lightMode && checks.live.required && ['pending', 'loading'].includes(checks.live.state);
  const warnings = reasons.some(r => r.severity === 'warning');

  const state = critical
    ? READINESS_STATE.FAILED
    : starting
      ? READINESS_STATE.STARTING
      : warnings
        ? READINESS_STATE.DEGRADED
        : READINESS_STATE.READY;

  return {
    ready: state === READINESS_STATE.READY || state === READINESS_STATE.DEGRADED,
    state,
    reasons,
    checks
  };
}

export default evaluateReadiness;
