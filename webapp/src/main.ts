import { startScan, type ScanWebApp } from './scan.js';

// The page's entry, loaded after telegram-web-app.js. Opened outside Telegram, the script and
// so `window.Telegram` may be missing, and the page only shows its fallback line.
declare global {
  interface Window {
    readonly Telegram?: { readonly WebApp?: ScanWebApp & { readonly ready?: () => void } };
  }
}

const webApp = window.Telegram?.WebApp;
webApp?.ready?.();

const status = document.getElementById('status');
startScan(webApp, window.location.hash, (line) => {
  if (status !== null) status.textContent = line;
});
