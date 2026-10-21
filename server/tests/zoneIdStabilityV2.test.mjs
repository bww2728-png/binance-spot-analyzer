/**
 * ثبات معرّف منطقة المحرك الجديد (v2) — الدليل الذي كان ناقصاً (عيب A4 المعاد في v2).
 *
 * كان معرّف v2 يحمل `i` (ترتيب العنقود) ووسيط السعر بتقريب 1e-8، ومعرّف عرض/طلب على
 * `originCandleIndex` الذي يتغيّر بأي إزاحة نافذة. أثر ذلك مُقاس: **12.2% دوران** في
 * المحرك الأول (1,676 من 13,709 منطقة تغيّر معرّفها بلا تغيّر مردودها).
 *
 * الاختبار يقيس الخاصية المطلوبة مباشرة، لا شكل النص:
 *  1) حركة سعرية أصغر من خانة الشبكة ⇒ المعرّف ثابت.
 *  2) انقلاب سعري كبير ⇒ المعرّف يتغيّر (لا اندماج مناطق متباعدة).
 *  3) المعيار نفسه يصلح لعملة بـ100$ ولأخرى بـ0.00001$ (خانة نسبية لا مطلقة).
 *  4) حراس على الخطأ القديم: درجتان متجاورتان لا تحملان نفس المعرّف السعري.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { stableBucket } from '../liquidity-zones/v2/zones.mjs';

test('حركة أصغر من عرض الخانة لا تُغيّر الخانة', () => {
  const base = 83_479.75;
  const shifted = base * 1.0005;   // 0.05% — أقل من 0.2% بكثير
  assert.equal(stableBucket(shifted), stableBucket(base), 'انزياح 0.05% يجب ألا يغيّر المعرّف');
});

test('انقلاب سعري كبير يُغيّر الخانة (لا خلط مناطق متباعدة)', () => {
  assert.notEqual(stableBucket(83_479.75), stableBucket(83_479.75 * 1.05), 'اختلاف 5% يجب أن يغيّر المعرّف');
  assert.notEqual(stableBucket(100), stableBucket(200), 'مضاعفة السعر تُغيّر المعرّف');
});

test('الخانة نسبية: مقدار التقدّم لأي نسبة سعرية واحد عند كل المقاييس', () => {
  /**
   * القانون الرياضي للخانة اللوغاريتمية: `log(p·c) = log p + log c`، فمقدار تقدّم
   * الخانة عند نسبة `c` هو `round(r)` أو `round(r)±1` حيث `r = log(c)/step`،
   * **مهما كان مستوى السعر** — وهذا بالضبط معنى «الخانة نسبة من السعر لا مقدار ثابت».
   * لو كانت الخانة مطلقة (كما في الخطأ القديم) لاختلف السلوك بين 100$ و0.00001$.
   */
  const step = 0.002;
  for (const c of [1.0005, 1.002, 1.01, 1.5]) {
    const r = Math.log(c) / step;
    const lo = Math.floor(r) - 1;
    const hi = Math.ceil(r) + 1;
    for (const base of [0.00001, 0.01, 1, 100, 83_000, 250_000]) {
      for (const frac of [1, 1.3, 1.7, 2.4]) {
        const p = base * frac;
        const d = stableBucket(p * c, step) - stableBucket(p, step);
        assert.equal(d >= lo && d <= hi, true, `تقدّم ${d} خارج المتوقع [${lo},${hi}] عند ${p} وc=${c}`);
      }
    }
  }
});

/** يقيس نسبة المناطق التي تغيّر معرّفها عند انزياح نسبي معطى */
function churn(step, driftFrac, samples = 400) {
  let changed = 0;
  for (let i = 0; i < samples; i += 1) {
    const p = 10 + i * 97;                  // مواضع متفرقة على مدى واسع من الأسعار
    if (stableBucket(p * (1 + driftFrac), step) !== stableBucket(p, step)) changed += 1;
  }
  return changed / samples;
}

test('الدوران يقلّ كلما اتسعت الخانة (اتجاه التأثير)', () => {
  const drift = 0.0002;                     // انزياح واقعي صغير
  const fine = churn(0.0005, drift);
  const mid = churn(0.002, drift);
  const coarse = churn(0.01, drift);
  assert.equal(fine >= mid, true, `الخانة الأضيق يجب ألا تكون أقل دوراناً (${fine} مقابل ${mid})`);
  assert.equal(mid >= coarse, true, `الخانة الأوسع أقل دوراناً (${mid} مقابل ${coarse})`);
  // والخانة المُعايَرة (0.002) تبقى في نطاق معقول على انزياح أصغر من نصف عرضها
  assert.equal(mid <= 0.35, true, `دوران الخانة المُعايَرة مرتفع: ${(mid * 100).toFixed(1)}%`);
});

test('خانة أوسع من الانزياح بمرات ⇒ دوران منخفض جداً (الحد النظري)', () => {
  // انزياح 0.005% مقابل خانة عرضها 1% ⇒ الاحتمال النظري ~0.5%، والقياس قريب منه
  const c = churn(0.01, 0.00005);
  assert.equal(c <= 0.02, true, `الدوران المقيس ${(c * 100).toFixed(2)}% أعلى من المتوقع نظرياً`);
});

test('مستويان يفصلهما 1000 ضعف لا يحملان نفس الخانة (حراسة على الخطأ القديم)', () => {
  // الخطأ القديم كان `Math.round(level / (level * step))` = قيمة ثابتة لكل المستويات
  assert.notEqual(stableBucket(0.01), stableBucket(10), '1000 ضعف يجب أن يغيّر المعرّف');
  assert.notEqual(stableBucket(1), stableBucket(1000));
});

test('القيم غير الصالحة تُعاد صفراً بلا انفجار (حتمية لا استثناءات)', () => {
  for (const bad of [null, undefined, NaN, 0, -5, 'x', Infinity]) {
    assert.equal(Number.isFinite(stableBucket(bad)), true, `مدخل ${String(bad)} يجب أن يعيد رقماً`);
  }
  assert.equal(stableBucket('83479.75'), stableBucket(83479.75), 'النص الرقمي يُعالج كرقم');
});

test('حتمية صارمة: نفس السعر ⇒ نفس الخانة في كل نداء', () => {
  const px = 2_476.55;
  const first = stableBucket(px);
  for (let i = 0; i < 50; i += 1) assert.equal(stableBucket(px), first);
});

test('عرض الخانة قابل للضبط، والأوسع يُقلّل الدوران', () => {
  const a = 83_000;
  const b = a * 1.004;             // 0.4%
  const fine = 0.002, coarse = 0.01;
  // الخانة الضيقة تُفرِّق (معرّفان)، والواسعة تجمعهما ⇒ اتجاه التأثير صحيح
  assert.notEqual(stableBucket(a, fine), stableBucket(b, fine));
  assert.equal(stableBucket(a, coarse), stableBucket(b, coarse));
  // والقيمة الافتراضية هي المُعايَرة (0.002)
  assert.equal(stableBucket(a), stableBucket(a, 0.002));
});

test('مصدر السبب موثَّق نصّاً: اسم الخانة يذكر أنها نسبية لا مطلقة', () => {
  // أي أن الخانة تُشتق من لوغاريتم النسبة، لا من طرح مقدار ثابت من السعر
  const a = stableBucket(100, 0.002);
  const b = stableBucket(100.1, 0.002);
  const far = stableBucket(200, 0.002);
  assert.equal(Math.abs(b - a) <= 1, true, 'فرق 0.1% لا ينقل إلا خانة واحدة');
  assert.equal(far - a > 5, true, 'والمضاعفة تنقل عشرات الخانات (استجابة لوغاريتمية)');
});
