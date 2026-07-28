import { describe, expect, it } from 'vitest';

import {
  APPAREL_TRAINING_LABELS,
  SHOE_TRAINING_LABELS,
  TRAINING_LABEL_SETS,
  TRAINING_NEGATIVE_LABEL,
  TRAINING_SIZE_LABEL_PATTERN,
  isTrainingSizeLabel,
  normalizeTrainingSizeLabel,
} from './size-count-labels';
import { compareSizeValues } from './size-order';

describe('apparel labels — the set that shipped stays exactly as it was', () => {
  it('is the nine letters the capture screen has always offered, in wearing order', () => {
    expect(APPAREL_TRAINING_LABELS).toEqual([
      'XS', 'S', 'M', 'L', 'XL', 'XXL', 'XXXL', 'XXXXL', 'XXXXXL',
    ]);
  });

  it('every one of them still validates — no existing capture becomes illegal', () => {
    for (const l of APPAREL_TRAINING_LABELS) expect(isTrainingSizeLabel(l)).toBe(true);
  });

  it('accepts the NONE hard negative', () => {
    expect(isTrainingSizeLabel(TRAINING_NEGATIVE_LABEL)).toBe(true);
    expect(TRAINING_NEGATIVE_LABEL).toBe('NONE');
  });

  it('still refuses the 6XL spelling 0284 refused (the pgTAP case)', () => {
    expect(isTrainingSizeLabel('XXXXXXL')).toBe(false);
  });
});

describe('shoe labels — numeric with half sizes', () => {
  it('spans the seeded US scales: 1 through 18 in half steps', () => {
    expect(SHOE_TRAINING_LABELS[0]).toBe('1');
    expect(SHOE_TRAINING_LABELS.at(-1)).toBe('18');
    // 1 .. 18 inclusive in half steps = 35 labels.
    expect(SHOE_TRAINING_LABELS).toHaveLength(35);
  });

  it('prints whole sizes bare and halves with .5 — never "9." or "9.0"', () => {
    expect(SHOE_TRAINING_LABELS).toContain('9');
    expect(SHOE_TRAINING_LABELS).toContain('9.5');
    expect(SHOE_TRAINING_LABELS).not.toContain('9.');
    expect(SHOE_TRAINING_LABELS).not.toContain('9.0');
  });

  it('every generated label validates', () => {
    for (const l of SHOE_TRAINING_LABELS) expect(isTrainingSizeLabel(l)).toBe(true);
  });

  it('is already in numeric order, and the core size-run sort agrees', () => {
    const shuffled = [...SHOE_TRAINING_LABELS].sort(() => 0);
    const sorted = [...shuffled].sort((a, b) => compareSizeValues(a, b));
    expect(sorted).toEqual([...SHOE_TRAINING_LABELS]);
  });

  it('sorts 9.5 between 9 and 10 — not as a string', () => {
    const sorted = ['10', '9', '9.5'].sort((a, b) => compareSizeValues(a, b));
    expect(sorted).toEqual(['9', '9.5', '10']);
  });
});

describe('validation — the format the DB CHECK also enforces', () => {
  it.each(['1', '1.5', '9', '9.5', '10', '10.5', '18', '19.5', '20'])(
    'accepts the numeric label %s',
    (l) => expect(isTrainingSizeLabel(l)).toBe(true),
  );

  it.each(['9.55', '9.', '.5', 'abc', '', '   ', '0', '21', '20.5', '-9', '9,5', '1e1'])(
    'refuses the garbage label %j',
    (l) => expect(isTrainingSizeLabel(l)).toBe(false),
  );

  it('refuses null and undefined', () => {
    expect(isTrainingSizeLabel(null)).toBe(false);
    expect(isTrainingSizeLabel(undefined)).toBe(false);
  });

  it('the pattern is anchored — it cannot match a substring', () => {
    expect(TRAINING_SIZE_LABEL_PATTERN.test('size 9')).toBe(false);
    expect(TRAINING_SIZE_LABEL_PATTERN.test('9 wide')).toBe(false);
  });
});

describe('normalization — one canonical form before it is stored', () => {
  it('trims and upper-cases alpha', () => {
    expect(normalizeTrainingSizeLabel('  xl ')).toBe('XL');
    expect(normalizeTrainingSizeLabel('none')).toBe('NONE');
  });

  it('canonicalises numerics the way the size scales print them', () => {
    expect(normalizeTrainingSizeLabel('9.0')).toBe('9');
    expect(normalizeTrainingSizeLabel('09')).toBe('9');
    expect(normalizeTrainingSizeLabel(' 9.5 ')).toBe('9.5');
    expect(normalizeTrainingSizeLabel('9.50')).toBe('9.5');
  });

  it('returns null for anything that is not a legal label', () => {
    expect(normalizeTrainingSizeLabel('9.55')).toBeNull();
    expect(normalizeTrainingSizeLabel('abc')).toBeNull();
    expect(normalizeTrainingSizeLabel('')).toBeNull();
    expect(normalizeTrainingSizeLabel(null)).toBeNull();
  });
});

describe('label sets — what the capture screen toggles between', () => {
  it('offers apparel first so the screen keeps its previous default', () => {
    expect(TRAINING_LABEL_SETS[0]?.key).toBe('apparel');
    expect(TRAINING_LABEL_SETS[0]?.labels).toEqual([...APPAREL_TRAINING_LABELS]);
  });

  it('offers shoes second', () => {
    expect(TRAINING_LABEL_SETS[1]?.key).toBe('shoes');
    expect(TRAINING_LABEL_SETS[1]?.labels).toEqual([...SHOE_TRAINING_LABELS]);
  });

  it('every label in every set is valid, and no set repeats a label', () => {
    for (const set of TRAINING_LABEL_SETS) {
      expect(new Set(set.labels).size).toBe(set.labels.length);
      for (const l of set.labels) expect(isTrainingSizeLabel(l)).toBe(true);
    }
  });
});
