import { useEffect, useRef } from 'react';
import type { LiquidityZone } from '../lib/types';
import type { IChartApi } from 'lightweight-charts';
import type { UTCTimestamp } from 'lightweight-charts';

export const BAND_COLORS = {
  BSL: { rgb: '242,54,69' },  // أحمر — سيولة بيعية فوق
  SSL: { rgb: '8,153,129' },  // أخضر — سيولة شرائية تحت
  MANUAL: { rgb: '59,130,246' } // أزرق — مناطق تعليم المستخدم
} as const;

/** أقوى N علامة آلية تُرسم على الشارت (البقية في القائمة الجانبية) */
export const MAX_AUTO_BANDS = 5;

/** نطاق المنطقة: السعر ± نصف عرضها (bandPct) */
export const zoneRange = (z: { price: number; bandPct?: number | null }) => {
  const half = (z.bandPct ?? 0.0015) / 2;
  return { low: z.price * (1 - half), high: z.price * (1 + half) };
};

/**
 * طبقة علامات المناطق فوق الشارت:
 * - الآلي: نقطة دائرية عند شمعة الاكتشاف نفسها (anchorTime) + عنوان الدرجة — بلا امتداد أفقي.
 *   إذا خرجت الشمعة من النطاق المرئي تُلتصق العلامة بحافة الشارت عند سعرها.
 * - اليدوي: منطقة زرقاء مظللة بعنوان الملاحظة (كما اعتمدت سابقاً).
 * highlightId: علامة مختارة تُرسم بحلقة بارزة (وميض) — يديره الأب عبر timeout.
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

      const drawLabel = (x: number, y: number, text: string, rgb: string, alpha: number, below: boolean) => {
        ctx.font = '600 10px system-ui, sans-serif';
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'left';
        const tw = ctx.measureText(text).width;
        const lx = Math.min(Math.max(x - (tw + 12) / 2, 4), w - tw - 16);
        const ly = below ? y + 10 : y - 10;
        ctx.fillStyle = `rgba(${rgb},${alpha})`;
        ctx.fillRect(lx, ly - 8, tw + 12, 16);
        ctx.fillStyle = '#fff';
        ctx.fillText(text, lx + 6, ly);
      };

      // ---- اليدوي: منطقة زرقاء مظللة بعرض الشارت (كما اعتمد المستخدم) ----
      for (const z of zonesRef.current.filter(z => z.source !== 'auto')) {
        const yTop = getPriceCoord(z.price * (1 + (z.bandPct ?? 0.003) / 2));
        const yBottom = getPriceCoord(z.price * (1 - (z.bandPct ?? 0.003) / 2));
        if (yTop == null || yBottom == null) continue;
        const bandH = Math.max(3, Math.abs(yBottom - yTop));
        const highlighted = highlightRef.current === z.id;
        const rgb = BAND_COLORS.MANUAL.rgb;
        ctx.fillStyle = `rgba(${rgb},${highlighted ? 0.5 : 0.26})`;
        ctx.fillRect(0, yTop, w, bandH);
        if (highlighted) {
          ctx.strokeStyle = `rgba(${rgb},0.95)`;
          ctx.lineWidth = 2;
          ctx.strokeRect(0, yTop, w, bandH);
        }
        const label = z.note ? `تعليمك: ${z.note.slice(0, 20)}` : z.type;
        drawLabel(60, yTop + bandH / 2, label, rgb, 0.8, false);
      }

      // ---- الآلي: أقوى 5 علامات نقطية عند شمعة الاكتشاف ----
      const auto = zonesRef.current
        .filter(z => z.source === 'auto')
        .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
        .slice(0, MAX_AUTO_BANDS);

      for (const z of auto) {
        const y = getPriceCoord(z.price);
        if (y == null || !Number.isFinite(y) || y < 0 || y > h) continue;
        const highlighted = highlightRef.current === z.id;
        const rgb = BAND_COLORS[z.type].rgb;
        const alpha = 0.55 + Math.min(1, (z.score ?? 50) / 100) * 0.4;

        // موضع شمعة الاكتشاف — خارج النطاق المرئي → التصق بحافة السعر (يمين=الأحدث)
        let x: number | null = z.anchorTime
          ? timeScale.timeToCoordinate(z.anchorTime as UTCTimestamp)
          : null;
        if (x == null || !Number.isFinite(x) || z.anchorTime == null) {
          const visRange = timeScale.getVisibleRange();
          const at = z.anchorTime ?? 0;
          const before = visRange ? at < Number(visRange.from) : false;
          x = before ? 14 : w - 14;
        } else {
          x = Math.min(Math.max(x, 14), w - 14);
        }

        // النقطة
        ctx.beginPath();
        ctx.arc(x, y, highlighted ? 7 : 5, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${rgb},${Math.min(0.95, alpha).toFixed(2)})`;
        ctx.fill();
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = 'rgba(255,255,255,0.9)';
        ctx.stroke();

        // حلقة الوميض للمنطقة المختارة
        if (highlighted) {
          ctx.beginPath();
          ctx.arc(x, y, 11, 0, Math.PI * 2);
          ctx.strokeStyle = `rgba(${rgb},0.95)`;
          ctx.lineWidth = 2.5;
          ctx.stroke();
        }

        // العلامة السهمية: مثلث صغير يشير للسعر من جهة النقطة
        const dir = z.type === 'BSL' ? 1 : -1; // BSL فوق → مثلث ينزل للسعر
        ctx.beginPath();
        ctx.moveTo(x, y + dir * 9);
        ctx.lineTo(x - 4, y + dir * 16);
        ctx.lineTo(x + 4, y + dir * 16);
        ctx.closePath();
        ctx.fillStyle = `rgba(${rgb},0.9)`;
        ctx.fill();

        drawLabel(x, y - dir * 20, `${z.type} ${z.score}٪${z.swept ? ' مُسحوبة' : ''}`, rgb, Math.min(0.9, alpha), z.type === 'SSL');
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
