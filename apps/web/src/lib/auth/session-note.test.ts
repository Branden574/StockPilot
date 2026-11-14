import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => undefined) }));

import {
  ACCOUNT_NOTE_LIMIT,
  ACCOUNT_NOTE_WINDOW_MS,
  admitUncountedNote,
  resetUncountedNoteReportForTests,
  SESSION_NOTE_WINDOW_MS,
  UNCOUNTED_NOTES_REMEMBERED,
} from './session-note';

/**
 * The phone's sign-in note while the limiter cannot answer: this instance
 * bounds the rows itself. A session's note is written once, for a day; an
 * account gets ACCOUNT_NOTE_LIMIT rows an hour; each memory holds at most
 * UNCOUNTED_NOTES_REMEMBERED keys, the oldest forgotten first. The memory is
 * the instance's own.
 */

const T0 = Date.UTC(2026, 10, 14, 9, 0, 0);
const user = (i: number) => `0a800000-0000-4000-8000-${String(i).padStart(12, '0')}`;

beforeEach(() => {
  resetUncountedNoteReportForTests();
});

describe('admitUncountedNote', () => {
  it('a session is written once, and again only after a day', () => {
    expect(admitUncountedNote('in', user(1), 'session-a', T0)).toBe('write');
    expect(admitUncountedNote('in', user(1), 'session-a', T0 + 60_000)).toBe('repeat');
    expect(admitUncountedNote('in', user(1), 'session-a', T0 + SESSION_NOTE_WINDOW_MS - 1)).toBe(
      'repeat',
    );
    expect(admitUncountedNote('in', user(1), 'session-a', T0 + SESSION_NOTE_WINDOW_MS)).toBe(
      'write',
    );
  });

  it('an account gets ACCOUNT_NOTE_LIMIT rows in its hour, then none until the hour is over', () => {
    for (let i = 0; i < ACCOUNT_NOTE_LIMIT; i += 1) {
      expect(admitUncountedNote('in', user(1), `s-${i}`, T0 + i)).toBe('write');
    }
    expect(admitUncountedNote('in', user(1), 's-over', T0 + 100)).toBe('account_limit');
    // A refused note does not take its session: it may be written later.
    expect(admitUncountedNote('in', user(1), 's-over', T0 + ACCOUNT_NOTE_WINDOW_MS)).toBe('write');
    expect(admitUncountedNote('in', user(2), 's-other', T0 + 100)).toBe('write');
  });

  it('a repeated session is not counted against the account', () => {
    expect(admitUncountedNote('in', user(1), 'same', T0)).toBe('write');
    for (let i = 0; i < 50; i += 1)
      expect(admitUncountedNote('in', user(1), 'same', T0 + i)).toBe('repeat');
    for (let i = 1; i < ACCOUNT_NOTE_LIMIT; i += 1) {
      expect(admitUncountedNote('in', user(1), `next-${i}`, T0 + 100)).toBe('write');
    }
    expect(admitUncountedNote('in', user(1), 'one-more', T0 + 100)).toBe('account_limit');
  });

  it('each memory holds at most UNCOUNTED_NOTES_REMEMBERED keys, the oldest forgotten first', () => {
    expect(UNCOUNTED_NOTES_REMEMBERED).toBe(5_000);
    for (let i = 0; i <= UNCOUNTED_NOTES_REMEMBERED; i += 1) {
      expect(admitUncountedNote('in', user(i), `session-${i}`, T0)).toBe('write');
    }
    // The first session (and its account) were forgotten to make room.
    expect(admitUncountedNote('in', user(0), 'session-0', T0 + 1)).toBe('write');
    expect(admitUncountedNote('in', user(2), 'session-2', T0 + 1)).toBe('repeat');
  });

  it("a session's sign-in note and its sign-out note are counted apart", () => {
    expect(admitUncountedNote('in', user(1), 'session-a', T0)).toBe('write');
    expect(admitUncountedNote('out', user(1), 'session-a', T0 + 1)).toBe('write');
    expect(admitUncountedNote('out', user(1), 'session-a', T0 + 2)).toBe('repeat');
    expect(admitUncountedNote('in', user(1), 'session-a', T0 + 3)).toBe('repeat');
  });

  it('a note with no session id is held to the account alone', () => {
    for (let i = 0; i < ACCOUNT_NOTE_LIMIT; i += 1) {
      expect(admitUncountedNote('out', user(1), null, T0 + i)).toBe('write');
    }
    expect(admitUncountedNote('out', user(1), null, T0 + 100)).toBe('account_limit');
  });

  it('the test reset forgets everything', () => {
    expect(admitUncountedNote('in', user(1), 'session-a', T0)).toBe('write');
    resetUncountedNoteReportForTests();
    expect(admitUncountedNote('in', user(1), 'session-a', T0)).toBe('write');
  });
});
