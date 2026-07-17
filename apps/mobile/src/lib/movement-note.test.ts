import { describe, expect, it } from 'vitest';

import {
  MOVEMENT_NOTE_MAX,
  applyNoteToMovements,
  normalizeMovementNote,
} from './movement-note';

describe('normalizeMovementNote', () => {
  it('trims surrounding whitespace', () => {
    expect(normalizeMovementNote('  fixed note  ')).toBe('fixed note');
  });

  it('collapses empty / whitespace-only input to null (mirrors nullif(btrim))', () => {
    expect(normalizeMovementNote('')).toBeNull();
    expect(normalizeMovementNote('   ')).toBeNull();
  });

  it('treats null / undefined as null', () => {
    expect(normalizeMovementNote(null)).toBeNull();
    expect(normalizeMovementNote(undefined)).toBeNull();
  });

  it('caps at 2000 chars to match the server + route guard', () => {
    expect(MOVEMENT_NOTE_MAX).toBe(2000);
  });
});

describe('applyNoteToMovements', () => {
  const rows = [
    { id: 'm-1', notes: 'old' as string | null, extra: 1 },
    { id: 'm-2', notes: null as string | null, extra: 2 },
  ];

  it('replaces notes on the matching row only', () => {
    const next = applyNoteToMovements(rows, 'm-2', 'added');
    expect(next.find((r) => r.id === 'm-2')?.notes).toBe('added');
    expect(next.find((r) => r.id === 'm-1')?.notes).toBe('old');
  });

  it('can clear a note by passing null', () => {
    const next = applyNoteToMovements(rows, 'm-1', null);
    expect(next.find((r) => r.id === 'm-1')?.notes).toBeNull();
  });

  it('returns a NEW array and preserves other fields', () => {
    const next = applyNoteToMovements(rows, 'm-1', 'x');
    expect(next).not.toBe(rows);
    expect(next.find((r) => r.id === 'm-1')?.extra).toBe(1);
  });

  it('returns unmatched rows by reference (no needless churn)', () => {
    const next = applyNoteToMovements(rows, 'm-1', 'x');
    expect(next[1]).toBe(rows[1]);
  });

  it('is a no-op mapping when the id is absent', () => {
    const next = applyNoteToMovements(rows, 'missing', 'x');
    expect(next.map((r) => r.notes)).toEqual(['old', null]);
  });
});
