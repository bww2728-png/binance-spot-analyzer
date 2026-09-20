import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FABIO_REASON_MARKERS,
  isFabioZone,
  zoneKeyOf,
  flattenSnapshots,
  clampPage
} from '../liquidity/autoHistory.mjs';

const snapTs = (ts, symbol, zones, extra = {}) => ({
  id: extra.id ?? 1,
  ts,
  symbol,
  type: 'auto_zones_snapshot',
  message: extra.message ?? 'لقطة كشف آلي',
  meta: JSON.stringify({ ts, symbol, zones })
});

test('isFabioZone: meta أولاً — profile_edge زون من منطق المزاد حتى بلا أسباب', () => {
  const zone = { meta: 'profile_edge', reasons: [] };
  assert.equal(isFabioZone(zone), true);
});

test('isFabioZone: بدون meta — ماركر نصي في الأسباب يكفي (للتاريخ القديم)', () => {
  const zone = { meta: 'structural', reasons: ['منطقة القيمة القالبية (POC) بالقرب من السعر'] };
  assert.equal(isFabioZone(zone), true);
});

test('isFabioZone: زون هيكلية بلا meta ولا أسباب مزاد → ليست من منطق المزاد', () => {
  const zone = { meta: 'structural', reasons: ['عنقود قمم متساوية 0.2%'] };
  assert.equal(isFabioZone(zone), false);
});

test('isFabioZone: null و zone بلا حقول → حتمية بلا استثناء', () => {
  assert.equal(isFabioZone(null), false);
  assert.equal(isFabioZone({}), false);
});

test('isFabioZone: كل ماركات القائمة تعمل — غطاء كامل للماركرات', () => {
  for (const marker of FABIO_REASON_MARKERS) {
    assert.equal(isFabioZone({ meta: 'structural', reasons: [`سبب يحتوي: ${marker}`] }), true, marker);
  }
});

test('zoneKeyOf: تقريب 4 أرقام معنوية — انزياح طفيف داخل نفس السلة', () => {
  const a = zoneKeyOf({ symbol: 'BTCUSDT', timeframe: '15m', type: 'BSL', price: 76113.1011 });
  const b = zoneKeyOf({ symbol: 'BTCUSDT', timeframe: '15m', type: 'BSL', price: 76113.1012 });
  assert.equal(a, b);
  assert.equal(a, 'BTCUSDT|15m|BSL|76110');
});

test('zoneKeyOf: سلة مشتركة عبر المقادير — عملة دقيقة لا تعيد سعرها نفسه', () => {
  const a = zoneKeyOf({ symbol: 'ETHUSDT', timeframe: '1h', type: 'SSL', price: 0.19 });
  const b = zoneKeyOf({ symbol: 'ETHUSDT', timeframe: '1h', type: 'SSL', price: 0.190001 });
  assert.equal(a, b);
  assert.equal(a, 'ETHUSDT|1h|SSL|0.19');
});

test('zoneKeyOf: فريم مختلف = مفتاح مختلف حتى لو نفس السلة', () => {
  const a = zoneKeyOf({ symbol: 'BTCUSDT', timeframe: '15m', type: 'BSL', price: 76113.1011 });
  const b = zoneKeyOf({ symbol: 'BTCUSDT', timeframe: '1h', type: 'BSL', price: 76113.1011 });
  assert.notEqual(a, b);
});

test('zoneKeyOf: سعر كسلسلة رقمية — يقرب بنفس الشبكة المشتركة', () => {
  assert.equal(zoneKeyOf({ symbol: 'BTCUSDT', timeframe: '', type: 'BSL', price: '76113' }), 'BTCUSDT||BSL|76110');
});

test('flattenSnapshots: تفكيك كامل — كل حقول المنطقة في صف واحد مع zoneKey', () => {
  const zone = {
    id: 'z1', type: 'BSL', price: 76113.1011, timeframe: '15m', score: 0.82,
    reasons: ['فقاعة سيولة فوق القمة'], clusterCount: 3, swept: true, sweptAt: 1700000010000,
    bandPct: 0.0015, anchorTime: 1699999000000, meta: 'structural'
  };
  const rows = flattenSnapshots([snapTs(1700000000000, 'BTCUSDT', [zone])]);
  assert.equal(rows.length, 1);
  const r = rows[0];
  assert.equal(r.zoneKey, 'BTCUSDT|15m|BSL|76110');
  assert.equal(r.snapshotTs, 1700000000000);
  assert.equal(r.symbol, 'BTCUSDT');
  assert.equal(r.id, 'z1');
  assert.equal(r.type, 'BSL');
  assert.equal(r.price, 76113.1011);
  assert.equal(r.timeframe, '15m');
  assert.equal(r.score, 0.82);
  assert.equal(r.reasons[0], 'فقاعة سيولة فوق القمة');
  assert.equal(r.swept, true);
  assert.equal(r.meta, 'structural');
});

test('flattenSnapshots: فلتر fabioOnly الافتراضي — هيكلية تُقصّ ومنطق المزاد يبقى', () => {
  const fabio = { id: 'a', type: 'SSL', price: 74000, timeframe: '1h', score: 0.7, meta: 'profile_lvn', reasons: [] };
  const structural = { id: 'b', type: 'BSL', price: 76000, timeframe: '1h', score: 0.9, meta: 'structural', reasons: ['عنقود قمم'] };
  const rows = flattenSnapshots([snapTs(1700000000000, 'BTCUSDT', [fabio, structural])]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 'a');
  const all = flattenSnapshots([snapTs(1700000000000, 'BTCUSDT', [fabio, structural])], { fabioOnly: false });
  assert.equal(all.length, 2);
});

test('flattenSnapshots: فلاتر symbol و timeframe و type و minScore تعمل مجتمعة', () => {
  const events = [
    snapTs(1700000000000, 'BTCUSDT', [
      { id: '1', type: 'BSL', price: 76000, timeframe: '15m', score: 0.9, meta: 'profile_edge', reasons: [] },
      { id: '2', type: 'SSL', price: 74000, timeframe: '1h', score: 0.4, meta: 'profile_edge', reasons: [] }
    ]),
    snapTs(1700000050000, 'ETHUSDT', [
      { id: '3', type: 'BSL', price: 3000, timeframe: '15m', score: 0.95, meta: 'profile_edge', reasons: [] }
    ], { id: 2 })
  ];
  assert.equal(flattenSnapshots(events, { symbol: 'ETHUSDT' }).length, 1);
  assert.equal(flattenSnapshots(events, { timeframe: '1h' }).length, 1);
  assert.equal(flattenSnapshots(events, { type: 'BSL' }).length, 2);
  // minScore 0.85: BTC BSL (0.9) + ETH BSL (0.95) فقط — SSL (0.4) يُقصّ
  assert.equal(flattenSnapshots(events, { minScore: 0.85 }).length, 2);
  assert.equal(flattenSnapshots(events, { symbol: 'ETHUSDT', type: 'BSL', minScore: 0.9 }).length, 1);
});

test('flattenSnapshots: نافذة زمنية from/to — خارجة فقط تُقصّ', () => {
  const events = [snapTs(1700000000000, 'BTCUSDT', [{ id: '1', type: 'BSL', price: 76000, timeframe: '1h', score: 0.9, meta: 'profile_edge', reasons: [] }])];
  assert.equal(flattenSnapshots(events, { from: 1699999000000, to: 1700000100000 }).length, 1);
  assert.equal(flattenSnapshots(events, { from: 1700000000001 }).length, 0);
  assert.equal(flattenSnapshots(events, { to: 1699999999999 }).length, 0);
});

test('flattenSnapshots: meta غير صالح أو zones فارغة — تُتجاهل بلا استثناء', () => {
  const bad = [
    { id: 3, ts: 1700000000000, symbol: 'BTCUSDT', type: 'auto_zones_snapshot', message: 'x', meta: '{not json' },
    { id: 4, ts: 1700000000000, symbol: 'BTCUSDT', type: 'auto_zones_snapshot', message: 'x', meta: JSON.stringify({ ts: 1, symbol: 'BTCUSDT', zones: [] }) }
  ];
  assert.equal(flattenSnapshots(bad).length, 0);
  assert.equal(flattenSnapshots(null).length, 0);
});

test('flattenSnapshots: الترتيب تنازلي بالزمن ثم eventId — الأحدث أولاً', () => {
  const z = (id) => ({ id, type: 'BSL', price: 76000, timeframe: '1h', score: 0.9, meta: 'profile_edge', reasons: [] });
  const events = [
    snapTs(1700000000000, 'BTCUSDT', [z('old')], { id: 1 }),
    snapTs(1700000100000, 'BTCUSDT', [z('new1'), z('new2')], { id: 2 })
  ];
  const rows = flattenSnapshots(events, { fabioOnly: false });
  assert.equal(rows.map(r => r.id).join(','), 'new1,new2,old');
});

test('clampPage: افتراضي 200، سقف 500، offset ≥ 0، والصفر يعد افتراضياً', () => {
  assert.deepEqual(clampPage(), { limit: 200, offset: 0 });
  assert.deepEqual(clampPage('1000', '50'), { limit: 500, offset: 50 });
  // الصفر/السالب كعدد: الصفر يعد "غير محدد" → أرضية الأرضيات 200، والسالب يقص إلى 0
  assert.deepEqual(clampPage('0', '-5'), { limit: 200, offset: 0 });
  assert.deepEqual(clampPage('abc', null), { limit: 200, offset: 0 });
  assert.deepEqual(clampPage('1', '0'), { limit: 1, offset: 0 });
});
