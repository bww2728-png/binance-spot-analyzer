import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mergeZones, replacePairScan, replaceSymbolScan, boundByNewest, shouldStartRotation, capState,
  pruneMissingKeys, lastTouchMs, zoneLevelKey, isSameLevel, resolveIdentityTolerance,
  DEFAULT_IDENTITY_TOLERANCE_PCT, IDENTITY_TOLERANCE_MIN, IDENTITY_TOLERANCE_MAX,
  DEFAULT_HISTORY_MAX_ZONES, DEFAULT_LIVE_MAX_ZONES
} from '../services/zoneStore.mjs';

/**
 * سياسة تخزين مخزون المناطق. السبب المُقاس: المنطقة الواحدة ~2.5KB، ودورة فحص كاملة
 * تُنتج ~27 ألف منطقة حيّة و~357 ألف منطقة تاريخية (~700MB) على حاوية حدّها 1GB،
 * فالتراكم بلا سقف يعني قتل الحاوية بالـOOM قبل إكمال أي تشغيل طويل.
 */

const zone = (symbol, timeframe, id, extra = {}) => ({
  symbol, timeframe, id, confidence: 0.5, detectedAt: 1000, ...extra
});

test('mergeZones: توافق خلفي — صفوف بلا سعر مرجعي تُدمج بالمعرّف، وترتيب تنازلي بالثقة', () => {
  const rows = [zone('BTCUSDT', '1m', 'a', { confidence: 0.2 }), zone('ETHUSDT', '1m', 'b', { confidence: 0.9 })];
  const out = mergeZones(rows, [zone('BTCUSDT', '1m', 'a', { confidence: 0.8 }), zone('BTCUSDT', '5m', 'c')]);
  assert.equal(out.length, 3, 'المعرّف المتكرر يُستبدل لا يُضاف');
  assert.equal(out[0].confidence, 0.9, 'الترتيب تنازلي بالثقة');
  assert.equal(out.find(z => z.id === 'a').confidence, 0.8, 'القيمة الأحدث غلبت');
});

test('replaceSymbolScan: يستبدل كل فريمات الرمز دفعة واحدة ويحفظ بقية الرموز', () => {
  const rows = [
    zone('BTCUSDT', '1m', 'a'), zone('BTCUSDT', '5m', 'b'), zone('BTCUSDT', '1h', 'c'),
    zone('ETHUSDT', '1m', 'd'), zone('ETHUSDT', '5m', 'e')
  ];
  const out = replaceSymbolScan(rows, 'BTCUSDT', ['1m', '5m', '1h'], [zone('BTCUSDT', '1m', 'n1'), zone('BTCUSDT', '5m', 'n2')]);
  assert.equal(out.length, 4, 'مناطق BTCUSDT القديمة الثلاث استُبدلت بمنطقتين + مناطق ETH');
  assert.deepEqual(out.filter(z => z.symbol === 'BTCUSDT').map(z => z.id).sort(), ['n1', 'n2']);
  assert.equal(out.filter(z => z.symbol === 'ETHUSDT').length, 2, 'رمز آخر لم يُمسّ');
});

test('replaceSymbolScan + boundByNewest: ثلاث دورات كاملة تبقى ضمن السقف', () => {
  let rows = [];
  const tfs = ['1m', '5m', '1h'];
  for (let rotation = 0; rotation < 3; rotation += 1) {
    for (let s = 0; s < 30; s += 1) {
      const symbol = `S${s}USDT`;
      const zones = tfs.map((tf, i) => zone(symbol, tf, `r${rotation}-${tf}-${i}`, { detectedAt: rotation * 1000 + s }));
      rows = boundByNewest(replaceSymbolScan(rows, symbol, tfs, zones), 50);
    }
  }
  assert.ok(rows.length <= 50, `المخزون ${rows.length} يجب ألا يتجاوز السقف 50`);
});

test('replacePairScan: مسح الزوج/الفريم الجديد يستبدل القديم ولا يتراكم معه', () => {
  const rows = [
    zone('BTCUSDT', '1m', 'old1'), zone('BTCUSDT', '1m', 'old2'),
    zone('BTCUSDT', '5m', 'keep'), zone('ETHUSDT', '1m', 'other')
  ];
  const out = replacePairScan(rows, 'BTCUSDT', '1m', [zone('BTCUSDT', '1m', 'new1')]);
  assert.equal(out.some(z => z.id === 'old1'), false, 'لم يبقَ مسح قديم لنفس الزوج والفريم');
  assert.equal(out.some(z => z.id === 'old2'), false);
  assert.equal(out.some(z => z.id === 'new1'), true);
  assert.equal(out.some(z => z.id === 'keep'), true, 'فريم آخر لم يُمسّ');
  assert.equal(out.some(z => z.id === 'other'), true, 'رمز آخر لم يُمسّ');
});

test('replacePairScan: دورة كاملة لنفس الزوج لا تُضاعف العدد', () => {
  let rows = [];
  const scan = [zone('BTCUSDT', '1m', 'x1'), zone('BTCUSDT', '1m', 'x2'), zone('BTCUSDT', '1m', 'x3')];
  for (let i = 0; i < 20; i += 1) {
    rows = replacePairScan(rows, 'BTCUSDT', '1m', scan.map(z => ({ ...z, detectedAt: 1000 + i })));
  }
  assert.equal(rows.length, 3, 'العشرون دورة أنتجت 3 مناطق لا 60');
});

test('replaceSymbolScan: يمرّر تسامح الهوية إلى الدمج (مسار تاريخي/حي بسلوك واحد)', () => {
  // مسحٌ واحد يحمل منطقتين متقاربتين 0.04%: التسامح الممرَّر يحدد هل تصيران واحدة
  const scan = () => [
    lvl('horizontal_bsl', 77_000, { id: 'a' }),
    lvl('horizontal_bsl', 77_000 * 1.0004, { id: 'b' })
  ];
  const loose = replaceSymbolScan([], 'BTCUSDT', ['1m'], scan(), { tolerancePct: 0.0005 });
  assert.equal(loose.length, 1, 'التسامح الممرَّر هو المُطبَّق');
  const strict = replaceSymbolScan([], 'BTCUSDT', ['1m'], scan());
  assert.equal(strict.length, 2, 'وبلا تمرير يبقى الافتراضي 0.02%');
});

test('boundByNewest: يُسقط الأقدم ويحتفظ بالأحدث عند بلوغ السقف', () => {
  const rows = Array.from({ length: 10 }, (_, i) => zone('BTCUSDT', '1m', `z${i}`, { detectedAt: i }));
  const out = boundByNewest(rows, 4);
  assert.equal(out.length, 4);
  const kept = new Set(out.map(z => z.id));
  assert.deepEqual([...kept].sort(), ['z6', 'z7', 'z8', 'z9'], 'الأحدث هي الباقية');
});

test('boundByNewest: بلا سقف أو تحت السقف لا يتغير شيء', () => {
  const rows = [zone('A', '1m', '1'), zone('A', '1m', '2')];
  assert.equal(boundByNewest(rows, 0), rows, 'سقف صفر = بلا حد');
  assert.equal(boundByNewest(rows, 100).length, 2);
  assert.equal(boundByNewest(rows, 2), rows, 'عند السقف بالضبط لا تغيير');
});

test('shouldStartRotation: يمنع البدء عند السقف فقط، ويسمح تحته', () => {
  assert.equal(shouldStartRotation(0, DEFAULT_LIVE_MAX_ZONES), true);
  assert.equal(shouldStartRotation(DEFAULT_LIVE_MAX_ZONES - 1, DEFAULT_LIVE_MAX_ZONES), true);
  assert.equal(shouldStartRotation(DEFAULT_LIVE_MAX_ZONES, DEFAULT_LIVE_MAX_ZONES), false, 'عند السقف: لا دورة جديدة');
  assert.equal(shouldStartRotation(999_999, DEFAULT_LIVE_MAX_ZONES), false);
  assert.equal(shouldStartRotation(999_999, 0), true, 'سقف معطّل = بلا حد');
});

test('capState: يبيّن السقف والاستهلاك، ويعني «بلا سقف» عند قيمة غير موجبة', () => {
  const half = capState(20_000, DEFAULT_LIVE_MAX_ZONES);
  assert.equal(half.capped, false);
  assert.equal(half.usagePct, 50);
  const full = capState(DEFAULT_LIVE_MAX_ZONES, DEFAULT_LIVE_MAX_ZONES);
  assert.equal(full.capped, true);
  assert.equal(full.usagePct, 100);
  const off = capState(500, 0);
  assert.equal(off.capped, false);
  assert.equal(off.cap, null);
  assert.equal(off.usagePct, null);
});

test('السقوف الافتراضية تكفي حاوية 1GB: 40 ألف منطقة × 2.5KB ≈ 100MB لكل مخزون', () => {
  const perZoneKb = 2.5;
  const liveMb = (DEFAULT_LIVE_MAX_ZONES * perZoneKb) / 1024;
  const historyMb = (DEFAULT_HISTORY_MAX_ZONES * perZoneKb) / 1024;
  assert.ok(liveMb <= 120, `المخزون الحي ${liveMb.toFixed(1)}MB يجب أن يبقى ≤ 120MB`);
  assert.ok(historyMb <= 120, `المخزون التاريخي ${historyMb.toFixed(1)}MB يجب أن يبقى ≤ 120MB`);
});

/**
 * هوية المنطقة من محتواها (★ العيب المقاس): `id` يحمل رقم العنقود الذي يتغيّر مع كل
 * انزلاق للنافذة، فيبقى للمستوى الفعلي الواحد صفّان أو أربعة. القياس على مخزون
 * BTCUSDT الحيّ: 18 منطقة لـ10 مستويات، وتكرار ×4 عند 76,956–76,961.
 */
const lvl = (kind, referenceLevel, extra = {}) => ({
  symbol: 'BTCUSDT', timeframe: '1m', kind, referenceLevel,
  id: `${kind}-${referenceLevel}`, confidence: 0.5, touches: 5, ...extra
});

test('mergeZones: معرّف متغيّر لنفس المستوى لا يُنتج صفاً ثانياً', () => {
  const rows = [lvl('horizontal_bsl', 76_958.64, { id: 'cluster-high-2', confidence: 0.6 })];
  const out = mergeZones(rows, [lvl('horizontal_bsl', 76_958.27, { id: 'cluster-high-7', confidence: 0.7 })]);
  assert.equal(out.length, 1, 'نفس المستوى بمعرّف جديد يُستبدل لا يُضاف');
  assert.equal(out[0].id, 'cluster-high-7', 'النسخة الأحدث هي الباقية');
});

test('mergeZones: التكرار المتراكم سابقاً (×4) يُنظَّف في دورة واحدة', () => {
  const rows = [76_505.38, 76_507.12, 76_512.91, 76_516.40].map((ref, i) => lvl('horizontal_ssl', ref, { id: `cluster-low-${i}` }));
  const out = mergeZones(rows, [lvl('horizontal_ssl', 76_509.95, { id: 'cluster-low-9' })]);
  assert.equal(out.length, 1, `أربع نسخ لنفس المستوى يجب أن تصير واحدة (بقي ${out.length})`);
});

test('mergeZones: النوع جزء من الهوية — أفقي وخط اتجاه بنفس السعر لا يُدمجان', () => {
  const rows = [lvl('horizontal_ssl', 76_487.12)];
  const out = mergeZones(rows, [lvl('trendline_ssl', 76_487.12)]);
  assert.equal(out.length, 2, 'خط الاتجاه كيان مستقل ولو تقارب السعر');
});

test('mergeZones: الرمز والفريم جزء من الهوية', () => {
  const rows = [lvl('horizontal_bsl', 76_958, { symbol: 'ETHUSDT' })];
  assert.equal(mergeZones(rows, [lvl('horizontal_bsl', 76_958, { symbol: 'BTCUSDT' })]).length, 2);
  const rows2 = [lvl('horizontal_bsl', 76_958, { timeframe: '5m' })];
  assert.equal(mergeZones(rows2, [lvl('horizontal_bsl', 76_958, { timeframe: '1m' })]).length, 2);
});

test('mergeZones: تسامح 0.02% — 0.012% (انزلاق مُقاس) يُدمج، 0.033% (مستويان حقيقيان) لا يُدمج', () => {
  const drift = mergeZones([lvl('horizontal_ssl', 76_507.38)], [lvl('horizontal_ssl', 76_516.40, { id: 'x' })]);
  assert.equal(drift.length, 1, 'تكرار مُقاس بنسبة 0.012% يُدمج');
  const distinct = mergeZones([lvl('horizontal_ssl', 76_752.19)], [lvl('horizontal_ssl', 76_777.37, { id: 'y' })]);
  assert.equal(distinct.length, 2, 'مستويان يرسمهما الشارت منفصلين (0.033%) يبقيان منفصلين');
});

test('mergeZones: عبور حدّ الكتلة السعرية لا يمنع الدمج (جيران الكتلة يُفحصون)', () => {
  const tol = 0.0002;
  const base = 77_000;
  const a = lvl('horizontal_bsl', base);
  const b = lvl('horizontal_bsl', base * (1 + tol * 0.9), { id: 'edge' });
  assert.notEqual(zoneLevelKey(a, tol), zoneLevelKey(b, tol), 'الكتلتان مختلفتان — أي أن الاختبار يعبر حدّاً فعلاً');
  const out = mergeZones([a], [b]);
  assert.equal(out.length, 1, 'الحدّ بين كتلتين ليس فرقاً سعرياً حقيقياً');
});

test('mergeZones: صف قديم بلا سعر مرجعي يُستبدل بالمعرّف إذا تطابق (مسار احتياطي)', () => {
  // صفوف ما قبل الإصلاح قد تخلو من `referenceLevel`؛ مفتاح المعرّف يبقى مفحوصاً دائماً
  const rows = [{ symbol: 'A', timeframe: '1m', id: 'z', confidence: 0.2, referenceLevel: undefined }];
  const out = mergeZones(rows, [lvl('horizontal_bsl', 77_000, { symbol: 'A', id: 'z', confidence: 0.9 })]);
  assert.equal(out.length, 1, 'لا يبقى الصف القديم بجانب الجديد');
  assert.equal(out[0].confidence, 0.9);
});

test('زواج الدمج بالمعرّف كما كان (توافق خلفي كامل)', () => {
  const rows = [{ symbol: 'A', timeframe: '1m', id: 'z', confidence: 0.2 }];
  const out = mergeZones(rows, [{ symbol: 'A', timeframe: '1m', id: 'z', confidence: 0.9 }]);
  assert.equal(out.length, 1);
  assert.equal(out[0].confidence, 0.9);
});

/**
 * إسقاط مناطق مفاتيح غادرت المخزن (★ التقادم المقاس: 274–321 دقيقة لمناطق 1m بعد فشل
 * بذر 3,503 مفتاحاً من 3,766).
 */
const NOW = 1_800_000_000_000; // مللي ثانية
const zoneSeenAgoMs = (agoMs, extra = {}) => ({
  symbol: 'BTCUSDT', timeframe: '1m', kind: 'horizontal_bsl', referenceLevel: 77_000, id: `z${agoMs}`,
  touchPoints: [{ time: Math.floor((NOW - agoMs) / 1000), price: 77_000 }], ...extra
});

test('pruneMissingKeys: المفتاح الحاضر لا يُمَس أبداً', () => {
  const rows = [zoneSeenAgoMs(10 * 60 * 60_000)];
  const res = pruneMissingKeys(rows, { hasKey: () => true, now: NOW, graceMs: 60 * 60_000 });
  assert.equal(res.dropped, 0);
  assert.equal(res.stale, 0);
  assert.equal(res.rows.length, 1);
});

test('pruneMissingKeys: مفتاح غائب داخل المهلة يبقى ويُعدّ stale', () => {
  const rows = [zoneSeenAgoMs(5 * 60_000)];
  const res = pruneMissingKeys(rows, { hasKey: () => false, now: NOW, graceMs: 60 * 60_000 });
  assert.equal(res.dropped, 0, 'انقطاع دقائق ليس سبباً لمسح مخزون يقرأه القرار');
  assert.equal(res.stale, 1);
  assert.equal(res.rows.length, 1);
});

test('pruneMissingKeys: مفتاح غائب بعد المهلة يُسقط، والقديم 5 ساعات يُسقط', () => {
  const rows = [zoneSeenAgoMs(2 * 60 * 60_000), zoneSeenAgoMs(5 * 60 * 60_000), zoneSeenAgoMs(60 * 60_000 + 1)];
  const res = pruneMissingKeys(rows, { hasKey: () => false, now: NOW, graceMs: 60 * 60_000 });
  assert.equal(res.dropped, 3, 'الثلاثة تجاوزوا المهلة (آخرها بفارق 1ms)');
  assert.equal(res.rows.length, 0);
});

test('pruneMissingKeys: منطقة بلا زمن لمس ولا إنشاء تُسقط (لا دليل على حداثتها)', () => {
  const rows = [{ symbol: 'X', timeframe: '1m', id: 'no-time', kind: 'horizontal_ssl', referenceLevel: 1 }];
  const res = pruneMissingKeys(rows, { hasKey: () => false, now: NOW, graceMs: 60 * 60_000 });
  assert.equal(res.dropped, 1);
});

test('pruneMissingKeys: بلا دالة hasKey أو بلا صفوف لا يتغيّر شيء', () => {
  const rows = [zoneSeenAgoMs(5 * 60_000)];
  assert.equal(pruneMissingKeys(rows, {}).rows, rows);
  assert.equal(pruneMissingKeys([], { hasKey: () => false }).dropped, 0);
  assert.equal(pruneMissingKeys(null, { hasKey: () => false }).dropped, 0);
});

test('pruneMissingKeys: يحسب العمر من lastTouchMs لا من detectedAt (وحداته مختلطة)', () => {
  // detectedAt في المحرك Date.now() للمناطق العادية، لكنه ثواني الشمعة لخط الاتجاه
  const z = zoneSeenAgoMs(5 * 60_000, { detectedAt: 1_700_000_000_000 });
  assert.equal(lastTouchMs(z), (Math.floor((NOW - 5 * 60_000) / 1000)) * 1000);
  const res = pruneMissingKeys([z], { hasKey: () => false, now: NOW, graceMs: 60 * 60_000 });
  assert.equal(res.dropped, 0, 'العمر من آخر لمسة = 5 دقائق');
});

test('pruneMissingKeys: المهلة تُحسب من أول غياب لا من عمر المنطقة', () => {
  // الحالة المُقاسة: منطقة عمرها 5 ساعات، والمفتاح غاب للتو ⇒ تبقى (سماح كامل)
  const rows = [zoneSeenAgoMs(5 * 60 * 60_000)];
  const absent = new Map();
  const first = pruneMissingKeys(rows, { hasKey: () => false, now: NOW, graceMs: 60 * 60_000, absentSince: absent });
  assert.equal(first.dropped, 0, 'أول رصد للغياب = بداية المهلة، لا نهاية المخزون');
  assert.equal(absent.get('BTCUSDT|1m'), NOW);
  const later = pruneMissingKeys(rows, { hasKey: () => false, now: NOW + 61 * 60_000, graceMs: 60 * 60_000, absentSince: absent });
  assert.equal(later.dropped, 1, 'بعد المهلة من أول غياب تُسقط');
  assert.equal(absent.get('BTCUSDT|1m'), NOW, 'لحظة الغياب لا تُحدَّث كل فحص');
});

test('pruneMissingKeys: عودة المفتاح تُصفّر عدّاد الغياب (ولا يُسقط لاحقاً بالخطأ)', () => {
  const rows = [zoneSeenAgoMs(30 * 60_000)];
  const absent = new Map();
  pruneMissingKeys(rows, { hasKey: () => false, now: NOW, graceMs: 60 * 60_000, absentSince: absent });
  assert.equal(absent.size, 1);
  const back = pruneMissingKeys(rows, { hasKey: () => true, now: NOW + 10 * 60_000, graceMs: 60 * 60_000, absentSince: absent });
  assert.equal(back.dropped, 0);
  assert.equal(absent.size, 0, 'المفتاح الحاضر يُحذف من خريطة الغياب');
  const again = pruneMissingKeys(rows, { hasKey: () => false, now: NOW + 20 * 60_000, graceMs: 60 * 60_000, absentSince: absent });
  assert.equal(again.dropped, 0, 'غياب جديد يبدأ مهلة جديدة لا مهلة قديمة');
  assert.equal(absent.get('BTCUSDT|1m'), NOW + 20 * 60_000);
});

test('pruneMissingKeys: تحمّل touchPoints غير مصفوفة (لا يرمي)', () => {
  const rows = [{ symbol: 'X', timeframe: '1m', id: 'x', kind: 'horizontal_ssl', referenceLevel: 1, touchPoints: 'bad' }];
  const res = pruneMissingKeys(rows, { hasKey: () => false, now: NOW, graceMs: 0, absentSince: new Map() });
  assert.equal(res.dropped, 0, 'غياب جديد بمهلة صفر ⇒ لم يمرّ وقت بعد');
});

test('resolveIdentityTolerance: يحمي الطرفين — NaN/0/سالب ← الافتراضي، صغير جداً ← الأرضية، كبير ← السقف', () => {
  assert.equal(resolveIdentityTolerance(NaN), DEFAULT_IDENTITY_TOLERANCE_PCT);
  assert.equal(resolveIdentityTolerance(0), DEFAULT_IDENTITY_TOLERANCE_PCT);
  assert.equal(resolveIdentityTolerance(-1), DEFAULT_IDENTITY_TOLERANCE_PCT);
  assert.equal(resolveIdentityTolerance(1e-320), IDENTITY_TOLERANCE_MIN, 'يمنع log1p=0 الذي يجعل كل الأسعار كتلة واحدة');
  assert.equal(resolveIdentityTolerance(1), IDENTITY_TOLERANCE_MAX, 'لا يُسمح بتسامح يدمج مستويات المحرك');
  assert.equal(resolveIdentityTolerance(0.0002), 0.0002);
});

test('isSameLevel: النوع الغائب غير معروف لا مخالف، والنوع المختلف يمنع الدمج', () => {
  assert.equal(isSameLevel({ symbol: 'A', timeframe: '1m', id: 'z' }, lvl('horizontal_bsl', 77_000, { symbol: 'A', id: 'z' })), true);
  assert.equal(isSameLevel({ symbol: 'A', timeframe: '1m', id: 'z' }, lvl('horizontal_bsl', 77_000, { symbol: 'A', id: 'other' })), false);
  assert.equal(isSameLevel(lvl('horizontal_bsl', 77_000), lvl('horizontal_ssl', 77_000)), false);
  assert.equal(isSameLevel(lvl('horizontal_bsl', 77_000), lvl('horizontal_bsl', 77_000 * 1.001)), false);
  assert.equal(isSameLevel(null, lvl('horizontal_bsl', 77_000)), false);
});

test('mergeZones: تكرار داخل الوارد نفسه يُدمج بالأعلى ثقة (حتمي بلا اعتماد على الترتيب)', () => {
  const a = lvl('horizontal_ssl', 76_500, { id: 'a', confidence: 0.6 });
  const b = lvl('horizontal_ssl', 76_505, { id: 'b', confidence: 0.8 });
  const out1 = mergeZones([], [a, b]);
  const out2 = mergeZones([], [b, a]);
  assert.equal(out1.length, 1);
  assert.equal(out2.length, 1);
  assert.equal(out1[0].id, 'b', 'الأعلى ثقة يفوز في الاتجاهين');
  assert.equal(out2[0].id, 'b');
});
