/* مخزن دورة الحياة (عقيدة §12 + المرحلة 4):
 * السلسلة السببية الكاملة Zone→Sweep→Reclaim→Confirmation→Opportunity→Outcome
 * تُحفظ كأحداث `live_lifecycle` على events_log (دائم، بلا DDL معلق) بمعرفات مترابطة،
 * وتُستعاد الحالات النشطة عند الإقلاع — إغلاق النظام لا يقتل التتبع.
 *
 * قاعدة أخذ العينات (للحد من الكتابة): تُحفظ أحداث swept/reclaimed فقط
 * (المجموعة القابلة للتنفيذ)، لا ضجيج armed/approaching.
 * نقية: toLifecycleRow + rehydrateState بلا شبكة — قابلة للاختبار حرفيا.
 */

export const LIFECYCLE_TYPE = 'live_lifecycle';

/** صف حدث دورة حياة من حدث محرك */
export function toLifecycleRow(kind, data = {}) {
  return {
    type: LIFECYCLE_TYPE,
    kind,
    symbol: String(data?.symbol || 'GLOBAL').toUpperCase(),
    timeframe: data?.timeframe ?? null,
    zoneId: data?.zoneId ?? null,
    key: data?.key ?? null, // trackerKey — يربط الحلقات ببعضها
    publishKey: data?.publishKey ?? null, // يربط النشر بسويبه
    at: Number(data?.at) || Date.now(),
    phase: data?.phase ?? null,
    payload: data?.payload ?? null // لقطة/سلسلة/سبب — immutable
  };
}

/**
 * إعادة بناء الحالات النشطة من أحداث دورة الحياة (+ الفرص المنشورة المحفوظة).
 * المدخلات مرتبة زمنيا تصاعديا. المخرجات: {trackers: [...], opportunities: [...]}.
 * قاعدة القدم: سويب أقدم من نافذة النضارة لحظة الاستعادة يُسقط (لا إحياء للموتى).
 */
export function rehydrateState(events, { nowMs = Date.now(), freshnessBars = 6, tfSecondsOf = () => 300 } = {}) {
  const trackers = new Map();
  const opportunities = new Map();
  const byKey = new Map(); // publishKey → opportunity
  const sorted = [...(events ?? [])].sort((a, b) => Number(a.at) - Number(b.at));
  for (const ev of sorted) {
    const k = ev.key;
    if (!k) continue;
    if (ev.kind === 'sweep') {
      const ageOk = nowMs - Number(ev.at) <= freshnessBars * Number(tfSecondsOf(ev.timeframe)) * 1000;
      trackers.set(k, {
        key: k, symbol: ev.symbol, timeframe: ev.timeframe, zoneId: ev.zoneId,
        kind: ev.payload?.kind ?? 'ssl',
        referenceLevel: Number(ev.payload?.referenceLevel),
        liquidityLevel: Number(ev.payload?.liquidityLevel),
        phase: ageOk ? 'swept' : 'invalidated',
        staleSweep: !ageOk, sawSweep: true,
        sweepObservedAt: Number(ev.at), sweepLow: Number(ev.payload?.sweepLow),
        reclaimAt: null, reclaimElapsedMs: null, reclaimBars: null,
        attempts: 0, publishedKey: null, invalidatedAt: ageOk ? null : nowMs,
        createdAt: Number(ev.at), updatedAt: Number(ev.at),
        geometry: null, lastReason: ageOk ? 'مستعاد بعد إعادة التشغيل' : 'سويب قديم — أُبطل عند الاستعادة'
      });
    } else if (ev.kind === 'reclaim') {
      const st = trackers.get(k);
      if (!st || st.phase !== 'swept') continue;
      st.phase = 'reclaimed';
      st.reclaimAt = Number(ev.at);
      st.reclaimElapsedMs = Number(ev.payload?.elapsedMs ?? Math.max(0, Number(ev.at) - Number(st.sweepObservedAt)));
      st.reclaimBars = ev.payload?.elapsedBars ?? null;
      st.updatedAt = Number(ev.at);
    } else if (ev.kind === 'published' && ev.payload?.opportunity) {
      const op = { ...ev.payload.opportunity };
      if (!op.outcome) {
        opportunities.set(op.id, op);
        byKey.set(op.id, op);
        const st = trackers.get(k);
        if (st) { st.phase = 'published'; st.publishedKey = op.id; st.updatedAt = Number(ev.at); }
      }
    } else if (ev.kind === 'closed' && ev.payload?.opportunity) {
      const op = ev.payload.opportunity;
      opportunities.delete(op.id ?? op.publishKey);
      const st = trackers.get(k);
      if (st && st.publishedKey === (op.id ?? op.publishKey)) {
        st.phase = 'invalidated'; st.invalidatedAt = Number(ev.at); st.updatedAt = Number(ev.at);
      }
    }
  }
  return { trackers: [...trackers.values()], opportunities: [...opportunities.values()] };
}
