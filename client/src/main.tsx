import React from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App';
import { useStore } from './store/useStore';
import { startEngine } from './lib/engine';

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
