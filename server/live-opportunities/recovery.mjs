export function createLiveOpportunityRecovery({
  engine,
  readLifecycle,
  readOpportunities,
  readPauseState = async () => ({ paused: false, pauseUpdatedAt: null }),
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  retryDelayMs = 30_000,
  maxRetryDelayMs = 5 * 60_000,
  log = console
}) {
  let timer = null;
  let attempt = 0;
  let inFlight = false;
  let pendingGeneration = null;
  let generation = 0;
  let stopped = false;

  const launch = (runGeneration) => {
    if (stopped || runGeneration !== generation) return;
    if (inFlight) {
      pendingGeneration = runGeneration;
      return;
    }
    void runNow(runGeneration);
  };

  const scheduleRetry = (runGeneration) => {
    if (stopped || runGeneration !== generation || timer) return;
    attempt += 1;
    const delay = Math.min(retryDelayMs * 2 ** Math.min(attempt - 1, 8), maxRetryDelayMs);
    timer = setTimeoutFn(() => {
      timer = null;
      launch(runGeneration);
    }, delay);
    timer?.unref?.();
  };

  const runNow = async (runGeneration = generation) => {
    if (stopped || runGeneration !== generation || inFlight) return { skipped: true };
    inFlight = true;
    engine.setRecoveryState('loading');
    const metadata = {};
    try {
      const [lifecycleResult, opportunitiesResult, calibrationResult, pauseStateResult] = await Promise.allSettled([
        readLifecycle(),
        readOpportunities(),
        engine.loadCalibration(),
        readPauseState()
      ]);
      if (stopped || runGeneration !== generation) return { skipped: true };
      metadata.lifecycle = lifecycleResult.status === 'fulfilled'
        ? { ok: true, count: lifecycleResult.value.rows.length, pages: lifecycleResult.value.pages, truncated: lifecycleResult.value.truncated }
        : { ok: false, count: 0, error: String(lifecycleResult.reason?.message ?? lifecycleResult.reason), truncated: false };
      metadata.opportunities = opportunitiesResult.status === 'fulfilled'
        ? { ok: true, count: opportunitiesResult.value.rows.length, pages: opportunitiesResult.value.pages, truncated: opportunitiesResult.value.truncated }
        : { ok: false, count: 0, error: String(opportunitiesResult.reason?.message ?? opportunitiesResult.reason), truncated: false };
      metadata.calibration = calibrationResult.status === 'fulfilled'
        ? { ok: true }
        : { ok: false, error: String(calibrationResult.reason?.message ?? calibrationResult.reason) };
      metadata.control = pauseStateResult.status === 'fulfilled'
        ? { ok: true, paused: Boolean(pauseStateResult.value?.paused), pauseUpdatedAt: Number(pauseStateResult.value?.pauseUpdatedAt) || null }
        : { ok: false, error: String(pauseStateResult.reason?.message ?? pauseStateResult.reason) };

      // اقتطاع سجل دورة الحياة غير قاتل: الصفوف المسقطة هي الأقدم، والسويبات الأقدم
      // من نافذة النضارة تُسقط أصلاً عند إعادة البناء، والمتتبعات الفردية تُعاد بناؤها
      // من مصدر المناطق الحي في أول دورة. اقتطاع فرص النشر يبقى قاتلاً — لا يجوز فقد
      // فرصة مفتوحة، وكذلك أي فشل قراءة.
      const failed = Object.entries(metadata).filter(([name, result]) => !result.ok || (result.truncated && name !== 'lifecycle'));
      if (failed.length) {
        const error = failed.map(([name, result]) => `${name}: ${result.error ?? (result.truncated ? 'تجاوز حد الاستعادة' : 'فشل غير محدد')}`).join(' · ');
        engine.setRecoveryState('failed', { error, metadata });
        log.error?.('[live-opp] recovery incomplete; engine remains paused:', metadata);
        scheduleRetry(runGeneration);
        return { ok: false, metadata };
      }
      if (metadata.lifecycle?.truncated) {
        log.warn?.('[live-opp] lifecycle history truncated at the read cap; recovering with the newest rows only:', metadata.lifecycle);
      }

      const rows = [...lifecycleResult.value.rows, ...opportunitiesResult.value.rows];
      if (stopped || runGeneration !== generation) return { skipped: true };
      const restored = engine.rehydrate(rows, metadata);
      if (restored?.skipped || engine.getStatus().recovery.state !== 'ready') {
        throw new Error(engine.getStatus().recovery.error ?? 'تعذر استكمال استعادة الفرص المحفوظة');
      }
      if (stopped || runGeneration !== generation) return { skipped: true };
      engine.setPaused?.(metadata.control.paused, metadata.control.pauseUpdatedAt);
      engine.start();
      attempt = 0;
      if (timer) clearTimeoutFn(timer);
      timer = null;
      log.log?.('[live-opp] recovery complete; scanning started:', metadata);
      return { ok: true, metadata, restored };
    } catch (error) {
      if (stopped || runGeneration !== generation) return { skipped: true };
      const message = String(error?.message ?? error).slice(0, 240);
      engine.setRecoveryState('failed', { error: message, metadata });
      log.error?.('[live-opp] recovery failed; engine remains paused:', message);
      scheduleRetry(runGeneration);
      return { ok: false, error: message, metadata };
    } finally {
      inFlight = false;
      if (pendingGeneration !== null) {
        const nextGeneration = pendingGeneration;
        pendingGeneration = null;
        launch(nextGeneration);
      }
    }
  };

  return {
    start(delayMs = 0) {
      stopped = false;
      generation += 1;
      pendingGeneration = null;
      const runGeneration = generation;
      if (timer) clearTimeoutFn(timer);
      timer = setTimeoutFn(() => {
        timer = null;
        launch(runGeneration);
      }, Math.max(0, Number(delayMs) || 0));
      timer?.unref?.();
    },
    runNow,
    stop() {
      stopped = true;
      generation += 1;
      pendingGeneration = null;
      if (timer) clearTimeoutFn(timer);
      timer = null;
    },
    getState() {
      return { inFlight, stopped, attempt, retryScheduled: timer !== null };
    }
  };
}
