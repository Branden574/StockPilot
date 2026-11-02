// @vitest-environment node
// Node, not a DOM: a browser-like Request drops Origin and Sec-Fetch-*, which
// the cross-site cookie rule needs to see on this same-origin post.
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Security invariant (docket S43a): the client crash beacon is the one route on
 * the AAL1 allowlist (AAL1_ROUTES in src/test/api-step-up.guard.test.ts).
 *
 * withApiContext now refuses an account with a verified authenticator factor
 * until its session has the code. The error boundaries (app/error.tsx,
 * app/global-error.tsx) post here from /signin/mfa too, before the code, so
 * the route asks for the labelled context with allowStepUpPending and a crash
 * on the code screen still reaches the error feed. It reads nothing of the
 * organization's: it forwards the report, keyed by the verified user.
 *
 * Runs the REAL withApiContext against a fake client, so dropping the opt-out
 * fails here rather than going quiet in production.
 */

const refs = vi.hoisted(() => ({
  client: null as unknown,
  reportError: vi.fn(async () => {}),
}));

vi.mock('@/lib/error-reporter', () => ({
  reportError: (...a: unknown[]) => refs.reportError(...(a as [])),
}));
vi.mock('@/lib/env', () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: 'https://db.example.test',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-key',
  },
}));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true, remaining: 9, resetAt: Date.now() })),
}));
vi.mock('@supabase/supabase-js', () => ({ createClient: () => refs.client }));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => refs.client }));

import { POST } from './route';

const USER = '99999999-9999-4999-8999-999999999999';
const ORG = 'aaaaaaaa-1111-4111-8111-111111111111';

const world = {
  factors: [] as Array<{ status: string }>,
  aal: 'aal1' as 'aal1' | 'aal2',
};

function makeClient() {
  return {
    rpc: async () => ({
      data: {
        user_id: USER,
        profile: {
          id: USER,
          email: 'person@example.test',
          full_name: null,
          avatar_url: null,
          default_organization_id: ORG,
          disabled_at: null,
        },
        memberships: [
          {
            organization_id: ORG,
            role: 'staff',
            organization: {
              id: ORG,
              name: 'Org',
              logo_url: null,
              terminology: null,
              mfa_policy: 'optional',
              timezone: null,
              nav_overrides: null,
              dashboard_layout: null,
              order_status_config: null,
              all_modules_comp: false,
              order_catalog_last_hide_at: null,
            },
            role_overrides: [],
            user_overrides: [],
            enabled_modules: [],
          },
        ],
      },
      error: null,
    }),
    from: () => {
      throw new Error('the beacon reads no table');
    },
    auth: {
      getUser: async () => ({ data: { user: { id: USER, factors: world.factors } }, error: null }),
      mfa: {
        getAuthenticatorAssuranceLevel: async () => ({
          data: { currentLevel: world.aal, nextLevel: 'aal2' },
          error: null,
        }),
      },
    },
  };
}

/** What the error boundary posts: same origin, with the session cookie. */
function beacon(body: Record<string, unknown>, withSession = true): Request {
  return new Request('https://app.test/api/client-error', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: 'https://app.test',
      'sec-fetch-site': 'same-origin',
      ...(withSession ? { cookie: 'sb-example-auth-token=abc' } : {}),
    },
    body: JSON.stringify(body),
  });
}

const REPORT = { message: 'Render failed', digest: 'd-1', path: '/signin/mfa', boundary: 'global' };

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  world.factors = [];
  world.aal = 'aal1';
  refs.client = makeClient();
});

describe('POST /api/client-error', () => {
  it('an enrolled session that has not entered its code yet still has its crash report accepted', async () => {
    world.factors = [{ status: 'verified' }];
    world.aal = 'aal1';

    const res = await POST(beacon(REPORT));

    expect(res.status).toBe(204);
    expect(refs.reportError).toHaveBeenCalledTimes(1);
    expect(refs.reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tag: 'client.boundary',
        organizationId: ORG,
        extra: { digest: 'd-1', path: '/signin/mfa', boundary: 'global' },
      }),
    );
  });

  it('an enrolled session at aal2, and a member with no factor, are accepted as before', async () => {
    world.factors = [{ status: 'verified' }];
    world.aal = 'aal2';
    await POST(beacon(REPORT));
    world.factors = [];
    world.aal = 'aal1';
    await POST(beacon(REPORT));
    expect(refs.reportError).toHaveBeenCalledTimes(2);
  });

  it('a post with no session is answered 204 and reports nothing', async () => {
    const res = await POST(beacon(REPORT, false));
    expect(res.status).toBe(204);
    expect(refs.reportError).not.toHaveBeenCalled();
  });
});
