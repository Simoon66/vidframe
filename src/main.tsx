// Ensure window.fetch is writable and configurable across all browser/iframe contexts
if (typeof window !== 'undefined') {
  try {
    let _fetch = window.fetch;
    const prop = {
      get() {
        return _fetch;
      },
      set(val: typeof fetch) {
        _fetch = val;
      },
      configurable: true,
      enumerable: true,
    };
    try {
      Object.defineProperty(window, 'fetch', prop);
    } catch {}
    try {
      if (typeof Window !== 'undefined' && Window.prototype) {
        Object.defineProperty(Window.prototype, 'fetch', prop);
      }
    } catch {}
    try {
      if (typeof globalThis !== 'undefined' && globalThis !== window) {
        Object.defineProperty(globalThis, 'fetch', prop);
      }
    } catch {}
  } catch {}
}

import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import './index.css';

createRoot(document.getElementById('root')!).render(<App />);
