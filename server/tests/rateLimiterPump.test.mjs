import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createRateLimiter } from '../net/limiter.mjs';
import { holdEventLoop } from './_holdLoop.mjs';

// مؤقّت الـpump داخل المحدد `unref()`ed، فانتظار وعد يُحلّ به يترك الحلقة بلا مقبض
// على Node 22 فيُلغى الاختبار. مثبّت واحد للملف كله (انظر _holdLoop.mjs).
const releaseLoop = holdEventLoop();
after(() => releaseLoop());

/**
 * عطل مُثبت ومُقاس: دالة `pump` كانت مُعرَّفة في المحدد ولا يُستدعى لها أحد.
 * الأثر: أي طلب يدخل صف الانتظار **لا يُحرَّر أبداً** — لا بعد ثانية ولا بعد ساعة.
 * ظهر عملياً عند بذر مخزن الشموع: توقّف البذر عند 3,102 مفتاح من 6,006، وبقيت
 * `waiting: 104` ثابتة أربع دقائق مع `usedInWindow: 26` من 4,200 — أي أن السعة كانت
 * متاحة والمنتظرون موقوفون. كان العطل كامناً لأن النظام سابقاً لم يبلغ ضغطاً كافياً
 * يدخل به مسار الانتظار.
 *
 * هذه الاختبارات تُثبت أن المنتظر يُحرَّر فعلاً، فلا يعود العطل صامتاً.
 */

const silent = { warn() {}, error() {}, info() {} };

test('المنتظر يُحرَّر بعد امتلاء النافذة (لا يبقى معلّقاً)', async () => {
  let clock = 1_000_000;
  const limiter = createRateLimiter({
    minuteBudget: 4,
    pumpMs: 20,
    log: silent,
    now: () => clock
  });

  // نداءان بوزن 2 يستهلكان النافذة كاملة (4)
  await limiter.acquire('live', 2);
  await limiter.acquire('live', 2);
  assert.equal(limiter.stats().waiting, 0, 'النداءان مرّا مباشرة');
  assert.equal(limiter.stats().usedInWindow, 4);

  // الثالث يجب أن ينتظر ثم يُحرَّر بعد تجدّد النافذة
  let released = false;
  const pending = limiter.acquire('live', 2).then(() => { released = true; });
  await new Promise(r => setTimeout(r, 30));
  assert.equal(released, false, 'لم يُحرَّر داخل النافذة الممتلئة');
  assert.equal(limiter.stats().waiting, 1, 'الطلب في صف الانتظار');

  clock += 61_000; // نافذة جديدة
  await pending;
  assert.equal(released, true, 'حُرِّر بعد تجدّد النافذة — وهذا ما كان مستحيلاً قبل الإصلاح');
  assert.equal(limiter.stats().waiting, 0, 'الصف فُرِّغ');
});

test('الأولوية الأعلى تُخدم أولاً عند التنافس', async () => {
  let clock = 2_000_000;
  const limiter = createRateLimiter({ minuteBudget: 4, pumpMs: 20, log: silent, now: () => clock });

  // إشباع النافذة كاملة (4 وزن) حتى يُضطر الطلبان إلى الصف فعلاً
  await limiter.acquire('live', 2);
  await limiter.acquire('live', 2);
  assert.equal(limiter.stats().usedInWindow, 4, 'النافذة ممتلئة — التنافس حقيقي');

  const order = [];
  const low = limiter.acquire('history', 2).then(() => order.push('history'));
  const high = limiter.acquire('live', 2).then(() => order.push('live'));
  await new Promise(r => setTimeout(r, 40));
  assert.deepEqual(order, [], 'لا يُخدم أحد داخل نافذة ممتلئة');

  clock += 61_000; // نافذة جديدة: السعة تكفي الاثنين، والترتيب يحكمه الأولوية
  await Promise.all([low, high]);
  assert.deepEqual(order, ['live', 'history'], 'الحي قبل التاريخي — ولا تجويع للصفوف');
});

test('أولوية مجهولة تُسقَط إلى live بدل أن تختفي صامتة', async () => {
  const limiter = createRateLimiter({ minuteBudget: 100, pumpMs: 20, log: silent });
  // قبل الإصلاح: queues.get('unknown') === undefined → خطأ يُبتلع في guard
  await limiter.acquire('unknown-priority', 2);
  assert.equal(limiter.stats().total, 1, 'النداء نُفِّذ ولم يُفقد');
});

test('بعد 429 يُحجب الجميع ثم يُحرَّرون عند انتهاء الحظر', async () => {
  let clock = 3_000_000;
  const limiter = createRateLimiter({ minuteBudget: 100, pumpMs: 20, log: silent, now: () => clock });
  await limiter.acquire('live', 2);
  limiter.report(429, 5_000); // حظر 5 ثوانٍ
  assert.ok(limiter.stats().blockedUntil, 'الحظر مُسجَّل');

  let released = false;
  const pending = limiter.acquire('history', 2).then(() => { released = true; });
  await new Promise(r => setTimeout(r, 30));
  assert.equal(released, false, 'محجوب أثناء الحظر');

  clock += 6_000; // انتهى الحظر
  await pending;
  assert.equal(released, true, 'حُرِّر بعد انتهاء الحظر — لا انتظار أبدي');
});
