/**
 * اختبارات التحويل الحادث لفحص مناطق السيولة: من REST لكل رمز وفريم إلى مخزن شموع
 * مجمّع يُغذّى من بث 1m واحد ويُكتشف على حدث إغلاق الشمعة.
 *
 * المحاور المُختبَرة:
 *  1) ربط apply1m→onAggregatedClose: شمعة 1m تُغلق فريم 5m → المستمع يُنادى مرة واحدة
 *     ب (symbol, '5m') وبقيم مجمّعة صحيحة.
 *  2) المستمع الفاشل لا يمنع الباقين (عزل try/catch لكل نداء).
 *  3) نزع التكرار في الطابور: 3 إغلاقات لنفس المفتاح في نفس النبضة → الكشف مرة واحدة.
 *  4) لا REST في المسار الحادث: تزوير seedKlines/limiter وتنفيذ إغلاق شمعة → لا شبكة.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocketServer } from 'ws';
import { createMarketStreams, createKeyQueue } from '../market/streams.mjs';

const silentLog = { log: () => {}, warn: () => {}, error: () => {} };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** خادم بث محلي يحاكي بروتوكول ستريمات بينانس */
async function localStreamServer() {
  const server = new WebSocketServer({ port: 0 });
  await new Promise(r => server.once('listening', r));
  const port = server.address().port;
  const sockets = new Set();
  server.on('connection', (ws) => {
    sockets.add(ws);
    ws.on('close', () => sockets.delete(ws));
  });
  return {
    port,
    push(stream, data) {
      const payload = JSON.stringify({ stream, data });
      for (const ws of sockets) ws.send(payload);
    },
    async close() {
      for (const ws of sockets) ws.close();
      await new Promise(r => server.close(r));
    }
  };
}

/** بثّ شمعة 1m كما ترسلها بينانس (V = taker buy base volume) */
const kline1m = (sym, t, o, h, l, c, v, V, x = false) => ({
  s: sym,
  k: { t, i: '1m', o: String(o), h: String(h), l: String(l), c: String(c), v: String(v), V: String(V), x }
});

async function connectedStreams(opts = {}) {
  const srv = await localStreamServer();
  const streams = createMarketStreams({
    log: silentLog,
    seedKlines: opts.seedKlines ?? (async () => []),
    config: { hosts: [`ws://127.0.0.1:${srv.port}`], maxConns: 1, ...opts.config }
  });
  streams.setKlineSubscriptions(['BTCUSDT|1m']);
  streams.start();
  for (let i = 0; i < 40 && streams.stats().connections === 0; i += 1) await sleep(25);
  await sleep(120);
  return { srv, streams };
}

test('1) شمعة 1m تُغلق فريم 5m → المستمع يُنادى مرة واحدة بقيم مجمّعة صحيحة', async () => {
  const { srv, streams } = await connectedStreams();
  try {
    const t0 = 1_700_000_000_000;
    // بذر نافذة 5m عند t0 (الحدود مشتقة من البذر لا من الحقبة)
    streams.candles.seed('BTCUSDT', '5m', [[t0, 100, 100, 100, 100, 0, t0 + 300000 - 1, 0, 0, 0]]);

    const got = [];
    streams.onAggregatedClose((e) => got.push(e));

    // أربع دقائق داخل النافذة (تحديث تراكمي)
    srv.push('btcusdt@kline_1m', kline1m('BTCUSDT', t0, 100, 105, 99, 104, 1, 0.4));
    srv.push('btcusdt@kline_1m', kline1m('BTCUSDT', t0 + 60000, 104, 110, 103, 108, 2, 0.9));
    srv.push('btcusdt@kline_1m', kline1m('BTCUSDT', t0 + 120000, 108, 109, 95, 96, 3, 1.2));
    srv.push('btcusdt@kline_1m', kline1m('BTCUSDT', t0 + 180000, 96, 97, 94, 95, 4, 1.5));
    // الدقيقة الخامسة: تُغلق نافذة 5m
    srv.push('btcusdt@kline_1m', kline1m('BTCUSDT', t0 + 300000, 95, 96, 93, 94, 5, 1.8));
    await sleep(200);

    const five = got.filter(e => e.tf === '5m');
    assert.equal(five.length, 1, 'نافذة 5m واحدة أُغلقت');
    assert.equal(five[0].symbol, 'BTCUSDT');
    assert.equal(five[0].tf, '5m');
    const b = five[0].bar;
    assert.equal(b.openTime, t0);
    assert.equal(b.open, 100, 'open = فتح الدقيقة الأولى');
    assert.equal(b.high, 110, 'high = الأكبر');
    assert.equal(b.low, 94, 'low = الأصغر (94 من الدقيقة الرابعة)');
    assert.equal(b.close, 95, 'close = إغلاق الدقيقة الأخيرة');
    assert.equal(b.volume, 10, 'volume = 1+2+3+4');
    assert.equal(b.takerBuyBase, 4, 'takerBuyBase = 0.4+0.9+1.2+1.5');
  } finally {
    streams.stop();
    await srv.close();
  }
});

test('2) المستمع الفاشل لا يمنع الباقين', async () => {
  const { srv, streams } = await connectedStreams();
  try {
    const t0 = 1_700_000_000_000;
    streams.candles.seed('BTCUSDT', '5m', [[t0, 100, 100, 100, 100, 0, t0 + 300000 - 1, 0, 0, 0]]);

    let goodCalls = 0;
    streams.onAggregatedClose(() => { throw new Error('مستمع فاشل مقصود'); });
    streams.onAggregatedClose(() => { goodCalls += 1; });

    srv.push('btcusdt@kline_1m', kline1m('BTCUSDT', t0, 100, 101, 99, 100, 1, 0.5));
    srv.push('btcusdt@kline_1m', kline1m('BTCUSDT', t0 + 300000, 100, 101, 99, 100, 1, 0.5));
    await sleep(200);

    assert.equal(goodCalls, 1, 'المستمع السليم يُنادى رغم فشل الأول');
  } finally {
    streams.stop();
    await srv.close();
  }
});

test('3) نزع التكرار: 3 إغلاقات لنفس المفتاح في نفس النبضة → الكشف مرة واحدة', async () => {
  const { srv, streams } = await connectedStreams();
  try {
    const t0 = 1_700_000_000_000;
    streams.candles.seed('BTCUSDT', '5m', [[t0, 100, 100, 100, 100, 0, t0 + 300000 - 1, 0, 0, 0]]);

    const keys = [];
    streams.onAggregatedClose(({ symbol, tf }) => keys.push(`${symbol}|${tf}`));

    // أربع شموع تُغلق ثلاث نوافذ 5m متتالية (كل إغلاق يُعلن مرة واحدة)
    srv.push('btcusdt@kline_1m', kline1m('BTCUSDT', t0, 100, 101, 99, 100, 1, 0.5));
    srv.push('btcusdt@kline_1m', kline1m('BTCUSDT', t0 + 300000, 100, 101, 99, 100, 1, 0.5));
    srv.push('btcusdt@kline_1m', kline1m('BTCUSDT', t0 + 600000, 100, 101, 99, 100, 1, 0.5));
    srv.push('btcusdt@kline_1m', kline1m('BTCUSDT', t0 + 900000, 100, 101, 99, 100, 1, 0.5));
    await sleep(200);

    // كل إغلاق يُعلن مرة واحدة (لا تكرار لنفس الشمعة) — والطابور ينزع تكرار المفتاح
    const five = keys.filter(k => k === 'BTCUSDT|5m');
    assert.equal(five.length, 3, 'ثلاث نوافذ 5m مختلفة أُغلقت (كل واحدة مرة)');
    // لا إعلان مزدوج لنفس الشمعة: عدد الإعلانات = عدد النوافذ المغلقة فعلاً
    assert.equal(keys.length, 3, 'لا إعلان زائد لنفس الشمعة');
  } finally {
    streams.stop();
    await srv.close();
  }
});

test('4) لا REST في المسار الحادث: إغلاق شمعة لا يستدعي seedKlines إطلاقاً', async () => {
  let seedCalls = 0;
  const { srv, streams } = await connectedStreams({
    seedKlines: async () => { seedCalls += 1; return []; }
  });
  try {
    const t0 = 1_700_000_000_000;
    // بذر مباشر في المخزن (بلا شبكة) لفتح نافذة 5m
    streams.candles.seed('BTCUSDT', '5m', [[t0, 100, 100, 100, 100, 0, t0 + 300000 - 1, 0, 0, 0]]);
    const before = seedCalls;

    const got = [];
    streams.onAggregatedClose((e) => got.push(e));

    // إغلاق نافذة 5m عبر البث — يجب ألا يُطلق أي طلب REST
    srv.push('btcusdt@kline_1m', kline1m('BTCUSDT', t0, 100, 101, 99, 100, 1, 0.5));
    srv.push('btcusdt@kline_1m', kline1m('BTCUSDT', t0 + 300000, 100, 101, 99, 100, 1, 0.5));
    await sleep(200);

    assert.equal(got.filter(e => e.tf === '5m').length, 1, 'الكشف حدث بلا REST');
    assert.equal(seedCalls, before, 'لا نداء شبكة واحد في المسار الحادث');
  } finally {
    streams.stop();
    await srv.close();
  }
});

test('5) warmUniverse: يبذر كل (رمز × فريم) مرة واحدة على دفعات ولا يكرّر المبذور', async () => {
  const calls = [];
  const streams = createMarketStreams({
    log: silentLog,
    seedKlines: async (symbol, tf) => {
      calls.push(`${symbol}|${tf}`);
      // صف REST صالح واحد لكل مفتاح
      return [[1_700_000_000_000, 1, 2, 0.5, 1.5, 10, 1_700_000_059_999, 0, 0, 4]];
    },
    config: { warmBatch: 4 }
  });

  const res = await streams.warmUniverse(['BTCUSDT', 'ETHUSDT'], { tfs: ['1m', '5m'] });
  assert.equal(res.queued, 4, 'مفتاحان × فريمان');
  assert.equal(res.seeded, 4, 'كلها بُذرت');
  assert.equal(res.failed, 0);
  assert.equal(calls.length, 4, 'طلب واحد لكل مفتاح');

  // تشغيل ثانٍ: لا يُكرّر البذر (ensureKlineSeed يتخطى المبذور)
  const res2 = await streams.warmUniverse(['BTCUSDT', 'ETHUSDT'], { tfs: ['1m', '5m'] });
  assert.equal(calls.length, 4, 'لا طلبات جديدة لمفاتيح مبذورة');
  assert.equal(res2.seeded, 4, 'المفاتيح موجودة في المخزن');
});

test('6) stats: قسم aggregate يعرض المفاتيح/الشموع/الميغابايت/الفجوات وaggregateMode', async () => {
  const streams = createMarketStreams({ log: silentLog, seedKlines: async () => [] });
  streams.candles.seed('BTCUSDT', '5m', [[1_700_000_000_000, 1, 2, 0.5, 1.5, 10, 1_700_000_299_999, 0, 0, 4]]);
  const s = streams.stats();
  assert.ok(s.aggregate, 'قسم aggregate موجود');
  assert.equal(s.aggregate.keys, 1);
  assert.equal(s.aggregate.bars, 1);
  assert.equal(typeof s.aggregate.bytesMb, 'number');
  assert.equal(s.aggregate.gaps, 0);
  assert.equal(s.aggregateMode, true);
});

test('7) createKeyQueue: 3 إضافات لنفس المفتاح في نفس النبضة → معالجة واحدة', async () => {
  const flushes = [];
  const q = createKeyQueue((keys) => flushes.push(keys));
  // ثلاث إضافات لنفس المفتاح قبل أي ميكروتاسك
  q.add('BTCUSDT|5m');
  q.add('BTCUSDT|5m');
  q.add('BTCUSDT|5m');
  assert.equal(q.size(), 1, 'المفتاح المكرر لا يُخزَّن مرتين');
  await Promise.resolve(); // تفريغ الميكروتاسك
  assert.equal(flushes.length, 1, 'معالجة واحدة فقط');
  assert.deepEqual(flushes[0], ['BTCUSDT|5m']);

  // مفاتيح مختلفة في نفس النبضة تُعالج معاً مرة واحدة
  q.add('ETHUSDT|1h');
  q.add('BTCUSDT|5m');
  await Promise.resolve();
  assert.equal(flushes.length, 2);
  assert.deepEqual(flushes[1].sort(), ['BTCUSDT|5m', 'ETHUSDT|1h'].sort());
});

test('8) createKeyQueue: معالج فاشل لا يُسقط الطابور ولا يمنع النبضة التالية', async () => {
  let calls = 0;
  const q = createKeyQueue(() => { calls += 1; throw new Error('فشل مقصود'); });
  q.add('BTCUSDT|5m');
  await Promise.resolve();
  assert.equal(calls, 1, 'المعالج نُودي مرة');
  // النبضة التالية تعمل رغم فشل السابقة
  q.add('ETHUSDT|1h');
  await Promise.resolve();
  assert.equal(calls, 2, 'الطابور لم يتعطل بعد الفشل');
});
