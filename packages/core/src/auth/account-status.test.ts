import { describe, expect, it } from 'vitest';

import {
  ACCOUNT_DISABLED_MESSAGE,
  ACCOUNT_DISABLED_PATH,
  ACCOUNT_DISABLED_TITLE,
  ACCOUNT_DISABLE_CODES,
  DISABLE_REASON_CATEGORIES,
  composeDisabledReason,
  disableReasonSchema,
  isAccountDisabled,
} from './account-status';

describe('disabled copy', () => {
  it('is the owner-approved wording, character for character', () => {
    expect(ACCOUNT_DISABLED_TITLE).toBe('Your account has been temporarily disabled');
    expect(ACCOUNT_DISABLED_MESSAGE).toBe(
      'Your StockPilot account has been temporarily disabled. Please contact your system administrator for assistance.',
    );
    expect(ACCOUNT_DISABLED_PATH).toBe('/account-disabled');
  });

  it('never leaks a reason, an actor or a date to the user', () => {
    const copy = `${ACCOUNT_DISABLED_TITLE} ${ACCOUNT_DISABLED_MESSAGE}`.toLowerCase();
    for (const leak of ['reason', 'because', 'admin@', 'disabled by', 'until']) {
      expect(copy).not.toContain(leak);
    }
  });
});

describe('ACCOUNT_DISABLE_CODES', () => {
  it('carries every code the surfaces branch on', () => {
    expect(ACCOUNT_DISABLE_CODES).toEqual([
      'ACCOUNT_TEMPORARILY_DISABLED',
      'ACCOUNT_ALREADY_DISABLED',
      'ACCOUNT_NOT_DISABLED',
      'ACCOUNT_DISABLE_NOT_AUTHORIZED',
      'PROTECTED_ADMIN_ACCOUNT',
      'ACCOUNT_DISABLE_REASON_REQUIRED',
      'ACCOUNT_NOT_FOUND',
    ]);
  });
});

describe('isAccountDisabled', () => {
  it('treats null, undefined and a missing row as ACTIVE', () => {
    expect(isAccountDisabled({ disabled_at: null })).toBe(false);
    expect(isAccountDisabled({ disabled_at: undefined })).toBe(false);
    expect(isAccountDisabled(null)).toBe(false);
    expect(isAccountDisabled(undefined)).toBe(false);
  });

  it('treats any timestamp as DISABLED, including a future one', () => {
    expect(isAccountDisabled({ disabled_at: '2026-07-31T10:00:00.000Z' })).toBe(true);
    expect(isAccountDisabled({ disabled_at: '2099-01-01T00:00:00.000Z' })).toBe(true);
  });

  it('treats a blank string as ACTIVE rather than crashing', () => {
    expect(isAccountDisabled({ disabled_at: '   ' })).toBe(false);
  });
});

describe('disableReasonSchema', () => {
  it('accepts a known category with no notes', () => {
    const res = disableReasonSchema.safeParse({ category: 'security_investigation' });
    expect(res.success).toBe(true);
  });

  it('REQUIRES notes when the category is other', () => {
    const res = disableReasonSchema.safeParse({ category: 'other', notes: '   ' });
    expect(res.success).toBe(false);
    expect(res.success === false && res.error.issues[0]?.path).toEqual(['notes']);
  });

  it('accepts other with real notes', () => {
    expect(disableReasonSchema.safeParse({ category: 'other', notes: 'Duplicate account' }).success).toBe(true);
  });

  it('rejects an unknown category', () => {
    expect(disableReasonSchema.safeParse({ category: 'vibes' }).success).toBe(false);
  });

  it('caps notes at 500 characters', () => {
    expect(disableReasonSchema.safeParse({ category: 'other', notes: 'x'.repeat(501) }).success).toBe(false);
    expect(disableReasonSchema.safeParse({ category: 'other', notes: 'x'.repeat(500) }).success).toBe(true);
  });

  it('exposes every category to the dialog', () => {
    expect(DISABLE_REASON_CATEGORIES).toEqual([
      'security_investigation',
      'offboarding_in_progress',
      'suspected_compromise',
      'policy_violation',
      'customer_request',
      'other',
    ]);
  });
});

describe('composeDisabledReason', () => {
  it('stores the category label alone when there are no notes', () => {
    expect(composeDisabledReason({ category: 'policy_violation' })).toBe('Policy violation');
  });

  it('appends trimmed notes after an em dash', () => {
    expect(composeDisabledReason({ category: 'other', notes: '  Duplicate account  ' })).toBe(
      'Other — Duplicate account',
    );
  });

  it('never returns an empty string for a valid input', () => {
    for (const category of DISABLE_REASON_CATEGORIES) {
      const composed = composeDisabledReason({ category, notes: category === 'other' ? 'n' : undefined });
      expect(composed.trim().length).toBeGreaterThan(0);
    }
  });
});
