/**
 * سقف الاشتراكات الموحّد — العيب الذي يحرسه هذا الملف:
 *
 * كان اتحاد اشتراكات الـtenants (live 900 + strategy2 بلا سقف + workbench) يتجاوز
 * سعة الاشتراك الفعلية (maxConns × maxStreamsPerConn = 6×250 = 1,500)، فتُطلق رسالة
 * `max conns reached` **سطراً لكل رمز** (مئات الأسطر إنتاجياً). الإصلاح:
 *  - سقف صريح لـstrategy2 بالرمز (planStrategy2KlineSubs) لا بلا سقف.
 *  - سقف موحّد للاتحاد في streams + تحذير **واحد مُجمَّع معدود** لا سطر لكل رمز.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMarketStreams } from '../market/streams.mjs';
import { planStrategy2KlineSubs } from '../strategy2/loop.mjs';

// ws اختيارية: اختبارات السقف عبر سوكت حقيقي تُتخطّى على المنصات بلا WebSockets
let WebSocketServer = null;
try { WebSocketServer = (await import('ws')).WebSocketServer; } catch { WebSocketServer = null; }

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const silentLog = { log: () => {}, warn: () => {}, error: () => {} };

/* ================= سقف strategy2 (دالّة نقية — بلا شبكة) ================= */

test('planStrategy2KlineSubs: يقصّ بالرمز ويحفظ كل فريمات الرمز (لا تغطية جزئية)', () => {
  const symbols = Array.from({ length: 100 }, (_, i) => `S${i}USDT`);
  const plan = planStrategy2KlineSubs(symbols, ['1m', '5m', '15m'], 12);
  assert.equal(plan.capped, true);
  // فريمات فريدة = {1m,5m,15m} = 3 ⇒ السقف 12 مفتاحاً = 4 رموز كاملة
  assert.equal(plan.symbols.length, 4);
  assert.equal(plan.keys.length, 12);
  assert.deepEqual(
    plan.keys.filter(k => k.startsWith('S0USDT|')).sort(),
    ['S0USDT|15m', 'S0USDT|1m', 'S0USDT|5m']
  );
  assert.equal(new Set(plan.keys).size, plan.keys.length, 'لا مفاتيح مكرّرة (1m في entryTfs لا تُضاعف)');
});

test('planStrategy2KlineSubs: تحت السقف لا قص، والسقف 0 = بلا قص إضافي', () => {
  const symbols = ['AUSDT', 'BUSDT', 'CUSDT'];
  const under = planStrategy2KlineSubs(symbols, ['1m', '5m'], 600);
  assert.equal(under.capped, false);
  assert.deepEqual(under.symbols, symbols);
  assert.equal(under.keys.length, 6, '3 رموز × فريمين فريدين');

  const noCap = planStrategy2KlineSubs(symbols, ['1m', '5m'], 0);
  assert.equal(noCap.capped, false);
  assert.equal(noCap.keys.length, 6);
});

/* ================= سقف streams الموحّد (سوكت محلي حقيقي) ================= */

if (!WebSocketServer) {
  test('ws غير متاحة — اختبار سقف الاشتراك الموحّد عبر البث متخطى', { skip: 'ws package not installed' }, () => {});
} else {
  async function localStreamServer() {
    const server = new WebSocketServer({ port: 0 });
    await new Promise(r => server.once('listening', r));
    const sockets = new Set();
    server.on('connection', (ws) => { sockets.add(ws); ws.on('close', () => sockets.delete(ws)); });
    return {
      port: server.address().port,
      async close() {
        for (const ws of sockets) ws.close();
        await new Promise(r => server.close(r));
      }
    };
  }

  async function harness(config) {
    const srv = await localStreamServer();
    const warns = [];
    const streams = createMarketStreams({
      log: { log: () => {}, warn: (m) => warns.push(String(m)), error: () => {} },
      seedKlines: async () => [],
      config: { hosts: [`ws://127.0.0.1:${srv.port}`], ...config }
    });
    return { srv, streams, warns };
  }

  test('تجاوز السعة: تحذير واحد مُجمَّع معدود ولا سطر لكل رمز', async () => {
    // السعة = 2×5 = 10؛ ميزانية الشموع = 10 − 1 (miniTicker) − 0 (تدفق) − 1 (سعر) = 8
    const { srv, streams, warns } = await harness({ maxConns: 2, maxStreamsPerConn: 5, maxPriceSubs: 1 });
    try {
      const keys = Array.from({ length: 20 }, (_, i) => `SYM${i}USDT|1m`);
      streams.setKlineSubscriptions(keys);
      streams.start();
      for (let i = 0; i < 40 && streams.stats().connections === 0; i += 1) await sleep(25);
      await sleep(150);

      const capWarns = warns.filter(w => w.includes('تجاوز سعة الاشتراك الموحّدة'));
      assert.equal(capWarns.length, 1, `تحذير سقف واحد فقط، وُجد ${capWarns.length}`);
      assert.equal(warns.filter(w => w.includes('cannot subscribe')).length, 0, 'لا سطر لكل رمز');

      const st = streams.stats();
      assert.equal(st.streamCapacity, 10);
      assert.ok(st.streamDemand > st.streamCapacity, 'الطلب (22) يتجاوز السعة (10)');
      // لا امتلاء اتصالات فعلي: القصّ قبل التوزيع بلغ 10 بالضبط
      assert.equal(warns.filter(w => w.includes('بلغ سقف الاتصالات')).length, 0);
    } finally {
      streams.stop();
      await srv.close();
    }
  });

  test('داخل السعة: لا تحذير سقف إطلاقاً', async () => {
    const { srv, streams, warns } = await harness({ maxConns: 1, maxStreamsPerConn: 50, maxPriceSubs: 40 });
    try {
      streams.setKlineSubscriptions(['BTCUSDT|1m', 'ETHUSDT|1m', 'SOLUSDT|1m']);
      streams.start();
      for (let i = 0; i < 40 && streams.stats().connections === 0; i += 1) await sleep(25);
      await sleep(120);
      assert.equal(warns.length, 0, 'لا تحذيرات عند عدم تجاوز السعة');
      assert.ok(streams.stats().streamDemand <= streams.stats().streamCapacity);
    } finally {
      streams.stop();
      await srv.close();
    }
  });
}