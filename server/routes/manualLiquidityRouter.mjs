import express from 'express';

export function createManualLiquidityRouter({ getService, getPublicConfig }) {
  const router = express.Router();
  const service = () => {
    const current = getService();
    if (!current) throw Object.assign(new Error('خدمة الرسم اليدوي غير جاهزة'), { statusCode: 503 });
    return current;
  };
  const contextFrom = (query) => ({ symbol: query.symbol, timeframe: query.timeframe });

  router.get('/config', (_req, res) => {
    try {
      const config = getPublicConfig?.();
      if (!config?.url || !config?.anonKey) throw new Error('إعداد Supabase العام غير مكتمل');
      return res.set('Cache-Control', 'no-store').json(config);
    } catch (error) {
      return res.status(503).json({ error: error?.message ?? 'إعداد Supabase العام غير متاح' });
    }
  });

  router.get('/candles', async (req, res) => {
    try {
      return res.json(await service().candles({ ...contextFrom(req.query), before: req.query.before }));
    } catch (error) {
      return res.status(error?.statusCode ?? 503).json({ error: error?.message ?? 'تعذر تحميل الشموع' });
    }
  });

  router.get('/drawings', async (req, res) => {
    try {
      const context = contextFrom(req.query);
      const drawings = await service().listDrawings(context);
      return res.json({ ...context, drawings });
    } catch (error) {
      return res.status(error?.statusCode ?? 503).json({ error: error?.message ?? 'تعذر قراءة الرسومات المحفوظة' });
    }
  });

  router.put('/drawings', async (req, res) => {
    try {
      const drawing = await service().saveDrawing(req.body);
      return res.status(200).json({ saved: true, drawing });
    } catch (error) {
      return res.status(error?.statusCode ?? 503).json({ error: error?.message ?? 'تعذر حفظ الرسم' });
    }
  });

  router.delete('/drawings/:drawingId', async (req, res) => {
    try {
      const result = await service().deleteDrawing({ ...req.query, drawingId: req.params.drawingId });
      return res.json(result);
    } catch (error) {
      return res.status(error?.statusCode ?? 503).json({ error: error?.message ?? 'تعذر حذف الرسم' });
    }
  });

  return router;
}
