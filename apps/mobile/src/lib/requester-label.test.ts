import { describe, expect, it } from 'vitest';

import { profileFromEmbed, resolveRequesterLabel } from './requester-label';

/**
 * The phone's requester label (orders list and order screen). Migration 0388
 * lets an account that placed orders be deleted: the order keeps no requester
 * id and, on the rows that never held one, no email, so the phone says
 * "Deleted user" as the web does.
 */
const base = { requesterName: null, requesterEmail: null, requesterUserId: null, profile: null };

describe('resolveRequesterLabel', () => {
  it('no requester id and no email on the row: "Deleted user"', () => {
    expect(resolveRequesterLabel(base)).toBe('Deleted user');
  });

  it('an empty-string email is not a deletion (strict null): "External requester"', () => {
    expect(resolveRequesterLabel({ ...base, requesterEmail: '' })).toBe('External requester');
  });

  it('a team member resolves through the profile, else "Team member"', () => {
    expect(
      resolveRequesterLabel({
        ...base,
        requesterUserId: 'u-1',
        profile: { full_name: 'Jane Doe', email: 'jane@site.org' },
      }),
    ).toBe('Jane Doe');
    expect(resolveRequesterLabel({ ...base, requesterUserId: 'u-1' })).toBe('Team member');
  });

  it('an on-behalf or public-link order shows its own name or email', () => {
    expect(resolveRequesterLabel({ ...base, requesterName: 'Doua Vang' })).toBe('Doua Vang');
    expect(resolveRequesterLabel({ ...base, requesterEmail: 'a@site.org' })).toBe('a@site.org');
  });

  it('a deleted requester whose row already held the name keeps showing it', () => {
    expect(resolveRequesterLabel({ ...base, requesterName: 'Cust Co' })).toBe('Cust Co');
  });
});

describe('profileFromEmbed', () => {
  it('reads an object or a one-element array, and nothing else', () => {
    expect(profileFromEmbed({ full_name: 'A', email: 'a@x' })).toEqual({ full_name: 'A', email: 'a@x' });
    expect(profileFromEmbed([{ full_name: 'B', email: null }])).toEqual({ full_name: 'B', email: null });
    expect(profileFromEmbed(null)).toBeNull();
  });
});
