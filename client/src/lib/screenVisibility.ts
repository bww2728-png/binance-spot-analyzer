import { createContext, useContext } from 'react';

/**
 * رؤية الشاشة داخل حاضن الشاشات (`ScreensHost`).
 *
 * السبب: الحاضن **يخفي** الشاشات غير النشطة بـ`display: none` ولا يهدمها (لتبقى
 * حالتها)، فتبقى `setInterval` الخاصة بها تعمل وتطلب من الخادم بلا فائدة — والقياس
 * كان تسعة استقصاءات متفرقة بلا وعي بالإخفاء. هذا السياق يجعل كل خطّاف استقصاء
 * يعرف أن شاشته مخفية فيتوقف، بلا تغيير في أي شاشة (الخطّاف يقرأ السياق بنفسه).
 *
 * القيمة الافتراضية `true` مقصودة: أي مستهلك خارج الحاضن (مثل شارة الرأس في App)
 * يُعتبر مرئياً.
 */
export const ScreenVisibilityContext = createContext(true);

/** هل الشاشة الحالية محتواها مرئي فعلاً؟ */
export function useScreenVisible(): boolean {
  return useContext(ScreenVisibilityContext);
}
