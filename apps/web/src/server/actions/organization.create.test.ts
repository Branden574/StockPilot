import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeSupabaseStub, type SupabaseStub } from '@/test/supabase-mock';

/**
 * A NEW WORKSPACE THAT FAILS SAYS SO IN PLAIN WORDS (S31).
 *
 * createOrganizationAction's result reaches the browser as it is. Without the
 * service-role key it answered the setting's name and where to add it, and a
 * failed insert answered Postgres text (the service-role client: no row-level
 * security). None of it was reported. Now: "This feature is not set up yet."
 * for the missing key, the fixed sentence for a failed write, and the text in
 * the report.
 */

vi.mock('next/cache', () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => undefined) }));
// S20 (#424) puts the platform-admin gate in front of this action. The gate is
// not under test here (organization.create-gate.test.ts runs the real one), so
// it lets this caller through.
vi.mock('@/lib/auth/platform-admin', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/platform-admin')>()),
  checkPlatformAdmin: vi.fn(async () => ({
    ok: true,
    session: {
      userId: 'user-1',
      email: 'owner@example.test',
      fullName: null,
      avatarUrl: null,
      defaultOrganizationId: null,
    },
  })),
}));

const h = vi.hoisted(() => ({ stub: null as SupabaseStub | null, keyMissing: false }));
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => {
    if (h.keyMissing) throw new Error('SUPABASE_SERVICE_ROLE_KEY is not configured');
    return h.stub!.client;
  },
}));

import { reportError } from '@/lib/error-reporter';

import { createOrganizationAction } from './organization';

const INPUT = { name: 'Example Workspace', timezone: 'America/New_York', currency: 'USD' };

beforeEach(() => {
  vi.clearAllMocks();
  h.keyMissing = false;
  h.stub = makeSupabaseStub({
    'organizations.select': { data: null, error: null },
    'organizations.insert': { data: { id: 'org-1', slug: 'example-workspace' }, error: null },
    'organizations.delete': { data: null, error: null },
    'organization_members.insert': { data: null, error: null },
    'user_profiles.update': { data: null, error: null },
    'locations.insert': { data: null, error: null },
  });
});

describe('createOrganizationAction: failures say plain words (S31)', () => {
  it('without the service-role key: not set up yet, never the setting, reported as a warning', async () => {
    h.keyMissing = true;
    const res = await createOrganizationAction(INPUT);
    expect(res).toEqual({
      ok: false,
      error: { code: 'internal_error', message: 'This feature is not set up yet.' },
    });
    expect(JSON.stringify(res)).not.toMatch(/SUPABASE|\.env/);
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(vi.mocked(reportError).mock.calls[0]![1]).toEqual({
      tag: 'actions.organization.create',
      level: 'warning',
    });
  });

  it('a failed organization insert answers the fixed sentence; the text is only in the report', async () => {
    h.stub = makeSupabaseStub({
      'organizations.select': { data: null, error: null },
      'organizations.insert': {
        data: null,
        error: {
          message: 'duplicate key value violates unique constraint "organizations_slug_key"',
        },
      },
    });
    const res = await createOrganizationAction(INPUT);
    expect(res).toEqual({
      ok: false,
      error: { code: 'internal_error', message: 'Something went wrong. Please try again.' },
    });
    expect(JSON.stringify(res)).not.toContain('organizations_slug_key');
    const [reported, context] = vi.mocked(reportError).mock.calls[0]!;
    expect((reported as Error).message).toContain('organizations_slug_key');
    expect(context).toEqual({ tag: 'actions.organization.create' });
  });

  it('a failed owner seat still removes the organization, and answers the fixed sentence', async () => {
    h.stub = makeSupabaseStub({
      'organizations.select': { data: null, error: null },
      'organizations.insert': { data: { id: 'org-1', slug: 'example-workspace' }, error: null },
      'organizations.delete': { data: null, error: null },
      'organization_members.insert': {
        data: null,
        error: { message: 'insert or update on table "organization_members" violates foreign key' },
      },
    });
    const res = await createOrganizationAction(INPUT);
    expect(res).toEqual({
      ok: false,
      error: { code: 'internal_error', message: 'Something went wrong. Please try again.' },
    });
    expect(h.stub.chainsAll.get('organizations.delete')?.length).toBe(1);
    const [reported, context] = vi.mocked(reportError).mock.calls[0]!;
    expect((reported as Error).message).toContain('organization_members');
    expect(context).toEqual({ tag: 'actions.organization.create', organizationId: 'org-1' });
  });
});
