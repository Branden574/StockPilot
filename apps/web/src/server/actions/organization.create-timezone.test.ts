import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeSupabaseStub, type SupabaseStub } from '@/test/supabase-mock';

import { ORG_TIMEZONE_INVALID_MESSAGE } from '@stockpilot/core';

/**
 * A NEW ORGANIZATION'S ZONE IS CHECKED BEFORE IT IS STORED (B41).
 *
 * createOrganizationAction (onboarding) inserted whatever 1 to 64 characters
 * the form sent. The form defaults to the creator's browser zone and lets them
 * type, so a zone the Book Order Totals report cannot use, or no zone at all,
 * reached organizations.timezone (no CHECK constraint, 0001_init.sql:34).
 */

vi.mock('next/cache', () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock('@/lib/auth/session', () => ({
  requireSession: vi.fn(async () => ({ userId: 'user-1', email: 'owner@example.test' })),
}));

const h = vi.hoisted(() => ({ stub: null as SupabaseStub | null }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => h.stub!.client }));

import { createOrganizationAction } from './organization';

beforeEach(() => {
  vi.clearAllMocks();
  h.stub = makeSupabaseStub({
    // ensureUniqueSlug's probe: the slug is free.
    'organizations.select': { data: null, error: null },
    'organizations.insert': { data: { id: 'org-1', slug: 'example-workspace' }, error: null },
    'organization_members.insert': { data: null, error: null },
    'user_profiles.update': { data: null, error: null },
    'locations.insert': { data: null, error: null },
  });
});

/** The row the action inserted into organizations. */
function insertedOrg(): Record<string, unknown> {
  const args = h.stub!.chainArgsAll.get('organizations.insert')?.[0]?.[0]?.[0];
  return args as Record<string, unknown>;
}

describe('createOrganizationAction: the zone', () => {
  it('refuses an unusable zone before any insert', async () => {
    for (const timezone of ['Mars/Olympus', 'PST', 'UTC+5', '   ']) {
      const res = await createOrganizationAction({
        name: 'Example Workspace',
        timezone,
        currency: 'USD',
      });
      expect(res.ok, timezone).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe('validation_error');
        expect(res.error.message).toBe(ORG_TIMEZONE_INVALID_MESSAGE);
      }
    }
    expect(h.stub!.fromCalls).toEqual([]);
  });

  it('stores a valid zone outside the settings list as given', async () => {
    const res = await createOrganizationAction({
      name: 'Example Workspace',
      timezone: 'America/Indiana/Indianapolis',
      currency: 'USD',
    });
    expect(res.ok).toBe(true);
    expect(insertedOrg()).toMatchObject({ timezone: 'America/Indiana/Indianapolis' });
  });
});
