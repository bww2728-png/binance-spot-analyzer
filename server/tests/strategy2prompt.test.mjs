/* اختبارات منطق البرومبت الجديد — sellers/buyers induced، بوابة البريميوم،
 * فشل choch-down الداخلي، الهدف المتحفظ، الاتجاهات متعددة الفريمات.
 * حتمية بالكامل، بلا شبكة.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildInternal, scanBuyFlow, analyzeCandles
} from '../strategy2/structure.mjs';
import { computeDirectionState, htfLabelOf } from '../strategy2/directions.mjs';
import { createStrategyEngine } from '../strategy2/loop.mjs';

/* ============ أدوات بناء شموع اصطناعية ============ */

const MS = 60_000;
let clock = 1_700_000_000;
const candle = (open, high, low, close) => {
  clock += MS / 1000;
  return { time: clock, timeMs: clock * 1000, open, high, low, close, volume: 10 };
};
const reset = () => { clock = 1_700_000_000; };
const flat = (price, n) => Array.from({ length: n }, () => candle(price, price + 0.05, price - 0.05, price));

/* ============ قيعان/قمم BOS مسجلة ============ */

test('buildInternal: انقلاب داخلي هابط ← صاعد يسجّل قاع BOS كـ sellers induced', () => {
  reset();
  const cs = flat(100, 10);
  cs.push(candle(100, 100.3, 97.5, 97.8));  // قاع داخلي 97.5
  cs.push(...flat(98.5, 6));
  cs.push(candle(98.5, 98.7, 97, 96.8));    // إغلاق تحت 97.5 → كسر ssl (الاتجاه داخلي هابط)
  cs.push(...flat(97, 4));
  cs.push(candle(97, 99.5, 96.9, 99.2));    // قمة داخلية ~99.5
  cs.push(...flat(99, 6));
  cs.push(candle(99, 99.8, 98.8, 99.6));    // إغلاق فوق 99.5 → كسر bsl (انقلاب صاعد)
  cs.push(...flat(99.5, 4));
  const internal = buildInternal(cs);
  assert.equal(internal.internalTrend, 'up');
  const bos = (internal.sellersInduced ?? []).filter(e => e.kind === 'bos-low');
  assert.ok(bos.length >= 1, 'يجب تسجيل قاع BOS واحد على الأقل');
});

test('buildInternal: انقلاب داخلي صاعد ← هابط يسجّل قمة BOS كـ buyers induced', () => {
  reset();
  const cs = flat(100, 10);
  cs.push(candle(100, 102.5, 99.8, 102.2)); // قمة داخلية 102.5
  cs.push(...flat(101.5, 6));
  cs.push(candle(101.5, 103, 101.2, 102.8)); // إغلاق فوق 102.5 → كسر bsl (صاعد)
  cs.push(...flat(102.5, 4));
  cs.push(candle(102.5, 102.7, 100.4, 100.2)); // قاع داخلي ~100.4
  cs.push(...flat(101, 6));
  cs.push(candle(101, 101.2, 99.5, 99.8));  // إغلاق تحت 100.4 → كسر ssl (انقلاب هابط)
  cs.push(...flat(99.8, 4));
  const internal = buildInternal(cs);
  assert.equal(internal.internalTrend, 'down');
  const bos = (internal.buyersInduced ?? []).filter(e => e.kind === 'bos-high');
  assert.ok(bos.length >= 1, 'يجب تسجيل قمة BOS واحدة على الأقل');
});

/* ============ سيناريو إشارة كامل (مُثبت من strategy2.test.mjs) ============ */

/** قمة محمية عند 101 (bsl ‏100.2) — choch up بإغلاق 101.3 */
function buildBase() {
  reset();
  const cs = [];
  cs.push(...flat(98, 6));
  cs.push(candle(98, 98.5, 97.2, 97.4));   // قاع 97.2 (بيفوت داخلي)
  cs.push(...flat(98, 4));
  cs.push(candle(98, 98.4, 94.2, 96));     // قاع 94.2 (ssl داخلي)
  cs.push(...flat(97, 6));
  cs.push(candle(97, 100.2, 96.8, 99.8));  // قمة 100.2 (bsl داخلي)
  cs.push(...flat(99, 4));
  cs.push(candle(99, 101, 98.8, 99.5));    // سويب bsl
  cs.push(candle(99.5, 99.6, 97.5, 97.6));  // كسر قاع فرعي
  cs.push(candle(97.6, 97.7, 96.4, 96.5));
  cs.push(candle(96.5, 96.6, 93.8, 95));    // سويب ssl
  cs.push(...flat(97, 4));
  cs.push(candle(97, 99, 96.8, 98.5));
  cs.push(candle(98.5, 100.5, 98.2, 100.3)); // إغلاق فوق 100.2
  cs.push(candle(100.3, 100.9, 99.8, 100.1)); // شمعة هابطة سابقة
  cs.push(candle(100.1, 100.4, 98.9, 99.2));  // ابتلاع بيعي → قمة محمية 101؟ (أعلى سعر 100.9)
  cs.push(...flat(99, 3));
  return cs;
}

test('analyzeCandles: الإشارة تحمل tpAlt (BSL داخلية فوق الدخول)', () => {
  const cs = buildBase();
  cs.push(candle(99, 101.6, 98.9, 101.3)); // choch up فوق 101
  cs.push(candle(101.3, 102, 100.8, 101.5));
  cs.push(candle(101.5, 101.6, 99.5, 99.8));
  cs.push(candle(99.8, 99.9, 98.2, 98.4));  // ديسكاونت
  cs.push(candle(98.4, 98.5, 96.9, 98.2));  // سويب ssl واستعادة
  cs.push(candle(98.2, 99.4, 98, 99.2));    // صعود
  cs.push(candle(99.2, 99.5, 98.6, 98.8));  // قمة داخلية 99.5
  cs.push(candle(98.8, 98.9, 98.2, 98.4));
  cs.push(candle(98.4, 99.8, 98.3, 99.6));  // choch داخلي
  cs.push(...flat(99.6, 2));
  const an = analyzeCandles(cs, { discountPos: 0.5, minRR: 0.4 });
  assert.ok(an.flow.signal, `متوقع إشارة — المرحلة: ${an.flow.phase}`);
  const tpAlt = an.flow.signal.tpAlt;
  assert.ok(tpAlt === null || (typeof tpAlt === 'number' && tpAlt > an.flow.signal.entry), 'tpAlt رقم فوق الدخول أو null');
});

test('analyzeCandles: الفشل يحمل تفسير buyers induced على الأكبر', () => {
  const cs = buildBase();
  cs.push(candle(99, 101.6, 98.9, 101.3));   // choch up
  cs.push(candle(101.3, 102, 100.8, 101.5));
  cs.push(candle(101.5, 101.6, 99.5, 99.8));
  cs.push(candle(99.8, 99.9, 98.2, 98.4));   // ديسكاونت
  cs.push(candle(98.4, 98.5, 96.9, 98.2));   // سويب ssl (قاع السويب 96.9)
  cs.push(candle(98.2, 99.4, 98, 99.2));     // صعود
  cs.push(candle(99.2, 100.4, 99, 100.2));   // سويب bsl داخلي (ذيل فوق وإغلاق تحت)
  cs.push(candle(100.2, 100.3, 98.5, 98.6));
  cs.push(candle(98.6, 98.7, 96.4, 96.5));    // كسر قاع السويب 96.9 بالإغلاق → فشل
  cs.push(...flat(96.6, 3));
  const an = analyzeCandles(cs, { discountPos: 0.5 });
  assert.ok(an.flow.invalid, 'يجب تسجيل فشل نقطة الدخول');
  assert.ok(typeof an.flow.invalid.interpretation === 'string' && an.flow.invalid.interpretation.length > 0, 'يجب إرفاق تفسير الفشل');
});

/* ============ الاتجاهات متعددة الفريمات ============ */
test('htfLabelOf: تسميات ×8 صحيحة', () => {
  assert.equal(htfLabelOf('1m'), '8m');
  assert.equal(htfLabelOf('5m'), '40m');
  assert.equal(htfLabelOf('15m'), '2h');
  assert.equal(htfLabelOf('1h'), '8h');
});

test('computeDirectionState: الاستدعاء القديم يعيد الحقول القديمة حرفياً', () => {
  reset();
  const cs = flat(100, 130);
  const st = computeDirectionState(cs, { price: 100 });
  assert.equal(st.tf, '1m');
  assert.ok('dir1m' in st && 'dir40m' in st && 'atr1m' in st, 'حقول التوافق الخلفي موجودة');
  assert.equal(st.dir, 'range');
  assert.equal(st.agreement, 'single');
});

test('computeDirectionState: فريم 5m يعيد حقولاً عامة بلا dir1m', () => {
  reset();
  const cs = [];
  for (let i = 0; i < 100; i += 1) {
    const t = 1700000000 + i * 300;
    cs.push({ time: t, timeMs: t * 1000, open: 100, high: 100.05, low: 99.95, close: 100, volume: 5 });
  }
  const st = computeDirectionState(cs, { price: 100, tf: '5m' });
  assert.equal(st.tf, '5m');
  assert.equal(st.htfTf, '40m');
  assert.ok(!('dir1m' in st), 'لا حقول قديمة لغير 1m');
  assert.ok(['up', 'down', 'range'].includes(st.dirTF));
});

test('computeDirectionState: شموع غير كافية لفريم أكبر تُرجع انتظاراً', () => {
  reset();
  const st = computeDirectionState(flat(100, 10), { price: 100, tf: '15m' });
  assert.ok(String(st.stage).includes('غير كافية'));
});

/* ============ إعدادات المحرك ============ */

test('createStrategyEngine: الفريمات الافتراضية تبدأ من الدقيقة', () => {
  const eng = createStrategyEngine({
    resolveTargets: async () => [],
    fetchRawKlines: async () => [],
    fetchPrices: async () => ({})
  });
  const tfs = eng._internals.cfg.entryTfs;
  assert.ok(Array.isArray(tfs) && tfs.includes('1m'), `entryTfs يجب أن تشمل 1m: ${JSON.stringify(tfs)}`);
});

/* ============ بوابة البريميوم (حقن مباشر) ============ */

function premiumCtx() {
  reset();
  const cs = [...flat(100, 40)];
  cs.push(candle(100, 103.6, 99.9, 103.5)); // choch up فوق 103 (i=40)
  cs.push(candle(103.5, 103.7, 102.4, 103));
  cs.push(candle(103, 103.1, 102, 102.6));
  cs.push(candle(102.6, 102.8, 101.8, 102.2)); // سويب bsl داخلي 102.5 (ذيل فوق وإغلاق تحت) — فوق المنتصف
  cs.push(...flat(102.2, 3));
  const t = (i) => cs[i].time;
  const internal = {
    bsl: [{ level: 102.5, time: t(38), state: 'open', i: 38 }],
    ssl: [],
    openBsl: [102.5],
    openSsl: []
  };
  const ph = { protectedHigh: 103, formedIdx: 38, level: 102.5, steps: { brokenLow: 96 } };
  const ctx = {
    range: { low: 95, high: 105, mid: 100, pos: 0.6 },
    externalSslBelow: [94, 93],
    externalBslAbove: [106]
  };
  return { cs, internal, ph, ctx };
}

test('scanBuyFlow: سويب BSL داخلي في بريميوم بلا SSL خارجي → انتظار بريميوم', () => {
  const { cs, internal, ph, ctx } = premiumCtx();
  const flow = scanBuyFlow(cs, ctx, internal, { completed: ph, completedList: [ph] }, { discountPos: 0.5, minRR: 1 });
  assert.equal(flow.signal, null);
  assert.ok(String(flow.phase).includes('بريميوم'), `المرحلة: ${flow.phase}`);
});

test('scanBuyFlow: سويب SSL خارجي لاحق يفتح البوابة', () => {
  const { cs, internal, ph, ctx } = premiumCtx();
  cs.push(candle(102.2, 102.3, 93.5, 95.5)); // سويب ssl خارجي 94 واستعادة
  cs.push(...flat(96, 2));
  const flow = scanBuyFlow(cs, ctx, internal, { completed: ph, completedList: [ph] }, { discountPos: 0.5, minRR: 1 });
  assert.ok(!String(flow.phase ?? '').includes('بريميوم'), `المرحلة: ${flow.phase}`);
});
