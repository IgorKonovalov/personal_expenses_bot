import { describe, expect, it } from 'vitest';
import { contrast, DARK, LIGHT, luminance, paletteFor } from './palette.js';

describe('the slice palettes', () => {
  it('computes WCAG luminance and contrast', () => {
    expect(luminance('#000000')).toBe(0);
    expect(luminance('#ffffff')).toBe(1);
    expect(contrast('#ffffff', '#000000')).toBe(21);
    expect(luminance('white')).toBe(undefined);
  });

  it.each([
    ['LIGHT', LIGHT, '#ffffff'],
    ['DARK', DARK, '#212d3b'],
  ])('keeps every %s colour at 3:1 or more against %s', (_name, palette, background) => {
    expect(palette).toHaveLength(8);
    for (const colour of palette) {
      expect(contrast(colour, background), colour).toBeGreaterThanOrEqual(3);
    }
  });

  it('has no colour twice within a palette', () => {
    for (const palette of [LIGHT, DARK]) {
      expect(new Set(palette.map((colour) => colour.toLowerCase())).size).toBe(palette.length);
    }
  });

  it('picks DARK below luminance 0.5 and LIGHT otherwise or without a theme', () => {
    expect(paletteFor('#000000')).toBe(DARK);
    expect(paletteFor('#212d3b')).toBe(DARK);
    expect(paletteFor('#ffffff')).toBe(LIGHT);
    expect(paletteFor(undefined)).toBe(LIGHT);
    expect(paletteFor('not a colour')).toBe(LIGHT);
  });
});
