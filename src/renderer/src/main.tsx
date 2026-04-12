import React from 'react';
import ReactDOM from 'react-dom/client';

// Catch module-level import errors that crash before React mounts
async function boot() {
  try {
    const { default: App } = await import('./App');
    ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
      <React.StrictMode>
        <App />
      </React.StrictMode>,
    );
  } catch (err: any) {
    console.error('[FATAL] App failed to load:', err);
    const root = document.getElementById('root');
    if (root) {
      root.style.cssText =
        'padding:24px;color:#f87171;background:#0f0f0f;font-family:monospace;font-size:13px';
      root.innerHTML = `<div style="font-size:16px;font-weight:700;margin-bottom:12px">Fatal Import Error</div>
        <div style="margin-bottom:8px">${err.message}</div>
        <pre style="color:#888;white-space:pre-wrap;font-size:11px">${err.stack || ''}</pre>`;
    }
  }
}
boot();
