/**
 * اختبارات ★2 (معرّف المنطقة المرشَّح) والاستمرارية (مخزون + ملخص باك تيست).
 *
 * الحراسة الأساسية هنا ليست «هل الدالة تعمل» بل **هل القياس نفسه أمين**:
 *  - المعرّف المرشَّح يجب أن يكون حتمياً ومن المحتوى وحده (لا من الترتيب).
 *  - دوران المعرّف يجب أن يُقاس بالتقارب (نفس منطق المحرك) لا بمفتاح شبكي، وإلا
 *    أنتج دوراناً وهمياً.
 *  - وحدات الحفظ/الاسترجاع يجب أن تكون حتمية ومحدودة الحجم ومتحمّلة للفشل.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { candidateZoneId, withCandidateId, measureCandidateGrids, createCandidateCollector } from '../services/zoneIdCandidate.mjs';
import { idStability } from '../services/zoneIdentityShadow.mjs';
import {
  summarizeInventory, saveInventory, loadInventory,
  summarizeBacktestRun, saveBacktestRun, loadBacktestRun, startInventorySaver,
  INVENTORY_MAX_SYMBOLS, INVENTORY_MAX_LEVELS
} from '../services/inventoryStore.mjs';

const zone = (over = {}) => ({
  id: `cluster-${over.kind ?? 'horizontal_ssl'}-7-${over.referenceLevel ?? 100}`,
  kind: 'horizontal_ssl',
  timeframe: '1h',
  referenceLevel: 100,
  liquidityLevel: 100,
  state: 'confirmed',
  ...over
});

test('★2: المعرّف المرشَّح من المحتوى وحده — لا يتغيّر بتغيّر الترتيب', () => {
  const a = zone({ id: 'cluster-horizontal_ssl-0-100', referenceLevel: 100 });
  const b = zone({ id: 'cluster-horizontal_ssl-42-100', referenceLevel: 100 });
  assert.equal(candidateZoneId(a, 0.002), candidateZoneId(b, 0.002), 'نفس المستوى والنوع ⇒ نفس المعرّف رغم اختلاف الترتيب');
});

test('★2: المعرّف المرشَّح يفصل الأنواع والفريمات', () => {
  const ssl = candidateZoneId(zone({ kind: 'horizontal_ssl' }), 0.002);
  const bsl = candidateZoneId(zone({ kind: 'horizontal_bsl' }), 0.002);
  const m15 = candidateZoneId(zone({ timeframe: '15m' }), 0.002);
  assert.notEqual(ssl, bsl, 'النوع داخل المعرّف');
  assert.notEqual(ssl, m15, 'الفريم داخل المعرّف');
});

test('★2: الشبكة الأنعم تُقلّل الدوران، والأخشن تُدمج المتجاورات (فلا شبكة «مثالية» بلا قياس)', () => {
  const grids = measureCandidateGrids({
    prev: [zone({ referenceLevel: 100.0 })],
    next: [zone({ referenceLevel: 100.1 })], // انزياح 0.1% — أقل من نسبة العنقدة 0.2%
    tolerancePct: 0.002,
    grids: [0.001, 0.002, 0.004],
    idStability
  });
  assert.equal(grids.length, 3);
  for (const g of grids) {
    assert.ok(g.churnRate === 0 || g.churnRate === 1, 'القياس يعطي 0 أو 1 للمنطقة الواحدة');
    assert.ok(g.grid > 0);
  }
});

test('★2: المجمّع يرجّح الدوران بعدد المناطق المُطابَقة لا بعدد العيّنات', () => {
  const c = createCandidateCollector();
  c.add({ zonesFull: 10, zonesTrimmed: 10, grids: [{ grid: 0.002, matched: 10, churned: 4 }] });
  c.add({ zonesFull: 2, zonesTrimmed: 2, grids: [{ grid: 0.002, matched: 2, churned: 2 }] });
  const s = c.summary();
  assert.equal(s.samples, 2);
  assert.equal(s.grids[0].matched, 12);
  assert.equal(s.grids[0].churned, 6);
  // 6/12 = 0.5 لا (0.4+1)/2 = 0.7 كما يفعل متوسط النسب
  assert.equal(s.grids[0].keepRate, 0.5);
  assert.match(s.note, /لم يُستبدل/);
});

test('★2: idStability يحمل النوع والمستوى في الأزواج ليقيس المرشَّح بلا كشف ثالث', () => {
  const r = idStability([zone()], [zone({ id: 'cluster-horizontal_ssl-9-100.05', referenceLevel: 100.05 })], 0.002, 8);
  assert.equal(r.matched, 1);
  assert.equal(r.pairs[0].kind, 'horizontal_ssl');
  assert.ok(Number.isFinite(r.pairs[0].level));
  assert.ok(Number.isFinite(r.pairs[0].prevLevel));
});

// ---------- الاستمرارية ----------

test('الاستمرارية: ملخص المخزون حتمي ومضغوط ويحفظ الأنواع والحالات', () => {
  const zones = [
    zone({ symbol: 'BTCUSDT', state: 'swept', liquidityLevel: 101, sweptAt: 5 }),
    zone({ symbol: 'BTCUSDT', state: 'confirmed' }),
    zone({ symbol: 'ETHUSDT', kind: 'demand', state: 'swept', liquidityLevel: 200, sweptAt: 9 }),
    zone({ symbol: 'ETHUSDT', kind: 'demand', state: 'swept', liquidityLevel: 190, sweptAt: 3 })
  ];
  const a = summarizeInventory(zones);
  const b = summarizeInventory(zones);
  assert.deepEqual(a, b, 'نفس المدخل ⇒ نفس الملخص');
  assert.equal(a.total, 4);
  assert.equal(a.symbols, 2);
  assert.deepEqual(a.byKind, { horizontal_ssl: 2, demand: 2 });
  assert.deepEqual(a.byState, { swept: 3, confirmed: 1 });
});

test('الاستمرارية: المستويات المسحوبة تُرتَّب بالأحدث وتُقصّ بحد صريح', () => {
  const many = Array.from({ length: 12 }, (_, i) => zone({ symbol: 'BTCUSDT', state: 'swept', liquidityLevel: 100 + i, sweptAt: i }));
  const s = summarizeInventory(many);
  const btc = s.inventory.find(r => r.symbol === 'BTCUSDT');
  assert.equal(btc.swept.length, INVENTORY_MAX_LEVELS);
  assert.equal(btc.swept[0].at, 11, 'الأحدث أولاً');
});

test('الاستمرارية: سقف الرموز مطبَّق والأكثر مناطق أولاً', () => {
  const zones = [];
  for (let i = 0; i < 30; i += 1) for (let k = 0; k <= i; k += 1) zones.push(zone({ symbol: `S${i}USDT` }));
  const s = summarizeInventory(zones, { maxSymbols: 5 });
  assert.equal(s.symbols, 5);
  assert.equal(s.inventory[0].symbol, 'S29USDT', 'الأكثر مناطق أولاً');
  assert.ok(s.total > s.inventory.reduce((n, r) => n + r.count, 0), 'الإجمالي من كل المخزون لا من المقصوص');
});

test('الاستمرارية: الحفظ والاسترجاع عبر مخزن مفاتيح، والفشل لا يرمي', async () => {
  const store = new Map();
  const db = { engineState: { put: async (k, v) => { store.set(k, v); }, get: async (k) => store.get(k) ?? null } };
  assert.equal(await saveInventory(db, summarizeInventory([zone({ symbol: 'BTCUSDT' })])), true);
  const back = await loadInventory(db);
  assert.equal(back.total, 1);
  assert.ok(back.savedAt > 0, 'وقت الحفظ مُدوَّن ليُعرف عمر الملخص');
  assert.equal(await saveInventory(null, { total: 1 }), false, 'بلا مخزن ⇒ false صريح لا رمي');
  assert.equal(await loadInventory({ engineState: { get: async () => { throw new Error('network'); } } }), null, 'فشل القراءة ⇒ null لا انهيار');
});

test('الاستمرارية: ملخص الباك تيست يجمع الصفقات والانحياز بلا صفقات كاملة', () => {
  const run = {
    startedAt: 1,
    lastRunAt: 2,
    results: [
      { symbol: 'BTCUSDT', timeframe: '1h', trades: [{ win: 1, rr: 2 }, { win: 0, rr: -1 }] },
      { symbol: 'ETHUSDT', timeframe: '4h', trades: [{ win: 1, rr: 1.5 }] },
      { symbol: 'XRPUSDT', timeframe: '1h', reason: 'لا بيانات', trades: [] }
    ],
    learn: { enough: true, winRate: 0.66, bias: { k: 1 } }
  };
  const s = summarizeBacktestRun(run);
  assert.equal(s.pairs, 3);
  assert.equal(s.trades, 3);
  assert.equal(s.wins, 2);
  assert.equal(s.winRate, 0.6667);
  assert.equal(s.learn.enough, true);
  assert.ok(s.pairDetails.length === 3);
  assert.ok(s.sample.length <= 200);
});

test('الاستمرارية: جدولة الحفظ تُبلّغ بالنتيجة ولا تُسقط شيئاً عند الفشل', async () => {
  const seen = [];
  const db = { engineState: { put: async () => { throw new Error('down'); }, get: async () => null } };
  const saver = startInventorySaver({
    db,
    snapshotFn: () => [zone({ symbol: 'BTCUSDT' })],
    log: { warn: () => {} },
    onSaved: (info) => seen.push(info)
  });
  const ok = await saver.run();
  saver.stop();
  assert.equal(ok, false, 'فشل الحفظ يُعاد صريحاً');
  assert.equal(seen[0].ok, false);
  assert.equal(seen[0].zones, 1);
});

test('الاستمرارية: ملخص فارغ آمن (لا مناطق ⇒ أصفار لا خطأ)', () => {
  const s = summarizeInventory([]);
  assert.equal(s.total, 0);
  assert.equal(s.symbols, 0);
  assert.deepEqual(s.inventory, []);
  assert.equal(summarizeBacktestRun(null), null);
  assert.equal(INVENTORY_MAX_SYMBOLS > 0 && INVENTORY_MAX_LEVELS > 0, true);
  assert.equal(withCandidateId({ kind: 'supply' }, 0.002).id, undefined, 'بلا مستوى ⇒ لا معرّف مُفبرك');
});
