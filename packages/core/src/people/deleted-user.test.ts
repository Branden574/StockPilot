import { describe, expect, it } from 'vitest';

import { DELETED_REQUESTER_LABEL } from '../orders/requester-identity';
import {
  DELETED_USER_LABEL,
  FORMER_MEMBER_LABEL,
  isDeletedPerson,
  isDeletedUserRef,
  personLabel,
} from './deleted-user';

/**
 * The one mapping from a row's person column and its `deleted_users` marker
 * (migration 0393) to words, shared by the web and the phone.
 */
const STAMP = '2026-11-04T18:22:05.123456+00:00';

describe('isDeletedUserRef', () => {
  it('is true for an own key holding the database timestamp', () => {
    expect(isDeletedUserRef({ received_by: STAMP }, 'received_by')).toBe(true);
  });

  it('is false for another column, an empty marker and a null marker', () => {
    expect(isDeletedUserRef({ received_by: STAMP }, 'user_id')).toBe(false);
    expect(isDeletedUserRef({}, 'user_id')).toBe(false);
    expect(isDeletedUserRef(null, 'user_id')).toBe(false);
    expect(isDeletedUserRef(undefined, 'user_id')).toBe(false);
  });

  it('is false for malformed markers (array, number, string, non-string or empty value, inherited key)', () => {
    expect(isDeletedUserRef(['user_id'], 'user_id')).toBe(false);
    expect(isDeletedUserRef(42, 'user_id')).toBe(false);
    expect(isDeletedUserRef('{"user_id":"x"}', 'user_id')).toBe(false);
    expect(isDeletedUserRef({ user_id: 1 }, 'user_id')).toBe(false);
    expect(isDeletedUserRef({ user_id: true }, 'user_id')).toBe(false);
    expect(isDeletedUserRef({ user_id: '' }, 'user_id')).toBe(false);
    expect(isDeletedUserRef(Object.create({ user_id: STAMP }), 'user_id')).toBe(false);
  });
});

describe('isDeletedPerson', () => {
  it('needs both a null column and a stamp', () => {
    expect(isDeletedPerson(null, { user_id: STAMP }, 'user_id')).toBe(true);
    expect(isDeletedPerson(undefined, { user_id: STAMP }, 'user_id')).toBe(true);
    expect(isDeletedPerson(null, null, 'user_id')).toBe(false);
    expect(isDeletedPerson('u-1', { user_id: STAMP }, 'user_id')).toBe(false);
  });
});

describe('personLabel', () => {
  it('says "Deleted user" for a stamped null column', () => {
    expect(
      personLabel({ id: null, marks: { user_id: STAMP }, column: 'user_id', nullLabel: 'System' }),
    ).toBe('Deleted user');
    expect(DELETED_USER_LABEL).toBe('Deleted user');
  });

  it("keeps the surface's own words for an unstamped null (a system row, or one from before 0393)", () => {
    expect(personLabel({ id: null, marks: null, column: 'user_id', nullLabel: 'System' })).toBe(
      'System',
    );
    expect(
      personLabel({ id: null, marks: { other: STAMP }, column: 'user_id', nullLabel: '—' }),
    ).toBe('—');
  });

  it("shows a live person's name, trimmed", () => {
    expect(
      personLabel({ id: 'u-1', name: '  Marissa Lopez ', column: 'user_id', nullLabel: 'System' }),
    ).toBe('Marissa Lopez');
  });

  it('says "Former member" for an id whose profile the reader cannot see, or the given hidden label', () => {
    expect(personLabel({ id: 'u-1', name: null, column: 'user_id', nullLabel: 'System' })).toBe(
      FORMER_MEMBER_LABEL,
    );
    expect(personLabel({ id: 'u-1', name: '   ', column: 'user_id', nullLabel: 'System' })).toBe(
      'Former member',
    );
    expect(
      personLabel({
        id: 'u-1',
        column: 'user_id',
        nullLabel: 'System',
        hiddenLabel: 'Unknown user',
      }),
    ).toBe('Unknown user');
  });

  it('prefers the name over any marker (the database drops a stamp once the column names someone)', () => {
    expect(
      personLabel({
        id: 'u-1',
        name: 'Doua',
        marks: { user_id: STAMP },
        column: 'user_id',
        nullLabel: 'System',
      }),
    ).toBe('Doua');
  });

  it('never returns the raw id', () => {
    const id = '11111111-0000-4000-8000-000000000001';
    expect(personLabel({ id, column: 'user_id', nullLabel: 'System' })).not.toContain(id);
  });

  it('is the same words as the order requester label (0388)', () => {
    expect(DELETED_REQUESTER_LABEL).toBe(DELETED_USER_LABEL);
  });
});
