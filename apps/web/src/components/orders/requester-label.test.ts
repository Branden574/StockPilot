import { describe, expect, it } from 'vitest';

import type { OrderRequestSummary } from '@/server/services/order-requests';

import { summaryRequesterLabel } from './requester-label';

/**
 * The orders list's requester label. Migration 0388 lets an account that
 * placed orders be deleted: the order keeps no requester id and (on the rows
 * that never held one) no email, and the list says "Deleted user" instead of
 * calling that person external.
 */
function row(overrides: Partial<OrderRequestSummary>): OrderRequestSummary {
  return {
    requesterUserId: null,
    requesterEmail: null,
    requesterName: null,
    requesterOrgLabel: null,
    requesterDeleted: false,
    ...overrides,
  } as OrderRequestSummary;
}

describe('summaryRequesterLabel', () => {
  it('a deleted requester (no id, no email on the row) reads "Deleted user"', () => {
    expect(summaryRequesterLabel(row({ requesterDeleted: true }))).toBe('Deleted user');
  });

  it('a live team member with no resolvable name reads "Team member"', () => {
    expect(summaryRequesterLabel(row({ requesterUserId: 'u-1' }))).toBe('Team member');
  });

  it('no id, no name, no email and not deleted reads "External requester"', () => {
    expect(summaryRequesterLabel(row({}))).toBe('External requester');
  });

  it('a name wins, with the org label', () => {
    expect(
      summaryRequesterLabel(row({ requesterName: 'Doua Vang', requesterOrgLabel: 'Clovis' })),
    ).toBe('Doua Vang · Clovis');
  });

  it('a deleted requester whose row already held a name keeps showing it', () => {
    expect(summaryRequesterLabel(row({ requesterDeleted: true, requesterName: 'Cust Co' }))).toBe(
      'Cust Co',
    );
  });

  it('an email wins over the deleted fallback', () => {
    expect(summaryRequesterLabel(row({ requesterEmail: 'a@site.org' }))).toBe('a@site.org');
  });
});
