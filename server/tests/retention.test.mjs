/**
 * اختبار سياسة الاحتفاظ — الضمانة الأهم: لا يُحذف ما هو ذاكرة النظام.
 * يُثبت أن الأنواع المحمية (الفرص، النتائج، المعايرات، القرارات، التحليلات،
 * الأحكام الشرعية) لا تدخل قائمة الحذف أبداً، وأن التشخيص المتكرر وحده يُقلَّم.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { runRetention, agedDiagnosticTypes, PROTECTED_TYPES, startRetention } from '../services/retention.mjs';

const DAY = 86_400_000;

/** قاعدة وهمية تُسجّل كل عملية حذف/تعديل ليتحقق منها الاختبار */
function fakeDb({ snapshotRows = [], imageRows = 0 } = {}) {
  const calls = { deleteBefore: [], deleteByIds: [], clearImages: [], samples: [], sampleOldest: [] };
  return {
    calls,
    db: {
      events: {
        deleteBefore: async (type, beforeTs) => { calls.deleteBefore.push({ type, beforeTs }); return 5; },
        listByType: async () => snapshotRows,
        deleteByIds: async (ids) => { calls.deleteByIds.push(ids); return ids.length; },
      clearImagesBefore: async (type, beforeTs) => { calls.clearImages.push({ type, beforeTs }); return imageRows; },
      /** لا صفوف لسجل الاتجاهات في هذا البديل ⇒ دورة السقف لا تفعل شيئاً */
      countByType: async () => 0
      },
      // عيّنات الصحة صارت تحت سياسة صريحة (كانت محمية حماية مطلقة فتنمو أبداً)
      health: {
        deleteBefore: async (beforeTs) => { calls.samples.push(beforeTs); return 3; },
        count: async () => 12_345,
        deleteOldest: async (n) => { calls.sampleOldest.push(n); return n; }
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

test('الحذف الزمني يستهدف الأنواع التشخيصية فقط وبحد 7 أيام (سياسة السبعة)', async () => {
  const now = 2_000_000_000_000;
  const { db, calls } = fakeDb();
  const report = await runRetention({ db, now: () => now, log: { log: () => {}, warn: () => {} } });
  const types = calls.deleteBefore.map(c => c.type);
  assert.deepEqual(types.sort(), ['live_lifecycle', 'live_opportunity_rejected', 'strategy2_rejected'], 'الأنواع التشخيصية فقط');
  for (const c of calls.deleteBefore) {
    const ageDays = (now - c.beforeTs) / DAY;
    assert.equal(Math.round(ageDays), 7, 'الحد 7 أيام: القياس الإنتاجي أثبت أن 30 يوماً = 2.4GB');
  }
  assert.equal(report.errors.length, 0);
});

test('لقطات المناطق: يُبقى آخر 10 لكل رمز ويُحذف ما زاد', async () => {
  // 25 لقطة للرمز نفسه + 3 لرمز آخر (مرتبة تنازلياً بالزمن كما تعيدها القاعدة)
  const rows = [];
  for (let i = 0; i < 25; i += 1) rows.push({ id: 1000 + i, symbol: 'BTCUSDT' });
  for (let i = 0; i < 3; i += 1) rows.push({ id: 2000 + i, symbol: 'ETHUSDT' });
  const { db, calls } = fakeDb({ snapshotRows: rows });
  await runRetention({ db, now: () => Date.now(), log: { log: () => {}, warn: () => {} } });
  const deleted = calls.deleteByIds.flat();
  assert.equal(deleted.length, 15, 'يُحذف الزائد عن 10 للرمز الواحد فقط');
  // أحدث 10 لـBTC (المعرّفات 1000..1009) تبقى، والأقدم (1010..1024) تُحذف
  for (const id of [1010, 1011, 1020, 1024]) {
    assert.equal(deleted.includes(id), true, `المعرّف ${id} القديم يجب أن يُحذف`);
  }
  assert.equal(deleted.includes(1009), false, 'أحدث 10 تبقى');
  // لا يُحذف شيء من ETH (3 فقط < 10)
  for (const id of [2000, 2001, 2002]) {
    assert.equal(deleted.includes(id), false, `لقطات ETH (${id}) قليلة ولا تُحذف`);
  }
});

test('عيّنات الصحة: سياسة صريحة — حذف بالمدة ثم سقف الصفوف', async () => {
  const now = 2_000_000_000_000;
  const { db, calls } = fakeDb();
  const report = await runRetention({ db, now: () => now, log: { log: () => {}, warn: () => {} } });
  assert.equal(calls.samples.length, 1, 'حدّ زمني للعيّنات مطبَّق');
  assert.equal(Math.round((now - calls.samples[0]) / DAY), 30, 'العيّنات تُحذف بعد 30 يوماً');
  assert.deepEqual(calls.sampleOldest, [2345], 'السقف 10000 صف: يحذف 12345-10000 الأقدم');
  assert.equal(report.samples.total, 12_345);
  assert.equal(report.errors.length, 0);
});

test('عيّنات الصحة محمية من فقدان التاريخ القريب (لا حذف داخل المدة)', async () => {
  const now = 2_000_000_000_000;
  const seen = [];
  const db = {
    events: {
      deleteBefore: async () => 0, listByType: async () => [], deleteByIds: async () => 0, clearImagesBefore: async () => 0
    },
    health: {
      deleteBefore: async (beforeTs) => { seen.push(beforeTs); return 0; },
      count: async () => 100,
      deleteOldest: async () => { throw new Error('يجب ألا يُستدعى: العدد تحت السقف'); }
    }
  };
  // لا صفوف لسجل الاتجاهات هنا ⇒ دورة السقف لا تحذف شيئاً
  db.events.countByType = async () => 0;
  const report = await runRetention({ db, now: () => now, log: { log: () => {}, warn: () => {} } });
  assert.equal((now - seen[0]) / DAY, 30, 'حدّ زمني 30 يوماً');
  assert.equal(report.errors.length, 0, 'تحت السقف لا حذف سقفي');
});

/**
 * سجل الاتجاهات: ذاكرة النظام لا تُحذف بالزمن، لكنها تُصان بسقف صفوف.
 * القياس بعد التغطية الكاملة: ~73 ألف صف/يوم (≈57MB/يوم)، وأكبر قارئ في النظام
 * يطلب 2,000 صف ⇒ سقف 20,000 صف = عشرة أضعاف أكبر قراءة ممكنة.
 */
test('سجل الاتجاهات: عند تجاوز السقف يُحذف الأقدم فقط (الذاكرة الحديثة تبقى)', async () => {
  const rows = [];
  for (let i = 0; i < 1500; i += 1) rows.push({ id: 5000 - i, ts: 2_000_000_000_000 - i * 1000 });
  const calls = { deleteBefore: [] };
  const db = {
    events: {
      deleteBefore: async (type, before) => { calls.deleteBefore.push({ type, before }); return 7; },
      listByType: async () => rows,
      deleteByIds: async () => 0,
      clearImagesBefore: async () => 0,
      countByType: async (type) => (type === 'strategy2_direction' ? 25_000 : 0)
    },
    health: { deleteBefore: async () => 0, count: async () => 0, deleteOldest: async () => 0 }
  };
  const report = await runRetention({ db, now: () => 2_000_000_100_000, log: { log: () => {}, warn: () => {} } });
  const capCalls = calls.deleteBefore.filter(c => c.type === 'strategy2_direction');
  assert.equal(capCalls.length, 1, 'حذف واحد بالسقف لهذا النوع');
  assert.equal(report.rowCaps.strategy2_direction.total, 25_000);
  assert.equal(report.rowCaps.strategy2_direction.deleted, 7);
  assert.equal(report.errors.length, 0);
});

test('سجل الاتجاهات: تحت السقف لا حذف إطلاقاً', async () => {
  const byType = [];
  const db = {
    events: {
      deleteBefore: async (type) => { byType.push(type); return 0; },
      listByType: async () => [],
      deleteByIds: async () => 0,
      clearImagesBefore: async () => 0,
      countByType: async (type) => (type === 'strategy2_direction' ? 12_000 : 0)
    },
    health: { deleteBefore: async () => 0, count: async () => 0, deleteOldest: async () => 0 }
  };
  const report = await runRetention({ db, now: () => Date.now(), log: { log: () => {}, warn: () => {} } });
  assert.equal(byType.includes('strategy2_direction'), false, 'لا حذف لسجل الاتجاهات تحت السقف');
  assert.equal(report.rowCaps.strategy2_direction.deleted, 0);
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
      clearImagesBefore: async () => 0,
      countByType: async () => 0
    },
    health: { deleteBefore: async () => 0, count: async () => 0, deleteOldest: async () => 0 }
  };
  const nowMs = 1_800_000_000_000;
  const DAY = 24 * 3600_000;

  const long = await runRetention({ db, now: () => nowMs, diagnosticDays: 60, imageDays: 180, log: { log: () => {}, warn: () => {} } });
  const cut = deleted[0]?.before;
  assert.equal(cut, nowMs - 60 * DAY, 'حدّ الحذف اتبع 60 يوماً لا الافتراضي');
  assert.equal(long.errors.length, 0);

  deleted.length = 0;
  await runRetention({ db, now: () => nowMs, diagnosticDays: 7, imageDays: 30, log: { log: () => {}, warn: () => {} } });
  assert.equal(deleted[0]?.before, nowMs - 7 * DAY, 'حدّ الحذف اتبع 7 أيام');
});

test('قيم المدد غير الصالحة تعود للافتراضي (لا حذف بلا حد)', async () => {
  const deleted = [];
  const db = {
    events: { deleteBefore: async (t, b) => { deleted.push(b); return 0; }, listByType: async () => [], clearImagesBefore: async () => 0 },
    health: { deleteBefore: async () => 0, count: async () => 0, deleteOldest: async () => 0 }
  };
  const nowMs = 1_800_000_000_000;
  const DAY = 24 * 3600_000;
  await runRetention({ db, now: () => nowMs, diagnosticDays: 0, imageDays: '', log: { log: () => {}, warn: () => {} } });
  assert.equal(deleted[0], nowMs - 7 * DAY, 'صفر يعني الافتراضي (7) لا «حذف كل شيء»');
});

/**
 * عيب مُقاس: `startRetention` لم يكن يتلقّى أي وسيلة إبلاغ، فبقيت دورات الاحتفاظ صفراً
 * في الصحة أبداً (رُصد: 0 دورات بعد 30 دقيقة تشغيل على النشر) — فيبدو أن سياسة الاحتفاظ
 * لا تعمل بينما هي تعمل، ويضيع دليل سعة التخزين من حكم التشغيل المستمر.
 */
test('الإبلاغ بعد كل دورة احتفاظ: نبضة بأسماء صحيحة بدل صفر دورات', async () => {
  const db = { events: { deleteBefore: async () => 0, listByType: async () => [], clearImagesBefore: async () => 0 } };
  const beats = [];
  const failures = [];
  const scheduler = startRetention({
    db,
    intervalMs: 60 * 60_000,
    log: { log: () => {}, warn: () => {}, error: () => {} },
    onRun: ({ ms = null, extra = null, error = null } = {}) => {
      if (error) failures.push(error); else beats.push({ ms, extra });
    }
  });
  try {
    scheduler.run();
    await new Promise(r => setTimeout(r, 60));
    assert.equal(beats.length, 1, 'نبضة واحدة بعد دورة واحدة');
    assert.equal(failures.length, 0, 'لا إخفاق في الدورة الناجحة');
    assert.ok(beats[0].extra && typeof beats[0].extra.deleted === 'number', 'النبضة تحمل عدد المحذوف');
  } finally { scheduler.stop(); }
});

test('إخفاق جدول واحد يُبلَّغ في عدد أخطاء النبضة ولا يمرّ صامتاً', async () => {
  const db = { events: { deleteBefore: async () => { throw new Error('قاعدة غير متاحة'); }, listByType: async () => [], clearImagesBefore: async () => 0 } };
  const beats = [];
  const scheduler = startRetention({
    db,
    intervalMs: 60 * 60_000,
    log: { log: () => {}, warn: () => {}, error: () => {} },
    onRun: ({ ms = null, extra = null, error = null } = {}) => { if (!error) beats.push({ ms, extra }); }
  });
  try {
    scheduler.run();
    await new Promise(r => setTimeout(r, 60));
    /**
     * السلوك المقصود: فشل جدول واحد لا يُسقط الدورة كلها (باقي الجداول تُقلَّم)، لكنه
     * يظهر في عدّاد الأخطاء — فلا يمرّ العطل صامتاً كما كان يمرّ قبل الإصلاح.
     */
    assert.equal(beats.length, 1, 'الدورة تُبلَّغ رغم فشل جدول واحد');
    assert.ok(beats[0].extra.errors >= 1, `الفشل ظاهر في عدّاد الأخطاء، والعدد ${beats[0].extra.errors}`);
    assert.ok(scheduler.lastReport(), 'التقرير متاح ولو جزئياً');
  } finally { scheduler.stop(); }
});
