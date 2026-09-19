/** التقاط صورة PNG حقيقية من حاوية شارت lightweights للقرار الحالي.
 * يبحث عن لوحة canvas داخل الحاوية، يكبّسها إلى عرض أقصى، ويعيد data: URL.
 * يعيد null عند أي فشل — التقاط الصورة ترفيهي ولا يجب أن يكسر القرار.
 */
export function captureChartPng(container: HTMLElement | null | undefined): string | null {
  try {
    const canvas = container?.querySelector('canvas');
    if (!canvas) return null;
    // تثنية الرسم بعد تغيير الحجم — يضمن حصولنا على الحالة المعروضة فعلياً
    const scale = Math.min(1, 1200 / canvas.width);
    const out = document.createElement('canvas');
    out.width = Math.max(1, Math.round(canvas.width * scale));
    out.height = Math.max(1, Math.round(canvas.height * scale));
    const ctx = out.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(canvas, 0, 0, out.width, out.height);
    const url = out.toDataURL('image/png');
    return url.length && url.length < 1_000_000 ? url : null;
  } catch {
    return null;
  }
}

/** يلتقط كل الفريمات المفتوحة القابلة للوصول في القرار. */
export function captureChartPngs(containers: (HTMLElement | null | undefined)[]): { tf: string; dataUrl: string }[] {
  const out: { tf: string; dataUrl: string }[] = [];
  for (let i = 0; i < containers.length; i++) {
    const url = captureChartPng(containers[i]);
    if (url) out.push({ tf: String(i), dataUrl: url });
  }
  return out;
}