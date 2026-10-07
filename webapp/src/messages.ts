// Every string the Mini App page shows (ADR-0025): the page's own messages module, in Russian.
// A chart's titles, amounts and category names aren't here: they arrive formatted in its payload.
export const messages = {
  // The hint under Telegram's live QR scanner.
  scanPrompt: 'Наведите камеру на QR-код чека',
  // The scanner is open: the line behind it.
  scanning: 'Сканирую QR-код…',
  // Opened without a mode or a chart, e.g. from a browser.
  openFromBot:
    'Откройте эту страницу из бота: кнопкой «📷 Скан» в меню или «📈 Диаграмма» под отчётом.',
  // A client without the live scanner (Telegram Desktop and web).
  scanUnsupported:
    'Это приложение Telegram не умеет сканировать QR-коды. Откройте «📷 Скан» на телефоне или отправьте боту фото чека.',
  // A chart link whose data is damaged or from a version of the bot the page can't read.
  chartBroken:
    'Не получилось открыть диаграмму. Откройте отчёт /week или /month заново и нажмите «📈 Диаграмма».',
  // The page title in chart mode, shown in Telegram's header.
  chartTitle: 'Диаграмма',
  // Under the total in the donut's hole.
  chartTotalCaption: 'Всего',
  // One line under the donut: the chart answers taps.
  chartTapHint: 'Нажмите на категорию, чтобы увидеть подробности',
} as const;
