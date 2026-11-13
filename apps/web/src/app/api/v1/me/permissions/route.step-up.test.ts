// @vitest-environment node
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Security invariant (docket S43c): an /api route answers a session that
 * still owes its authenticator code in its own words, never with the page
 * redirect.
 *
 * requireOrgContext() (lib/auth/session.ts) now sends such a session to
 * /signin/mfa. That is an answer for a page or a Server Action. A route
 * handler is called by fetch() and by the phone, which need a status and a
 * JSON body, and the routes already give one (docket S43a,
 * lib/auth/api-context.step-up.test.ts):
 *   - withApiContext() gives no context, and the route answers its own 401;
 *   - a route that opts out (allowStepUpPending) gets a context labelled "not
 *     satisfied", and assertPermission refuses it with 403 and
 *     `reason: 'aal2_required'`, the shape the step-up prompts read.
 * Neither changes here. The route below is a real one, through the real
 * withApiContext on a cookie session; only the network is faked.
 */

const redirect = vi.fn((to: string) => {
  throw new Error(`REDIRECT:${to}`);
});
vi.mock('next/navigation', () => ({ redirect: (to: string) => redirect(to) }));
vi.mock('next/headers', async () => {
  const f = await import('@/test/step-up-session-fixture');
  return {
    headers: async () => f.fixtureHeaders(),
    cookies: async () => ({ get: () => undefined, getAll: () => [], set: () => {} }),
  };
});
vi.mock('@/lib/supabase/server', async () => {
  const f = await import('@/test/step-up-session-fixture');
  return { createClient: async () => f.fixtureClient() };
});
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => {}) }));

import { withApiContext } from '@/lib/auth/api-context';
import { assertPermission, ServiceError, serviceErrorStatus } from '@/server/services/context';
import { resetWorld, USER, VERIFIED_FACTOR, world } from '@/test/step-up-session-fixture';

import { GET } from './route';

/** A browser's request with its session cookie (the fixture client stands in for what it holds). */
const request = () =>
  new Request('https://app.example.test/api/v1/me/permissions', {
    headers: { cookie: 'sb-exampleproject-auth-token=held-by-the-fixture' },
  });

beforeEach(() => {
  redirect.mockClear();
  resetWorld();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('GET /api/v1/me/permissions on a cookie session', () => {
  it('a member with a verified factor at aal1: 401 and a JSON body, no redirect', async () => {
    world.factors = VERIFIED_FACTOR;
    const res = await GET(request());
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized' });
    expect(res.headers.get('location')).toBeNull();
    expect(redirect).not.toHaveBeenCalled();
    // Refused right after the identity read, before the context is resolved.
    expect(world.calls).toContain('auth:getUser');
    expect(world.calls.filter((c) => c.startsWith('rpc:') || c.startsWith('from:'))).toEqual([]);
  });

  it('the same member at aal2 is answered', async () => {
    world.factors = VERIFIED_FACTOR;
    world.aal = 'aal2';
    const res = await GET(request());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ role: 'staff' });
  });

  it('a member with no factor is answered at aal1', async () => {
    const res = await GET(request());
    expect(res.status).toBe(200);
    expect(redirect).not.toHaveBeenCalled();
  });
});

describe('a route that must answer before the code', () => {
  it('gets a context labelled "not satisfied", which assertPermission refuses with 403 aal2_required', async () => {
    world.factors = VERIFIED_FACTOR;
    const ctx = await withApiContext(request(), { allowStepUpPending: true });
    expect(ctx).toMatchObject({
      userId: USER,
      mfaRequired: true,
      mfaSatisfied: false,
      mfaEnrolled: true,
    });
    let refusal: unknown;
    try {
      assertPermission(ctx!, 'items:read');
    } catch (e) {
      refusal = e;
    }
    expect(refusal).toBeInstanceOf(ServiceError);
    const error = refusal as ServiceError;
    expect(serviceErrorStatus(error.code)).toBe(403);
    expect(error.details).toEqual({ reason: 'aal2_required' });
    expect(redirect).not.toHaveBeenCalled();
  });
});

describe('the API context cannot reach the page redirect', () => {
  it('lib/auth/api-context.ts imports neither the session loader nor its gate', () => {
    const source = readFileSync(
      path.resolve(__dirname, '../../../../../lib/auth/api-context.ts'),
      'utf8',
    );
    const imported = [...source.matchAll(/^import[^;]*?from\s+'([^']+)';/gms)].map((m) => m[1]);
    expect(imported.length).toBeGreaterThan(8);
    expect(imported).not.toContain('@/lib/auth/session');
    expect(imported).not.toContain('@/lib/auth/step-up-gate');
    expect(imported).not.toContain('next/navigation');
  });
});
