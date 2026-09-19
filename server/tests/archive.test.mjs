import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupZoneHistory, parseZoneMeta } from '../archive.mjs';

const ev = (id, ts, zone) => ({ id, ts, symbol: zone?.symbol ?? '', type: 'liquidity_zone', message: '', meta: JSON.stringify(zone) });

const zone = (id, symbol, price, extra = {}) => ({ id, symbol, type: 'BSL', price, timeframe: '1h', note: '', created_at: 0, expires_at: null, active: true, source: 'manual', ...extra });

test('parseZoneMeta: يتجاهل الأحداث التالفة والفاقدة للمعنى', () => {
  assert.equal(parseZoneMeta({ meta: 'not-json' }), null);
  assert.equal(parseZoneMeta({ meta: null }), null);
  assert.equal(parseZoneMeta({ meta: JSON.stringify({ id: 'x', source: 'auto' }) }), null);
  assert.equal(parseZoneMeta(ev(1, 10, zone('z1', 'BTCUSDT'))).id, 'z1');
});

test('groupZoneHistory: سلسلة إنشاء → تعديل → حذف تُصنَّف بشكل صحيح', () => {
  const events = [
    ev(1, 100, zone('z1', 'BTCUSDT', 100)),
    ev(2, 200, zone('z1', 'BTCUSDT', 101, { note: 'معدّل' })),
    ev(3, 300, zone('z1', 'BTCUSDT', 101, { active: false }))
  ];
  const groups = groupZoneHistory(events);
  assert.equal(groups.length, 1);
  const g = groups[0];
  assert.equal(g.zoneId, 'z1');
  assert.equal(g.deleted, true);
  assert.equal(g.symbol, 'BTCUSDT');
  assert.equal(g.versions.length, 3);
  assert.deepEqual(g.versions.map(v => v.action), ['create', 'edit', 'delete']);
  assert.equal(g.versions[2].zone.active, false);
});

test('groupZoneHistory: ترتيب عشوائي للإدخالات لا يكسر السلسلة', () => {
  const events = [
    ev(9, 300, zone('z1', 'BTCUSDT', 101, { active: false })),
    ev(1, 100, zone('z1', 'BTCUSDT', 100)),
    ev(5, 200, zone('z1', 'BTCUSDT', 101))
  ];
  const g = groupZoneHistory(events)[0];
  assert.deepEqual(g.versions.map(v => v.action), ['create', 'edit', 'delete']);
  assert.deepEqual(g.versions.map(v => v.ts), [100, 200, 300]);
});

test('groupZoneHistory: منطقة بدون حذف = غير محذوفة ومرتّبة تنازلياً حسب آخر نسخة', () => {
  const events = [
    ev(1, 100, zone('a', 'BTCUSDT', 100)),
    ev(2, 200, zone('a', 'BTCUSDT', 105)),
    ev(3, 150, zone('b', 'ETHUSDT', 50))
  ];
  const groups = groupZoneHistory(events);
  assert.equal(groups[0].zoneId, 'a');
  assert.equal(groups[0].deleted, false);
  assert.equal(groups[1].zoneId, 'b');
  assert.deepEqual(groups[0].versions.map(v => v.action), ['create', 'edit']);
});