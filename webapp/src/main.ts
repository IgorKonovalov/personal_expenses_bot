import { startChart, type ChartWebApp } from './pie.js';
import { modeOf, startScan, type ScanWebApp } from './scan.js';

// The page's entry, loaded after telegram-web-app.js. Opened outside Telegram, the script and
// so `window.Telegram` may be missing: the page then draws in its default colours, or only shows
// its fallback line. `#m=scan` is scan mode; anything else is chart mode, which reads `z` or `d`
// and draws once it is decoded.
declare global {
  interface Window {
    readonly Telegram?: {
      readonly WebApp?: ScanWebApp & ChartWebApp & { readonly ready?: () => void };
    };
  }
}

const webApp = window.Telegram?.WebApp;
webApp?.ready?.();

const hash = window.location.hash;
const status = document.getElementById('status');
if (modeOf(hash) === 'scan') {
  startScan(webApp, hash, (line) => {
    if (status !== null) status.textContent = line;
  });
} else {
  void startChart<HTMLElement | SVGElement>(document, document.body, hash, webApp);
}
