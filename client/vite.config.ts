import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// process موجود وقت تشغيل Vite (Node) لكن أنواعه غير مثبتة في العميل — نقرأ البيئة دون معرّف process لتجاوز tsc بلا اعتماد جديد
const nodeEnv = (globalThis as unknown as { process?: { env?: Record<string, string | undefined> } }).process?.env;

// مضيف HMR يُقرأ من البيئة فقط — بلا قيمة مدمجة لمضيف معاينة من جلسة سابقة.
// عند غيابه يُستنتج المضيف تلقائياً من الطلب (سلوك Vite الافتراضي).
const hmrHost = nodeEnv?.VERDENT_HMR_HOST;
const apiProxyTarget = nodeEnv?.VITE_API_PROXY_TARGET || 'http://localhost:8787';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: '0.0.0.0',
    allowedHosts: true,
    ...(hmrHost ? { hmr: { host: hmrHost, protocol: 'wss', clientPort: 443 } } : {}),
    proxy: {
      '/api': apiProxyTarget,
      '/ws': { target: apiProxyTarget, ws: true }
    }
  },
  build: {
    rollupOptions: {
      output: {
        // تقسيم الحزمة: مكتبات الأساس منفصلة عن الشاشات الثقيلة (شارت/سيولة/استراتيجية)
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (id.includes('lightweight-charts')) return 'vendor-charts';
          if (id.includes('@supabase')) return 'vendor-supabase';
          if (id.includes('react-dom') || id.includes('/react/') || id.includes('scheduler')) return 'vendor-react';
          if (id.includes('zustand')) return 'vendor-state';
          return 'vendor';
        }
      }
    }
  }
});
