// What every widget program shares (ADR-0053). scripts/build-widgets.ts inlines this file ahead of
// each program in one script, with imports and exports stripped, so a helper no program uses
// still costs bytes of the 4096-byte budget: keep it small.

// The part of Telegram's `window.TelegramWidget` the programs use
// (https://core.telegram.org/bots/widgets). It is undefined outside Telegram.
export interface TelegramWidget {
  readonly chatData: string | null;
  readonly themeParams: Readonly<Record<string, string | undefined>>;
  request(data: string): Promise<{ readonly result: string | null }>;
  onEvent(type: 'chatDataChanged' | 'themeChanged', handler: () => void): void;
  ready(): void;
}

declare global {
  interface Window {
    TelegramWidget?: TelegramWidget;
  }
}

export const W = window.TelegramWidget;

// The glyph a program shows for a chatData version it doesn't know: the bot is newer than the
// message, which a fresh tap of the chart button replaces.
export const UNKNOWN = '⟳';

// The chat state as a positional array whose first element is the version `v`; undefined for
// anything else.
export function state(v: number): readonly unknown[] | undefined {
  try {
    const parsed: unknown = JSON.parse(W?.chatData ?? '');
    return Array.isArray(parsed) && parsed[0] === v ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function el(tag: string, cls = '', text = ''): HTMLElement {
  const node = document.createElement(tag);
  if (cls !== '') node.className = cls;
  if (text !== '') node.textContent = text;
  return node;
}

// Escapes text for an SVG string.
export function esc(text: string): string {
  return text.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
}

// `n` fills from the theme: the button colour stepped toward the bubble's background. The steps
// mute the colour itself, never `opacity`, which the client caps.
export function palette(n: number): string[] {
  const rgb = (hex: string | undefined, fallback: number[]) =>
    hex !== undefined && /^#[0-9a-f]{6}$/i.test(hex)
      ? [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
      : fallback;
  const theme = W?.themeParams ?? {};
  const a = rgb(theme['button_color'], [51, 144, 236]);
  const b = rgb(theme['bg_color'], [255, 255, 255]);
  return Array.from({ length: n }, (_, i) => {
    const t = (i / Math.max(n, 2)) * 0.8;
    return `rgb(${a.map((c, k) => Math.round(c + ((b[k] ?? c) - c) * t)).join(',')})`;
  });
}

// The page's frame: the base style, then the program's own, and a fresh root to draw into.
export function frame(css: string): HTMLElement {
  const style = el('style');
  style.textContent =
    'body{margin:0;font:13px/1.35 system-ui,sans-serif;color:var(--tg-theme-text-color)}' +
    '#r{box-sizing:border-box;height:380px;padding:10px 12px 26px;display:flex;flex-direction:column}' +
    '.h{color:var(--tg-theme-hint-color)}.t{font-weight:600;margin-bottom:6px}' +
    '.e{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
    css;
  const root = el('div');
  root.id = 'r';
  document.body.append(style, root);
  return root;
}
