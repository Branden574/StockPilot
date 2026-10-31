import { describe, expect, it } from 'vitest';

import {
  maintenanceRequesterAccountDeleted,
  supportTicketOwner,
  supportTicketSubmitterAccountDeleted,
} from './kept-address';

/**
 * B23: whether a record's kept address may still be emailed. The owner
 * columns are emptied only by an account deletion (kept-address.ts says why;
 * kept-address.guard.test.ts pins it), and a row read without them counts as
 * a deleted member's, so the answer fails toward sending nothing.
 */

describe('maintenanceRequesterAccountDeleted', () => {
  it('is false while the request names the member who filed it', () => {
    expect(maintenanceRequesterAccountDeleted({ requester_user_id: 'member-1' })).toBe(false);
  });

  it('is true once the account deletion emptied requester_user_id', () => {
    expect(maintenanceRequesterAccountDeleted({ requester_user_id: null })).toBe(true);
  });

  it('is true for a row read without requester_user_id (never sends on a guess)', () => {
    expect(maintenanceRequesterAccountDeleted({})).toBe(true);
    expect(maintenanceRequesterAccountDeleted({ requester_user_id: '' })).toBe(true);
  });
});

describe('supportTicketSubmitterAccountDeleted', () => {
  it('is false for an in-app ticket that names its organization and member', () => {
    expect(
      supportTicketSubmitterAccountDeleted({ organization_id: 'org-1', submitted_by: 'member-1' }),
    ).toBe(false);
  });

  it('is false for a public ticket, which names neither', () => {
    expect(
      supportTicketSubmitterAccountDeleted({ organization_id: null, submitted_by: null }),
    ).toBe(false);
  });

  it('is true for an in-app ticket whose member deleted their account', () => {
    expect(
      supportTicketSubmitterAccountDeleted({ organization_id: 'org-1', submitted_by: null }),
    ).toBe(true);
  });

  it('is false for a living member whose organization was deleted (their own address)', () => {
    expect(
      supportTicketSubmitterAccountDeleted({ organization_id: null, submitted_by: 'member-1' }),
    ).toBe(false);
  });

  it('is true for a row read without both columns', () => {
    expect(supportTicketSubmitterAccountDeleted({})).toBe(true);
    expect(supportTicketSubmitterAccountDeleted({ organization_id: 'org-1' })).toBe(true);
    expect(supportTicketSubmitterAccountDeleted({ submitted_by: 'member-1' })).toBe(true);
  });
});

describe('supportTicketOwner', () => {
  it('names both columns for a ticket a member filed in the app', () => {
    expect(supportTicketOwner({ organizationId: 'org-1', submittedBy: 'member-1' })).toEqual({
      organization_id: 'org-1',
      submitted_by: 'member-1',
    });
  });

  it('names neither for a public ticket', () => {
    expect(supportTicketOwner({})).toEqual({ organization_id: null, submitted_by: null });
    expect(supportTicketOwner({ organizationId: null, submittedBy: null })).toEqual({
      organization_id: null,
      submitted_by: null,
    });
  });

  it('refuses half an owner, which would read as a deleted member ticket', () => {
    expect(() => supportTicketOwner({ organizationId: 'org-1' })).toThrow(/both .* or neither/);
    expect(() => supportTicketOwner({ submittedBy: 'member-1' })).toThrow(/both .* or neither/);
    expect(() => supportTicketOwner({ organizationId: 'org-1', submittedBy: '' })).toThrow(
      /both .* or neither/,
    );
  });
});
