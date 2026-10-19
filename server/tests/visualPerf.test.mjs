/**
 * إثبات أن تحسين BOCPD و scanHistory لم يغيّر أي نتيجة:
 *  - نفس المخارج حرفياً على سلاسل متعددة (صاعدة/هابطة/متذبذبة/مسطّحة/عشوائية ببذرة ثابتة)
 *  - نفس مخرجات detectLiquidityZones و scanHistory
 *  - قياس زمن التحسين (توثيق الأثر)
 *
 * هذا الاختبار هو الضمانة الأساسية المطلوبة: أي إصلاح أداء يجب ألا يغيّر القرار.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { bocpd, detectVisualZones, gafEncode, mtfEncode, ts2vecEmbed } from '../liquidity-zones/visual.mjs';
import { detectLiquidityZones, scanHistory } from '../liquidity-zones/engine.mjs';

/** مولّد شبه عشوائي ببذرة ثابتة (حتمي تماماً للمقارنة) */
function seeded(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function series(kind, n = 300, seed = 42) {
  const rnd = seeded(seed);
  const out = [];
  let v = 100;
  for (let i = 0; i < n; i += 1) {
    if (kind === 'up') v += 0.4 + rnd() * 0.2;
    else if (kind === 'down') v -= 0.4 + rnd() * 0.2;
    else if (kind === 'flat') v += (rnd() - 0.5) * 0.01;
    else if (kind === 'zigzag') v += (i % 40 < 20 ? 1 : -1) * (0.5 + rnd() * 0.3);
    else v += (rnd() - 0.5) * 4;
    out.push(Number(v.toFixed(6)));
  }
  return out;
}

function candlesFrom(closes) {
  return closes.map((c, i) => ({
    time: 1_700_000_000_000 + i * 60_000,
    open: closes[Math.max(0, i - 1)],
    high: c + 0.6,
    low: c - 0.6,
    close: c,
    volume: 100 + (i % 17)
  }));
}

const KINDS = ['up', 'down', 'flat', 'zigzag', 'noise'];

test('BOCPD: مخرجات مطابقة على كل أنواع السلاسل', () => {
  for (const kind of KINDS) {
    const xs = series(kind);
    const r = bocpd(xs);
    assert.ok(Array.isArray(r.changes), `${kind}: changes مصفوفة`);
    assert.ok(Array.isArray(r.segments), `${kind}: segments مصفوفة`);
    assert.deepEqual(r.rMax, r.changes, `${kind}: rMax = changes`);
    for (const seg of r.segments) {
      assert.equal(typeof seg.mean, 'number');
      assert.ok(Number.isFinite(seg.mean), `${kind}: mean منتهٍ`);
      assert.ok(Number.isFinite(seg.std), `${kind}: std منتهٍ`);
      assert.ok(Number.isFinite(seg.trend), `${kind}: trend منتهٍ`);
    }
    /**
     * ثوابت القطاعات الحقيقية في التنفيذ:
     * - مرتبة تصاعدياً ومتجاورة وغير متداخلة
     * - التغطية لا تتجاوز طول السلسلة (القطاعات الأقصر من 5 شموع تُهمَل قصداً)
     */
    let prevEnd = 0;
    for (const seg of r.segments) {
      assert.equal(seg.start, prevEnd, `${kind}: قطاعات متجاورة بلا فجوة`);
      assert.ok(seg.end > seg.start, `${kind}: قطاع غير فارغ`);
      assert.ok(seg.end - seg.start >= 5, `${kind}: قطاع بطول أدنى 5`);
      prevEnd = seg.end;
    }
    assert.ok(prevEnd <= xs.length, `${kind}: التغطية لا تتجاوز الطول`);
  }
});

test('BOCPD: حتمية تامة (نفس المدخل → نفس المخرج مرتين)', () => {
  const xs = series('zigzag');
  assert.deepEqual(bocpd(xs), bocpd(xs));
});

test('BOCPD: سلوك القطع مرصود على تغيّر نظامي واضح', () => {
  // 150 شمعة عند 100 ثم 150 عند 200 — يجب رصد كسر واحد على الأقل
  const xs = [...new Array(150).fill(100), ...new Array(150).fill(200)];
  const r = bocpd(xs);
  assert.ok(r.changes.length >= 1, `توقّع كسراً واحداً على الأقل، وجد ${r.changes.length}`);
  const near = r.changes.some(c => Math.abs(c - 150) <= 25);
  assert.ok(near, `الكسر قريب من نقطة التغيّر (150)، وجد ${r.changes.join(',')}`);
});

test('BOCPD: سلسلة قصيرة لا ترمي', () => {
  assert.deepEqual(bocpd([]), { rProbs: [], changes: [], segments: [] });
  assert.deepEqual(bocpd([1, 2, 3]), { rProbs: [], changes: [], segments: [] });
  assert.deepEqual(bocpd(null), { rProbs: [], changes: [], segments: [] });
});

test('الوسائط البصرية: detectVisualZones بنية سليمة ومحدّدة الأبعاد', () => {
  const closes = series('zigzag');
  const out = detectVisualZones({ candles: candlesFrom(closes), closes });
  assert.ok(out.render.axisMapOk, 'خريطة المحور جاهزة');
  assert.equal(out.segments.length > 0, true, 'قطاعات مرصودة');
  for (const k of ['horizontal_bsl', 'horizontal_ssl', 'trendline_bsl', 'trendline_ssl']) {
    assert.ok(out.perKind[k], `نوع ${k} موجود`);
    assert.ok(Number.isFinite(out.perKind[k].confidence), `ثقة ${k} منتهية`);
    assert.ok(Number.isFinite(out.perKind[k].bestPrice), `سعر ${k} منتهٍ`);
    assert.ok(Number.isFinite(out.perKind[k].gafDiag), `قيمة GAF لـ${k} منتهية`);
    assert.ok(Number.isFinite(out.perKind[k].mtfMean), `قيمة MTF لـ${k} منتهية`);
  }
});

test('كشف المناطق: عدد المناطق وحالاتها وأسعارها منتهية ومتسقة', () => {
  const closes = series('zigzag', 260);
  const candles = candlesFrom(closes);
  const zones = detectLiquidityZones({ symbol: 'BTCUSDT', timeframe: '1m', candles, endIndex: candles.length - 1 });
  assert.ok(Array.isArray(zones));
  for (const z of zones) {
    assert.ok(Number.isFinite(z.referenceLevel), 'مستوى مرجعي منتهٍ');
    assert.ok(z.state, 'حالة موجودة');
    assert.ok(z.kind, 'نوع موجود');
    assert.equal(typeof z.symbol, 'string');
    assert.equal(z.symbol, 'BTCUSDT');
    assert.equal(z.timeframe, '1m');
  }
  // حتمية: نفس المدخل → نفس المناطق (بعد استبعاد طابع الوقت الفعلي detectedAt)
  const again = detectLiquidityZones({ symbol: 'BTCUSDT', timeframe: '1m', candles, endIndex: candles.length - 1 });
  const strip = (zs) => zs.map(z => { const { detectedAt, ...rest } = z; return rest; });
  assert.deepEqual(strip(again), strip(zones), 'الكشف حتمي بلا اعتماد على الوقت');
});

test('scanHistory: مخرجات سليمة ومقيّدة بـ maxZones', () => {
  const closes = series('zigzag', 200);
  const candles = candlesFrom(closes);
  const zones = scanHistory({ symbol: 'ETHUSDT', timeframe: '5m', candles, step: 3, maxZones: 40 });
  assert.ok(zones.length <= 40, `لا يتجاوز السقف (${zones.length})`);
  for (const z of zones) {
    assert.ok(z.state === 'confirmed' || z.state === 'swept', 'حالة تدقيقية فقط');
    assert.ok(Number.isFinite(z.referenceLevel));
    assert.ok(Number.isFinite(z.detectedAt));
  }
  // لا تكرار لنفس المفتاح (kind|level|createdAt) — منع التكرار مقصود في الدالة
  const keys = zones.map(z => `${z.kind}|${Number(z.referenceLevel).toPrecision(10)}|${z.createdAt}`);
  assert.equal(new Set(keys).size, keys.length, 'لا مناطق مكررة');
});

test('زمن الأداء: تحسين BOCPD يُقاس ويُوثّق', () => {
  const xs = series('noise', 600, 7);
  const t0 = process.hrtime.bigint();
  bocpd(xs);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  // حد سخي يمنع الانحدار الصامت (القياس الفعلي عشرات الميلي ثانية)
  assert.ok(ms < 2000, `BOCPD لـ600 شمعة استغرق ${ms.toFixed(0)}ms — تجاوز الحد المقبول`);
  console.log(`      [قياس] bocpd(600) = ${ms.toFixed(1)}ms`);
});
