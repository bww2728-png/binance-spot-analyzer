import type { HistoryLayout } from '../../../../shared/historyModel.mjs';

/**
 * رسم أوليات النموذج على قماش الشارت.
 * لا منطق قرار هنا: كل ما يُرسم أتى من `layoutElements` المحسوب مسبقاً،
 * فلا يوجد أي إزاحة بصرية تقريبية أو إعادة حساب هندسة داخل حلقة الرسم.
 */

const dashFor = (dashed: boolean | 'dot') => {
  if (dashed === 'dot') return [2, 3];
  return dashed ? [5, 4] : [];
};

export function drawLayout(ctx: CanvasRenderingContext2D, layout: HistoryLayout): void {
  ctx.save();

  for (const r of layout.rects) {
    if (r.w <= 0 || r.h <= 0) continue;
    ctx.globalAlpha = 1;
    ctx.fillStyle = r.fill;
    ctx.fillRect(r.x, r.y, r.w, r.h);
    ctx.globalAlpha = Math.max(0, Math.min(1, r.strokeAlpha));
    ctx.strokeStyle = r.stroke;
    ctx.lineWidth = r.lineWidth;
    ctx.setLineDash(dashFor(r.dashed));
    ctx.strokeRect(r.x, r.y, r.w, r.h);
    ctx.setLineDash([]);
  }

  for (const s of layout.segments) {
    ctx.globalAlpha = Math.max(0, Math.min(1, s.alpha));
    ctx.strokeStyle = s.color;
    ctx.lineWidth = s.width;
    ctx.setLineDash(dashFor(s.dashed));
    ctx.beginPath();
    ctx.moveTo(s.x1, s.y1);
    ctx.lineTo(s.x2, s.y2);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  for (const m of layout.markers) {
    ctx.globalAlpha = Math.max(0, Math.min(1, m.alpha));
    ctx.fillStyle = m.color;
    ctx.strokeStyle = m.color;
    const s = m.size;
    switch (m.shape) {
      case 'triangle_up':
        ctx.beginPath();
        ctx.moveTo(m.x, m.y - s);
        ctx.lineTo(m.x - s, m.y + s * 0.9);
        ctx.lineTo(m.x + s, m.y + s * 0.9);
        ctx.closePath();
        ctx.fill();
        break;
      case 'triangle_down':
        ctx.beginPath();
        ctx.moveTo(m.x, m.y + s);
        ctx.lineTo(m.x - s, m.y - s * 0.9);
        ctx.lineTo(m.x + s, m.y - s * 0.9);
        ctx.closePath();
        ctx.fill();
        break;
      case 'cross':
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.moveTo(m.x - s, m.y - s);
        ctx.lineTo(m.x + s, m.y + s);
        ctx.moveTo(m.x + s, m.y - s);
        ctx.lineTo(m.x - s, m.y + s);
        ctx.stroke();
        break;
      case 'diamond':
        ctx.beginPath();
        ctx.moveTo(m.x, m.y - s);
        ctx.lineTo(m.x + s, m.y);
        ctx.lineTo(m.x, m.y + s);
        ctx.lineTo(m.x - s, m.y);
        ctx.closePath();
        ctx.fill();
        break;
      default:
        ctx.beginPath();
        ctx.arc(m.x, m.y, s, 0, Math.PI * 2);
        ctx.fill();
        break;
    }
  }

  ctx.globalAlpha = 1;
  ctx.font = '10px system-ui, sans-serif';
  ctx.textBaseline = 'alphabetic';
  for (const l of layout.labels) {
    ctx.textAlign = l.align === 'right' ? 'right' : 'left';
    // ظل خفيف يجعل النص مقروءاً فوق الشموع بلا صندوق يحجبها
    ctx.fillStyle = 'rgba(8,12,20,0.72)';
    ctx.fillText(l.text, l.x + 0.8, l.y + 0.8);
    ctx.fillStyle = l.color;
    ctx.fillText(l.text, l.x, l.y);
  }
  ctx.restore();
}

/** رسم إبراز العنصر المحدد/الممرَّر عليه فوق القماش (طبقة منفصلة، بلا مساس بالشارت) */
export function drawHighlight(ctx: CanvasRenderingContext2D, layout: HistoryLayout, id: string, color: string): void {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.globalAlpha = 0.9;
  ctx.lineWidth = 2;
  ctx.setLineDash([3, 2]);
  for (const r of layout.rects) {
    if (r.id !== id) continue;
    ctx.strokeRect(r.x - 1, r.y - 1, r.w + 2, r.h + 2);
  }
  for (const s of layout.segments) {
    if (s.id !== id) continue;
    ctx.beginPath();
    ctx.moveTo(s.x1, s.y1);
    ctx.lineTo(s.x2, s.y2);
    ctx.stroke();
  }
  for (const m of layout.markers) {
    if (m.id !== id) continue;
    ctx.beginPath();
    ctx.arc(m.x, m.y, 6, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}
