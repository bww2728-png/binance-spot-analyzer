/**
 * اختبار سياسة الاحتفاظ — الضمانة الأهم: لا يُحذف ما هو ذاكرة النظام.
 * يُثبت أن الأنواع المحمية (الفرص، النتائج، المعايرات، القرارات، التحليلات،
 * الأحكام الشرعية) لا تدخل قائمة الحذف أبداً، وأن التشخيص المتكرر وحده يُقلَّم.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { runRetention, agedDiagnosticTypes, PROTECTED_TYPES } from '../services/retention.mjs';

const DAY = 86_400_000;

/** قاعدة وهمية تُسجّل كل عملية حذف/تعديل ليتحقق منها الاختبار */
function fakeDb({ snapshotRows = [], imageRows = 0 } = {}) {
  const calls = { deleteBefore: [], deleteByIds: [], clearImages: [] };
  return {
    calls,
    db: {
      events: {
        deleteBefore: async (type, beforeTs) => { calls.deleteBefore.push({ type, beforeTs }); return 5; },
        listByType: async () => snapshotRows,
        deleteByIds: async (ids) => { calls.deleteByIds.push(ids); return ids.length; },
        clearImagesBefore: async (type, beforeTs) => { calls.clearImages.push({ type, beforeTs }); return imageRows; }
      }
    }
  };
}

test('الأنواع المحمية غير قابلة للحذف ولا تدخل قائمة التقليم', () => {
  const candidates = agedDiagnosticTypes(30);
  for (const t of candidates) {
    assert.equal(PROTECTED_TYPES.has(t), false, `النوع ${t} محمي ولا يجوز أن يُرشَّح`);
  }
  // الأنواع التي تحمل قيمة النظام يجب ألا تكون في المرشحين
  for (const mustKeep of ['strategy2_resolved', 'live_opportunity', 'live_opportunity_closed', 'live_calibration', 'barcode_scan']) {
    assert.equal(candidates.includes(mustKeep), false, `${mustKeep} لا يجوز ترشيحه للحذف`);
  }
  // حالة المحركات الدائمة: حذفها يعني فقدان تعلّم المراجعات وقياس ★ عند كل إعادة تشغيل
  assert.equal(PROTECTED_TYPES.has('engine_state'), true, 'حالة المحركات يجب أن تكون محمية');
  assert.equal(candidates.includes('engine_state'), false, 'engine_state ليس تشخيصاً قابلاً للتقليم');
});

test('الحذف الزمني يستهدف الأنواع التشخيصية فقط وبحد 30 يوماً', async () => {
  const now = 2_000_000_000_000;
  const { db, calls } = fakeDb();
  const report = await runRetention({ db, now: () => now, log: { log: () => {}, warn: () => {} } });
  const types = calls.deleteBefore.map(c => c.type);
  assert.deepEqual(types.sort(), ['live_lifecycle', 'live_opportunity_rejected'], 'النوعان التشخيصيان فقط');
  for (const c of calls.deleteBefore) {
    const ageDays = (now - c.beforeTs) / DAY;
    assert.equal(Math.round(ageDays), 30, 'الحد 30 يوماً بالضبط');
  }
  assert.equal(report.errors.length, 0);
});

test('لقطات المناطق: يُبقى آخر 20 لكل رمز ويُحذف ما زاد', async () => {
  // 25 لقطة للرمز نفسه + 3 لرمز آخر (مرتبة تنازلياً بالزمن كما تعيدها القاعدة)
  const rows = [];
  for (let i = 0; i < 25; i += 1) rows.push({ id: 1000 + i, symbol: 'BTCUSDT' });
  for (let i = 0; i < 3; i += 1) rows.push({ id: 2000 + i, symbol: 'ETHUSDT' });
  const { db, calls } = fakeDb({ snapshotRows: rows });
  await runRetention({ db, now: () => Date.now(), log: { log: () => {}, warn: () => {} } });
  const deleted = calls.deleteByIds.flat();
  assert.equal(deleted.length, 5, 'يُحذف الزائد عن 20 للرمز الواحد فقط');
  // أحدث 20 لـBTC (المعرّفات 1000..1019) تبقى، والأقدم (1020..1024) تُحذف
  for (const id of [1020, 1021, 1022, 1023, 1024]) {
    assert.equal(deleted.includes(id), true, `المعرّف ${id} القديم يجب أن يُحذف`);
  }
  // لا يُحذف شيء من ETH (3 فقط < 20)
  for (const id of [2000, 2001, 2002]) {
    assert.equal(deleted.includes(id), false, `لقطات ETH (${id}) قليلة ولا تُحذف`);
  }
});

test('الصور تُسقط بعد 90 يوماً مع إبقاء الحدث نفسه', async () => {
  const now = 2_000_000_000_000;
  const { db, calls } = fakeDb({ imageRows: 7 });
  await runRetention({ db, now: () => now, log: { log: () => {}, warn: () => {} } });
  assert.equal(calls.clearImages.length > 0, true, 'تنظيف الصور يعمل');
  for (const c of calls.clearImages) {
    const ageDays = (now - c.beforeTs) / DAY;
    assert.equal(Math.round(ageDays), 90, 'حد الصور 90 يوماً');
    assert.equal(PROTECTED_TYPES.has(c.type), false, `لا تمسّ الأنواع المحمية (${c.type})`);
  }
});

test('الوضع التجريبي (dryRun) لا يحذف شيئاً', async () => {
  const { db, calls } = fakeDb({ snapshotRows: [{ id: 1, symbol: 'A' }] });
  const report = await runRetention({ db, now: () => Date.now(), dryRun: true, log: { log: () => {}, warn: () => {} } });
  assert.equal(calls.deleteBefore.length, 0, 'لا حذف زمني في dryRun');
  assert.equal(calls.deleteByIds.length, 0, 'لا حذف بمعرّفات في dryRun');
  assert.equal(calls.clearImages.length, 0, 'لا إسقاط صور في dryRun');
  assert.equal(report.totalDeleted, 0);
});

test('فشل قاعدة البيانات لا يُسقط الدورة بل يُسجّل خطأ', async () => {
  const db = {
    events: {
      deleteBefore: async () => { throw new Error('شبكة مقطوعة'); },
      listByType: async () => { throw new Error('شبكة مقطوعة'); },
      deleteByIds: async () => 0,
      clearImagesBefore: async () => { throw new Error('شبكة مقطوعة'); }
    }
  };
  const report = await runRetention({ db, now: () => Date.now(), log: { log: () => {}, warn: () => {} } });
  assert.equal(report.errors.length > 0, true, 'الأخطاء مرصودة');
  assert.equal(typeof report.totalDeleted, 'number', 'الدورة أُكملت بلا رمي');
});

test('المدد قابلة للضبط: تغييرها يغيّر حدّ الحذف فعلاً', async () => {
  const deleted = [];
  const db = {
    events: {
      deleteBefore: async (type, before) => { deleted.push({ type, before }); return 1; },
      listByType: async () => [],
      clearImagesBefore: async () => 0
    }
  };
  const nowMs = 1_800_000_000_000;
  const DAY = 24 * 3600_000;

  const long = await runRetention({ db, now: () => nowMs, diagnosticDays: 60, imageDays: 180, log: { log: () => {}, warn: () => {} } });
  const cut = deleted[0]?.before;
  assert.equal(cut, nowMs - 60 * DAY, 'حدّ الحذف اتبع 60 يوماً لا 30');
  assert.equal(long.errors.length, 0);

  deleted.length = 0;
  await runRetention({ db, now: () => nowMs, diagnosticDays: 7, imageDays: 30, log: { log: () => {}, warn: () => {} } });
  assert.equal(deleted[0]?.before, nowMs - 7 * DAY, 'حدّ الحذف اتبع 7 أيام');
});

test('قيم المدد غير الصالحة تعود للافتراضي (لا حذف بلا حد)', async () => {
  const deleted = [];
  const db = { events: { deleteBefore: async (t, b) => { deleted.push(b); return 0; }, listByType: async () => [], clearImagesBefore: async () => 0 } };
  const nowMs = 1_800_000_000_000;
  const DAY = 24 * 3600_000;
  await runRetention({ db, now: () => nowMs, diagnosticDays: 0, imageDays: '', log: { log: () => {}, warn: () => {} } });
  assert.equal(deleted[0], nowMs - 30 * DAY, 'صفر يعني الافتراضي لا «حذف كل شيء»');
});
