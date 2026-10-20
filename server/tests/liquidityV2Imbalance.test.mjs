/**
 * اختبارات الطبقة 2 (v2): FVG ومناطق العرض/الطلب.
 * node:test — بلا شبكة ولا مؤقتات، وكل الأرقام مكتوبة صراحةً.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectFvgs, detectSupplyDemand } from '../liquidity-zones/v2/imbalance.mjs';

/** شمعة مختصرة: time بالثواني، index تلقائي */
const c = (time, open, high, low, close) => ({ time, open, high, low, close, volume: 1 });

/** سلسلة شموع من قائمة [open, high, low, close] بأسعار ثابتة */
const series = (rows, startTime = 0) => rows.map((r, i) => c(startTime + i * 60, r[0], r[1], r[2], r[3]));

// ============================================================================
// 1) تعريف FVG الثلاثي
// ============================================================================
test('FVG الثلاثي: فجوة صاعدة بحدود دقيقة، والترتيب البديل لا يُنتج', () => {
  // شمعة 0: high=100 ، شمعة 2: low=110 → فجوة صاعدة [100, 110]
  const cs = series([
    [95, 100, 90, 98],   // i-1
    [98, 108, 97, 105],  // i (الإدفاع)
    [105, 120, 110, 118] // i+1
  ]);
  const fvgs = detectFvgs(cs, 2, [], { minSizeAtr: 0 });
  assert.equal(fvgs.length, 1);
  const f = fvgs[0];
  assert.equal(f.kind, 'bullish');
  assert.equal(f.index, 1);
  assert.equal(f.bottom, 100); // high[i-1]
  assert.equal(f.top, 110);    // low[i+1]
  assert.equal(f.time, 60);

  // الترتيب البديل (لا فجوة): high[i-1] >= low[i+1]
  const alt = series([
    [95, 100, 90, 98],
    [98, 108, 97, 105],
    [105, 120, 99, 118] // low=99 < high[i-1]=100 → لا فجوة
  ]);
  assert.equal(detectFvgs(alt, 2, [], { minSizeAtr: 0 }).length, 0);
});

test('FVG الثلاثي: فجوة هابطة بحدود دقيقة', () => {
  // شمعة 0: low=100 ، شمعة 2: high=90 → فجوة هابطة [90, 100]
  const cs = series([
    [105, 110, 100, 102],
    [102, 103, 95, 96],
    [96, 90, 80, 85]
  ]);
  const fvgs = detectFvgs(cs, 2, [], { minSizeAtr: 0 });
  assert.equal(fvgs.length, 1);
  assert.equal(fvgs[0].kind, 'bearish');
  assert.equal(fvgs[0].top, 100);    // low[i-1]
  assert.equal(fvgs[0].bottom, 90);  // high[i+1]
});

// ============================================================================
// 2) حدّ ATR
// ============================================================================
test('حدّ ATR: فجوة ضئيلة تُرفض وأخرى كبيرة تُقبل', () => {
  // ATR محسوب من الشموع؛ نضبط minSizeAtr=0.25
  // فجوة ضئيلة: 0.5 نقطة على ATR كبير
  const small = series([
    [100, 101, 99, 100],
    [100, 100.5, 99.5, 100],
    [100, 101, 100.5, 100.8] // low=100.5 ، high[i-1]=101 → لا فجوة أصلاً
  ]);
  // نبني فجوة ضئيلة حقيقية: high[i-1]=100 ، low[i+1]=100.2 → حجم 0.2
  const tiny = series([
    [99, 100, 98, 99],
    [99, 100.1, 98.9, 100],
    [100, 101, 100.2, 100.9]
  ]);
  const tinyFvgs = detectFvgs(tiny, 2, [], { minSizeAtr: 0.25, atrPeriod: 14 });
  // ATR هنا كبير نسبياً (مدى الشموع ~2) → 0.2 < 0.25*ATR → مرفوضة
  assert.equal(tinyFvgs.length, 0);

  // فجوة كبيرة: حجم 10 على نفس ATR → مقبولة
  const big = series([
    [99, 100, 98, 99],
    [99, 100.1, 98.9, 100],
    [100, 120, 110, 118] // low=110 ، high[i-1]=100 → حجم 10
  ]);
  const bigFvgs = detectFvgs(big, 2, [], { minSizeAtr: 0.25, atrPeriod: 14 });
  assert.equal(bigFvgs.length, 1);
  assert.equal(bigFvgs[0].bottom, 100);
  assert.equal(bigFvgs[0].top, 110);
  assert.ok(bigFvgs[0].sizeAtr >= 0.25);
});

// ============================================================================
// 3) الإبطال بالامتلاء الكامل
// ============================================================================
test('الإبطال: امتلاء جزئي يحدّث filledPct ولا يُبطل، والكامل يُبطل', () => {
  // فجوة صاعدة [100, 110] عند index 1
  const base = [
    [95, 100, 90, 98],
    [98, 108, 97, 105],
    [105, 120, 110, 118]
  ];
  // امتلاء جزئي: شمعة لاحقة low=105 (تغطي 100→105 = 50%)
  const partial = series([...base, [118, 119, 105, 108]]);
  const pf = detectFvgs(partial, 3, [], { minSizeAtr: 0 });
  assert.equal(pf.length, 1);
  assert.ok(pf[0].filledPct > 0 && pf[0].filledPct < 100);
  assert.equal(pf[0].filledPct, 50);
  assert.equal(pf[0].invalidatedAt, null);

  // امتلاء كامل: شمعة لاحقة low=99 (تغطي كامل [100,110])
  const full = series([...base, [118, 119, 99, 101]]);
  const ff = detectFvgs(full, 3, [], { minSizeAtr: 0 });
  assert.equal(ff.length, 1);
  assert.equal(ff[0].filledPct, 100);
  assert.equal(ff[0].invalidatedAt, 180); // time الشمعة الثالثة (index 3)
});

// ============================================================================
// 4) شرط البوس/CHoCH
// ============================================================================
test('شرط البوس: بلا حدث → triggered:false وskipReason، ومع حدث خارجي → true، والداخلي لا يُفعّل', () => {
  const cs = series([
    [95, 100, 90, 98],
    [98, 108, 97, 105],
    [105, 120, 110, 118]
  ]);
  // بلا أحداث
  const none = detectFvgs(cs, 2, [], { minSizeAtr: 0 });
  assert.equal(none[0].triggered, false);
  assert.equal(none[0].brakeless, true);
  assert.equal(none[0].skipReason, 'no_structural_break');

  // حدث خارجي في الاتجاه عند i+1=2
  const ext = detectFvgs(cs, 2, [{ type: 'bos_up', index: 2, time: 120, price: 120, external: true }], { minSizeAtr: 0 });
  assert.equal(ext[0].triggered, true);
  assert.equal(ext[0].brakeless, false);
  assert.equal(ext[0].skipReason, null);

  // حدث داخلي (external:false) → لا تفعيل
  const internal = detectFvgs(cs, 2, [{ type: 'bos_up', index: 2, time: 120, price: 120, external: false }], { minSizeAtr: 0 });
  assert.equal(internal[0].triggered, false);

  // حدث خارجي لكن في الاتجاه المعاكس → لا تفعيل
  const wrongDir = detectFvgs(cs, 2, [{ type: 'bos_down', index: 2, time: 120, price: 90, external: true }], { minSizeAtr: 0 });
  assert.equal(wrongDir[0].triggered, false);
});

// ============================================================================
// 5) الشكل A
// ============================================================================
test('الشكل A: كسر قاع + FVG + كسر قمة → منطقة طلب بحدود ذيل-ذيل وجسم مختلف', () => {
  // شمعة 0 قاعها 90، شمعة 1 تكسر القاع (low=85) وتكوّن FVG صاعدة مع شمعة 2
  const cs = series([
    [95, 100, 90, 98],   // 0: قاع سابق 90
    [92, 96, 85, 95],    // 1: كسر القاع (85 < 90) + شمعة إدفاع
    [95, 120, 100, 118]  // 2: low=100 > high[0]=100? لا؛ نضبط
  ]);
  // نضبط: high[0]=100 ، low[2]=101 → فجوة صاعدة [100,101]
  const cs2 = series([
    [95, 100, 90, 98],
    [92, 96, 85, 95],
    [95, 120, 101, 118]
  ]);
  const fvgs = detectFvgs(cs2, 2, [], { minSizeAtr: 0 });
  assert.equal(fvgs.length, 1);
  const events = [{ type: 'bos_up', index: 2, time: 120, price: 120, external: true }];
  const zones = detectSupplyDemand(cs2, fvgs, events, 2, { minSizeAtr: 0 });
  const a = zones.find(z => z.form === 'A' && z.kind === 'demand');
  assert.ok(a, 'يجب إنتاج منطقة طلب شكل A');
  assert.equal(a.originCandleIndex, 1);
  assert.equal(a.zoneHigh, 96);  // high الشمعة الأصلية
  assert.equal(a.zoneLow, 85);   // low الشمعة الأصلية
  assert.equal(a.bodyHigh, 95);  // max(open,close)
  assert.equal(a.bodyLow, 92);   // min(open,close)
  assert.notEqual(a.zoneHigh, a.bodyHigh); // الجسم مختلف عن الذيل
  assert.equal(a.confirmed, true);
  assert.equal(a.bosIndex, 2);
  assert.equal(a.provisional, false);
});

// ============================================================================
// 6) الشكل B
// ============================================================================
test('الشكل B: فجوتان يفصلهما تذبذب ثم كسر قمة', () => {
  /**
   * تصحيح بيانات الاختبار: النسخة الأولى لم تُنتج السيناريو الذي تصفه هي نفسها.
   * بالتعريف الثلاثي، الفجوة عند `i` تستخدم الشموع i-1 وi وi+1 — ففجوتان متلاصقتان
   * (فرق الفهرس = 1) تتشاركان الشموع ولا «يوجد بينهما شمعة أو تذبذب». الشرط الصحيح أن
   * يكون الفرق أكبر من 1، وهذه البيانات تحقّقه: فجوة عند 1 ([100,101]) ثم فجوة عند 3
   * ([105,110]) وبينهما الشمعة 2.
   */
  const cs = series([
    [95, 100, 90, 98],    // 0: قمة 100
    [92, 96, 85, 95],     // 1: كسر قاع سابق (85 < 90) — الإدفاع
    [95, 105, 101, 103],  // 2: low=101 > high[0]=100 → فجوة صاعدة #1
    [103, 108, 100, 106], // 3: low=100 > high[1]=96 → فجوة صاعدة #2
    [110, 130, 110, 128]  // 4: low=110 > high[2]=105 → فجوة صاعدة #3
  ]);
  const fvgs = detectFvgs(cs, 4, [], { minSizeAtr: 0 });
  const events = [{ type: 'bos_up', index: 4, time: 240, price: 130, external: true }];
  const zones = detectSupplyDemand(cs, fvgs, events, 4, { minSizeAtr: 0 });
  const b = zones.find(z => z.form === 'B' && z.kind === 'demand');
  assert.ok(b, 'يجب إنتاج منطقة طلب شكل B');
  assert.equal(b.originCandleIndex, 1);
  assert.equal(b.fvgs.length, 2);
  assert.ok(b.fvgs[1].index > b.fvgs[0].index + 1, `يفصلهما تذبذب: ${JSON.stringify(b.fvgs.map(f => f.index))}`);
  assert.equal(b.confirmed, true);
});

// ============================================================================
// 7) الشكل C
// ============================================================================
test('الشكل C: شمعة ثم فجوة ثم كسر قمة', () => {
  // شمعة 1 أصلية، فجوة صاعدة عند 2، كسر قمة عند 3
  const cs = series([
    [95, 100, 90, 98],   // 0
    [92, 96, 85, 95],    // 1: الشمعة الأصلية
    [95, 120, 101, 118], // 2: FVG صاعدة [100,101]
    [118, 130, 110, 128] // 3: كسر قمة
  ]);
  const fvgs = detectFvgs(cs, 3, [], { minSizeAtr: 0 });
  const events = [{ type: 'bos_up', index: 3, time: 180, price: 130, external: true }];
  const zones = detectSupplyDemand(cs, fvgs, events, 3, { minSizeAtr: 0 });
  const cc = zones.find(z => z.form === 'C' && z.kind === 'demand');
  assert.ok(cc, 'يجب إنتاج منطقة طلب شكل C');
  assert.equal(cc.originCandleIndex, 1);
  assert.equal(cc.fvgs[0].index, 2); // الفجوة مباشرة بعد الشمعة
  assert.equal(cc.confirmed, true);
});

// ============================================================================
// 8) العكس عند العرض
// ============================================================================
test('العكس عند العرض: نفس السيناريوهات بمعكوس الاتجاه → kind:supply', () => {
  // شكل A عرض: كسر قمة سابقة + FVG هابطة + كسر قاع
  const cs = series([
    [105, 110, 100, 102], // 0: قمة سابقة 110
    [108, 115, 104, 105], // 1: كسر القمة (115 > 110) + إدفاع FVG هابطة
    [105, 100, 90, 92]    // 2: high=100 < low[0]=100? نضبط
  ]);
  const cs2 = series([
    [105, 110, 100, 102],
    [108, 115, 104, 105],
    [105, 99, 90, 92]     // high=99 < low[0]=100 → FVG هابطة [99,100]
  ]);
  const fvgs = detectFvgs(cs2, 2, [], { minSizeAtr: 0 });
  assert.equal(fvgs.length, 1);
  assert.equal(fvgs[0].kind, 'bearish');
  const events = [{ type: 'bos_down', index: 2, time: 120, price: 90, external: true }];
  const zones = detectSupplyDemand(cs2, fvgs, events, 2, { minSizeAtr: 0 });
  const a = zones.find(z => z.form === 'A' && z.kind === 'supply');
  assert.ok(a, 'يجب إنتاج منطقة عرض شكل A');
  assert.equal(a.originCandleIndex, 1);
  assert.equal(a.zoneHigh, 115);
  assert.equal(a.zoneLow, 104);
  assert.equal(a.confirmed, true);
});

// ============================================================================
// 9) الاعتماد
// ============================================================================
test('الاعتماد: منطقة بلا كسر → confirmed:false وprovisional:true', () => {
  const cs = series([
    [95, 100, 90, 98],
    [92, 96, 85, 95],
    [95, 120, 101, 118]
  ]);
  const fvgs = detectFvgs(cs, 2, [], { minSizeAtr: 0 });
  const zones = detectSupplyDemand(cs, fvgs, [], 2, { minSizeAtr: 0 });
  assert.ok(zones.length > 0);
  for (const z of zones) {
    assert.equal(z.confirmed, false);
    assert.equal(z.provisional, true);
    assert.equal(z.bosIndex, null);
  }
});

// ============================================================================
// 10) لا معلومة مستقبلية + حتمية
// ============================================================================
test('لا معلومة مستقبلية: زيادة endIndex لا تغيّر نتائج الشموع السابقة', () => {
  const cs = series([
    [95, 100, 90, 98],
    [92, 96, 85, 95],
    [95, 120, 101, 118],
    [118, 130, 110, 128],
    [128, 140, 120, 138]
  ]);
  const at2 = detectFvgs(cs, 2, [], { minSizeAtr: 0 });
  const at4 = detectFvgs(cs, 4, [], { minSizeAtr: 0 });
  // الفجوة الأولى (index 1) يجب أن تبقى متطابقة
  const f2 = at2.find(f => f.index === 1);
  const f4 = at4.find(f => f.index === 1);
  assert.deepEqual(f2, f4);
});

test('حتمية: نفس المدخل مرتين → نفس المخرج', () => {
  const cs = series([
    [95, 100, 90, 98],
    [92, 96, 85, 95],
    [95, 120, 101, 118]
  ]);
  const events = [{ type: 'bos_up', index: 2, time: 120, price: 120, external: true }];
  const a = detectFvgs(cs, 2, events, { minSizeAtr: 0 });
  const b = detectFvgs(cs, 2, events, { minSizeAtr: 0 });
  assert.deepEqual(a, b);
  const za = detectSupplyDemand(cs, a, events, 2, { minSizeAtr: 0 });
  const zb = detectSupplyDemand(cs, b, events, 2, { minSizeAtr: 0 });
  assert.deepEqual(za, zb);
});

// ============================================================================
// 11) مدخلات فاسدة
// ============================================================================
test('مدخلات فاسدة: [] وNaN وstructureEvents غير مصفوفة → لا رمي', () => {
  assert.doesNotThrow(() => detectFvgs([], 0, [], {}));
  assert.deepEqual(detectFvgs([], 0, [], {}), []);
  assert.deepEqual(detectFvgs(null, 0, [], {}), []);
  assert.deepEqual(detectFvgs(undefined, undefined, undefined, undefined), []);

  // شموع فيها NaN
  const bad = [
    { time: 0, open: NaN, high: 100, low: 90, close: 98 },
    { time: 60, open: 98, high: 108, low: 97, close: 105 },
    { time: 120, open: 105, high: 120, low: 110, close: 118 }
  ];
  assert.doesNotThrow(() => detectFvgs(bad, 2, [], { minSizeAtr: 0 }));

  // structureEvents غير مصفوفة
  const cs = series([
    [95, 100, 90, 98],
    [92, 96, 85, 95],
    [95, 120, 101, 118]
  ]);
  assert.doesNotThrow(() => detectFvgs(cs, 2, 'not-array', { minSizeAtr: 0 }));
  assert.doesNotThrow(() => detectSupplyDemand(cs, null, 'x', 2, {}));
  assert.deepEqual(detectSupplyDemand(cs, null, [], 2, {}), []);
});
