import express from 'express';

export function createLiquidityWorkbenchRouter({ getWorkbench, timeframes }) {
  const router = express.Router();
  router.get('/status', (_req, res) => {
    const workbench = getWorkbench();
    res.json(workbench?.status() ?? { enabled: false, recovery: 'pending', error: 'الخدمة لم تتهيأ بعد' });
  });
  router.get('/points', async (req, res) => {
    const timeframe = String(req.query.timeframe ?? '');
    const engine = String(req.query.engine ?? '');
    const zoneId = String(req.query.zoneId ?? '');
    if (!timeframes.includes(timeframe)) return res.status(400).json({ error: 'فريم غير صالح' });
    if (!['liquidity-engine-v1', 'liquidity-engine-v2'].includes(engine)) return res.status(400).json({ error: 'محرك غير صالح' });
    if (!zoneId || zoneId.length > 300) return res.status(400).json({ error: 'معرّف المنطقة غير صالح' });
    const workbench = getWorkbench();
    if (!workbench) return res.status(503).json({ error: 'الخدمة لم تتهيأ بعد' });
    try {
      const points = await workbench.listPoints({ timeframe, engine, zoneId });
      return res.json({ symbol: workbench.status().symbol, timeframe, engine, zoneId, points });
    } catch {
      return res.status(503).json({ error: 'تعذر قراءة نقاط المنطقة من التخزين الدائم' });
    }
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
