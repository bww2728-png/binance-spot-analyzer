/**
 * مُجمّع عمال (worker pool) لتنفيذ الأعمال الثقيلة خارج حلقة الأحداث.
 *
 * الخصائص:
 *  - طابور مهام بترتيب وصول.
 *  - إعادة تشغيل العامل فوراً إن خرج أو رمى خطأ قاتلاً (الاستقرار المستمر).
 *  - مهلة لكل مهمة؛ تجاوزها يفشل المهمة وحدها ويُعاد تشغيل العامل.
 *  - إغلاق سليم ينهي كل العمال.
 *  - عدّادات للأعمال والمهل والأعطال تُقرأ في صفحة الصحة.
 *
 * لا يغيّر أي نتيجة: ينفّذ الدالة نفسها على نفس المدخلات في خيط آخر.
 */
import { Worker } from 'node:worker_threads';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export function createWorkerPool({
  file = path.join(here, '..', 'workers', 'liquidityScan.worker.mjs'),
  size = 2,
  taskTimeoutMs = 60_000,
  maxHeapMb = Number(process.env.WORKER_HEAP_MB) || 160,
  log = console
} = {}) {
  const workers = [];
  const queue = [];
  let nextId = 1;
  let closing = false;
  const stats = { created: 0, tasks: 0, errors: 0, timeouts: 0, restarts: 0, inFlight: 0, queued: 0, maxQueue: 0 };

  function spawn() {
    /**
     * سقف ذاكرة صريح لكل عامل: بدونه يرث العامل سقف NODE_OPTIONS للعملية الأم
     * (460MB هنا) فيتضاعف الاستهلاك بعدد العمال ويُسقط الحاوية.
     * القياس قبل السقف: 917MB عند عاملين. بعده: محدود ومتوقّع.
     */
    const w = {
      worker: new Worker(file, {
        resourceLimits: {
          maxOldGenerationSizeMb: maxHeapMb,
          maxYoungGenerationSizeMb: Math.max(16, Math.round(maxHeapMb / 8))
        }
      }),
      busy: null, id: 0, restarts: 0
    };
    w.id = stats.created += 1;
    w.worker.on('message', (msg) => {
      const job = w.busy;
      if (!job || msg?.id !== job.id) return;
      clearTimeout(job.timer);
      w.busy = null;
      stats.inFlight -= 1;
      if (msg.ok) job.resolve(msg.result);
      else {
        stats.errors += 1;
        job.reject(new Error(msg.error || 'فشل غير معروف في العامل'));
      }
      pump();
    });
    w.worker.on('error', (err) => {
      stats.errors += 1;
      const job = w.busy;
      if (job) {
        clearTimeout(job.timer);
        w.busy = null;
        stats.inFlight -= 1;
        job.reject(err);
      }
      replace(w, err);
      pump();
    });
    w.worker.on('exit', (code) => {
      if (closing) return;
      if (code !== 0 && !w.dead) log.error?.(`[workerPool] خرج العامل ${w.id} بالرمز ${code} — يُعاد تشغيله`);
      w.dead = true;
      const job = w.busy;
      if (job) {
        clearTimeout(job.timer);
        w.busy = null;
        stats.inFlight -= 1;
        job.reject(new Error(`انتهى العامل بالرمز ${code}`));
      }
      replace(w);
      pump();
    });
    // لا نمنع الخروج عند الإغلاق
    w.worker.unref?.();
    workers.push(w);
    return w;
  }

  /** استبدال عامل ميت بعامل جديد في نفس الموضع */
  function replace(dead, err = null) {
    const i = workers.indexOf(dead);
    if (i < 0) return;             // سبق استبداله
    workers.splice(i, 1);
    stats.restarts += 1;
    if (err) log.warn?.(`[workerPool] إعادة تشغيل عامل: ${err.message}`);
    if (!closing) spawn();
  }

  function pump() {
    if (closing) return;
    stats.queued = queue.length;
    if (queue.length > stats.maxQueue) stats.maxQueue = queue.length;
    for (const w of workers) {
      // العامل المُنهى يبقى في المصفوفة حتى حدث exit — لا يجوز تسليمه عملاً جديداً
      if (w.dead || w.busy || !queue.length) continue;
      const job = queue.shift();
      w.busy = job;
      stats.inFlight += 1;
      job.timer = setTimeout(() => {
        stats.timeouts += 1;
        const stuck = w.busy;
        w.busy = null;
        stats.inFlight -= 1;
        if (stuck) stuck.reject(new Error(`مهلة المهمة ${job.op} تجاوزت ${taskTimeoutMs}ms`));
        // عامل عالق: يُنهى ويُستبدل — ويُوسم ميتاً فوراً كي لا يستلم عملاً بين
        // لحظة الإنهاء ولحظة حدث exit (وإلا رُفض العمل الجديد بخطأ «انتهى العامل»)
        w.dead = true;
        w.worker.terminate().catch(() => {});
        pump();
      }, job.timeoutMs ?? taskTimeoutMs);
      if (job.timer.unref) job.timer.unref();
      w.worker.postMessage({ id: job.id, op: job.op, payload: job.payload });
    }
    stats.queued = queue.length;
  }

  function run(op, payload, { timeoutMs = taskTimeoutMs } = {}) {
    if (closing) return Promise.reject(new Error('المجمّع مغلق'));
    stats.tasks += 1;
    return new Promise((resolve, reject) => {
      queue.push({ id: nextId++, op, payload, resolve, reject, timeoutMs });
      stats.queued = queue.length;
      if (queue.length > stats.maxQueue) stats.maxQueue = queue.length;
      pump();
    });
  }

  async function close() {
    closing = true;
    for (const w of workers) {
      const job = w.busy;
      if (job) job.reject(new Error('المجمّع يُغلق'));
      await w.worker.terminate().catch(() => {});
    }
    workers.length = 0;
    for (const job of queue.splice(0)) job.reject(new Error('المجمّع يُغلق'));
  }

  function snapshot() {
    return { ...stats, size, workers: workers.length, busy: workers.filter(w => w.busy).length };
  }

  for (let i = 0; i < Math.max(1, size); i += 1) spawn();
  return { run, close, snapshot };
}

export default createWorkerPool;
