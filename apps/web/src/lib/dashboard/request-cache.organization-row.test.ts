import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeSupabaseStub, type SupabaseStub } from '@/test/supabase-mock';

/**
 * The organization row read (getOrgRowForRequest) when it does not answer.
 *
 * The row holds the authenticator policy, so a read that failed is never
 * taken for a row with default settings: it throws. It throws the
 * "could not check your access" error (OrganizationRowUnavailableError),
 * which carries the same fixed digest as a module state that could not be
 * read. A page that reaches it shows the plain "We couldn't check your access
 * just now" state with Try again, and a Server Action answers its try-again
 * sentence. The database's own words stay in the server log, never in the
 * error's message.
 *
 * A row that was read, and a row hidden from the member (no error), answer
 * exactly as before.
 */

const holder = vi.hoisted(() => ({ stub: null as SupabaseStub | null }));
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => holder.stub!.client),
}));
vi.mock('@/lib/auth/request-context-bundle', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/request-context-bundle')>()),
  loadRequestContextBundle: vi.fn(async () => null),
}));

import { OrganizationRowUnavailableError } from '@/lib/auth/organization-row-unavailable';
import { ACCESS_UNCHECKED_DIGEST, knownErrorState } from '@/lib/known-error-states';

import { getModulesForRequest, getOrgRowForRequest } from './request-cache';

const ORG = 'org-1';
const ROW = {
  terminology: null,
  mfa_policy: 'optional',
  logo_url: null,
  timezone: 'America/Los_Angeles',
  nav_overrides: null,
  dashboard_layout: null,
  order_status_config: null,
  all_modules_comp: false,
};
const FAILED = {
  data: null,
  error: { message: 'permission denied for table organizations', code: '42501' },
};

function organizations(answer: { data: unknown; error: unknown }) {
  holder.stub = makeSupabaseStub({
    'organizations.select': answer as never,
    'organization_modules.select': { data: [{ module_id: 'orders' }], error: null } as never,
  });
}

async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error('expected the read to reject');
}

let consoleError: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.clearAllMocks();
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('getOrgRowForRequest: a read that did not answer', () => {
  it('throws the could-not-check error with the access digest, never a row with default settings', async () => {
    organizations(FAILED);
    const e = await rejection(getOrgRowForRequest(ORG));
    expect(e).toBeInstanceOf(OrganizationRowUnavailableError);
    expect((e as { digest?: unknown }).digest).toBe(ACCESS_UNCHECKED_DIGEST);
    expect(knownErrorState(e)?.key).toBe('access-unchecked');
    expect((e as Error).message).toBe('Your access could not be checked. Please try again.');
  });

  it("keeps the database's words on the server: logged, never in the error's message", async () => {
    organizations(FAILED);
    const e = await rejection(getOrgRowForRequest(ORG));
    expect((e as Error).message).not.toMatch(/permission denied|organizations|42501/);
    const logged = consoleError.mock.calls.map((c: unknown[]) => c.join(' ')).join('\n');
    expect(logged).toContain('42501');
  });

  it('the module set that takes its comp flag from the same row rejects with the same error', async () => {
    organizations(FAILED);
    const e = await rejection(getModulesForRequest(ORG));
    expect(e).toBeInstanceOf(OrganizationRowUnavailableError);
    expect(knownErrorState(e)?.key).toBe('access-unchecked');
  });
});

describe('getOrgRowForRequest: an answer, as before', () => {
  it('a row that was read is that row', async () => {
    organizations({ data: [ROW], error: null });
    await expect(getOrgRowForRequest(ORG)).resolves.toEqual(ROW);
  });

  it('a row hidden from the member (no error) is null, not an error', async () => {
    organizations({ data: [], error: null });
    await expect(getOrgRowForRequest(ORG)).resolves.toBeNull();
  });
});
