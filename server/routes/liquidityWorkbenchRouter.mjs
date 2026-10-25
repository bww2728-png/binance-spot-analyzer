import express from 'express';

export function createLiquidityWorkbenchRouter({ getWorkbench, timeframes }) {
  const router = express.Router();
  router.get('/status', (_req, res) => {
    const workbench = getWorkbench();
    res.json(workbench?.status() ?? { enabled: false, recovery: 'pending', error: 'الخدمة لم تتهيأ بعد' });
  });
  router.get('/', (req, res) => {
    const timeframe = String(req.query.timeframe ?? '1h');
    if (!timeframes.includes(timeframe)) return res.status(400).json({ error: 'فريم غير صالح' });
    const workbench = getWorkbench();
    if (!workbench) return res.status(503).json({ status: { recovery: 'pending', enabled: false }, error: 'الخدمة لم تتهيأ بعد' });
    res.json(workbench.snapshot(timeframe));
  });
  return router;
}
