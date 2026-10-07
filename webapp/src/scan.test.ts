import { describe, expect, it, vi } from 'vitest';
import { messages } from './messages.js';
import { modeOf, startScan, type ScanWebApp } from './scan.js';

const RECEIPT = 'https://suf.purs.gov.rs/v/?vl=synthetic';

// A stub `Telegram.WebApp` whose scanner hands its callback to the test.
function stubWebApp() {
  let onText: ((text: string) => boolean | undefined) | undefined;
  const showScanQrPopup = vi.fn(
    (_params: { readonly text?: string }, callback: (text: string) => boolean | undefined) => {
      onText = callback;
    },
  );
  const closeScanQrPopup = vi.fn();
  const sendData = vi.fn();
  const webApp: ScanWebApp = { showScanQrPopup, closeScanQrPopup, sendData };
  const scanned = (text: string) => onText?.(text);
  return { webApp, showScanQrPopup, closeScanQrPopup, sendData, scanned };
}

describe('startScan', () => {
  it('opens the scanner once in scan mode, and sends the first text exactly, once', () => {
    const { webApp, showScanQrPopup, closeScanQrPopup, sendData, scanned } = stubWebApp();
    const show = vi.fn();

    startScan(webApp, '#m=scan', show);

    expect(showScanQrPopup).toHaveBeenCalledTimes(1);
    expect(showScanQrPopup.mock.calls[0]?.[0]).toEqual({ text: messages.scanPrompt });
    expect(sendData).not.toHaveBeenCalled();

    expect(scanned(RECEIPT)).toBe(true);
    expect(scanned('https://example.org/second-code')).toBe(true);

    expect(closeScanQrPopup).toHaveBeenCalledTimes(1);
    expect(sendData).toHaveBeenCalledTimes(1);
    expect(sendData).toHaveBeenCalledWith(RECEIPT);
    expect(showScanQrPopup).toHaveBeenCalledTimes(1);
    expect(show).toHaveBeenCalledWith(messages.scanning);
  });

  it('reads scan mode next to the launch parameters Telegram appends', () => {
    const { webApp, showScanQrPopup } = stubWebApp();

    startScan(webApp, '#m=scan&tgWebAppVersion=8.0&tgWebAppPlatform=android', vi.fn());

    expect(showScanQrPopup).toHaveBeenCalledTimes(1);
    expect(modeOf('#tgWebAppVersion=8.0&m=scan')).toBe('scan');
  });

  it('without #m=scan calls neither and shows the open-from-bot line', () => {
    const { webApp, showScanQrPopup, sendData } = stubWebApp();
    const show = vi.fn();

    startScan(webApp, '', show);
    startScan(webApp, '#tgWebAppVersion=8.0', show);

    expect(showScanQrPopup).not.toHaveBeenCalled();
    expect(sendData).not.toHaveBeenCalled();
    expect(show.mock.calls).toEqual([[messages.openFromBot], [messages.openFromBot]]);
  });

  it('with no showScanQrPopup calls neither and shows the unsupported line', () => {
    const sendData = vi.fn();
    const show = vi.fn();

    startScan({ sendData }, '#m=scan', show);
    startScan(undefined, '#m=scan', show);

    expect(sendData).not.toHaveBeenCalled();
    expect(show.mock.calls).toEqual([[messages.scanUnsupported], [messages.scanUnsupported]]);
  });

  it('treats a client below Bot API 6.4 as one without the scanner', () => {
    const { webApp, showScanQrPopup, sendData } = stubWebApp();
    const show = vi.fn();

    startScan({ ...webApp, isVersionAtLeast: () => false }, '#m=scan', show);

    expect(showScanQrPopup).not.toHaveBeenCalled();
    expect(sendData).not.toHaveBeenCalled();
    expect(show.mock.calls).toEqual([[messages.scanUnsupported]]);
  });
});
