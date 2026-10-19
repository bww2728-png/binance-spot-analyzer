/**
 * ارتدادي لصحة بيانات السوق — يشتغل على سوكت حقيقي (خادم WS محلي):
 *  1) إغلاق شموع متعددة في نفس اللحظة: كلها تصل (العلة السابقة: تخفيف 200ms عام كان يُسقطها)
 *  2) نفس الشمعة لا تُعلن مرتين
 *  3) السعر المجمّد لا يُعدّ صالحاً: connected()=false و getFreshPrice()=null
 *  4) فجوة الشموع: المفتاح المتأخر يُعاد بذره بـforce
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocketServer } from 'ws';
import { createMarketStreams } from '../market/streams.mjs';

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
    /** بثّ رسالة مغلّفة كما ترسلها بينانس */
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

async function connectedStreams(opts = {}) {
  const srv = await localStreamServer();
  const streams = createMarketStreams({
    log: silentLog,
    seedKlines: async () => [],
    config: { hosts: [`ws://127.0.0.1:${srv.port}`], maxConns: 1, ...opts.config }
  });
  streams.setKlineSubscriptions(['BTCUSDT|1m', 'ETHUSDT|1m']);
  streams.start();
  // انتظار الاتصال الفعلي
  for (let i = 0; i < 40 && streams.stats().connections === 0; i += 1) await sleep(25);
  await sleep(120);
  return { srv, streams };
}

test('كل إغلاقات الشموع في نفس اللحظة تصل (لا تخفيف عام)', async () => {
  const { srv, streams } = await connectedStreams();
  try {
    const got = [];
    streams.onCandleClose((s, tf) => got.push(`${s}|${tf}`));
    const bar = 1_700_000_000_000;
    // ثلاث شموع تُغلق في نفس الرسالة/اللحظة
    for (const sym of ['BTCUSDT', 'ETHUSDT', 'SOLUSDT']) {
      srv.push(`${sym.toLowerCase()}@kline_1m`, {
        s: sym, k: { t: bar, i: '1m', o: '1', h: '2', l: '0.5', c: '1.5', v: '1', x: true }
      });
    }
    await sleep(150);
    assert.deepEqual(got.sort(), ['BTCUSDT|1m', 'ETHUSDT|1m', 'SOLUSDT|1m'].sort(),
      `وصل ${got.length} من 3 إغلاقات`);
  } finally {
    streams.stop();
    await srv.close();
  }
});

test('نفس الشمعة لا تُعلن مرتين، والشمعة التالية تُعلن', async () => {
  const { srv, streams } = await connectedStreams();
  try {
    const got = [];
    streams.onCandleClose((s, tf) => got.push(`${s}|${tf}`));
    const bar = 1_700_000_000_000;
    const frame = (t) => ({ s: 'BTCUSDT', k: { t, i: '1m', o: '1', h: '2', l: '0.5', c: '1.5', v: '1', x: true } });
    // بينانس تعيد إرسال علم الإغلاق أكثر من مرة — يجب ألا يُعلن مرتين
    srv.push('btcusdt@kline_1m', frame(bar));
    await sleep(60);
    srv.push('btcusdt@kline_1m', frame(bar));
    await sleep(60);
    srv.push('btcusdt@kline_1m', frame(bar + 60_000));
    await sleep(120);
    assert.equal(got.length, 2, `توقّع إعلانين (شمعة أولى + تالية)، وصل ${got.length}`);
  } finally {
    streams.stop();
    await srv.close();
  }
});

test('السعر المجمّد لا يُعتمد: connected=false و getFreshPrice=null', async () => {
  let clock = 1_700_000_000_000;
  const srv = await localStreamServer();
  const streams = createMarketStreams({
    log: silentLog,
    now: () => clock,
    seedKlines: async () => [],
    config: { hosts: [`ws://127.0.0.1:${srv.port}`], maxConns: 1, priceStaleMs: 10_000 }
  });
  streams.setKlineSubscriptions(['BTCUSDT|1m']);
  streams.start();
  for (let i = 0; i < 40 && streams.stats().connections === 0; i += 1) await sleep(25);
  await sleep(120);
  try {
    srv.push('!miniTicker@arr', [{ s: 'BTCUSDT', c: '50000' }]);
    await sleep(120);
    assert.equal(streams.connected(), true, 'سعر حديث + اتصال مفتوح = متصل');
    assert.equal(streams.getFreshPrice('BTCUSDT'), 50000);

    clock += 11_000; // تجاوز حد الحداثة بلا رسائل جديدة
    assert.equal(streams.connected(), false, 'بث مجمّد لا يُعدّ متصلاً');
    assert.equal(streams.getFreshPrice('BTCUSDT'), null, 'السعر القديم لا يُعرض كصالح');
    assert.equal(streams.getPrice('BTCUSDT'), 50000, 'القيمة الخام تبقى للعرض');
    const st = streams.stats();
    assert.equal(st.stalePrices, 1, 'stats تكشف الأسعار القديمة');
    assert.ok(st.priceAgeMs >= 11_000, 'عمر السعر مرصود');
  } finally {
    streams.stop();
    await srv.close();
  }
});

test('فجوة الشموع: force يُعيد الجلب، وبلا force لا يُعاد', async () => {
  let seeded = 0;
  const streams = createMarketStreams({
    log: silentLog,
    seedKlines: async () => {
      seeded += 1;
      return [
        [1_700_000_000_000, '1', '2', '0.5', '1.5', '10', 0, '0', 0, '0', '0', '0'],
        [1_700_000_060_000, '1', '2', '0.5', '1.6', '11', 0, '0', 0, '0', '0', '0']
      ];
    },
    config: { maxConns: 1 }
  });
  const key = 'BTCUSDT|1m';
  await streams.ensureKlineSeed(key);
  assert.equal(seeded, 1);
  assert.equal(streams.hasKline(key), true);
  await streams.ensureKlineSeed(key);
  assert.equal(seeded, 1, 'بلا force لا تُعاد الجلب (منع النداء المكرر)');
  await streams.ensureKlineSeed(key, { force: true });
  assert.equal(seeded, 2, 'force يُعيد الجلب لإصلاح الفجوة');
  assert.equal(streams.lastBarAt('BTCUSDT', '1m'), 1_700_000_060_000, 'زمن آخر شمعة مرصود');
});

test('stats تُبلّغ عن اكتمال المفاتيح وعددها', async () => {
  const streams = createMarketStreams({
    log: silentLog,
    seedKlines: async () => [[1, '1', '1', '1', '1', '1', 0, '0', 0, '0', '0', '0']],
    config: { maxConns: 1 }
  });
  streams.setKlineSubscriptions(['BTCUSDT|1m']);
  await streams.ensureKlineSeed('BTCUSDT|1m');
  const s = streams.stats();
  assert.equal(s.klineSubs, 1);
  assert.equal(s.klineKeys, 1);
  assert.equal(s.staleCandles, 1, 'شمعة بُذرت من زمن قديم تُعدّ متأخرة');
});

test('صمت دفق الشموع يُقاس على الرموز التي تداولت فعلاً لا على الخامل', async () => {
  const { srv, streams } = await connectedStreams();
  try {
    streams.setAggTradeSubscriptions(['BTCUSDT', 'ETHUSDT']);
    const oldBar = Date.now() - 10 * 60_000; // شمعة قديمة لكلا الرمزين
    for (const sym of ['BTCUSDT', 'ETHUSDT']) {
      srv.push(`${sym.toLowerCase()}@kline_1m`, {
        s: sym, k: { t: oldBar, i: '1m', o: '1', h: '2', l: '0.5', c: '1.5', v: '1', x: false }
      });
    }
    // BTC تداول الآن (يجب أن تُدفع شمعته ولم تُدفع) — ETH خامل بلا صفقات
    srv.push('btcusdt@aggTrade', { s: 'BTCUSDT', p: '50000', q: '1', m: false, T: Date.now() });
    await sleep(200);
    const s = streams.stats();
    assert.equal(s.recentTraders, 1, 'رمز واحد تداول فعلاً خلال النافذة');
    assert.equal(s.staleCandles, 2, 'كلتا الشمعتين قديمتان (معلوماتي)');
    assert.equal(s.tradingStaleCandles, 1, 'العطل الحقيقي: رمز تداول ولم تُدفع شمعته');
  } finally {
    streams.stop();
    await srv.close();
  }
});

test('الرمز الذي تداول ولم تُدفع شمعته لا يُعدّ عطلاً بعد وصول شمعته', async () => {
  const { srv, streams } = await connectedStreams();
  try {
    streams.setAggTradeSubscriptions(['BTCUSDT']);
    srv.push('btcusdt@aggTrade', { s: 'BTCUSDT', p: '50000', q: '1', m: false, T: Date.now() });
    await sleep(80);
    assert.equal(streams.stats().tradingStaleCandles >= 1, true, 'عطل مرصود قبل وصول الشمعة');
    srv.push('btcusdt@kline_1m', {
      s: 'BTCUSDT', k: { t: Date.now(), i: '1m', o: '1', h: '2', l: '0.5', c: '1.5', v: '1', x: false }
    });
    await sleep(200);
    assert.equal(streams.stats().tradingStaleCandles, 0, 'زوال العطل بعد وصول الشمعة');
  } finally {
    streams.stop();
    await srv.close();
  }
});

test('السعر يُشتق من الشمعة الحية لرموز التحليل (لا من !miniTicker@arr وحده)', async () => {
  const { srv, streams } = await connectedStreams();
  try {
    const bar = 1_700_000_000_000;
    // شمعة BTC الجارية: إغلاق 50000 — يجب أن يصبح سعر القرار
    srv.push('btcusdt@kline_1m', {
      s: 'BTCUSDT', k: { t: bar, i: '1m', o: '49000', h: '51000', l: '48000', c: '50000', v: '1', x: false }
    });
    await sleep(150);
    assert.equal(streams.getFreshPrice('BTCUSDT'), 50000, 'سعر القرار من الشمعة');
    assert.equal(streams.stats().klineSourced >= 1, true, 'مرصود كمصدر شمعة');

    // رسالة شمعة قديمة (زمن أقدم) يجب ألا تُلوّث السعر الحالي
    srv.push('btcusdt@kline_1m', {
      s: 'BTCUSDT', k: { t: bar - 60_000, i: '1m', o: '1', h: '1', l: '1', c: '11111', v: '1', x: true }
    });
    await sleep(150);
    assert.equal(streams.getFreshPrice('BTCUSDT'), 50000, 'الشمعة الأقدم لا تُغيّر سعر القرار');
  } finally {
    streams.stop();
    await srv.close();
  }
});

test('نسبة التقادم تُقاس على رموز التحليل لا على كل كاش الأسعار', async () => {
  const { srv, streams } = await connectedStreams();
  try {
    const bar = 1_700_000_000_000;
    // 300 رمز "خامل" يصل مرة واحدة عبر المصفوفة ثم لا يتحدّث (محاكاة سلوك بينانس الفعلي)
    const stale = [];
    for (let i = 0; i < 300; i += 1) stale.push({ s: `OLD${i}USDT`, c: '1' });
    srv.push('!miniTicker@arr', stale);
    // رموز التحليل المشتركة في الشموع تتحدّث
    for (const sym of ['BTCUSDT', 'ETHUSDT']) {
      srv.push(`${sym.toLowerCase()}@kline_1m`, {
        s: sym, k: { t: bar, i: '1m', o: '1', h: '2', l: '0.5', c: '1.5', v: '1', x: false }
      });
    }
    await sleep(200);
    const s = streams.stats();
    assert.equal(s.priceSymbols >= 300, true, 'كل الأسعار محفوظة للعرض');
    assert.equal(s.analyzedSymbols, 2, 'رموز القرار فقط');
    assert.equal(s.stalePrices, 0, 'لا رموز قرار متقادمة');
    assert.equal(s.stalePriceRatio, 0, 'النسبة صحيحة (لا تتأثر بالرموز الخاملة)');
  } finally {
    streams.stop();
    await srv.close();
  }
});

test('استطلاع REST يُحدّث الأسعار المتقادمة ولا يطغى على سعر البث الحديث', async () => {
  const srv = await localStreamServer();
  let calls = 0;
  const streams = createMarketStreams({
    log: silentLog,
    seedKlines: async () => [],
    // استطلاع وهمي يُرجع سعراً لكل رمز
    fetchAllPrices: async () => { calls += 1; return { BTCUSDT: 55555, ETHUSDT: 3333 }; },
    config: { hosts: [`ws://127.0.0.1:${srv.port}`], maxConns: 1, priceStaleMs: 10_000, pricePollMs: 40 }
  });
  streams.setKlineSubscriptions(['BTCUSDT|1m', 'ETHUSDT|1m']);
  streams.start();
  for (let i = 0; i < 40 && streams.stats().connections === 0; i += 1) await sleep(25);
  try {
    await sleep(120);
    assert.equal(calls > 0, true, 'الاستطلاع اشتغل');
    assert.equal(streams.getFreshPrice('BTCUSDT'), 55555, 'سعر REST عُتمد حيث لا بث');
    assert.equal(streams.getFreshPrice('ETHUSDT'), 3333);

    // سعر بث حديث يجب أن يبقى (لا يُستبدل بطلب REST خلال 1.5 ثانية)
    srv.push('btcusdt@kline_1m', {
      s: 'BTCUSDT', k: { t: Date.now(), i: '1m', o: '1', h: '2', l: '0.5', c: '60000', v: '1', x: false }
    });
    await sleep(60);
    assert.equal(streams.getFreshPrice('BTCUSDT'), 60000, 'البث الحديث له الأولوية');
    await sleep(60);
    const st = streams.stats();
    assert.equal(st.pricePoll.intervalMs > 0, true, 'الفاصل مُبلّغ عنه');
    assert.equal(typeof st.restSourced, 'number', 'مصدر REST مرصود');
  } finally {
    streams.stop();
    await srv.close();
  }
});

test('فشل الاستطلاع لا يعطّل أي شيء ويُعاد لاحقاً', async () => {
  const srv = await localStreamServer();
  let calls = 0;
  const streams = createMarketStreams({
    log: silentLog,
    now: () => Date.now(),
    seedKlines: async () => [],
    fetchAllPrices: async () => { calls += 1; if (calls <= 2) throw new Error('شبكة مقطوعة'); return { BTCUSDT: 42 }; },
    config: { hosts: [`ws://127.0.0.1:${srv.port}`], maxConns: 1, pricePollMs: 30 }
  });
  streams.setKlineSubscriptions(['BTCUSDT|1m']);
  streams.start();
  for (let i = 0; i < 40 && streams.stats().connections === 0; i += 1) await sleep(25);
  try {
    await sleep(250);
    assert.equal(calls > 2, true, 'الاستطلاع استُعيد بعد الفشل');
    assert.equal(streams.getFreshPrice('BTCUSDT'), 42, 'عمل بعد التعافي');
    assert.equal(streams.stats().messages >= 0, true, 'الحالة سليمة');
  } finally {
    streams.stop();
    await srv.close();
  }
});
