/* إعادة تشغيل الأحداث (Replay Harness — عقيدة §15 + قاعدة التكافؤ):
 * يغذي نفس advanceTracker بسلسلة مسجلة ( ticks: [{price, at}] ) ويعيد الخط الزمني
 * الكامل (الحالات + الأحداث). القاعدة: Live = Replay = Backtest على نفس المدخلات.
 * نقية وحتمية: نفس السلسلة → نفس الناتج حرفيا (تُستخدم في الاختبارات والتدقيق).
 */

import { advanceTracker, initTracker } from './tracker.mjs';

export function replayTimeline({ zone, ticks, atr = null, freshnessBars = 6, reclaimWindowBars = 3, approachAtr = 1.5, breakAtr = 0.6 }) {
  const out = [];
  let state = initTracker(zone, ticks[0]?.at ?? Date.now(), { freshnessBars });
  const a = Number(atr) > 0 ? Number(atr) : Math.abs(Number(zone?.referenceLevel)) * 0.005 || 1;
  for (const tick of ticks ?? []) {
    const { next, events } = advanceTracker(state, {
      zone, price: tick.price, atr: a, now: tick.at,
      freshnessBars, approachAtr, breakAtr, reclaimWindowBars
    });
    out.push({ at: tick.at, price: tick.price, phase: next.phase, events: events.map(e => ({ ...e })) });
    state = next;
  }
  return { timeline: out, final: state };
}

/** تسلسل الحالات فقط (للمقارنة الحتمية بين تشغيلين) */
export const phaseTrail = (replay) => replay.timeline.map(t => `${t.at}:${t.phase}`).join('|');

/** أحداث من نوع معين عبر الخط الزمني */
export const eventsOf = (replay, type) => replay.timeline.flatMap(t => t.events.filter(e => e.type === type));
