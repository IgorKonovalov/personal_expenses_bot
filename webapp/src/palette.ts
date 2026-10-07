// Categorical slice colours, in line order, one palette per theme brightness. Each colour keeps
// at least 3:1 WCAG contrast against its background: white for LIGHT, and for DARK `#212d3b`,
// the lightest dark background among Telegram's default themes (palette.test.ts checks both).
export const LIGHT: readonly string[] = [
  '#1f77b4',
  '#d35f00',
  '#2ca02c',
  '#d62728',
  '#9467bd',
  '#8c564b',
  '#c2378f',
  '#00838f',
];

export const DARK: readonly string[] = [
  '#5aa9e6',
  '#f28e2b',
  '#ff6b6b',
  '#59c36a',
  '#c39bd3',
  '#edc948',
  '#ff9da7',
  '#76b7b2',
];

// The palette for a page background: DARK when its relative luminance is below 0.5, LIGHT for
// a light background or one that isn't `#rrggbb` (outside Telegram there is none).
export function paletteFor(bg: string | undefined): readonly string[] {
  const l = bg === undefined ? undefined : luminance(bg);
  return l !== undefined && l < 0.5 ? DARK : LIGHT;
}

// WCAG 2 relative luminance of a `#rrggbb` colour, from 0 (black) to 1 (white); undefined for
// anything else.
export function luminance(hex: string): number | undefined {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (match === null) return undefined;
  const [r, g, b] = match.slice(1).map((part) => {
    const c = parseInt(part, 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
}

// WCAG 2 contrast ratio of two `#rrggbb` colours, from 1 to 21; undefined if either isn't one.
export function contrast(a: string, b: string): number | undefined {
  const la = luminance(a);
  const lb = luminance(b);
  if (la === undefined || lb === undefined) return undefined;
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
