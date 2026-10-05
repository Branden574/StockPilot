import { describe, expect, it } from 'vitest';

import {
  DELETE_ACCOUNT_CARD_COPY,
  DELETE_ACCOUNT_DIALOG_COPY,
} from './delete-account-copy';

/**
 * The consent text for deleting an account (A3 review 2026-10-05). Under the
 * narrow scope (O-A3-1) only some records show "Deleted user": stock
 * movements, received stock, purchase order imports, the audit log, order
 * timelines, schedule entries and returns. Others keep the name or email they
 * were made with (maintenance requests, legacy-shaped orders, public-link
 * returns) or show no name (counts, approvers, procedures, rentals). The text
 * a person agrees to before an irreversible, privacy-motivated action must not
 * promise more than that.
 */
const all = [
  DELETE_ACCOUNT_DIALOG_COPY.kept,
  DELETE_ACCOUNT_DIALOG_COPY.released,
  DELETE_ACCOUNT_DIALOG_COPY.owner,
  DELETE_ACCOUNT_CARD_COPY,
];

describe('the delete-account consent text (web dialog and Settings card)', () => {
  it('names where "Deleted user" shows and says some records keep the name or email', () => {
    expect(DELETE_ACCOUNT_DIALOG_COPY.kept).toContain(
      'On stock movements, received stock, purchase order imports and the audit log they show “Deleted user” instead of your name.',
    );
    expect(DELETE_ACCOUNT_DIALOG_COPY.kept).toContain(
      'Some records keep the name or email they were made with, such as maintenance requests and older orders, and some show no name.',
    );
    expect(DELETE_ACCOUNT_CARD_COPY).toContain(
      'stock movements, received stock and the audit log show “Deleted user” instead of your name',
    );
    expect(DELETE_ACCOUNT_CARD_COPY).toContain('keep the name or email they were made with');
  });

  it('never promises that everything recorded shows "Deleted user"', () => {
    for (const s of all) {
      expect(s).not.toMatch(/What you recorded stays with your organization and shows “Deleted user”/);
      expect(s).not.toMatch(/keeps what you recorded, shown as “Deleted user”/);
      expect(s).not.toMatch(/every (screen|page|record)|everywhere|all records/i);
      expect(s.toLowerCase()).not.toMatch(/\bbooks?\b/);
    }
  });

  it('says what is released and where ownership moves, with the control the Team page actually shows', () => {
    expect(DELETE_ACCOUNT_DIALOG_COPY.released).toBe(
      'Counts, picks and deliveries assigned to you become unassigned so someone else can finish them.',
    );
    expect(DELETE_ACCOUNT_DIALOG_COPY.owner).toBe(
      'If you are the only owner of an organization with other members, transfer ownership first: on the Team page, choose Transfer ownership on another member, or remove the other members.',
    );
    expect(DELETE_ACCOUNT_CARD_COPY).toContain(
      'If you are the only owner of an organization with other members, transfer ownership on the Team page first.',
    );
    for (const s of all) expect(s).not.toMatch(/make another member the owner/i);
  });
});
