import React from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App';
import { useStore } from './store/useStore';
import { startEngine } from './lib/engine';

// تخفيف خطأ حميد من lightweight-charts (حتى 5.2.1): rAF داخلي مجدول قبل remove يُرمي "Object is disposed"
// بعد التفكيك في التناوب السريع. نسقط هذا الخطأ فقط — أي خطأ آخر يُبلغ طبيعياً.
window.addEventListener('error', (e) => {
  if (e.message === 'Object is disposed') e.preventDefault();
});

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

void useStore.getState().init().then(() => {
  startEngine();
}).catch((e) => {
  useStore.getState().pushToast(`فشل الاتصال بالخادم المحلي: ${String(e)}`, 'alert');
});
