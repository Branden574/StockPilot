import { describe, expect, it } from 'vitest';

import { DELETED_USER_LABEL } from '@stockpilot/core';

import {
  DELETE_ACCOUNT_CONFIRM_COPY,
  actorText,
  isRowPersonDeleted,
  receiverText,
  signerEmailDefault,
} from './deleted-user-labels';

/**
 * The phone's "Deleted user" labels (migration 0393). A stamped null column
 * reads "Deleted user"; an unstamped null keeps the screen's own words; a live
 * person keeps their name; a malformed marker is never a stamp.
 */

const STAMP = { user_id: '2026-10-04T12:00:00.000+00:00' };

describe('isRowPersonDeleted', () => {
  it('is true only for a null column the row stamps', () => {
    expect(isRowPersonDeleted({ user_id: null, deleted_users: STAMP })).toBe(true);
    expect(isRowPersonDeleted({ user_id: null, deleted_users: null })).toBe(false);
    expect(isRowPersonDeleted({ user_id: null })).toBe(false); // old select, no marker
    expect(isRowPersonDeleted({ user_id: 'u-live', deleted_users: STAMP })).toBe(false);
  });

  it('reads the column it is asked about', () => {
    const row = { received_by: null, deleted_users: { received_by: '2026-10-04T12:00:00Z' } };
    expect(isRowPersonDeleted(row, 'received_by')).toBe(true);
    expect(isRowPersonDeleted(row, 'user_id')).toBe(false);
  });

  it('never treats a malformed marker as a stamp', () => {
    for (const marks of [[], 'user_id', 1, { user_id: 1 }, { user_id: '' }, { other: 'x' }]) {
      expect(isRowPersonDeleted({ user_id: null, deleted_users: marks })).toBe(false);
    }
  });
});

describe('actorText (movement and audit cards)', () => {
  it('a live actor keeps their name, else email', () => {
    expect(actorText({ full_name: 'Ada Lovelace', email: 'ada@x.org' }, false)).toBe('Ada Lovelace');
    expect(actorText({ full_name: null, email: 'ada@x.org' }, true)).toBe('ada@x.org');
  });

  it('a stamped null actor reads "Deleted user", an unstamped one "system"', () => {
    expect(actorText(null, true)).toBe(DELETED_USER_LABEL);
    expect(actorText(null, false)).toBe('system');
    expect(actorText(null, undefined)).toBe('system');
  });
});

describe('receiverText (PO receipt history)', () => {
  const names = new Map([['u-1', 'Bob Receiver']]);

  it('names a live receiver, "Unknown" for one the reader cannot see', () => {
    expect(receiverText(names, { received_by: 'u-1' })).toBe('Bob Receiver');
    expect(receiverText(names, { received_by: 'u-hidden' })).toBe('Unknown');
  });

  it('"Deleted user" for a stamped null receiver; "Unknown" when not stamped', () => {
    expect(
      receiverText(names, { received_by: null, deleted_users: { received_by: '2026-10-04T12:00:00Z' } }),
    ).toBe(DELETED_USER_LABEL);
    expect(receiverText(names, { received_by: null, deleted_users: null })).toBe('Unknown');
  });
});

describe('DELETE_ACCOUNT_CONFIRM_COPY (Settings)', () => {
  // Re-pinned by the A3 review (was "Your organization keeps what you
  // recorded, shown as “Deleted user”" and "make another member the owner on
  // the web first"): only some records show "Deleted user" (narrow scope), and
  // the Team page's control is "Transfer ownership…".
  it('says what stays, what is released, and where ownership moves', () => {
    expect(DELETE_ACCOUNT_CONFIRM_COPY).toContain(
      'Records you made stay with your organization: stock movements, received stock and the audit log show “Deleted user” instead of your name, and some records, such as maintenance requests, keep the name or email they were made with.',
    );
    expect(DELETE_ACCOUNT_CONFIRM_COPY).toContain('Work assigned to you becomes unassigned.');
    expect(DELETE_ACCOUNT_CONFIRM_COPY).toContain(
      'If you are the only owner of an organization with other members, transfer ownership on the Team page on the web first, or remove the other members.',
    );
    expect(DELETE_ACCOUNT_CONFIRM_COPY).toContain('This cannot be undone.');
    expect(DELETE_ACCOUNT_CONFIRM_COPY).not.toMatch(/keeps what you recorded, shown as “Deleted user”|make another member the owner/);
    expect(DELETE_ACCOUNT_CONFIRM_COPY.toLowerCase()).not.toMatch(/\bbooks?\b/);
  });
});

describe('signerEmailDefault (A3 desk check F-1 sweep)', () => {
  // The signature pad pre-fills the signer email, and the signer receipt goes
  // to whatever is submitted: a deleted requester's kept address is never the
  // default (A3: a deleted requester is never emailed again).
  it("offers the order's requester email while the requester's account exists", () => {
    expect(signerEmailDefault({ requesterEmail: 'pat@example.org', requesterDeletedAt: null })).toBe(
      'pat@example.org',
    );
  });

  it('offers nothing once the requester deleted their account', () => {
    expect(
      signerEmailDefault({
        requesterEmail: 'pat@example.org',
        requesterDeletedAt: '2026-10-04T12:00:00.000Z',
      }),
    ).toBe('');
  });

  it('offers nothing when the order kept no address', () => {
    expect(signerEmailDefault({ requesterEmail: null, requesterDeletedAt: null })).toBe('');
  });
});
