import { messages } from './messages.js';

// The slice of `Telegram.WebApp` the scan uses. The scanner methods are absent or refused on
// clients without a camera scanner (Telegram Desktop and web).
export interface ScanWebApp {
  readonly showScanQrPopup?: (
    params: { readonly text?: string },
    callback: (text: string) => boolean | undefined,
  ) => void;
  readonly closeScanQrPopup?: () => void;
  readonly sendData: (data: string) => void;
  readonly isVersionAtLeast?: (version: string) => boolean;
}

// The Bot API version that added showScanQrPopup.
const SCANNER_VERSION = '6.4';

// The page's mode from the URL fragment. Telegram appends its own launch parameters
// (`tgWebAppData` and others) to the fragment, so `m` is read as one key among them.
export function modeOf(hash: string): string | undefined {
  return new URLSearchParams(hash.replace(/^#/, '')).get('m') ?? undefined;
}

// Scan mode (`#m=scan`): opens Telegram's live QR scanner, and the first text it reads goes back
// to the bot verbatim through sendData, which also closes the page. Later codes the scanner
// reports are dropped. Without scan mode or a scanner, `show` gets the line to display and
// nothing is sent.
export function startScan(
  webApp: ScanWebApp | undefined,
  hash: string,
  show: (line: string) => void,
): void {
  if (modeOf(hash) !== 'scan') {
    show(messages.openFromBot);
    return;
  }
  if (
    webApp?.showScanQrPopup === undefined ||
    webApp.isVersionAtLeast?.(SCANNER_VERSION) === false
  ) {
    show(messages.scanUnsupported);
    return;
  }
  let sent = false;
  show(messages.scanning);
  try {
    webApp.showScanQrPopup({ text: messages.scanPrompt }, (text) => {
      if (sent) return true;
      sent = true;
      webApp.closeScanQrPopup?.();
      webApp.sendData(text);
      // Closes the popup on clients where closeScanQrPopup is missing.
      return true;
    });
  } catch {
    // telegram-web-app.js throws for a method the client's version doesn't support.
    show(messages.scanUnsupported);
  }
}
