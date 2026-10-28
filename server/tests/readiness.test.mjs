/**
 * قياس الجاهزية — العيب الذي يحرسه هذا الملف:
 *
 * `/readyz` كانت تعيد `{ok:true}` بمجرد وجود `client/dist/index.html`، بينما `/healthz`
 * (وهي healthcheckPath في railway.json) تعيد `{ok:true}` دائماً. النتيجة أن نظاماً فشلت
 * استعادة فرصه الحية — فلا يبدأ محركه إطلاقاً — أو نظاماً بلا قاعدة بيانات مُهيّأة كان
 * يُعلن «جاهزاً» عند المنصة وعند أي مراقب خارجي.
 *
 * الاختبار يثبت أن الجاهزية تسقط عند غياب شرط صحّي، وتبقى صاعدة عند تدهور غير صحّي
 * (بيانات سوق قديمة أو مسار REST احتياطي) — لأن إسقاط النظام بسبب سوق هادئ خطأ مضاد.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateReadiness, READINESS_STATE } from '../readiness.mjs';

const healthy = {
  dist: true,
  storage: { configured: true, persistFailures: 0 },
  live: { required: true, state: 'ready' },
  market: { available: true, connected: true, priceAgeMs: 1000 }
};

test('حالة سليمة كاملة ⇒ ready وجاهز', () => {
  const r = evaluateReadiness(healthy);
  assert.equal(r.state, READINESS_STATE.READY);
  assert.equal(r.ready, true);
  assert.deepEqual(r.reasons, []);
});

test('حزمة الواجهة مفقودة ⇒ فشل حرج و503', () => {
  const r = evaluateReadiness({ ...healthy, dist: false });
  assert.equal(r.state, READINESS_STATE.FAILED);
  assert.equal(r.ready, false);
  assert.ok(r.reasons.some(x => x.code === 'bundle_missing' && x.severity === 'critical'));
});

test('تخزين غير مُهيّأ ⇒ فشل حرج (لا استعادة ولا حفظ)', () => {
  const r = evaluateReadiness({ ...healthy, storage: { configured: false } });
  assert.equal(r.ready, false);
  assert.equal(r.state, READINESS_STATE.FAILED);
  assert.ok(r.reasons.some(x => x.code === 'storage_unconfigured'));
});

test('فشل استعادة الفرص الحية ⇒ فشل حرج (المحرك لا يبدأ)', () => {
  const r = evaluateReadiness({ ...healthy, live: { required: true, state: 'failed', error: 'timeout' } });
  assert.equal(r.ready, false);
  const reason = r.reasons.find(x => x.code === 'live_recovery_failed');
  assert.ok(reason);
  assert.equal(reason.detail, 'timeout');
});

test('الاستعادة قيد التنفيذ ⇒ starting وغير جاهز (لا يُعلن الجاهزية قبل الاكتمال)', () => {
  for (const state of ['pending', 'loading']) {
    const r = evaluateReadiness({ ...healthy, live: { required: true, state } });
    assert.equal(r.state, READINESS_STATE.STARTING, state);
    assert.equal(r.ready, false, state);
    assert.equal(r.reasons.some(x => x.severity === 'critical'), false, state);
  }
});

test('LIGHT_MODE يتجاوز شرط استعادة المحرك المعطّل', () => {
  const r = evaluateReadiness({
    ...healthy,
    lightMode: true,
    live: { required: true, state: 'pending' }
  });
  assert.equal(r.ready, true);
  assert.equal(r.checks.live.state, 'disabled');
});

test('بث السوق غير متاح ⇒ degraded لا failed (مسار REST بديل مشروع)', () => {
  const r = evaluateReadiness({ ...healthy, market: { available: false, connected: false } });
  assert.equal(r.state, READINESS_STATE.DEGRADED);
  assert.equal(r.ready, true);
  assert.ok(r.reasons.some(x => x.code === 'market_stream_unavailable'));
});

test('بث متاح لكن غير متصل ⇒ تحذير فقط', () => {
  const r = evaluateReadiness({ ...healthy, market: { available: true, connected: false, priceAgeMs: 10 } });
  assert.equal(r.state, READINESS_STATE.DEGRADED);
  assert.ok(r.reasons.some(x => x.code === 'market_disconnected'));
});

test('آخر سعر أقدم من الحد ⇒ تحذير تقادم لا إسقاط', () => {
  const r = evaluateReadiness({ ...healthy, market: { available: true, connected: true, priceAgeMs: 900_000 }, marketStaleMs: 300_000 });
  assert.equal(r.ready, true);
  assert.ok(r.reasons.some(x => x.code === 'market_stale'));
});

test('فشل حفظ سابق ⇒ تحذير يحمل نص الخطأ', () => {
  const r = evaluateReadiness({ ...healthy, storage: { configured: true, persistFailures: 3, lastPersistError: 'HTTP 500' } });
  assert.equal(r.ready, true);
  const reason = r.reasons.find(x => x.code === 'persist_failures');
  assert.equal(reason.detail, 'HTTP 500');
});

test('تدهور + شرط حرج معاً ⇒ الفشل الحرج يحكم', () => {
  const r = evaluateReadiness({
    dist: false,
    storage: { configured: true },
    live: { required: true, state: 'ready' },
    market: { available: false }
  });
  assert.equal(r.state, READINESS_STATE.FAILED);
  assert.equal(r.ready, false);
});

test('مدخلات ناقصة لا تُسقط التقييم (لا رمي استثناءات)', () => {
  const r = evaluateReadiness({});
  assert.equal(r.ready, true);
  assert.equal(r.state, READINESS_STATE.DEGRADED); // dist مجهول = تحذير
  assert.ok(r.reasons.some(x => x.code === 'bundle_unknown'));
});
