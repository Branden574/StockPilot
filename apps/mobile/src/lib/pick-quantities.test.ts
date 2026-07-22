import { describe, expect, it } from 'vitest';

import { mergePickQuantities, seedSavedQuantities, type PickLineLike } from './pick-quantities';

function line(id: string, picked: number | null = null): PickLineLike {
  return { id, quantity_picked: picked };
}

describe('mergePickQuantities', () => {
  it('keeps typed-but-unsaved quantities when refreshing after an add', () => {
    // The defect this replaces: the order screen remounted DigitalPick with a
    // changing `key` after items were added, so a picker who had typed 3 and 5
    // without saving lost both — and "Complete picking" then saw no dirty lines
    // and shipped those lines at zero.
    const typed = { 'line-a': '3', 'line-b': '5' };
    const merged = mergePickQuantities(typed, [line('line-a'), line('line-b'), line('line-c')], true);

    expect(merged['line-a']).toBe('3');
    expect(merged['line-b']).toBe('5');
    // The newly added line is the only one seeded from the server.
    expect(merged['line-c']).toBe('0');
  });

  it('seeds a newly added line from its persisted quantity, not from zero', () => {
    const merged = mergePickQuantities({ 'line-a': '3' }, [line('line-a'), line('line-d', 7)], true);
    expect(merged['line-d']).toBe('7');
  });

  it('drops a line that is no longer on the order', () => {
    const merged = mergePickQuantities({ 'line-a': '3', 'gone': '9' }, [line('line-a')], true);
    expect(Object.keys(merged)).toEqual(['line-a']);
  });

  it('re-seeds everything from the server on a first load', () => {
    // preserveTyped=false is the mount path: there is nothing to protect, and
    // the server is the only truth.
    const merged = mergePickQuantities({ 'line-a': '3' }, [line('line-a', 2)], false);
    expect(merged['line-a']).toBe('2');
  });
});

describe('seedSavedQuantities', () => {
  it('treats an unsaved line as 0 so isDirty compares against the real baseline', () => {
    expect(seedSavedQuantities([line('line-a'), line('line-b', 4)])).toEqual({
      'line-a': 0,
      'line-b': 4,
    });
  });
});
