import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildElements,
  defaultFilters,
  filterOptions,
  hiddenTotal,
  hitTest,
  layoutElements,
  mergeFilters,
  replaySnapshot,
  selectElements,
  stateAt,
  stepIndex,
  toSeconds,
  TYPE_META
} from '../../shared/historyModel.mjs';

/**
 * اختبارات نموذج الشارت التاريخي (منطق نقي، بلا متصفح):
 *  - عزل المحركين: أنواع كل محرك كما تنتجها وحداته فقط.
 *  - منع تسرب المستقبل: لا عنصر قبل availableAt، ولا حالة لاحقة على لحظة سابقة.
 *  - دقة الإحداثيات: تحويلات خطية معروفة، ومقارنة حسابية لا بصرية.
 *  - حتمية: نفس المدخلات ⇒ نفس المخرجات حرفياً.
 */

const candleSeries = (count, startTime = 1_000_000, step = 60) =>
  Array.from({ length: count }, (_, i) => ({
    index: i,
    time: startTime + i * step,
    open: 100 + i,
    high: 101 + i,
    low: 99 + i,
    close: 100.5 + i,
    volume: 10
  }));

const legacyZone = (over = {}) => ({
  id: 'BTCUSDT-1m-horizontal_bsl-cluster-high-0',
  kind: 'horizontal_bsl',
  state: 'confirmed',
  direction: 'down',
  referenceLevel: 101,
  referenceAlt: null,
  liquidityLevel: 103,
  retailStop: 103,
  zoneBox: null,
  bodyBox: null,
  createdAt: 1_000_000,
  confirmedAt: 1_000_600,
  detectedAt: 1_999_999,
  sweptAt: null,
  invalidatedAt: null,
  invalidation: null,
  availableAt: 1_000_240,
  availableAtBasis: 'pivot_confirm',
  confidence: 0.7,
  touches: 3,
  timeframe: '1m',
  touchPoints: [
    { index: 0, time: 1_000_000, price: 101, availableAt: 1_000_180 },
    { index: 4, time: 1_000_240, price: 101.2, availableAt: 1_000_420 },
    { index: 9, time: 1_000_540, price: 100.8, availableAt: 1_000_720 }
  ],
  trendline: null,
  staircase: { valid: true, breaks: [{ index: 12, time: 1_000_720, reactionPrice: 99 }], missingAt: -1 },
  finalBreak: { breakTime: 1_000_720, reactionPrice: 99 },
  breakSteps: [],
  atr: 0.5,
  distanceAtr: 4,
  prominenceAtr: 1.2,
  reasons: ['3 لمسات متقاربة'],
  premium: null,
  form: null,
  fvgs: [],
  structureEventKeys: [],
  source: 'liquidity-engine-v1',
  ...over
});

const v2Supply = (over = {}) => ({
  id: 'BTCUSDT-1m-supply-A-123-1000000',
  kind: 'supply',
  state: 'confirmed',
  direction: 'down',
  referenceLevel: 105,
  referenceAlt: null,
  liquidityLevel: 106,
  retailStop: 108,
  zoneBox: { high: 106, low: 104 },
  bodyBox: { high: 105.5, low: 104.5 },
  createdAt: 1_000_000,
  confirmedAt: 1_000_900,
  detectedAt: 1_999_999,
  sweptAt: null,
  invalidatedAt: null,
  invalidation: null,
  availableAt: 1_000_120,
  availableAtBasis: 'fvg_formed',
  confidence: 0.6,
  touches: 1,
  timeframe: '1m',
  touchPoints: [{ index: 0, time: 1_000_000, price: 105, availableAt: 1_000_120 }],
  trendline: null,
  staircase: { valid: false, breaks: [], missingAt: -1 },
  finalBreak: null,
  breakSteps: [],
  atr: 0.4,
  distanceAtr: 0,
  prominenceAtr: 5,
  reasons: ['منطقة عرض بالشكل A'],
  premium: null,
  form: 'A',
  fvgs: [
    { index: 0, time: 1_000_000, kind: 'bearish', top: 106, bottom: 104, availableAt: 1_000_060, invalidatedAt: null }
  ],
  structureEventKeys: ['bos_down:15'],
  source: 'liquidity-engine-v2',
  ...over
});

const v2Event = (over = {}) => ({
  key: 'bos_down:15',
  type: 'bos_down',
  index: 15,
  time: 1_000_900,
  price: 104,
  brokenLevel: 104,
  brokenPivotIndex: 5,
  brokenPivotTime: 1_000_300,
  brokenIndex: null,
  brokenTime: null,
  confirmBasis: 'close',
  external: true,
  priorBos: null,
  idmLevel: null,
  availableAt: 1_000_900,
  confirmed: true,
  evidence: { low1: 5, high1: 2, close: 103.9 },
  ...over
});

const axisFor = (rows) => ({
  tx: (t) => ((t - rows[0].time) / 60) * 10,
  py: (p) => 500 - p * 2,
  timeAtIndex: (i) => (rows[i] ? rows[i].time : null),
  indexAtTime: (t) => Math.round((t - rows[0].time) / 60)
});

/* ------------------------------------------------------------------ */
/* عزل المحركين                                                        */
/* ------------------------------------------------------------------ */

test('legacy: الأنواع هي أنواع المحرك القديم فقط — لا أحداث بنية ولا FVG ولا عرض/طلب', () => {
  const rows = candleSeries(50);
  const { elements, meta } = buildElements({ engine: 'legacy', zones: [legacyZone()], structureEvents: [] });
  const types = new Set(elements.map((e) => e.typeId));
  for (const t of ['idm', 'bos_up', 'bos_down', 'choch_up', 'choch_down', 'fvg', 'supply', 'demand']) {
    assert.equal(types.has(t), false, `لا يجب أن يظهر النوع ${t} في المحرك القديم`);
  }
  assert.ok(types.has('horizontal_bsl'));
  assert.ok(types.has('swing_high'));
  assert.deepEqual(meta.engineTypes, ['horizontal_bsl', 'horizontal_ssl', 'trendline_bsl', 'trendline_ssl']);
  assert.ok(meta.gaps.some((g) => g.includes('لا ينتج أحداث بنية')));
  assert.ok(rows.length > 0);
});

test('v2: يعرض أنواعه الستة + الأحداث + FVG، ويحذف تكرار الأحداث والفجوات', () => {
  const { elements } = buildElements({
    engine: 'v2',
    zones: [v2Supply(), v2Supply({ id: 'BTCUSDT-1m-supply-C-999-1000000', form: 'C' })],
    structureEvents: [v2Event()]
  });
  const types = elements.map((e) => e.typeId);
  assert.ok(types.includes('supply'));
  assert.equal(types.filter((t) => t === 'fvg').length, 1, 'FVG المكرر على منطقتين يُرسم مرة واحدة');
  assert.equal(types.filter((t) => t === 'bos_down').length, 1, 'الحدث المكرر على منطقتين يُرسم مرة واحدة');
  assert.equal(types.filter((t) => t === 'swing_high').length, 1, 'نفس نقطة اللمس لا تتكرر');
  assert.ok(elements.every((e) => TYPE_META[e.typeId]));
});

test('v2: zone.idm الفارغ موثّق كفجوة بدل اختلاق بيانات', () => {
  const { meta } = buildElements({ engine: 'v2', zones: [v2Supply()], structureEvents: [v2Event()] });
  assert.ok(meta.gaps.some((g) => g.includes('zone.idm')));
});

/* ------------------------------------------------------------------ */
/* منع تسرب المستقبل                                                   */
/* ------------------------------------------------------------------ */

test('لا حالة قبل availableAt: createdAt يسبق المعرفة ولا يُستخدم للتأكيد', () => {
  const { elements } = buildElements({ engine: 'legacy', zones: [legacyZone()] });
  const zone = elements.find((e) => e.zoneId === 'BTCUSDT-1m-horizontal_bsl-cluster-high-0' && e.shape !== 'marker');
  assert.equal(zone.createdAt, 1_000_000);
  assert.equal(zone.availableAt, 1_000_240);
  assert.notEqual(zone.createdAt, zone.confirmedAt, 'createdAt لا يُستبدل بزمن التأكيد');
  assert.equal(stateAt(zone, 1_000_000), 'pending', 'قبل المعرفة لا حالة');
  assert.equal(stateAt(zone, 1_000_239), 'pending');
  assert.equal(stateAt(zone, 1_000_240), 'candidate');
  assert.equal(stateAt(zone, 1_000_599), 'candidate');
  assert.equal(stateAt(zone, 1_000_600), 'confirmed', 'التأكيد عند confirmedAt الحقيقي من المحرك');
});

test('وضع التتبع يحجب كل عنصر لم يُعرف بعد عند المؤشر', () => {
  const { elements } = buildElements({ engine: 'legacy', zones: [legacyZone()] });
  const filters = defaultFilters();
  const early = selectElements(elements, { filters, cursorTime: 1_000_100, replay: true });
  assert.equal(early.visible.length, 0, 'لا شيء معروف قبل 1_000_240');
  assert.ok(early.counts.hidden.replay > 0);

  const later = selectElements(elements, { filters, cursorTime: 1_000_800, replay: true });
  assert.ok(later.visible.length > 0);
  const zone = later.visible.find((e) => e.shape === 'band');
  assert.equal(stateAt(zone, 1_000_800), 'confirmed');
});

test('العرض الكامل لا يحجب، لكن الحالة تُقيَّم على الزمن الحقيقي', () => {
  const { elements } = buildElements({ engine: 'legacy', zones: [legacyZone()] });
  const full = selectElements(elements, { filters: defaultFilters(), cursorTime: 1_000_240, replay: false });
  assert.ok(full.visible.length > 0);
  const zone = full.visible.find((e) => e.shape === 'band');
  assert.equal(stateAt(zone, 1_000_240), 'candidate', 'العرض الكامل لا يجعلها مؤكدة قبل وقتها');
});

test('المنطقة المسحوبة: التأكيد المشتق يُقبل فقط إن سبق السحب', () => {
  const beforeSweep = buildElements({
    engine: 'legacy',
    zones: [legacyZone({ state: 'swept', confirmedAt: null, sweptAt: 1_000_900, availableAt: 1_000_240 })]
  }).elements.find((e) => e.shape === 'band');
  assert.equal(beforeSweep.confirmedAt, 1_000_720, 'finalBreak = زمن التأكيد الفعلي');
  assert.equal(beforeSweep.confirmedBasis, 'final_break_derived');
  assert.equal(stateAt(beforeSweep, 1_000_800), 'confirmed');
  assert.equal(stateAt(beforeSweep, 1_000_900), 'swept');

  const afterSweep = buildElements({
    engine: 'legacy',
    zones: [legacyZone({ state: 'swept', confirmedAt: null, sweptAt: 1_000_500, availableAt: 1_000_240 })]
  }).elements.find((e) => e.shape === 'band');
  assert.equal(afterSweep.confirmedAt, null, 'السحب وقع قبل الكسر ⇒ لم تكن مؤكدة أبداً');
  assert.equal(stateAt(afterSweep, 1_000_600), 'swept');
});

test('المرجع البديل بلا زمن تكوّن: محجوب في وضع التتبع ما لم يُسمح به صراحةً', () => {
  const rows = candleSeries(50);
  const { elements } = buildElements({
    engine: 'v2',
    zones: [v2Supply({ referenceAlt: 109.5, kind: 'horizontal_bsl', zoneBox: null, form: null, fvgs: [], structureEventKeys: [] })],
    structureEvents: []
  });
  const args = {
    elements, ...axisFor(rows), width: 1000, height: 500,
    cursorTime: rows[40].time, cursorIndex: 40,
    style: defaultFilters().appearance, replay: true
  };
  const blocked = layoutElements({ ...args, altAllowed: false });
  assert.equal(blocked.segments.some((s) => s.id.endsWith(':alt')), false, 'لا خط مرجع بديل في التتبع بلا إذن');
  const allowed = layoutElements({ ...args, altAllowed: true });
  assert.equal(allowed.segments.some((s) => s.id.endsWith(':alt')), true, 'يظهر عند السماح الصريح');
});

test('عنصر بلا availableAt يُعدّ غير مؤرخ ويُحجب في وضع التتبع', () => {
  const { elements } = buildElements({ engine: 'legacy', zones: [legacyZone({ availableAt: null })] });
  const zone = elements.find((e) => e.shape === 'band');
  assert.equal(zone.untimed, true);
  const filters = defaultFilters();
  const hidden = selectElements(elements, { filters, cursorTime: 1_100_000, replay: true });
  assert.ok(hidden.counts.hidden.untimed > 0);
  const shown = selectElements(elements, { filters: { ...filters, untimed: true }, cursorTime: 1_100_000, replay: true });
  assert.equal(shown.counts.hidden.untimed, 0);
});

/* ------------------------------------------------------------------ */
/* الفلاتر                                                             */
/* ------------------------------------------------------------------ */

test('الفلاتر لا تحذف بيانات ولا تغيّر حالات: تعمل على مجموعة العرض فقط', () => {
  const { elements } = buildElements({ engine: 'legacy', zones: [legacyZone()] });
  const before = elements.map((e) => `${e.id}:${e.state}:${e.availableAt}`).join('|');
  const filters = mergeFilters({ types: { horizontal_bsl: false }, minConfidence: 0.9 });
  const result = selectElements(elements, { filters, cursorTime: 1_100_000, replay: false });
  assert.equal(result.visible.length, 0);
  assert.ok(result.counts.hidden.type > 0);
  assert.ok(result.counts.hidden.strength > 0);
  assert.equal(hiddenTotal(result.counts), elements.length);
  const after = elements.map((e) => `${e.id}:${e.state}:${e.availableAt}`).join('|');
  assert.equal(after, before, 'العناصر نفسها لم تتغير');
});

test('عدّادات الإخفاء تُفصّل السبب وتُطابق الإجمالي', () => {
  const { elements } = buildElements({ engine: 'legacy', zones: [legacyZone({ state: 'swept', sweptAt: 1_000_900 })] });
  const byStrength = selectElements(elements, {
    filters: mergeFilters({ minTouches: 5 }),
    cursorTime: 1_100_000,
    replay: false
  });
  assert.equal(byStrength.counts.total, elements.length);
  assert.equal(byStrength.counts.visible + hiddenTotal(byStrength.counts), elements.length);
  assert.ok(byStrength.counts.hidden.strength > 0);

  const byTime = selectElements(elements, {
    filters: mergeFilters({ timeFrom: 1_500_000 }),
    cursorTime: 1_100_000,
    replay: false
  });
  assert.equal(byTime.counts.visible + hiddenTotal(byTime.counts), elements.length);
  assert.ok(byTime.counts.hidden.time > 0);
});

test('filterOptions لا يعرض نوعاً غير موجود في مخرجات المحرك', () => {
  const legacy = buildElements({ engine: 'legacy', zones: [legacyZone()] });
  const legacyTypes = filterOptions(legacy.elements).types.map((t) => t.id);
  assert.deepEqual(legacyTypes, ['horizontal_bsl', 'swing_high']);
  const v2 = buildElements({ engine: 'v2', zones: [v2Supply()], structureEvents: [v2Event()] });
  const v2Types = filterOptions(v2.elements).types.map((t) => t.id);
  assert.ok(v2Types.includes('supply'));
  assert.ok(v2Types.includes('fvg'));
  assert.ok(v2Types.includes('bos_down'));
});

/* ------------------------------------------------------------------ */
/* الإحداثيات                                                          */
/* ------------------------------------------------------------------ */

test('دقة الإحداثيات: مستطيل المنطقة يبدأ عند availableAt وينتهي عند المؤشر', () => {
  const rows = candleSeries(50);
  const axis = axisFor(rows);
  const { elements } = buildElements({ engine: 'v2', zones: [v2Supply()], structureEvents: [v2Event()] });
  const layout = layoutElements({
    elements, ...axis, width: 1000, height: 500,
    cursorTime: rows[20].time, cursorIndex: 20,
    style: defaultFilters().appearance, replay: true
  });
  const box = layout.rects.find((r) => r.id === 'zone:BTCUSDT-1m-supply-A-123-1000000');
  assert.ok(box, 'يجب رسم المستطيل');
  assert.equal(box.x, axis.tx(1_000_120));
  assert.equal(box.w, axis.tx(rows[20].time) - axis.tx(1_000_120));
  assert.equal(box.y, axis.py(106));
  assert.equal(box.h, axis.py(104) - axis.py(106));
});

test('خط الاتجاه يُرسم بميل المحرك حتى مؤشر الوقت — لا بقيمة projected المستقبلية', () => {
  const rows = candleSeries(50);
  const axis = axisFor(rows);
  const zone = legacyZone({
    kind: 'trendline_bsl',
    trendline: {
      points: [
        { index: 0, time: rows[0].time, price: 100 },
        { index: 10, time: rows[10].time, price: 105 }
      ],
      slope: 0.5,
      projected: 130,
      errorAtr: 0.2,
      maxDeviationAtr: 0.3
    }
  });
  const { elements } = buildElements({ engine: 'legacy', zones: [zone] });
  const layout = layoutElements({
    elements, ...axis, width: 1000, height: 500,
    cursorTime: rows[20].time, cursorIndex: 20,
    style: defaultFilters().appearance, replay: true
  });
  const line = layout.segments.find((s) => s.id === `zone:${zone.id}`);
  assert.ok(line);
  assert.equal(line.y2, axis.py(100 + 0.5 * 20), 'السعر عند المؤشر من الميل لا من projected');
  assert.notEqual(line.y2, axis.py(130));
});

test('حتمية الرسم: نفس المدخلات ⇒ نفس المخرجات حرفياً', () => {
  const rows = candleSeries(50);
  const axis = axisFor(rows);
  const { elements } = buildElements({ engine: 'v2', zones: [v2Supply()], structureEvents: [v2Event()] });
  const args = {
    elements, ...axis, width: 1000, height: 500,
    cursorTime: rows[30].time, cursorIndex: 30,
    style: defaultFilters().appearance, replay: true
  };
  const a = layoutElements(args);
  const b = layoutElements(args);
  assert.deepEqual(a, b);
});

test('منطقة سُحبت بعد المؤشر: الامتداد يُقصّ عند المؤشر ولا يُرسم زمن سحب مستقبلي', () => {
  const rows = candleSeries(50);
  const axis = axisFor(rows);
  const zone = legacyZone({ state: 'swept', sweptAt: rows[45].time });
  const { elements } = buildElements({ engine: 'legacy', zones: [zone] });
  const layout = layoutElements({
    elements, ...axis, width: 1000, height: 500,
    cursorTime: rows[20].time, cursorIndex: 20,
    style: defaultFilters().appearance, replay: true
  });
  const box = layout.rects.find((r) => r.id.startsWith('zone:'));
  assert.ok(box, 'المنطقة تُرسم لأنها معروفة عند المؤشر');
  assert.equal(box.x + box.w, axis.tx(rows[20].time), 'النهاية عند المؤشر لا عند زمن السحب اللاحق');
  assert.notEqual(box.x + box.w, axis.tx(rows[45].time));
  const el = elements.find((e) => e.shape === 'band');
  assert.notEqual(stateAt(el, rows[20].time), 'swept', 'الحالة عند المؤشر لا تعرف سحباً لم يقع');
});

test('منطقة نشأت قبل النطاق المرئي: تُرسم من حافة النطاق ولا تُستبعد', () => {
  const rows = candleSeries(50);
  const axis = axisFor(rows);
  // منطقة عُرفت قبل أول شمعة في المحور (إحداثيها الأفقي سالب خارج الإطار)
  const zone = legacyZone({ createdAt: rows[0].time - 6600, availableAt: rows[0].time - 6000 });
  const { elements } = buildElements({ engine: 'legacy', zones: [zone] });
  const args = {
    elements, ...axis, width: 1000, height: 500,
    cursorTime: rows[49].time, cursorIndex: 49,
    style: defaultFilters().appearance, replay: false
  };
  assert.ok(axis.tx(zone.availableAt) < -40, 'إحداثي البداية خارج الإطار يساراً');
  const unclipped = layoutElements(args);
  assert.equal(unclipped.rects.length + unclipped.segments.length, 0, 'بلا نطاق مرئي معلن يبقى السلوك الأصلي');
  assert.ok(unclipped.culled > 0);

  // مع نطاق مرئي معلن والعنصر ما زال حياً: يُرسم من الحافة لا يُستبعد
  const clipped = layoutElements({ ...args, viewStartTime: rows[10].time, viewEndTime: rows[49].time });
  assert.equal(clipped.culled, 0, 'لا استبعاد صامت لعنصر حي داخل النطاق');
  const rect = clipped.rects.find((r) => r.id.startsWith('zone:'));
  assert.ok(rect, 'المنطقة تُرسم كمستطيل');
  assert.equal(rect.x, 0, 'تبدأ من حافة النطاق الأيسر');
  assert.equal(rect.x + rect.w, axis.tx(rows[49].time), 'وتمتد إلى المؤشر');

  // عنصر سُحب قبل بداية النطاق: لا يُرسم لأنه ليس امتداداً حياً
  const dead = legacyZone({ createdAt: rows[0].time - 6600, availableAt: rows[0].time - 6000, sweptAt: rows[5].time });
  const built2 = buildElements({ engine: 'legacy', zones: [dead] });
  const deadLayout = layoutElements({ ...args, elements: built2.elements, viewStartTime: rows[10].time, viewEndTime: rows[49].time });
  assert.equal(deadLayout.rects.length, 0, 'منطقة مسحوبة قبل النطاق تبقى مستبعدة');
});

test('لا انحراف عند التكبير: تحويلان مختلفان يعطيان نفس النسبة', () => {
  const rows = candleSeries(50);
  const { elements } = buildElements({ engine: 'legacy', zones: [legacyZone()] });
  const style = defaultFilters().appearance;
  const wide = layoutElements({ elements, ...axisFor(rows), width: 1000, height: 500, cursorTime: rows[40].time, cursorIndex: 40, style, replay: true });
  const zoomAxis = {
    // نفس أصل الإحداثيات وثلاثة أضعاف مقياس الزمن — الفرق في العرض فقط
    tx: (t) => ((t - rows[0].time) / 60) * 30,
    py: (p) => 500 - p * 4,
    timeAtIndex: (i) => (rows[i] ? rows[i].time : null),
    indexAtTime: (t) => Math.round((t - rows[0].time) / 60)
  };
  const zoom = layoutElements({ elements, ...zoomAxis, width: 1000, height: 500, cursorTime: rows[40].time, cursorIndex: 40, style, replay: true });
  const w1 = wide.rects.find((r) => r.id.startsWith('zone:')).w;
  const w2 = zoom.rects.find((r) => r.id.startsWith('zone:')).w;
  assert.equal(w2, w1 * 3, 'التمدد يتناسب مع مقياس الزمن (بلا إزاحة تقريبية)');
});

test('التسميات المتداخلة تُخفى وتُعدّ بدل أن تتراكب', () => {
  const rows = candleSeries(50);
  const zones = [
    legacyZone({ id: 'z1', referenceLevel: 101 }),
    legacyZone({ id: 'z2', referenceLevel: 101.05 })
  ];
  const { elements } = buildElements({ engine: 'legacy', zones });
  const layout = layoutElements({
    elements, ...axisFor(rows), width: 1000, height: 500,
    cursorTime: rows[40].time, cursorIndex: 40,
    style: defaultFilters().appearance, replay: true
  });
  assert.ok(layout.labelSkips > 0);
  assert.ok(layout.labels.length >= 1);
});

test('hitTest: النقر على المستوى يعيد المنطقة، والنقر في الفراغ يعيد null', () => {
  const rows = candleSeries(50);
  const axis = axisFor(rows);
  const { elements } = buildElements({ engine: 'legacy', zones: [legacyZone()] });
  const layout = layoutElements({
    elements, ...axis, width: 1000, height: 500,
    cursorTime: rows[40].time, cursorIndex: 40,
    style: defaultFilters().appearance, replay: true
  });
  const seg = layout.segments.find((s) => s.id.startsWith('zone:') && !s.dashed);
  assert.ok(seg);
  const midX = (seg.x1 + seg.x2) / 2;
  assert.equal(hitTest(layout, { x: midX, y: seg.y1 }, 8), seg.id);
  assert.equal(hitTest(layout, { x: midX, y: seg.y1 + 60 }, 8), null);
});

test('العناصر خارج النطاق تُعدّ culled ولا تُرسم', () => {
  const rows = candleSeries(50);
  const axis = axisFor(rows);
  const { elements } = buildElements({ engine: 'legacy', zones: [legacyZone()] });
  const layout = layoutElements({
    elements, ...axis, width: 100, height: 100,
    cursorTime: rows[40].time, cursorIndex: 40,
    style: defaultFilters().appearance, replay: true
  });
  assert.ok(layout.culled > 0);
  assert.equal(layout.rects.length, 0);
});

/* ------------------------------------------------------------------ */
/* التتبع                                                              */
/* ------------------------------------------------------------------ */

test('إعادة التشغيل حتمية: نفس المؤشر ⇒ نفس اللقطة', () => {
  const { elements } = buildElements({ engine: 'v2', zones: [v2Supply()], structureEvents: [v2Event()] });
  const args = { cursorTime: 1_000_800, replay: true, filters: defaultFilters() };
  assert.deepEqual(replaySnapshot(elements, args), replaySnapshot(elements, args));
});

test('الخطوات لا تتجاوز الحدود ولا تعتمد على الساعة', () => {
  assert.equal(stepIndex(0, -1, 10), 0);
  assert.equal(stepIndex(9, 1, 10), 9);
  assert.equal(stepIndex(5, 2, 10), 7);
  assert.equal(stepIndex(5, 2, 10), 7);
});

test('toSeconds يوحّد الثواني والمللي ثانية ويرفض غير الصالح', () => {
  assert.equal(toSeconds(1_700_000_000), 1_700_000_000);
  assert.equal(toSeconds(1_700_000_000_000), 1_700_000_000);
  assert.equal(toSeconds(null), null);
  assert.equal(toSeconds(0), null);
  assert.equal(toSeconds('x'), null);
});
