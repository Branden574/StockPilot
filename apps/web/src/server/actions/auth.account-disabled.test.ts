import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { isBannedUserAuthError } from './auth-error-classify';

/**
 * A banned user and a wrong password must be distinguishable server-side, but
 * the "temporarily disabled" sentence must NEVER be shown for a mere bad
 * credential — that would turn the sign-in form into an account-status oracle.
 * The only accepted signal is GoTrue's own structured `user_banned` code.
 */

describe('isBannedUserAuthError', () => {
  it('recognises the structured GoTrue code', () => {
    expect(isBannedUserAuthError({ code: 'user_banned' })).toBe(true);
  });

  it('does NOT fire on invalid credentials', () => {
    expect(
      isBannedUserAuthError({ code: 'invalid_credentials', message: 'Invalid login credentials' }),
    ).toBe(false);
  });

  it('does NOT fire on a rate limit', () => {
    expect(isBannedUserAuthError({ status: 429, code: 'over_email_send_rate_limit' })).toBe(false);
  });

  it('never infers a ban from free-text alone — an attacker-influenced message is not a signal', () => {
    expect(isBannedUserAuthError({ message: 'user_banned' })).toBe(false);
    expect(isBannedUserAuthError({ message: 'your user_banned account' })).toBe(false);
  });

  it('tolerates null and empty errors', () => {
    expect(isBannedUserAuthError(null)).toBe(false);
    expect(isBannedUserAuthError({})).toBe(false);
  });
});

describe('signInAction branches on the classifier before the generic collapse', () => {
  const src = readFileSync(join(__dirname, 'auth.ts'), 'utf8');

  it('checks the ban BEFORE returning invalid email or password', () => {
    // Anchored on the CALL SITE, not the bare identifier: the identifier also
    // appears in the import at the top of the file, so matching it would pass
    // even if the ban branch were placed after the generic return — or omitted.
    const banIdx = src.indexOf('if (isBannedUserAuthError(');
    const genericIdx = src.indexOf("'Invalid email or password'");
    expect(banIdx).toBeGreaterThan(-1);
    expect(genericIdx).toBeGreaterThan(-1);
    expect(banIdx).toBeLessThan(genericIdx);
  });

  it('returns the shared copy, not a retyped sentence', () => {
    expect(src).toContain('ACCOUNT_DISABLED_MESSAGE');
  });
});
