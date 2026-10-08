import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// process موجود وقت تشغيل Vite (Node) لكن أنواعه غير مثبتة في العميل — نقرأ البيئة دون معرّف process لتجاوز tsc بلا اعتماد جديد
const nodeEnv = (globalThis as unknown as { process?: { env?: Record<string, string | undefined> } }).process?.env;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: '0.0.0.0',
    allowedHosts: true,
    // مضيف المعاينة يُقرأ من البيئة (VERDENT_HMR_HOST) — القيمة المدمجة احتياط تطوير فقط ولا تمس بناء الإنتاج
    hmr: {
      host: nodeEnv?.VERDENT_HMR_HOST || '9cd43386-5173-20-base.preview.verdent.ai',
      protocol: 'wss',
      clientPort: 443
    },
    proxy: {
      '/api': 'http://localhost:8787'
    }
  }
});
