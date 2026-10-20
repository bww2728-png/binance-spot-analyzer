import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mergeZones, replacePairScan, replaceSymbolScan, boundByNewest, shouldStartRotation, capState,
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

test('mergeZones: نفس دلالات الدمج الأصلية (مفتاح رمز|فريم|معرّف، ترتيب بالثقة)', () => {
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
