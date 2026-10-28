/**
 * اختبار عدم فقدان أقسام التشخيص عند ضغط العيّنة — عيب اكتُشف في الإنتاج.
 *
 * الدليل: عيّنة منشورة حقيقية كان فيها `engines` = `{n:8, head:[…8 عناصر]}` بعد أن
 * صار عدد المحركات 9+، فسقط أول محرك من العيّنة **بلا أي إنذار** — أي أن قياساً
 * تشخيصياً اختفى صامتاً. المطلوب: رأس يكفي لكل المحركات الفعلية.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { compactSample } from '../health.mjs';

/** المحركات المسجَّلة فعلاً في التشغيل (أسماؤها كما تظهر في الصحة) — محرك الباك تيست أُوقف بعد حذف واجهته */
const REAL_ENGINES = [
  'shariah-resolver', 'liquidity-zones', 'live-opportunities',
  'strategy2', 'market-streams', 'retention', 'storage-watcher', 'workers'
];

test('كل المحركات تبقى في العيّنة المضغوطة (لا يسقط محرك صامتاً)', () => {
  const engines = REAL_ENGINES.map((name, i) => ({
    name, cycles: 100 + i, failures: 0, stalled: false, lastErrorAt: null, lastError: null,
    lastCycleMs: 12, sinceCycleMs: 500, extra: { a: 1, b: 2 }
  }));
  const compacted = compactSample({ engines });
  assert.equal(compacted.engines.n, REAL_ENGINES.length, 'العدد الكامل محفوظ');
  assert.equal(compacted.engines.head.length, REAL_ENGINES.length, 'كل المحركات موجودة في الرأس');
  const names = compacted.engines.head.map(e => e.name);
  for (const name of REAL_ENGINES) {
    assert.equal(names.includes(name), true, `المحرك ${name} مفقود`);
  }
});

test('تفاصيل كل محرك محفوظة (دورات/إخفاقات/توقف/خطأ)', () => {
  const compacted = compactSample({
    engines: [{ name: 'liquidity-zones', cycles: 2011, failures: 3, stalled: true, lastError: 'x', lastCycleMs: 480, sinceCycleMs: 90000, extra: { mode: 'event', results: 429 } }]
  });
  const e = compacted.engines.head[0];
  assert.equal(e.cycles, 2011);
  assert.equal(e.failures, 3);
  assert.equal(e.stalled, true);
  assert.equal(e.lastCycleMs, 480);
  assert.equal(e.extra.mode, 'event', 'extra (تشخيص الحلقة) محفوظ');
  assert.equal(e.extra.results, 429);
});

test('قائمة محركات كبيرة جداً تُقصّ في الرأس مع ذكر العدد (حماية الحجم)', () => {
  const many = Array.from({ length: 60 }, (_, i) => ({ name: `engine-${i}`, cycles: i }));
  const compacted = compactSample({ engines: many });
  assert.equal(compacted.engines.n, 60);
  assert.equal(compacted.engines.head.length, 16, 'السقف 16');
  // والمحركات المهمة (الأولى) محفوظة كاملة
  assert.equal(compacted.engines.head[0].name, 'engine-0');
});

test('ضغط عيّنة الصحة يحفظ حالة الاستعادة والاكتمال دون نص الخطأ', () => {
  const compacted = compactSample({
    engines: [{
      name: 'live-opportunities',
      extra: {
        recovery: {
          state: 'ready', attemptedAt: 1_700_000_000_000, readyAt: 1_700_000_000_100,
          error: 'تفاصيل داخلية لا يجب حفظها',
          metadata: {
            lifecycle: { ok: true, count: 12, pages: 2, truncated: false, error: 'secret-like detail' },
            opportunities: { ok: true, count: 8, pages: 1, truncated: false },
            calibration: { ok: true }
          }
        }
      }
    }]
  });
  const recovery = compacted.engines.head[0].extra.recovery;
  assert.equal(recovery.state, 'ready');
  assert.equal(recovery.readyAt, 1_700_000_000_100);
  assert.equal(recovery.metadata.lifecycle.count, 12);
  assert.equal(recovery.metadata.lifecycle.pages, 2);
  assert.equal(recovery.metadata.lifecycle.truncated, false);
  assert.equal(recovery.metadata.opportunities.ok, true);
  assert.equal(Object.hasOwn(recovery, 'error'), false);
  assert.equal(JSON.stringify(compacted).includes('secret-like detail'), false);
});

test('فشل الاستعادة يبقى ظاهراً في العينة دون كشف تفاصيل الخطأ', () => {
  const compacted = compactSample({
    engines: [{
      name: 'live-opportunities',
      extra: { recovery: { state: 'failed', attemptedAt: 100, error: 'database credential detail', truncated: true } }
    }]
  });
  const recovery = compacted.engines.head[0].extra.recovery;
  assert.equal(recovery.state, 'failed');
  assert.equal(recovery.truncated, true);
  assert.equal(JSON.stringify(compacted).includes('database credential detail'), false);
});

test('ضغط عيّنة كاملة يحفظ كل الأقسام التشخيصية الأساسية', () => {
  const sample = {
    now: 1, uptimeSec: 600, lagMs: { p50: 60, p99: 384 },
    gc: { count: 17954, totalMs: 70741, maxMs: 89, major: { count: 0 } },
    heap: { pressurePct: 15, spaces: [{ space: 'old_space', usedMb: 89 }] },
    engines: REAL_ENGINES.map(n => ({ name: n, cycles: 1 })),
    zoneIdentity: { churned: 12, matched: 100, examples: [{ id: 1 }, { id: 2 }] },
    shadow: { comparisons: { x: { samples: 5 } }, records: Array.from({ length: 40 }, (_, i) => ({ key: `k${i}`, ms: 1 })) },
    liquidityV2: { parityPct: 71.5, recent: Array.from({ length: 200 }, (_, i) => ({ id: i })) }
  };
  const c = compactSample(sample);
  assert.equal(c.engines.head.length, REAL_ENGINES.length, 'لا محرك مفقود');
  assert.equal(c.lagMs.p99, 384, 'مقياس الحلقة محفوظ');
  assert.equal(c.gc.count, 17954, 'عدّاد GC محفوظ');
  assert.equal(c.heap.pressurePct, 15, 'ضغط الذاكرة محفوظ');
  assert.equal(c.shadow.comparisons.x.samples, 5, 'مقارنات الظل محفوظة');
  assert.equal(c.liquidityV2.parityPct, 71.5);
  assert.equal(c.liquidityV2.recent.n, 200, 'طول قائمة المناطق محفوظ');
  assert.equal(c.zoneIdentity.churned, 12);
});
