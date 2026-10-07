// Every string the Mini App page shows (ADR-0025): the page's own messages module, in Russian.
export const messages = {
  // The hint under Telegram's live QR scanner.
  scanPrompt: 'Наведите камеру на QR-код чека',
  // The scanner is open: the line behind it.
  scanning: 'Сканирую QR-код…',
  // Opened without a mode, e.g. from a browser.
  openFromBot: 'Откройте эту страницу кнопкой «📷 Скан» в меню бота.',
  // A client without the live scanner (Telegram Desktop and web).
  scanUnsupported:
    'Это приложение Telegram не умеет сканировать QR-коды. Откройте «📷 Скан» на телефоне или отправьте боту фото чека.',
} as const;
