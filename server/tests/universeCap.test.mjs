/**
 * نطاق العمل المحدود — العيب الذي يحرسه هذا الملف:
 *
 * `resolveTargets()` كانت بلا سقف، و`warmUniverseAtBoot` يبذر كل الأهداف (~1200+)
 * × 14 فريماً ≈ 16,800 مفتاح عند الإقلاع، فيحجز المخزن المجمّع ~537MB ويموت V8 عند
 * ~594MB/640MB. الاختبار يثبت أن السقف يُطبَّق، وأن البذر لا يتجاوز النطاق المحدود.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  universeLimitFromEnv, capUniverse, UNIVERSE_MIN, UNIVERSE_MAX, UNIVERSE_DEFAULT
} from '../market/universe.mjs';
import { createMarketStreams } from '../market/streams.mjs';

const silentLog = { log: () => {}, warn: () => {}, error: () => {} };

test('LIVE_UNIVERSE_LIMIT: الافتراضي متحفظ عند غياب المتغيّر', () => {
  assert.equal(universeLimitFromEnv({}), UNIVERSE_DEFAULT);
  assert.equal(universeLimitFromEnv({ LIVE_UNIVERSE_LIMIT: '' }), UNIVERSE_DEFAULT);
  assert.equal(universeLimitFromEnv({ LIVE_UNIVERSE_LIMIT: 'abc' }), UNIVERSE_DEFAULT);
  assert.equal(universeLimitFromEnv({ LIVE_UNIVERSE_LIMIT: '0' }), UNIVERSE_DEFAULT);
  assert.equal(universeLimitFromEnv({ LIVE_UNIVERSE_LIMIT: '-5' }), UNIVERSE_DEFAULT);
});

test('LIVE_UNIVERSE_LIMIT: يُقيَّد ضمن [150, 600]', () => {
  assert.equal(universeLimitFromEnv({ LIVE_UNIVERSE_LIMIT: '1' }), UNIVERSE_MIN);
  assert.equal(universeLimitFromEnv({ LIVE_UNIVERSE_LIMIT: '9999' }), UNIVERSE_MAX);
  assert.equal(universeLimitFromEnv({ LIVE_UNIVERSE_LIMIT: '420' }), 420);
  assert.equal(universeLimitFromEnv({ LIVE_UNIVERSE_LIMIT: '420.9' }), 420);
});

test('capUniverse: يحفظ ترتيب المصدر ويقصّ الزائد بلا تعديل الأصل', () => {
  const full = ['A', 'B', 'C', 'D', 'E'];
  assert.deepEqual(capUniverse(full, 3), ['A', 'B', 'C']);
  assert.deepEqual(capUniverse(full, 999), full);
  assert.deepEqual(capUniverse(full, Number.POSITIVE_INFINITY), full);
  // limit غير صالح ⇒ بلا قص (احتياط محافظ لا يُخفي شيئاً بصمت)
  assert.deepEqual(capUniverse(full, Number.NaN), full);
  assert.deepEqual(capUniverse(full, -1), full);
  assert.deepEqual(full, ['A', 'B', 'C', 'D', 'E'], 'المصفوفة الأصلية لم تُمَس');
  assert.deepEqual(capUniverse(null, 3), []);
});

test('البذر لا يتجاوز النطاق المحدود: يُبذر رمز×فريم للنطاق فقط', async () => {
  const seedKlines = async () => [[1_700_000_000_000, 1, 2, 0.5, 1.5, 10, 0, 0, 0, 0, 0, 0]];
  const m = createMarketStreams({
    log: silentLog,
    seedKlines,
    config: { aggregateMode: true, aggregateCapacity: 20 }
  });
  const full = Array.from({ length: 1000 }, (_, i) => `SYM${i}USDT`);
  const working = capUniverse(full, 5); // نطاق العمل المحدود
  const res = await m.warmUniverse(working, { tfs: ['1m', '5m'] });
  assert.equal(working.length, 5);
  assert.equal(res.queued, 10, '5 رموز × فريمان = 10 مفاتيح فقط');
  assert.equal(m.candles.stats().keys, 10, 'المخزن يحوي النطاق المحدود وحده');
  assert.equal(m.candles.has('SYM0USDT', '1m'), true, 'داخل النطاق مبذور');
  assert.equal(m.candles.has('SYM4USDT', '5m'), true);
  assert.equal(m.candles.has('SYM5USDT', '1m'), false, 'خارج النطاق لم يُبذر إطلاقاً');
  assert.equal(m.candles.has('SYM999USDT', '1m'), false);
});