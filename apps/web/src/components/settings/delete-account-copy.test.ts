import { describe, expect, it } from 'vitest';

import {
  DELETE_ACCOUNT_CARD_COPY,
  DELETE_ACCOUNT_CODE_SEND_PAUSED_COPY,
  DELETE_ACCOUNT_CONFIRM_COPY,
  DELETE_ACCOUNT_DIALOG_COPY,
  DELETE_ACCOUNT_NEWEST_CODE_ONLY_COPY,
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

describe('the words around a deletion code', () => {
  it('after a code is sent, says that only the newest code works', () => {
    expect(DELETE_ACCOUNT_CONFIRM_COPY.codeSent).toBe(
      'We sent a six-digit code to your sign-in email. It works for 10 minutes. If you ask again, only the newest code works.',
    );
    expect(DELETE_ACCOUNT_CONFIRM_COPY.codeSent).toContain(DELETE_ACCOUNT_NEWEST_CODE_ONLY_COPY);
  });

  it('the send limit speaks of codes, not tries', () => {
    expect(DELETE_ACCOUNT_CODE_SEND_PAUSED_COPY).toBe(
      'Too many codes requested. Try again in a few minutes, or enter your password.',
    );
    expect(DELETE_ACCOUNT_CODE_SEND_PAUSED_COPY).not.toMatch(/tries/i);
  });

  it('no exclamation mark and no emoji', () => {
    for (const s of [
      ...Object.values(DELETE_ACCOUNT_CONFIRM_COPY),
      DELETE_ACCOUNT_CODE_SEND_PAUSED_COPY,
      DELETE_ACCOUNT_NEWEST_CODE_ONLY_COPY,
    ]) {
      expect(s).not.toContain('!');
      expect(s).not.toMatch(/\p{Extended_Pictographic}/u);
    }
  });
});
