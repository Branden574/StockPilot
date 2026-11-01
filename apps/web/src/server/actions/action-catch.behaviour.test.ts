// @vitest-environment node
import { getURLFromRedirectError } from 'next/dist/client/components/redirect';
import { isRedirectError } from 'next/dist/client/components/redirect-error';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A SIGNED-OUT ACTION GOES TO SIGN-IN; A REAL FAILURE STILL SAYS WHAT FAILED.
 *
 * Nothing between the action and the session gate is stubbed: the action
 * calls its service's forCurrentUser() (or withContext() itself), which calls
 * requireOrgContext(), which finds no session on the request (the proxy
 * deleted the identity header, as it does for a signed-out request) and calls
 * redirect() to sign-in with the page to come back to. Next.js carries that
 * redirect as a thrown error, and the catch in each action used to turn it
 * into a result: `internal_error: 'NEXT_REDIRECT'`, "Failed to save view.",
 * or `{ ok: false }`, so the page said something went wrong and stayed put.
 *
 * One action per catch shape the fix touched: a module's shared toResult
 * mapper (tags), a catch written out in the action (saved views), and a catch
 * that bound no error at all (tour state).
 */

const { requestHeaders } = vi.hoisted(() => ({
  requestHeaders: { current: {} as Record<string, string> },
}));

vi.mock('next/headers', () => ({
  headers: vi.fn(async () => new Headers(requestHeaders.current)),
  cookies: vi.fn(async () => ({
    get: () => undefined,
    getAll: () => [],
    set: () => {},
    delete: () => {},
  })),
}));
vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
  unstable_cache: (f: unknown) => f,
}));
vi.mock('@/server/loaders/inventory-list', () => ({
  revalidateInventoryListForCurrentOrg: vi.fn(),
}));
// The request reaches no Supabase client: with no identity header the gate
// answers before any read. withContext() starts the MFA factor read first
// (it overlaps it with the context); stubbed so nothing real loads.
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => {
    throw new Error('no client is created for a request with no session');
  },
}));
vi.mock('@/lib/dashboard/request-cache', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/dashboard/request-cache')>()),
  getMfaFactorsForRequest: vi.fn(async () => ({ data: { all: [], totp: [] }, error: null })),
}));

import { ServiceError } from '@/server/services/context';
import { SavedViewsService } from '@/server/services/saved-views';
import { TagsService } from '@/server/services/tags';
import { getTourStateAction } from '@/lib/onboarding/actions';

import { createSavedViewAction } from './saved-views';
import { createTagAction } from './tags';

const RETURN_PATH = 'x-stockpilot-return-path';

/** The sign-in URL the request was redirected to, or a description of what it got instead. */
async function redirectedTo(run: () => Promise<unknown>): Promise<string> {
  try {
    const answer = await run();
    return `answered ${JSON.stringify(answer)}`;
  } catch (e) {
    return isRedirectError(e) ? getURLFromRedirectError(e) : `threw ${String(e)}`;
  }
}

beforeEach(() => {
  vi.restoreAllMocks();
  // A signed-out request: the proxy forwards no identity, and the page the
  // action was sent from.
  requestHeaders.current = { [RETURN_PATH]: '/dashboard/tags?q=sale' };
});

describe('an action called with no session', () => {
  const SIGN_IN = '/signin?redirect=%2Fdashboard%2Ftags%3Fq%3Dsale';

  it('createTagAction (a shared toResult mapper) redirects to sign-in with the return path', async () => {
    expect(await redirectedTo(() => createTagAction({ name: 'Clearance' }))).toBe(SIGN_IN);
  });

  it('createSavedViewAction (its own catch) redirects to sign-in with the return path', async () => {
    expect(
      await redirectedTo(() =>
        createSavedViewAction({ scope: 'inventory', name: 'Low stock', state: {} as never }),
      ),
    ).toBe(SIGN_IN);
  });

  it('getTourStateAction (a catch that bound no error) redirects to sign-in with the return path', async () => {
    expect(await redirectedTo(() => getTourStateAction())).toBe(SIGN_IN);
  });
});

describe('an action whose service fails', () => {
  it('createTagAction still answers with the service error and its message', async () => {
    vi.spyOn(TagsService, 'forCurrentUser').mockResolvedValue({
      create: async () => {
        throw new ServiceError('conflict', 'A tag with this name already exists.');
      },
    } as unknown as TagsService);

    expect(await createTagAction({ name: 'Clearance' })).toEqual({
      ok: false,
      error: { code: 'conflict', message: 'A tag with this name already exists.' },
    });
  });

  it('createSavedViewAction still answers with the service error, and an unknown one stays generic', async () => {
    const create = vi
      .fn()
      .mockRejectedValueOnce(new ServiceError('validation_error', 'Give the view a name.'))
      .mockRejectedValueOnce(new Error('socket hang up'));
    vi.spyOn(SavedViewsService, 'forCurrentUser').mockResolvedValue({
      create,
    } as unknown as SavedViewsService);
    const input = { scope: 'inventory' as const, name: 'x', state: {} as never };

    expect(await createSavedViewAction(input)).toEqual({
      ok: false,
      error: { code: 'validation_error', message: 'Give the view a name.' },
    });
    expect(await createSavedViewAction(input)).toEqual({
      ok: false,
      error: { code: 'internal_error', message: 'Failed to save view.' },
    });
  });
});
