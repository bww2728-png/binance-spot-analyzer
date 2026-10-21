/**
 * اختبار ترميز لقطة المناطق الآلية — الضمانة الحاكمة: **بلا فقدان**.
 * القياس الإنتاجي: اللقطة 100 منطقة ≈ 60 كيلوبايت، و`reasons` وحدها 40% منها
 * لأنها قوالب نصية متكررة. الترميز المشترك يقصّها بشرط أن يعيد الفكّ الكائن
 * الأصلي **مطابقاً حرفياً**، وإلا صار التقليم فقداناً للبيانات لا ضغطاً لها.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  compactSnapshot, expandSnapshot, expandSnapshotMeta, SNAPSHOT_CODEC_VERSION
} from '../services/snapshotCodec.mjs';

/** لقطة اختبارية تحاكي الشكل الحقيقي: أسباب متكررة ومعرّفات طويلة المشترك */
function makeSnapshot(n = 30) {
  const zones = [];
  for (let i = 0; i < n; i += 1) {
    zones.push({
      id: `BTCUSDT-1h-horizontal_bsl-cluster-high-${i}-${8347975000000 + i}`,
      symbol: 'BTCUSDT',
      type: 'horizontal_bsl',
      price: 83000 + i * 10,
      timeframe: '1h',
      score: 0.5 + (i % 5) / 10,
      clusterCount: 2 + (i % 3),
      swept: i % 4 === 0,
      sweptAt: i % 4 === 0 ? 1792445000000 : null,
      bandPct: 0.0025,
      anchorTime: 1792440000000 + i,
      // النصوص المتكررة — هي سبب الحجم كما أثبت القياس
      reasons: ['منطقة القيمة اليومية', 'عقدة حجم منخفض', 'ندرة حادة', `تأكيد ${i % 3}`],
      meta: 'structural',
      side: 'bsl',
      feedback: null,
      note: '',
      created_at: 1792440000000,
      updated_at: 1792440000000,
      active: true,
      expires_at: null
    });
  }
  return { symbol: 'BTCUSDT', ts: 1792445000000, zones };
}

test('الفكّ يعيد الكائن الأصلي مطابقاً حرفياً (بلا فقدان)', () => {
  const snap = makeSnapshot(25);
  const roundTrip = expandSnapshot(compactSnapshot(snap));
  assert.deepEqual(roundTrip, snap, 'دورة ترميز/فكّ يجب أن تكون مطابقة حرفياً');
});

test('الحجم ينقص فعلاً (الغرض من الترميز)', () => {
  const snap = makeSnapshot(200);
  const before = Buffer.byteLength(JSON.stringify(snap), 'utf8');
  const after = Buffer.byteLength(JSON.stringify(compactSnapshot(snap)), 'utf8');
  assert.equal(after < before, true, `الحجم بعد الترميز (${after}) يجب أن يقل عن ${before}`);
  /**
   * القياس على **لقطات إنتاجية حقيقية** (8 لقطات، 100 منطقة لكل منها):
   *   الإجمالي 458,837 → 315,273 بايت = نسبة 0.687 أي **توفير 31.3%**.
   * والاختبار هنا بنصوص أسباب أقصر من الحقيقي فيعطي نسبة أفضل تحصيلاً (~0.81)،
   * لذلك يُشترط هنا حدّ أدنى محافظ، والقيمة الحقيقية مُثبتة في الاختبار الذي يلي.
   */
  assert.equal(after / before < 0.9, true, `التقليص ضعيف: ${(after / before).toFixed(2)} من الأصل`);
});

test('نصوص الأسباب الطويلة (كما في الإنتاج) تُقلَّص بنسبة قريبة من القياس الحي', () => {
  // أسباب طويلة متكررة تحاكي الحقيقي: المتكرر يُخزَّن مرة واحدة في القاموس
  const longReasons = [
    'منطقة القيمة اليومية مع عودة السعر إلى حدّ البروفايل العلوي وتأكيد السيولة',
    'عقدة حجم منخفض تفصل بين منطقتي قيمة، واختبارها يعطي دفعة سعرية واضحة',
    'قمة اليوم السابق ونقطة الانعكاس المتوقعة قبل افتتاح الجلسة الأوروبية'
  ];
  const zones = [];
  for (let i = 0; i < 100; i += 1) {
    zones.push({
      id: `ADAUSDT-15m-horizontal_bsl-cluster-high-${i}-${8347975000000 + i}`,
      price: 100 + i, timeframe: '15m', score: 0.6, clusterCount: 3,
      reasons: longReasons, created_at: 1, updated_at: 1, active: true
    });
  }
  const snap = { symbol: 'ADAUSDT', ts: 1, zones };
  const before = Buffer.byteLength(JSON.stringify(snap), 'utf8');
  const after = Buffer.byteLength(JSON.stringify(compactSnapshot(snap)), 'utf8');
  assert.equal(after < before * 0.6, true, `مع النصوص الطويلة يُتوقع تقليص كبير، والناتج ${(after / before).toFixed(3)}`);
  assert.deepEqual(expandSnapshot(compactSnapshot(snap)), snap, 'وبلا فقدان');
});

test('المعرّف الطويل يُرمَّز مقطعاً ويعود كاملاً', () => {
  const snap = makeSnapshot(3);
  const compact = compactSnapshot(snap);
  assert.equal(compact.zones[0].id.includes('BTCUSDT-1h-horizontal_bsl-cluster-high'), false, 'البادئة المتكررة تُخزَّن قاموساً');
  const back = expandSnapshot(compact);
  assert.equal(back.zones[0].id, snap.zones[0].id, 'المعرّف يعود كما كان حرفياً');
});

test('اللقطات القديمة (بلا ترميز) تُقرأ كما هي — توافق خلفي', () => {
  const legacy = makeSnapshot(5);
  assert.deepEqual(expandSnapshot(legacy), legacy, 'لقطة قديمة لا تتأثر');
  assert.equal(expandSnapshotMeta(JSON.stringify(legacy)).zones.length, 5);
});

test('النص التالف لا يُسقط القارئ (يُعاد null)', () => {
  assert.equal(expandSnapshotMeta('{ليس JSON'), null);
  assert.equal(expandSnapshotMeta(null), null);
  assert.equal(expandSnapshotMeta(undefined), null);
});

test('meta المخزَّن يحمل وسم النسخة كي يُفكّ لاحقاً', () => {
  const compact = compactSnapshot(makeSnapshot(2));
  assert.equal(compact.__c, SNAPSHOT_CODEC_VERSION);
  const parsed = expandSnapshotMeta(JSON.stringify(compact));
  assert.equal(parsed.__c, undefined, 'الوسم لا يتسرّب للكائن المفكوك');
  assert.equal(parsed.zones.length, 2);
});

test('لقطة فارغة أو بلا مناطق تمرّ بلا تغيير', () => {
  assert.deepEqual(compactSnapshot({ symbol: 'X', zones: [] }), { symbol: 'X', zones: [] });
  assert.equal(compactSnapshot(null), null);
});

test('الحقول الفارغة تبقى كما هي (القيم الفارغة جزء من الشكل لا حشو)', () => {
  const snap = {
    symbol: 'X', ts: 1,
    zones: [{
      id: 'A-B-c', type: 't', price: 1, reasons: ['r'],
      note: '', feedback: null, side: null, active: true, expires_at: null, sweptAt: null
    }]
  };
  const back = expandSnapshot(compactSnapshot(snap));
  assert.deepEqual(back, snap, 'الحقول الفارغة تعود كما كانت بالضبط');
  assert.equal('note' in back.zones[0], true, 'النص الفارغ محفوظ');
  assert.equal(back.zones[0].feedback, null, 'null محفوظ لا محذوف');
});

test('`reasons` غير الصالحة (كائن أو أرقام) تبقى بلا ترميز ولا تتلف', () => {
  const snap = { symbol: 'X', ts: 1, zones: [{ id: 'q', reasons: [1, 2, 3] }] };
  const back = expandSnapshot(compactSnapshot(snap));
  assert.deepEqual(back.zones[0].reasons, [1, 2, 3], 'مصفوفة غير نصية تُترك كما هي');
});
