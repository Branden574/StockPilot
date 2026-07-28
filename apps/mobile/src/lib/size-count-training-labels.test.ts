import { describe, expect, it } from 'vitest';

import { APPAREL_TRAINING_LABELS, SHOE_TRAINING_LABELS } from '@stockpilot/core';

import {
  DEFAULT_TRAINING_LABEL_SET_KEY,
  buildTrainingFilters,
  nextTrainingLabelSetKey,
  resolveTrainingLabelSet,
} from './size-count-training-labels';

describe('the default set — an existing capturer sees no change', () => {
  it('defaults to apparel, the vocabulary the screen has always shown', () => {
    expect(DEFAULT_TRAINING_LABEL_SET_KEY).toBe('apparel');
  });

  it('resolves the default to exactly the nine letters, in order', () => {
    expect(resolveTrainingLabelSet(DEFAULT_TRAINING_LABEL_SET_KEY).labels).toEqual([
      ...APPAREL_TRAINING_LABELS,
    ]);
  });
});

describe('resolveTrainingLabelSet', () => {
  it('resolves shoes to the numeric run, halves included', () => {
    const set = resolveTrainingLabelSet('shoes');
    expect(set.name).toBe('Shoes');
    expect(set.labels).toEqual([...SHOE_TRAINING_LABELS]);
    expect(set.labels).toContain('9.5');
  });

  it('falls back to the default rather than rendering an empty chip row', () => {
    // A key could be stale (persisted from an older build) or simply wrong. An
    // empty row would leave the shutter with nothing to tap and no way back.
    expect(resolveTrainingLabelSet('nonsense' as never).key).toBe('apparel');
    expect(resolveTrainingLabelSet(undefined as never).labels.length).toBeGreaterThan(0);
  });
});

describe('nextTrainingLabelSetKey — the toggle', () => {
  it('cycles apparel to shoes and back, so the toggle can never dead-end', () => {
    expect(nextTrainingLabelSetKey('apparel')).toBe('shoes');
    expect(nextTrainingLabelSetKey('shoes')).toBe('apparel');
  });

  it('returns to the start from an unknown key', () => {
    expect(nextTrainingLabelSetKey('nonsense' as never)).toBe('apparel');
  });

  it('visits every set before repeating', () => {
    const seen = new Set<string>();
    let k = DEFAULT_TRAINING_LABEL_SET_KEY;
    for (let i = 0; i < 10 && !seen.has(k); i++) {
      seen.add(k);
      k = nextTrainingLabelSetKey(k);
    }
    expect(seen).toEqual(new Set(['apparel', 'shoes']));
    expect(k).toBe(DEFAULT_TRAINING_LABEL_SET_KEY);
  });
});

describe('buildTrainingFilters — the review row', () => {
  const filters = buildTrainingFilters();

  it('leads with ALL', () => {
    expect(filters[0]).toBe('ALL');
  });

  it('reaches numeric captures — the whole point of the row not being hand-listed', () => {
    expect(filters).toContain('9.5');
    expect(filters).toContain('10');
  });

  it('still offers every apparel letter and the hard negative', () => {
    for (const l of APPAREL_TRAINING_LABELS) expect(filters).toContain(l);
    expect(filters).toContain('NONE');
  });

  it('repeats nothing — a duplicated chip would be two ways to run one query', () => {
    expect(new Set(filters).size).toBe(filters.length);
  });
});
