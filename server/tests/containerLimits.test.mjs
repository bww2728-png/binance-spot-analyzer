/**
 * قياس حدود الحاوية — العيب الذي يحرسه هذا الملف:
 *
 * `containerLimits()` كانت تقرأ `/sys/fs/cgroup/cpu.max` بلا حماية بينما تقرأ
 * `memory.max` بحماية. على أي تشغيل cgroup v2 بلا كنترولر CPU مُفعَّل (شائع في حاويات
 * مُقيَّدة الذاكرة فقط) يرمي `readFileSync` استثناء ENOENT من داخل `snapshot()`، فيُسقط
 * `/api/health/deep` بالكامل — أي أن فحص الصحة يصبح هو نفسه نقطة فشل واحدة.
 *
 * الإصلاح: حدّ الذاكرة يبقى مُقاساً، وغياب cpu.max يُنتج `cpuCores: null` لا استثناء.
 * الاختبار يحاكي أنظمة ملفات مختلفة بحقن قارئ وهمي (لا حاوية حقيقية).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readContainerLimits } from '../health.mjs';

const fakeFs = (files) => ({
  readFile: (p) => {
    if (Object.hasOwn(files, p)) return files[p];
    const err = new Error(`ENOENT: no such file or directory, open '${p}'`);
    err.code = 'ENOENT';
    throw err;
  }
});

const MEM_V2 = '/sys/fs/cgroup/memory.max';
const CPU_V2 = '/sys/fs/cgroup/cpu.max';
const MEM_V1 = '/sys/fs/cgroup/memory/memory.limit_in_bytes';

test('cgroup v2 كامل ⇒ الذاكرة والحصّة مقيسان', () => {
  const r = readContainerLimits(fakeFs({
    [MEM_V2]: '1073741824\n',
    [CPU_V2]: '150000 100000\n'
  }));
  assert.equal(r.memoryLimitMb, 1024);
  assert.equal(r.cpuCores, 1.5);
});

test('cgroup v2 بلا cpu.max ⇒ لا استثناء، الذاكرة تبقى والحصّة null', () => {
  const r = readContainerLimits(fakeFs({ [MEM_V2]: '1073741824\n' }));
  assert.equal(r.memoryLimitMb, 1024);
  assert.equal(r.cpuCores, null);
});

test('cpu.max = "max 100000" ⇒ حصّة غير محدودة تُترجم null لا NaN', () => {
  const r = readContainerLimits(fakeFs({ [MEM_V2]: '536870912', [CPU_V2]: 'max 100000' }));
  assert.equal(r.memoryLimitMb, 512);
  assert.equal(r.cpuCores, null);
});

test('cpu.max بصيغة تالفة ⇒ null بلا رمي', () => {
  const r = readContainerLimits(fakeFs({ [MEM_V2]: '536870912', [CPU_V2]: '' }));
  assert.equal(r.cpuCores, null);
});

test('cgroup v1 يُقرأ عند غياب memory.max', () => {
  const r = readContainerLimits(fakeFs({ [MEM_V1]: '2147483648' }));
  assert.equal(r.memoryLimitMb, 2048);
  assert.equal(r.cpuCores, null);
});

test('memory.max = max (بلا حد) يمرّ إلى v1', () => {
  const r = readContainerLimits(fakeFs({ [MEM_V2]: 'max', [MEM_V1]: '1073741824' }));
  assert.equal(r.memoryLimitMb, 1024);
});

test('لا ملفات cgroup (macOS/Windows) ⇒ قيم null بلا استثناء', () => {
  const r = readContainerLimits(fakeFs({}));
  assert.deepEqual(r, { memoryLimitMb: null, cpuCores: null });
});

test('حد v1 غير منطقي (2^63) يُرفض كما كان', () => {
  const r = readContainerLimits(fakeFs({ [MEM_V1]: String(2 ** 63) }));
  assert.equal(r.memoryLimitMb, null);
});
