/**
 * وضع نقل بيانات السوق — العيب الذي يحرسه هذا الملف:
 *
 * `marketStreams.stats()` كانت تُرجع `connected` فقط. عند غياب حزمة `ws` (وهي ليست
 * اعتمادية في هذا المشروع) يكون `connected` = false دائماً، فلا يمكن التمييز بين
 * «السوق هادئ» و«لا يوجد بث إطلاقاً» — وهذا تدهور مُعلن في السجل لكنه غير مقيس في
 * الحالة، فلا يصل إلى `/readyz` ولا إلى أي مراقب.
 *
 * الإصلاح: `available` (هل الحزمة موجودة؟) و`transport` ('ws' | 'rest-fallback')
 * بوصفهما تهيئة لا انحرافاً: الفرق بين «النقل غير متاح» و«النقل متاح لكنه منقطع».
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMarketStreams, marketStreamsAvailable } from '../market/streams.mjs';

const silentLog = { log() {}, warn() {}, error() {}, info() {} };

const makeStreams = () => createMarketStreams({
  log: silentLog,
  // لا بذر ولا استطلاع: الاختبار يخص الحالة المعلنة فقط، لا الشبكة.
  fetchAllPrices: null,
  seedCandles: null
});

test('stats() يُعلن النقل صراحةً: available + transport متطابقان', () => {
  const s = makeStreams();
  const st = s.stats();
  assert.equal(typeof st.available, 'boolean');
  assert.equal(st.available, marketStreamsAvailable());
  assert.equal(st.transport, st.available ? 'ws' : 'rest-fallback');
});

test('بدون حزمة ws: available=false وtransport=rest-fallback (تدهور معلن لا صامت)', () => {
  const s = makeStreams();
  const st = s.stats();
  if (marketStreamsAvailable()) {
    // بيئة فيها ws مثبّتة: التوقّع المعاكس، والربط بينهما يبقى مُثبتاً.
    assert.equal(st.transport, 'ws');
    return;
  }
  assert.equal(st.available, false);
  assert.equal(st.transport, 'rest-fallback');
  assert.equal(st.connected, false, 'لا بث ⇒ غير متصل');
});

test('available منفصل عن connected: العقد يمنعهما من التطابق القسري', () => {
  const s = makeStreams();
  const st = s.stats();
  // المرحلة الأولى: لا اتصال بعد. الاتصال يصبح true فقط مع ws متاحة.
  assert.equal(st.connected, false);
  if (!st.available) assert.equal(st.connected, false);
});

test('stats() لا يرمي قبل التشغيل ولا بعده (عقد نقطة الجاهزية)', () => {
  const s = makeStreams();
  assert.doesNotThrow(() => s.stats());
  s.start();
  try {
    const st = s.stats();
    assert.equal(typeof st.available, 'boolean');
    assert.equal(typeof st.connected, 'boolean');
  } finally {
    s.stop();
  }
});
