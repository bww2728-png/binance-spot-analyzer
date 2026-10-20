import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHealth } from '../health.mjs';

/**
 * عيب مُقاس: `HEALTH_SAMPLE_MIN` قيمة كبيرة (مثل 99999 دقيقة) تعطي فترة أكبر من 2^31-1
 * مللي ثانية، فيُفيض `setInterval` ويُحوّلها Node إلى 1ms مع `TimeoutOverflowWarning`.
 * الأثر: المُعيّن يصبح مطرقة على القاعدة بدل عيّنة كل دقائق، وعدّاد إخفاقات الحفظ يتضخم.
 * الإصلاح: قصّ الفترة إلى نطاق معقول. الاختبار يثبت القصّ عند الطرفين والحالة الطبيعية.
 */

const silentLog = { info() {}, warn() {}, error() {} };

function periodFor(minutes) {
  const health = createHealth({ log: silentLog });
  const sampler = health.startSampler({
    db: { health: { append: async () => {} } },
    intervalMs: Number(minutes) * 60 * 1000,
    log: silentLog
  });
  const period = sampler.periodMs;
  sampler.stop();
  return period;
}

test('الفترة الطبيعية تبقى كما هي (5 دقائق)', () => {
  assert.equal(periodFor(5), 5 * 60 * 1000);
});

test('الفترة الضخمة تُقصّ ولا تُفيض إلى 1ms', () => {
  const period = periodFor(99999);
  assert.ok(period > 0, 'الفترة موجبة');
  assert.ok(period <= 24 * 60 * 60 * 1000, `تُقصّ إلى 24 ساعة كحد أقصى، والناتج ${period}`);
  assert.ok(period < 2 ** 31, 'دون حدّ setTimeout وإلا انقلبت إلى نبضة كل مللي ثانية');
});

test('الفترة الصغيرة جداً تُرفع إلى 30 ثانية — لا مطرقة على القاعدة', () => {
  assert.equal(periodFor(0.001), 30_000);
});

test('قيمة غير رقمية تعود إلى الافتراضي 5 دقائق', () => {
  assert.equal(periodFor(Number.NaN), 5 * 60 * 1000);
});
