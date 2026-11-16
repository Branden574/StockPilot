import { describe, expect, it } from 'vitest';

import {
  ACCOUNT_DELETE_AAL2_COPY,
  ACCOUNT_DELETE_BLOCKED_COPY,
  ACCOUNT_DELETE_CODE_NOT_OFFERED_COPY,
  ACCOUNT_DELETE_CODE_RE,
  ACCOUNT_DELETE_CODE_REFUSED_COPY,
  ACCOUNT_DELETE_CODE_SEND_FAILED_COPY,
  ACCOUNT_DELETE_CODE_SEND_PAUSED_COPY,
  ACCOUNT_DELETE_CODE_SENT_COPY,
  ACCOUNT_DELETE_CREDENTIAL_CHECK_FAILED_COPY,
  ACCOUNT_DELETE_CREDENTIAL_PAUSED_COPY,
  ACCOUNT_DELETE_CREDENTIAL_REQUIRED_COPY,
  ACCOUNT_DELETE_LAST_OWNER_COPY,
  ACCOUNT_DELETE_LAST_OWNER_COPY_MOBILE,
  ACCOUNT_DELETE_OWNER_CHECK_FAILED_COPY,
  ACCOUNT_DELETE_PASSWORD_REFUSED_COPY,
  ACCOUNT_DELETE_PLATFORM_ADMIN_COPY,
  ACCOUNT_DELETE_RETRY_COPY,
  ACCOUNT_DELETE_SIGNED_OUT_COPY,
  ACCOUNT_DELETE_TYPE_DELETE_COPY,
  DELETE_ACCOUNT_CARD_COPY,
  DELETE_ACCOUNT_CODE_SEND_PAUSED_COPY,
  DELETE_ACCOUNT_CONFIRM_COPY,
  DELETE_ACCOUNT_DIALOG_COPY,
  DELETE_ACCOUNT_NEWEST_CODE_ONLY_COPY,
} from './account/delete-account-copy';
import {
  AUTHENTICATOR_SET_UP_PAGE,
  AUTHENTICATOR_SET_UP_TITLE,
  AUTHENTICATOR_SET_UP_URL,
} from './auth/set-up-copy';
import { UNREADABLE_ORG_MFA_POLICY } from './auth/step-up';

/**
 * The exact text of the words the website and the API show, shared through
 * core: the delete-account dialog, card and route answers, the set-up address
 * and title, and the policy an unreadable organization is held to. Each value
 * is written out here, never imported, so an edit to any of them is a visible
 * change to this test.
 */
describe('the delete-account words', () => {
  it('DELETE_ACCOUNT_DIALOG_COPY', () => {
    expect(DELETE_ACCOUNT_DIALOG_COPY).toEqual({
      kept: 'This deletes your account and removes your access immediately. Records you made stay with your organization. On stock movements, received stock, purchase order imports and the audit log they show “Deleted user” instead of your name. Some records keep the name or email they were made with, such as maintenance requests and older orders, and some show no name.',
      released:
        'Counts, picks and deliveries assigned to you become unassigned so someone else can finish them.',
      owner:
        'If you are the only owner of an organization with other members, transfer ownership first: on the Team page, choose Transfer ownership on another member, or remove the other members.',
    });
  });
  it('DELETE_ACCOUNT_CARD_COPY', () => {
    expect(DELETE_ACCOUNT_CARD_COPY).toBe(
      'Permanently delete your account and your access to StockPilot. Records you made stay with your organization: stock movements, received stock and the audit log show “Deleted user” instead of your name, and some records, such as maintenance requests, keep the name or email they were made with. If you are the only owner of an organization with other members, transfer ownership on the Team page first.',
    );
  });
  it('DELETE_ACCOUNT_NEWEST_CODE_ONLY_COPY', () => {
    expect(DELETE_ACCOUNT_NEWEST_CODE_ONLY_COPY).toBe(
      'If you ask again, only the newest code works.',
    );
  });
  it('DELETE_ACCOUNT_CODE_SEND_PAUSED_COPY', () => {
    expect(DELETE_ACCOUNT_CODE_SEND_PAUSED_COPY).toBe(
      'Too many codes requested. Try again in a few minutes, or enter your password.',
    );
  });
  it('DELETE_ACCOUNT_CONFIRM_COPY', () => {
    expect(DELETE_ACCOUNT_CONFIRM_COPY).toEqual({
      passwordLabel: 'Your password',
      passwordHint:
        'Enter your password to confirm. If you have no password or do not remember it, use a code instead.',
      emailCode: 'Email me a code instead',
      codeLabel: 'Code from your email',
      codeSent:
        'We sent a six-digit code to your sign-in email. It works for 10 minutes. If you ask again, only the newest code works.',
      sendAgain: 'Send a new code',
      usePassword: 'Use my password instead',
    });
  });
  it('ACCOUNT_DELETE_CREDENTIAL_REQUIRED_COPY', () => {
    expect(ACCOUNT_DELETE_CREDENTIAL_REQUIRED_COPY).toBe(
      'Enter your password, or ask for a code by email, to confirm. Nothing was deleted.',
    );
  });
  it('ACCOUNT_DELETE_PASSWORD_REFUSED_COPY', () => {
    expect(ACCOUNT_DELETE_PASSWORD_REFUSED_COPY).toBe(
      'That password is not correct. Nothing was deleted. You can ask for a code by email instead.',
    );
  });
  it('ACCOUNT_DELETE_CODE_REFUSED_COPY', () => {
    expect(ACCOUNT_DELETE_CODE_REFUSED_COPY).toBe(
      'That code is not correct or has expired. Nothing was deleted. Ask for a new code and try again.',
    );
  });
  it('ACCOUNT_DELETE_CREDENTIAL_PAUSED_COPY', () => {
    expect(ACCOUNT_DELETE_CREDENTIAL_PAUSED_COPY).toBe(
      'Too many tries. Nothing was deleted. Wait a few minutes and try again.',
    );
  });
  it('ACCOUNT_DELETE_CREDENTIAL_CHECK_FAILED_COPY', () => {
    expect(ACCOUNT_DELETE_CREDENTIAL_CHECK_FAILED_COPY).toBe(
      'Could not check that just now. Nothing was deleted. Try again in a minute.',
    );
  });
  it('ACCOUNT_DELETE_AAL2_COPY', () => {
    expect(ACCOUNT_DELETE_AAL2_COPY).toBe(
      'Enter your authenticator code before deleting your account. Nothing was deleted.',
    );
  });
  it('ACCOUNT_DELETE_CODE_SENT_COPY', () => {
    expect(ACCOUNT_DELETE_CODE_SENT_COPY).toBe(
      'We sent a six-digit code to your sign-in email. It works for 10 minutes. If you ask again, only the newest code works.',
    );
  });
  it('ACCOUNT_DELETE_CODE_SEND_PAUSED_COPY', () => {
    expect(ACCOUNT_DELETE_CODE_SEND_PAUSED_COPY).toBe(
      'Too many codes requested. Try again in a few minutes, or enter your password.',
    );
  });
  it('ACCOUNT_DELETE_CODE_NOT_OFFERED_COPY', () => {
    expect(ACCOUNT_DELETE_CODE_NOT_OFFERED_COPY).toBe(
      'Your account has an authenticator, so deleting it is confirmed with your authenticator code.',
    );
  });
  it('ACCOUNT_DELETE_CODE_SEND_FAILED_COPY', () => {
    expect(ACCOUNT_DELETE_CODE_SEND_FAILED_COPY).toBe(
      'The code could not be sent just now. Try again in a few minutes, or enter your password.',
    );
  });
  it('ACCOUNT_DELETE_BLOCKED_COPY', () => {
    expect(ACCOUNT_DELETE_BLOCKED_COPY).toBe(
      'Your account could not be deleted because it is linked to a record that could not be released. Nothing was changed. Contact StockPilot support.',
    );
  });
  it('ACCOUNT_DELETE_LAST_OWNER_COPY', () => {
    expect(ACCOUNT_DELETE_LAST_OWNER_COPY).toBe(
      'You are the only owner of an organization that has other members. On the Team page, choose Transfer ownership on another member, or remove the other members, then delete your account. Nothing was changed.',
    );
  });
  it('ACCOUNT_DELETE_LAST_OWNER_COPY_MOBILE', () => {
    expect(ACCOUNT_DELETE_LAST_OWNER_COPY_MOBILE).toBe(
      'You are the only owner of an organization that has other members. On the Team page on the web, choose Transfer ownership on another member, or remove the other members, then delete your account. Nothing was changed.',
    );
  });
  it('ACCOUNT_DELETE_OWNER_CHECK_FAILED_COPY', () => {
    expect(ACCOUNT_DELETE_OWNER_CHECK_FAILED_COPY).toBe(
      'Could not check the organizations you own. Nothing was deleted. Try again.',
    );
  });
  it('ACCOUNT_DELETE_PLATFORM_ADMIN_COPY', () => {
    expect(ACCOUNT_DELETE_PLATFORM_ADMIN_COPY).toBe(
      'This account is a StockPilot platform admin. Remove it from the platform admin list before deleting it. Nothing was changed.',
    );
  });
  it('ACCOUNT_DELETE_RETRY_COPY', () => {
    expect(ACCOUNT_DELETE_RETRY_COPY).toBe(
      'Your account could not be deleted right now. Nothing was changed. Try again in a minute.',
    );
  });
  it('ACCOUNT_DELETE_SIGNED_OUT_COPY', () => {
    expect(ACCOUNT_DELETE_SIGNED_OUT_COPY).toBe(
      'Your account could not be deleted right now. You have been signed out; nothing else changed. Try again in a minute.',
    );
  });
  it('ACCOUNT_DELETE_TYPE_DELETE_COPY', () => {
    expect(ACCOUNT_DELETE_TYPE_DELETE_COPY).toBe('Type DELETE to confirm.');
  });
  it('ACCOUNT_DELETE_CODE_RE', () => {
    expect(ACCOUNT_DELETE_CODE_RE.source).toBe('^[0-9]{6}$');
    expect(ACCOUNT_DELETE_CODE_RE.flags).toBe('');
  });
});

describe('the set-up address and title', () => {
  it('AUTHENTICATOR_SET_UP_PAGE', () => {
    expect(AUTHENTICATOR_SET_UP_PAGE).toBe('/dashboard/settings/security');
  });
  it('AUTHENTICATOR_SET_UP_URL', () => {
    expect(AUTHENTICATOR_SET_UP_URL).toBe('/dashboard/settings/security?enroll=1');
  });
  it('AUTHENTICATOR_SET_UP_TITLE', () => {
    expect(AUTHENTICATOR_SET_UP_TITLE).toBe('Set up an authenticator to continue');
  });
});

describe('the policy an unreadable organization is held to', () => {
  it('UNREADABLE_ORG_MFA_POLICY', () => {
    expect(UNREADABLE_ORG_MFA_POLICY).toBe('all_required');
  });
});
