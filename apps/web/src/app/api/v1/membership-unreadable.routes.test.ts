// @vitest-environment node
// Node, not a DOM: a browser-like Request drops the cookie header a web tab sends.
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * SECURITY TEST: /api/v1 routes when the membership choice cannot be read.
 *
 * The real withApiContext runs on its legacy reads (the one-round-trip context
 * read fails) and the real route runs behind it; only the database is a
 * double (src/test/legacy-api-context.ts). When the read that decides the
 * caller's organization does not answer, every route refuses with an answer
 * the phone retries, and does no work:
 *
 *   - the stock adjustment, which the phone cannot send twice, answers the API
 *     context gate's 503 marked as refused before any write (core
 *     contextUnavailableBody): a queued adjustment stays queued;
 *   - a route whose catch is internalErrorResponse answers its 500 with the
 *     fixed try-again sentence;
 *   - a route with no catch around the context lets the error reach Next,
 *     which answers 500.
 *
 * A membership read that answers still answers as before.
 */

const refs = vi.hoisted(() => ({
  client: null as unknown,
  /** Made-up values: the client double ignores both. */
  projectUrl: 'https://example.supabase.co',
  publicValue: 'test-public-value',
}));

vi.mock('@/lib/env', () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: refs.projectUrl,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: refs.publicValue,
  },
}));
vi.mock('@supabase/supabase-js', () => ({ createClient: () => refs.client }));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => refs.client }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => {}) }));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true, resetAt: Date.now() + 60_000 })),
}));
vi.mock('@/server/loaders/inventory-list', () => ({ revalidateInventoryList: vi.fn() }));

import { contextUnavailableBody, isRefusedBeforeAnyWrite } from '@stockpilot/core';

import {
  LEGACY_ORG_ID,
  legacyBearerToken,
  legacyContextClient,
  legacyContextWorld,
  legacyPhoneHeaders,
  routeWork,
  type LegacyContextWorld,
} from '@/test/legacy-api-context';

import { POST as signedOutPOST } from './auth/signed-out/route';
import { POST as adjustPOST } from './items/[id]/adjust/route';
import { GET as permissionsGET } from './me/permissions/route';

const ITEM = '22222222-0000-4000-8000-000000000004';
const WAREHOUSE = '11111111-0000-4000-8000-000000000003';
/** The person's first membership. */
const OLDEST = '77777777-0000-4000-8000-00000000000a';

/** The refusal (lib/auth/membership-unavailable.ts), matched by name and code. */
const REFUSED = { name: 'MembershipUnavailableError', code: 'MEMBERSHIP_UNAVAILABLE' };

let world: LegacyContextWorld;

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  world = legacyContextWorld({
    role: 'admin',
    memberships: [
      { organization_id: OLDEST, role: 'staff' },
      { organization_id: LEGACY_ORG_ID, role: 'admin' },
    ],
    defaultOrganizationId: LEGACY_ORG_ID,
  });
  refs.client = legacyContextClient(world);
});

function phonePost(path: string, body: unknown): NextRequest {
  return new NextRequest(`https://app.example.test${path}`, {
    method: 'POST',
    headers: legacyPhoneHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify(body),
  });
}

/** A phone request before its workspace is saved: no organization header. */
function phoneGetNoOrg(path: string): NextRequest {
  return new NextRequest(`https://app.example.test${path}`, {
    headers: { authorization: `Bearer ${legacyBearerToken()}` },
  });
}

/** A web tab's request: the session cookie, no organization header. */
function cookieGet(path: string): NextRequest {
  return new NextRequest(`https://app.example.test${path}`, {
    headers: { cookie: 'sb-example-auth-token=made-up-cookie' },
  });
}

const adjust = () =>
  adjustPOST(
    phonePost(`/api/v1/items/${ITEM}/adjust`, { warehouseId: WAREHOUSE, quantityChange: 1 }),
    {
      params: Promise.resolve({ id: ITEM }),
    },
  );

describe('a write the phone cannot send twice: POST /api/v1/items/[id]/adjust', () => {
  it('the membership in the named organization unreadable: the 503 marked as refused before any write, and no work', async () => {
    world.membershipReadFails = { read: 'named', orgId: LEGACY_ORG_ID, how: 'error' };
    const res = await adjust();
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('5');
    const body = await res.json();
    expect(body).toEqual(contextUnavailableBody());
    expect(
      isRefusedBeforeAnyWrite({ status: res.status, code: body.error, details: body.details }),
    ).toBe(true);
    expect(routeWork(world)).toEqual([]);
  });

  it('not a member of the named organization: the 401 it always got', async () => {
    world.memberships = [{ organization_id: OLDEST, role: 'staff' }];
    const res = await adjust();
    expect(res.status).toBe(401);
  });
});

describe('a route whose catch is internalErrorResponse: POST /api/v1/auth/signed-out', () => {
  it('the membership in the named organization unreadable: a 500 with the try-again sentence, never 401', async () => {
    world.membershipReadFails = { read: 'named', orgId: LEGACY_ORG_ID, how: 'error' };
    const res = await signedOutPOST(phonePost('/api/v1/auth/signed-out', {}));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: 'internal_error',
      message: 'Your access could not be checked. Please try again.',
    });
  });
});

describe('a route with no catch around the context: GET /api/v1/me/permissions', () => {
  it('a member: their role in the organization they asked for', async () => {
    const res = await permissionsGET(
      new NextRequest('https://app.example.test/api/v1/me/permissions', {
        headers: legacyPhoneHeaders(),
      }),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { role: string }).role).toBe('admin');
  });

  it.each([
    ['the phone before its workspace is saved', phoneGetNoOrg],
    ['a web tab', cookieGet],
  ])('%s, default organization: its role there', async (_who, make) => {
    const res = await permissionsGET(make('/api/v1/me/permissions'));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { role: string }).role).toBe('admin');
  });

  it.each([
    ['the phone before its workspace is saved', phoneGetNoOrg],
    ['a web tab', cookieGet],
  ])('%s, the profile default unreadable: refused (Next answers 500)', async (_who, make) => {
    world.membershipReadFails = { read: 'profile', how: 'error' };
    await expect(permissionsGET(make('/api/v1/me/permissions'))).rejects.toMatchObject(REFUSED);
  });

  it.each([
    ['the phone before its workspace is saved', phoneGetNoOrg],
    ['a web tab', cookieGet],
  ])('%s, the default membership unreadable: refused (Next answers 500)', async (_who, make) => {
    world.membershipReadFails = { read: 'named', orgId: LEGACY_ORG_ID, how: 'error' };
    await expect(permissionsGET(make('/api/v1/me/permissions'))).rejects.toMatchObject(REFUSED);
  });
});
