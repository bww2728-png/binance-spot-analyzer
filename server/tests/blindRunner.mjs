/* عدّاء الاختبار الأعمى — يشغّل replayTimeline على ملف تسميات خارجي (لا يُحفظ في المستودع).
 * الاستخدام: node server/tests/blindRunner.mjs <labels.json>
 * يطبع id: PASS/FAIL فقط + المجموع (الإجابات لا تُكشف في الكود).
 */
import { readFileSync } from 'node:fs';
import { replayTimeline, eventsOf } from '../live-opportunities/replay.mjs';

const file = process.argv[2];
if (!file) {
  console.error('usage: node server/tests/blindRunner.mjs <labels.json>');
  process.exit(2);
}
const labels = JSON.parse(readFileSync(file, 'utf8'));

function verdictOf(replay) {
  const sweep = eventsOf(replay, 'sweep').length;
  const rec = eventsOf(replay, 'reclaim').length;
  const late = eventsOf(replay, 'late_reclaim').length;
  const fin = replay.final.phase;
  if (sweep === 1 && rec === 1 && late === 0) return 'sweep_ok';
  if (sweep >= 1 && late === 1 && rec === 0) return 'late';
  if (sweep >= 1 && rec === 0 && late === 0 && fin === 'invalidated') return 'sweep_fail';
  if (rec === 0 && late === 0) return 'no_reclaim';
  if (fin === 'invalidated') return 'invalidated';
  return `unknown:${fin}`;
}

let pass = 0;
for (const c of labels) {
  const replay = replayTimeline({
    zone: c.zone, ticks: c.ticks, atr: c.atr ?? null,
    reclaimWindowBars: c.reclaimWindowBars ?? 3
  });
  const got = verdictOf(replay);
  const ok = got === c.expected;
  if (ok) pass += 1;
  console.log(`${c.id}: ${ok ? 'PASS' : `FAIL (got ${got}, want ${c.expected})`}`);
}
console.log(`---\n${pass}/${labels.length} blind cases passed`);
process.exit(pass === labels.length ? 0 : 1);
