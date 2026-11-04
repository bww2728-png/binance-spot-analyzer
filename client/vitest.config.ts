import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

/**
 * إعداد اختبارات مكوّنات العميل (vitest + jsdom).
 * منفصل عن vite.config.ts حتى لا يُحمَّل إضافة Tailwind في بيئة الاختبار،
 * وحتى لا يتأثر `tsc -b` (tsconfig.node يضمّ vite.config.ts وحده).
 * الاختبارات تُفحص أنواعياً ضمن tsconfig.app (include: ["src"]) لأنها تستورد من 'vitest'.
 */
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    globals: false,
    restoreMocks: true,
    testTimeout: 20_000
  }
});
