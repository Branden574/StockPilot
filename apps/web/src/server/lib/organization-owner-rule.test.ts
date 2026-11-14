import { describe, expect, it } from 'vitest';

import {
  ACT_AS_ONLY_OWNER_COPY,
  INVITE_ORGANIZATION_HAS_NO_OWNER_COPY,
  ORGANIZATION_NEEDS_OWNER_COPY,
  ORGANIZATION_OWNER_BUSY_COPY,
  organizationOwnerRefusal,
} from './organization-owner-rule';

/**
 * The database's owner rule (migration 0458) answers at commit with one of
 * two refusals of its own. Only those two, by SQLSTATE AND message, are read
 * as the rule: any other error keeps its caller's own handling.
 */
describe('organizationOwnerRefusal', () => {
  it('P0001 organization_needs_owner is the rule refusing', () => {
    expect(organizationOwnerRefusal({ code: 'P0001', message: 'organization_needs_owner' })).toBe('needs_owner');
  });

  it('55P03 organization_owner_check_busy is the rule busy', () => {
    expect(organizationOwnerRefusal({ code: '55P03', message: 'organization_owner_check_busy' })).toBe('busy');
  });

  it('anything else is not the rule', () => {
    for (const e of [
      null,
      undefined,
      {},
      { code: 'P0001', message: 'last_owner' },
      { code: 'P0001', message: 'something else' },
      { code: '55P03', message: 'canceling statement due to lock timeout' },
      { code: '42501', message: 'organization_needs_owner' },
      { code: '0A000', message: 'organization_owner_check_isolation' },
      { message: 'organization_needs_owner' },
    ]) {
      expect(organizationOwnerRefusal(e)).toBeNull();
    }
  });

  // On the sign-up path the account already exists when the invite is
  // refused, so this sentence says only what did not happen.
  it('the invite refusal says the person was not added', () => {
    expect(INVITE_ORGANIZATION_HAS_NO_OWNER_COPY).toBe(
      'This organization has no owner right now, so the invite cannot be accepted. You were not added.',
    );
    expect(ORGANIZATION_NEEDS_OWNER_COPY).toBe(
      'This change would leave the organization with members and no owner. Nothing was changed.',
    );
  });

  it('the sentences are plain and name no database word', () => {
    for (const s of [
      ORGANIZATION_OWNER_BUSY_COPY,
      ORGANIZATION_NEEDS_OWNER_COPY,
      INVITE_ORGANIZATION_HAS_NO_OWNER_COPY,
      ACT_AS_ONLY_OWNER_COPY,
    ]) {
      expect(s).not.toMatch(/organization_|P0001|55P03|constraint|_/);
      expect(s.length).toBeLessThan(140);
    }
  });
});
