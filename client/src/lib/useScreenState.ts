import { useEffect, useRef } from 'react';
import { useStore, type Screen, type ScreenState } from '../store/useStore';

/**
 * ربط حالة شاشة محلية بشريحة المخزن.
 *
 * السبب: حاضن الشاشات يهدم الشاشات المتجاوزة سقف الثلاثة، فتحتاج كل شاشة أن
 * تُصدّر فلاترها/رمزها/فريمها/تبويبها الداخلي إلى المخزن لتُستعاد عند إعادة الفتح.
 * الاستعادة تحدث مرة واحدة عند أول تحميل للمكوّن (لا عند كل تغيير).
 */
export interface ScreenStateBinding {
  filters?: Record<string, string>;
  symbol?: string;
  timeframe?: string;
  tab?: string;
  page?: number;
  /** يُنادى مرة واحدة عند التحميل ليطبّق الشاشة حالتها المحفوظة */
  onRestore?: (state: ScreenState) => void;
}

export function useScreenState(screen: Screen, binding: ScreenStateBinding) {
  const save = useStore(s => s.saveScreenState);
  const restored = useRef(false);
  const bindingRef = useRef(binding);
  bindingRef.current = binding;

  // استعادة مرة واحدة عند أول تحميل
  useEffect(() => {
    if (restored.current) return;
    restored.current = true;
    const saved = useStore.getState().getScreenState(screen);
    if (saved) bindingRef.current.onRestore?.(saved);
  }, [screen]);

  // حفظ عند كل تغيير في الحقول المرصودة
  const { filters, symbol, timeframe, tab, page } = binding;
  useEffect(() => {
    save(screen, { filters: filters ?? {}, symbol, timeframe, tab, page });
  }, [screen, save, filters, symbol, timeframe, tab, page]);
}
