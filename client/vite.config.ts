import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: '0.0.0.0',
    allowedHosts: true,
    hmr: {
      host: '9cd43386-5173-20-base.preview.verdent.ai',
      protocol: 'wss',
      clientPort: 443
    },
    proxy: {
      '/api': 'http://localhost:8787'
    }
  }
});
