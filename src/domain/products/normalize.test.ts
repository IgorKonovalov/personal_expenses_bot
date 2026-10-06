import { describe, expect, it } from 'vitest';
import { normalize } from './normalize.js';

describe('normalize', () => {
  it('lower-cases, folds diacritics and collapses whitespace', () => {
    expect(normalize('ČOKOLADNO  MLEKO 0,2L')).toBe('cokoladno mleko 0,2l');
  });

  it('transliterates Serbian Cyrillic to Latin', () => {
    expect(normalize('МЛЕКО 1Л')).toBe('mleko 1l');
    expect(normalize('ЏЕМ ЉУБИЧИЦА ЊОКЕ ЂУС ЋЕВАП')).toBe('dzem ljubicica njoke djus cevap');
  });

  it('folds đ to dj and trims the ends', () => {
    expect(normalize('  Pirinač  ĐUVEČ\t ')).toBe('pirinac djuvec');
  });
});
