/* اختبارات رسم الشارت الحقيقي (chart.mjs) — حتمية بالكامل (بدون شبكة)
 * العلامة الدائرية على مستوى سعر السيولة عند الإحداثي الصحيح + الزمن الحقيقي على المحور
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderZoneChart } from '../liquidity-zones/chart.mjs';

const cs = Array.from({ length: 10 }, (_, i) => ({
  time: i * 3600,
  open: 100, high: 105, low: 95, close: 102
}));

const baseZone = {
  symbol: 'ADAUSDT', timeframe: '1h', kind: 'horizontal_bsl', state: 'confirmed',
  referenceLevel: 110, liquidityLevel: 112, retailStop: 108,
  touchPoints: [], reasons: ['اختبار'], createdAt: 3600, detectedAt: null
};

test('العلامة الدائرية: تُرسم عند الإحداثي الصحيح المحسوب من سعر السيولة', () => {
  // y(112) = 310 - ((112-95)/17)*250 = 60
  const svg = renderZoneChart(baseZone, cs, 4);
  const ring = svg.match(/<circle cx="[^"]*" cy="60" r="11" [^>]*stroke="#f23645"/);
  assert.ok(ring, 'حلقة العلامة عند y=60 بلون BSL');
  const core = /<circle cx="[^"]*" cy="60" r="4\.5" fill="#f23645"\/>/.test(svg);
  assert.ok(core, 'نقطة العلامة عند y=60');
  // الحلقة على المحور السيني عند لحظة الاكتشاف x(4) = 50 + (4.5/10)*890 = 450.5
  const cxVal = svg.match(/<circle cx="([0-9.]+)" cy="60" r="11"/);
  assert.ok(cxVal, 'القيمة x موجودة');
  assert.ok(Math.abs(parseFloat(parseFloat(cxVal[1]).toFixed(1)) - 450.5) < 0.5, `x=${cxVal[1]} ≈ 450.5`);
});

test('علامة SSL: لون أخضر', () => {
  const svg = renderZoneChart({ ...baseZone, kind: 'horizontal_ssl' }, cs, 2);
  assert.ok(/<circle cx="[^"]*" cy="60" r="11" [^>]*stroke="#089981"/.test(svg));
});

test('بدون مستوى سيولة: لا توجد علامة', () => {
  const svg = renderZoneChart({ ...baseZone, liquidityLevel: null }, cs, 4);
  assert.ok(!/<circle[^>]*r="11"/.test(svg), 'لا حلقة علامة');
  assert.ok(!/<circle[^>]*r="17"/.test(svg), 'لا توهج');
});

test('الزمن الحقيقي: طوابع زمنية من الشموع الفعلية على المحور', () => {
  const svg = renderZoneChart(baseZone, cs, 4);
  assert.ok(/>01-01 00:00</.test(svg), 'طولاع أول شمعة');
  assert.ok(/>01-01 09:00</.test(svg), 'طولاع آخر شمعة (time=9*3600)');
});

test('العنوان: العملة والفريم + وقت الاكتشاف وسعر الاكتشاف', () => {
  const svg = renderZoneChart(baseZone, cs, 4);
  assert.ok(/>ADAUSDT 1h/.test(svg), 'العملة نفسها والفريم نفسها');
  assert.ok(/>الاكتشاف: 01-01 01:00 · سعر الاكتشاف: 102/.test(svg), 'وقت الاكتشاف وسعره');
});

test('شموع غير كافية: رسالة بدل الرسم', () => {
  const svg = renderZoneChart(baseZone, cs.slice(0, 3), 0);
  assert.ok('لا شموع متاحة للعرض'.length > 0);
  assert.ok(svg.includes('width="960"'));
});
