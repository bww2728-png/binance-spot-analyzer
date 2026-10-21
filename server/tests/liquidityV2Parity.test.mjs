/**
 * اختبارات الطبقة 4ب (v2): التطابق حي/تاريخي + الاكتمال + الحد الأدنى.
 *
 * السؤال الذي يجيب عنه الملف: هل يُنتج المحرك **نفس المناطق حرفياً** حين يُنادى بنافذة
 * شموع تنتهي عند `endIndex`، مقارنةً بندائه على السلسلة الكاملة عند نفس `endIndex`؟
 * هذا هو الفرق الحقيقي بين المسار الحيّ (مصفوفة تنمو شمعةً شمعة) والمسار التاريخي
 * (سلسلة كاملة)؛ أي اختلاف هنا = نظر مستقبلي أو اعتماد على طول النافذة.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectLiquidityZonesV2, structureSummary } from '../liquidity-zones/v2/index.mjs';

/** مولّد حتمي (LCG) — نفس الأرقام في كل تشغيل، بلا عشوائية حقيقية */
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** سلسلة شموع حتمية فيها اتجاهات وارتدادات (فجوات وأطراف فعلية) */
function syntheticCandles(n = 260, seed = 20261021) {
  const rnd = lcg(seed);
  const out = [];
  let price = 100;
  for (let i = 0; i < n; i += 1) {
    const drift = Math.sin(i / 11) * 0.9 + Math.sin(i / 37) * 1.4;
    const open = price;
    const close = Math.max(1, open + drift + (rnd() - 0.5) * 1.6);
    const hi = Math.max(open, close) + rnd() * 1.1;
    const lo = Math.min(open, close) - rnd() * 1.1;
    out.push({ time: 1_700_000_000_000 + i * 3_600_000, open, high: hi, low: lo, close, volume: 1 + rnd() * 10 });
    price = close;
  }
  return out;
}

const CANDLES = syntheticCandles();
const ENDS = [120, 140, 160, 180, 200, 220, 240, 259];

test('التطابق حي/تاريخي: النافذة المقصوصة والكاملة تُنتجان نفس المناطق حرفياً', () => {
  for (const endIndex of ENDS) {
    const windowed = detectLiquidityZonesV2({ symbol: 'TESTUSDT', timeframe: '1h', candles: CANDLES.slice(0, endIndex + 1), endIndex });
    const full = detectLiquidityZonesV2({ symbol: 'TESTUSDT', timeframe: '1h', candles: CANDLES, endIndex });
    assert.deepEqual(windowed, full, `اختلاف بين المسارين عند endIndex=${endIndex}`);
  }
});

test('التطابق حي/تاريخي في ملخّص البنية: أحداث IDM/BOS/CHoCH لا ترى ما بعد endIndex', () => {
  for (const endIndex of ENDS) {
    const a = structureSummary({ candles: CANDLES.slice(0, endIndex + 1), endIndex });
    const b = structureSummary({ candles: CANDLES, endIndex });
    assert.deepEqual(a, b, `اختلاف ملخّص البنية عند endIndex=${endIndex}`);
  }
});

test('لا نظر مستقبلي: كل أثر منطقة يشير إلى فهرس ≤ endIndex', () => {
  for (const endIndex of ENDS) {
    const zones = detectLiquidityZonesV2({ symbol: 'TESTUSDT', timeframe: '1h', candles: CANDLES, endIndex });
    for (const z of zones) {
      for (const p of z.touchPoints ?? []) assert.ok(p.index <= endIndex, `${z.kind}: نقطة لمس بعد endIndex`);
      for (const b of z.breakSteps ?? []) assert.ok(b.index <= endIndex, `${z.kind}: خطوة كسر بعد endIndex`);
      for (const e of z.structureEvents ?? []) assert.ok(e.index <= endIndex, `${z.kind}: حدث بنيوي بعد endIndex`);
      if (Number.isFinite(z.createdAt)) assert.ok(z.createdAt <= CANDLES[endIndex].time, `${z.kind}: إنشاء بعد endIndex`);
    }
  }
});

test('الاكتمال: كل منطقة مُعلَّلة بحد أدنى لمسات، وبلا منطقة بلا سبب', () => {
  const zones = detectLiquidityZonesV2({ symbol: 'TESTUSDT', timeframe: '1h', candles: CANDLES, endIndex: 259 });
  assert.ok(zones.length > 0, 'يجب أن تُنتج السلسلة مناطق');
  const HORIZONTAL = new Set(['horizontal_bsl', 'horizontal_ssl', 'trendline_bsl', 'trendline_ssl']);
  for (const z of zones) {
    assert.ok(Array.isArray(z.reasons) && z.reasons.length > 0, `${z.kind}: منطقة بلا تعليل`);
    /**
     * حد اللمستين قاعدة **المناطق الأفقية** (BSL/SSL) بطلب صاحب النظام. أما مناطق العرض/الطلب
     * فمعيار اعتمادها الكسر البنيوي (BOS) لا عدد اللمسات، وهي شمعة أصلية واحدة بطبيعتها.
     */
    if (HORIZONTAL.has(z.kind)) assert.ok(z.touches >= 2, `${z.kind}: منطقة بلمسة واحدة (${z.touches})`);
    assert.ok(['potential', 'candidate', 'confirmed', 'swept'].includes(z.state), `${z.kind}: حالة غير معروفة`);
    assert.ok(Number.isFinite(z.liquidityLevel) && Number.isFinite(z.retailStop), `${z.kind}: عتبات غير رقمية`);
  }
});

test('الحتمية: نفس المدخل ثلاث مرات ⇒ نفس المخرج حرفياً', () => {
  const sig = () => JSON.stringify(detectLiquidityZonesV2({ symbol: 'TESTUSDT', timeframe: '1h', candles: CANDLES, endIndex: 240 }));
  assert.equal(sig(), sig());
  assert.equal(sig(), sig());
});

test('تنقية العرض/الطلب: عدد المؤكدة انخفض ولم يبقَ صندوقان متداخلان من شمعتين مختلفتين', () => {
  const zones = detectLiquidityZonesV2({ symbol: 'TESTUSDT', timeframe: '1h', candles: CANDLES, endIndex: 259 });
  const sd = zones.filter(z => z.kind === 'supply' || z.kind === 'demand').filter(z => z.zoneBox);
  for (const a of sd) {
    for (const b of sd) {
      // الشمعة الأصلية نفسها: الأشكال المختلفة تبقى مقصودةً (ثلاث قراءات للشمعة نفسها)
      const originA = a.touchPoints?.[0]?.index;
      const originB = b.touchPoints?.[0]?.index;
      if (a === b || a.kind !== b.kind || originA === originB) continue;
      const boxA = { high: a.zoneBox.high, low: a.zoneBox.low };
      const boxB = { high: b.zoneBox.high, low: b.zoneBox.low };
      const inter = Math.min(boxA.high, boxB.high) - Math.max(boxA.low, boxB.low);
      if (inter <= 0) continue;
      const minSpan = Math.min(boxA.high - boxA.low, boxB.high - boxB.low);
      if (minSpan > 0 && inter / minSpan >= 0.7) {
        assert.fail(`صندوقان متداخلان لم يُنقَّيا: ${a.id} و${b.id}`);
      }
    }
  }
});
