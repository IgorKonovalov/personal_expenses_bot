import { showChart } from './pie.js';
import { modeOf, startScan, type ScanWebApp } from './scan.js';

// The page's entry, loaded after telegram-web-app.js. Opened outside Telegram, the script and
// so `window.Telegram` may be missing: the page then draws in its default colours, or only shows
// its fallback line. `#m=scan` is scan mode; anything else is chart mode, which reads `d`.
declare global {
  interface Window {
    readonly Telegram?: {
      readonly WebApp?: ScanWebApp & {
        readonly ready?: () => void;
        readonly themeParams?: {
          readonly bg_color?: string;
          readonly text_color?: string;
          readonly hint_color?: string;
        };
      };
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
  const theme = webApp?.themeParams;
  // CSSOM writes, which the CSP's missing style-src doesn't block (index.html).
  if (theme?.bg_color !== undefined) document.body.style.backgroundColor = theme.bg_color;
  if (theme?.text_color !== undefined) document.body.style.color = theme.text_color;
  showChart<Element>(document, document.body, hash, {
    bg: theme?.bg_color,
    hint: theme?.hint_color,
  });
}
