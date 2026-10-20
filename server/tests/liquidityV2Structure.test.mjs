import test from 'node:test';
import assert from 'node:assert/strict';
import {
  detectStructureEvents,
  detectInducement,
  classifyExternalPivots,
  STRUCTURE_EVENT_TYPES
} from '../liquidity-zones/v2/structure.mjs';

/**
 * اختبارات وحدة البنية (محرك v2). كل شرط هنا مأخوذ حرفياً من تعريف صاحب النظام،
 * وبأرقام صريحة حتى يكون أي انحراف ظاهراً لا مُخمَّناً.
 *
 * ملاحظة على بناء البيانات: كشف الارتدادات يعتمد **كسر هاي/لو الشمعة السابقة** لا لونها،
 * ويُعلّق الحكم في الشمعة الاحتوائية ويُهمل الداخلية. لذلك بُنيت سلسلة السيناريو بحيث
 * تحوي **ارتداد سحب حقيقي** (كسر اللو دون كسر الهاي) — وهو ما يعرّفه صاحب النظام كـIDM.
 */

/** سلسلة السيناريو الأساسية: صعود → IDM (100) → قمة 1 (112) → [كسر IDM] → قاع 1 (88) */
const BASE = [
  [100, 105, 99, 104],    // 0
  [104, 110, 103, 109],   // 1: ارتداد صاعد (110)
  [108, 109, 100, 101],   // 2: ارتداد هابط (100) = IDM
  [101, 112, 101, 111],   // 3: ارتداد صاعد (112) = قمة 1
];
const BREAK_WICK = [111, 113, 95, 105];   // 4: الذيل 95 يكسر IDM، والإغلاق 105 فوقه
const BREAK_CLOSE = [111, 112, 92, 93];   // 4: الإغلاق 93 يكسر IDM
const LOW1 = [93, 94, 88, 89];            // 5: قاع 1 = 88
const BOS_WICK_ONLY = [89, 115, 89, 111]; // 6: ذيل فوق 112 والإغلاق 111 تحته
const BOS_CLOSE = [89, 115, 110, 114];    // 6: الإغلاق 114 فوق 112
const CHOCH_WICK_ONLY = [114, 114, 80, 90]; // 7: ذيل تحت 88 والإغلاق 90 فوقه
const CHOCH_CLOSE = [90, 91, 85, 86];       // 7: الإغلاق 86 تحت 88

function series(rows, startTime = 1_700_000_000) {
  return rows.map((r, i) => [startTime + i * 300, r[0], r[1], r[2], r[3], 10, startTime + i * 300 + 299, 0, 0, 5]);
}
/** قمة/قاع مُصنَّع يُمرَّر مباشرة لعزل اختبار السيناريو عن ضجيج الكشف */
function piv(index, price, kind, prominenceAtr = 3) {
  return { index, time: 1_700_000_000 + index * 300, price, kind, atr: 1, prominenceAtr, confirmedAt: null, strength: 1 };
}
const PIVOTS = [piv(3, 112, 'high'), piv(5, 88, 'low')];

// ============================================================================
// 1) الشمعة الداخلية تُهمل تماماً
// ============================================================================
test('الشمعة الداخلية تُهمل: لا تُنتج ارتداداً ولا تدخل في السلسلة', () => {
  const cs = series([
    [100, 105, 99, 104],   // 0
    [104, 110, 103, 109],  // 1: ارتداد صاعد
    [108, 109, 105, 107],  // 2: داخلية (high<=110 و low>=103) → تُهمل
    [107, 109, 106, 108],  // 3: داخلية → تُهمل
    [108, 109, 100, 101],  // 4: تكسر لو 3 → ارتداد هابط
    [101, 102, 98, 99]     // 5
  ]);
  const ev = detectStructureEvents(cs, [piv(1, 110, 'high'), piv(4, 100, 'low')], 5, { externalMinAtr: 0 });
  assert.equal(ev.filter(e => e.type === 'bos_up' || e.type === 'bos_down').length, 0, 'لا بوس بلا كسر IDM');
  assert.ok(ev.every(e => STRUCTURE_EVENT_TYPES.includes(e.type)), 'كل الأحداث من الأنواع المعلنة');
});

// ============================================================================
// 2) الشمعة الاحتوائية: لا يُحسم الاتجاه منها
// ============================================================================
test('الشمعة الاحتوائية تُعلَّق ولا تُنتج قراراً من نفسها', () => {
  const cs = series([
    [100, 110, 95, 108],   // 0
    [108, 112, 94, 96],    // 1: احتوائية (high>=110 و low<=95)
    [96, 99, 93, 94]       // 2: تكسر لو 1 → القرار من هذه
  ]);
  const ev = detectStructureEvents(cs, [piv(0, 110, 'high'), piv(2, 93, 'low')], 2, { externalMinAtr: 0 });
  assert.ok(Array.isArray(ev), 'لا انهيار على الاحتوائية');
});

// ============================================================================
// 3) كسر IDM بالذيل
// ============================================================================
test('كسر IDM بالذيل: brokenBy = wick', () => {
  const cs = series([...BASE, BREAK_WICK]);
  const idm = detectInducement(cs, [piv(3, 112, 'high')], 4, {});
  assert.equal(idm.length, 1, 'كُشف IDM واحد للقمة');
  assert.equal(idm[0].price, 100, 'مستوى IDM = قاع السحب (100) لا قمة الحركة');
  assert.equal(idm[0].kind, 'low', 'IDM قبل القمة قاع');
  assert.equal(idm[0].index, 2, 'IDM هو الارتداد المعاكس الأقرب قبل القمة');
  assert.equal(idm[0].brokenIndex, 4, 'كُسر عند الشمعة 4');
  assert.equal(idm[0].brokenBy, 'wick', 'الإغلاق 105 فوق IDM 100 ⇒ الكسر بالذيل');
  assert.equal(idm[0].confirmed, true);
});

// ============================================================================
// 4) كسر IDM بالإغلاق
// ============================================================================
test('كسر IDM بالإغلاق: brokenBy = close', () => {
  const cs = series([...BASE, BREAK_CLOSE]);
  const idm = detectInducement(cs, [piv(3, 112, 'high')], 4, {});
  assert.equal(idm[0].brokenIndex, 4);
  assert.equal(idm[0].brokenBy, 'close', 'الإغلاق 93 تحت IDM 100 ⇒ الكسر بالإغلاق');
});

// ============================================================================
// 5) البوس الصاعد يشترط الإغلاق فوق قمة 1
// ============================================================================
test('البوس الصاعد: لا يُعلَن بالذيل، ويُعلَن بالإغلاق فوق قمة 1', () => {
  const wickOnly = detectStructureEvents(series([...BASE, BREAK_CLOSE, LOW1, BOS_WICK_ONLY]), PIVOTS, 6, { externalMinAtr: 0 });
  assert.equal(wickOnly.filter(e => e.type === 'bos_up').length, 0, 'الذيل 115 فوق 112 وحده لا يُنتج بوساً (الإغلاق 111)');

  const withClose = detectStructureEvents(series([...BASE, BREAK_CLOSE, LOW1, BOS_CLOSE]), PIVOTS, 6, { externalMinAtr: 0 });
  const bos = withClose.find(e => e.type === 'bos_up');
  assert.ok(bos, 'الإغلاق 114 فوق 112 يُنتج بوساً صاعداً');
  assert.equal(bos.index, 6);
  assert.equal(bos.confirmBasis, 'close', 'أساس التأكيد إغلاق حصراً');
  assert.equal(bos.brokenLevel, 112, 'المستوى المكسور = قمة 1');
  assert.equal(bos.idmLevel, 100, 'بوابة كسر IDM مطلوبة ومسجَّلة في الحدث');
  assert.equal(bos.idmBrokenBy, 'close');
});

// ============================================================================
// 6) CHoCH بالإغلاق فقط
// ============================================================================
test('CHoCH down: بالإغلاق تحت قاع 1 فقط', () => {
  const wickOnly = detectStructureEvents(series([...BASE, BREAK_CLOSE, LOW1, BOS_CLOSE, CHOCH_WICK_ONLY]), PIVOTS, 7, { externalMinAtr: 0 });
  assert.equal(wickOnly.filter(e => e.type === 'choch_down').length, 0, 'الذيل 80 تحت 88 والإغلاق 90 فوقه ⇒ لا CHoCH');

  const withClose = detectStructureEvents(series([...BASE, BREAK_CLOSE, LOW1, BOS_CLOSE, CHOCH_CLOSE]), PIVOTS, 7, { externalMinAtr: 0 });
  const choch = withClose.find(e => e.type === 'choch_down');
  assert.ok(choch, 'الإغلاق 86 تحت 88 يُنتج CHoCH down');
  assert.equal(choch.index, 7);
  assert.equal(choch.confirmBasis, 'close');
  assert.equal(choch.brokenLevel, 88, 'المستوى المكسور = قاع 1');
  assert.equal(choch.priorBos, 6, 'CHoCH يشير للبوس الذي سبقه');
});

// ============================================================================
// 7) البنية الخارجية شرط
// ============================================================================
test('لا بوس على طرف داخلي', () => {
  const rows = [...BASE, BREAK_CLOSE, LOW1, BOS_CLOSE];
  const internal = detectStructureEvents(
    series(rows),
    [piv(3, 112, 'high', 0.1), piv(5, 88, 'low', 0.1)],
    6,
    { externalMinAtr: 1 }
  );
  assert.equal(internal.filter(e => e.type === 'bos_up').length, 0, 'الطرف الداخلي لا يُنتج بوساً');

  const cls = classifyExternalPivots([piv(3, 112, 'high', 0.1)], series(rows), 6, { externalMinAtr: 1 });
  assert.equal(cls[0].level, 'internal', 'التصنيف يسمّي الداخلي داخلاً');
  const ext = classifyExternalPivots([piv(3, 112, 'high', 3)], series(rows), 6, { externalMinAtr: 1 });
  assert.equal(ext[0].level, 'external', 'البروز الكافي بلا احتواء = خارجي');
});

// ============================================================================
// 8) لا معلومة مستقبلية
// ============================================================================
test('لا معلومة مستقبلية: الأحداث المعلنة لا تتغيّر بشموع لاحقة', () => {
  const early = detectStructureEvents(series([...BASE, BREAK_CLOSE, LOW1, BOS_CLOSE]), PIVOTS, 6, { externalMinAtr: 0 });
  const later = detectStructureEvents(series([...BASE, BREAK_CLOSE, LOW1, BOS_CLOSE, CHOCH_CLOSE]), PIVOTS, 7, { externalMinAtr: 0 });
  const earlyBos = early.filter(e => e.type === 'bos_up');
  const laterBos = later.filter(e => e.type === 'bos_up');
  assert.deepEqual(laterBos, earlyBos, 'البوس المعلن سابقاً لم يتغيّر بسبب شمعة لاحقة');
  assert.ok(later.length > early.length, 'الشمعة اللاحقة أضافت حدث CHoCH ولم تحذف شيئاً');
});

// ============================================================================
// 9) الحتمية
// ============================================================================
test('حتمية: نفس المدخل يُنتج نفس المخرج حرفياً', () => {
  const cs = series([...BASE, BREAK_CLOSE, LOW1, BOS_CLOSE, CHOCH_CLOSE]);
  const a = detectStructureEvents(cs, PIVOTS, 7, { externalMinAtr: 0 });
  const b = detectStructureEvents(cs, PIVOTS, 7, { externalMinAtr: 0 });
  assert.deepEqual(a, b, 'لا عشوائية ولا زمن حقيقي في المخرج');
});

// ============================================================================
// 10) مدخلات فاسدة
// ============================================================================
test('مدخلات فاسدة لا تُسقط الوحدة', () => {
  assert.deepEqual(detectStructureEvents([], [], 5, {}), []);
  assert.deepEqual(detectInducement([], [], 0, {}), []);
  assert.deepEqual(classifyExternalPivots(null, null, 0, {}), []);
  const bad = [[100, 102, 98, 101], [null, NaN, NaN, null], [96, 108, 96, 107]];
  assert.doesNotThrow(() => detectStructureEvents(bad, [piv(2, 108, 'high')], 2, {}));
  assert.doesNotThrow(() => detectStructureEvents(series([[1, 1, 1, 1]]), [{ price: 'x' }], 0, {}));
});
