import { useEffect, useRef } from 'react';
import type { LiquidityZone } from '../lib/types';
import type { IChartApi } from 'lightweight-charts';

export const BAND_COLORS = {
  BSL: { rgb: '242,54,69' },  // أحمر — سيولة بيعية فوق
  SSL: { rgb: '8,153,129' },  // أخضر — سيولة شرائية تحت
  MANUAL: { rgb: '59,130,246' } // أزرق — مناطق تعليم المستخدم
} as const;

/** أقوى N منطقة آلية تُرسم على الشارت (البقية في القائمة الجانبية عبر التبويب) */
export const MAX_AUTO_BANDS = 5;

/** نطاق المنطقة: السعر ± نصف عرضها (bandPct) */
export const zoneRange = (z: { price: number; bandPct?: number | null }) => {
  const half = (z.bandPct ?? 0.0015) / 2;
  return { low: z.price * (1 - half), high: z.price * (1 + half) };
};

/**
 * طبقة مناطق مظللة: canvas مطلق فوق الشارت، يعيد الرسم مع تحرك/تحجيم الشارت.
 * - الآلي: شفافية تعبر الدرجة، أقوى 5 فقط.
 * - اليدوي: أزرق مميز بعنوان الملاحظة.
 * - highlightId: منطقة مختارة تُرسم بحدود صلبة (وميض) — يديره الأب عبر timeout.
 */
export function useZoneBands(
  containerRef: React.RefObject<HTMLDivElement | null>,
  chartRef: React.RefObject<IChartApi | null>,
  getPriceCoord: (price: number) => number | null,
  zones: LiquidityZone[],
  highlightId: string | null
) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const zonesRef = useRef(zones);
  const highlightRef = useRef(highlightId);
  zonesRef.current = zones;
  highlightRef.current = highlightId;

  useEffect(() => {
    const draw = () => {
      const canvas = canvasRef.current;
      const container = containerRef.current;
      const chart = chartRef.current;
      if (!canvas || !container || !chart) return;
      const w = container.clientWidth;
      const h = container.clientHeight;
      const dpr = window.devicePixelRatio || 1;
      if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
        canvas.width = w * dpr;
        canvas.height = h * dpr;
        canvas.style.width = `${w}px`;
        canvas.style.height = `${h}px`;
      }
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      const timeScale = chart.timeScale();
      const visible = timeScale.getVisibleLogicalRange();
      if (!visible) return;
      // عرض النطاق المرئي بالبكسل — من أول شمعة ظاهرة إلى آخر الشارت
      const firstX = timeScale.logicalToCoordinate(visible.from);
      const x0 = Math.max(0, firstX ?? 0);
      const x1 = w;

      // الآلي: أقوى 5 حسب الدرجة
      const auto = zonesRef.current
        .filter(z => z.source === 'auto')
        .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
        .slice(0, MAX_AUTO_BANDS);
      const manual = zonesRef.current.filter(z => z.source !== 'auto');
      const list = [...manual, ...auto];

      for (const z of list) {
        const y = getPriceCoord(z.price);
        if (y == null || !Number.isFinite(y)) continue;
        const { low, high } = zoneRange(z);
        const yTop = getPriceCoord(high);
        const yBottom = getPriceCoord(low);
        if (yTop == null || yBottom == null) continue;
        const bandH = Math.max(3, Math.abs(yBottom - yTop));
        const isManual = z.source !== 'auto';
        const colorKey = isManual ? BAND_COLORS.MANUAL.rgb : BAND_COLORS[z.type].rgb;
        const alpha = isManual
          ? 0.26
          : 0.12 + Math.min(1, (z.score ?? 50) / 100) * 0.33;
        const highlighted = highlightRef.current === z.id;

        // جسم المنطقة
        ctx.fillStyle = `rgba(${colorKey},${(highlighted ? Math.min(0.75, alpha + 0.3) : alpha).toFixed(3)})`;
        ctx.fillRect(x0, yTop, x1 - x0, bandH);

        // حدود للمنطقة المختارة (وميض)
        if (highlighted) {
          ctx.strokeStyle = `rgba(${colorKey},0.95)`;
          ctx.lineWidth = 2;
          ctx.strokeRect(x0, yTop, x1 - x0, bandH);
        }

        // عنوان المنطقة (الملاحظة لليدوي، الدرجة للآلي)
        const label = isManual
          ? (z.note ? `تعليمك: ${z.note.slice(0, 20)}` : z.type)
          : `${z.type} آلي ${z.score}٪${z.swept ? ' مُسحوبة' : ''}`;
        ctx.font = '600 10px system-ui, sans-serif';
        ctx.textBaseline = 'bottom';
        ctx.textAlign = 'left';
        const tw = ctx.measureText(label).width;
        // شارة النص في يسار المنطقة
        ctx.fillStyle = `rgba(${colorKey},${highlighted ? 0.95 : 0.65})`;
        ctx.fillRect(x0 + 4, yTop - 13, tw + 10, 13);
        ctx.fillStyle = '#fff';
        ctx.fillText(label, x0 + 9, yTop - 1);
      }
    };

    draw();
    const chart = chartRef.current;
    let unsub: (() => void) | undefined;
    if (chart) {
      chart.timeScale().subscribeVisibleLogicalRangeChange(draw);
      unsub = () => chart.timeScale().unsubscribeVisibleLogicalRangeChange(draw);
    }
    const ro = new ResizeObserver(draw);
    if (containerRef.current) ro.observe(containerRef.current);
    return () => {
      unsub?.();
      ro.disconnect();
    };
  }, [zones, highlightId, containerRef, chartRef, getPriceCoord]);

  return canvasRef;
}
