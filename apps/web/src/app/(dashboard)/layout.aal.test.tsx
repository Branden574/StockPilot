// @vitest-environment node
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Security invariant: the dashboard layout's AAL2 gate for an enrolled member
 * (HI-6) reads the session's level from an access token whose signature has
 * been checked.
 *
 * It read auth.mfa.getAuthenticatorAssuranceLevel() on a fresh server client,
 * which decodes the cookie's token unchecked and reads the cookie's stored
 * user object; auth-js logged "could be insecure" for it on every dashboard
 * render of such a member. The node environment is deliberate: the layout's
 * output is a React element tree that nothing here renders, and the session
 * is read by the REAL server client and auth-js, against the fixture's ES256
 * keys and Auth server (src/test/auth-session-fixture.ts), which need Node's
 * WebCrypto.
 */

let jar = new Map<string, string>();
vi.mock('next/headers', async () => {
  const { cookieStoreOver } = await import('@/test/auth-session-fixture');
  return {
    cookies: async () => cookieStoreOver(jar),
    headers: async () => new Headers({ 'x-pathname': '/dashboard/purchase-orders' }),
  };
});
vi.mock('@/lib/env', async () => {
  const f = await import('@/test/auth-session-fixture');
  return {
    env: {
      NEXT_PUBLIC_SUPABASE_URL: f.FIXTURE_SUPABASE_URL,
      NEXT_PUBLIC_SUPABASE_ANON_KEY: f.FIXTURE_ANON_KEY,
    },
  };
});
vi.mock('next/navigation', () => ({
  redirect: vi.fn((to: string) => {
    throw new Error(`REDIRECT:${to}`);
  }),
}));
vi.mock('@/components/dashboard/dashboard-shell', () => ({ DashboardShell: () => null }));
vi.mock('@/components/dashboard/mfa-required-banner', () => ({ MfaRequiredBanner: () => null }));
vi.mock('@/components/dashboard/sidebar-pref', () => ({
  SIDEBAR_HIDDEN_COOKIE: 'sidebar-hidden',
  parseSidebarHidden: () => false,
  DENSITY_COOKIE: 'density',
  parseDensity: () => 'comfortable',
  NAV_COLLAPSED_COOKIE: 'nav-collapsed',
  parseCollapsedSections: () => null,
}));
vi.mock('@/components/platform/impersonation-banner', () => ({ ImpersonationBanner: () => null }));
vi.mock('@/components/realtime/inventory-realtime', () => ({ InventoryRealtime: () => null }));
vi.mock('@/components/activity-beacon', () => ({ ActivityBeacon: () => null }));
vi.mock('@/lib/auth/platform-admin', () => ({
  currentUserIsPlatformAdminFromRequestHeader: vi.fn(async () => false),
}));
vi.mock('@/lib/auth/session', () => ({
  requireOrgContext: vi.fn(async () => ({
    userId: '11111111-1111-4111-8111-111111111111',
    email: 'member@example.com',
    fullName: null,
    avatarUrl: null,
    defaultOrganizationId: 'org-1',
    organizationId: 'org-1',
    organizationName: 'Acme',
    role: 'staff',
    permissions: new Set(),
  })),
  getSessionMemberships: vi.fn(async () => []),
}));
// An enrolled member: the layout's gate applies under the 'optional' policy.
vi.mock('@/lib/dashboard/request-cache', () => ({
  getMfaFactorsForRequest: vi.fn(async () => [{ status: 'verified' }]),
  getModulesForRequest: vi.fn(async () => new Set()),
  getOrgRowForRequest: vi.fn(async () => ({
    terminology: null,
    mfa_policy: 'optional',
    logo_url: null,
    timezone: null,
    nav_overrides: null,
    dashboard_layout: null,
    order_status_config: null,
  })),
  getWarehousesForRequest: vi.fn(async () => []),
}));
vi.mock('@/lib/auth/warehouse', () => ({
  getWarehouseAccess: vi.fn(async () => ({
    readableIds: [],
    writableIds: [],
    hasAllAccess: false,
    primaryWarehouseId: null,
  })),
}));
vi.mock('@/lib/warehouse-filter', () => ({ getActiveWarehouseFilter: vi.fn(async () => null) }));

import {
  INSECURE_USER_WARNING,
  fakeAuthServer,
  makeSigningKey,
  sessionClaims,
  sessionCookies,
  signAccessToken,
  unsignedToken,
  withEditedPayload,
  type FakeAuthServer,
  type SigningKey,
} from '@/test/auth-session-fixture';

import { getMfaFactorsForRequest } from '@/lib/dashboard/request-cache';

import DashboardLayout from './layout';

const TO_CHALLENGE = 'REDIRECT:/signin/mfa?redirect=%2Fdashboard%2Fpurchase-orders';

let projectKey: SigningKey;
let attackerKey: SigningKey;
let server: FakeAuthServer;
let warn: ReturnType<typeof vi.spyOn>;

beforeAll(async () => {
  projectKey = await makeSigningKey('project-kid-1');
  attackerKey = await makeSigningKey('attacker-kid');
});

beforeEach(() => {
  server = fakeAuthServer(projectKey);
  vi.stubGlobal('fetch', server.fetch);
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  jar = new Map();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function signIn(claims: Record<string, unknown>, token?: string) {
  jar = sessionCookies(token ?? (await signAccessToken(projectKey, claims)), claims);
}

const insecureWarnings = () =>
  warn.mock.calls.filter((c: unknown[]) => INSECURE_USER_WARNING.test(String(c[0]))).length;

describe('DashboardLayout — the enrolled member AAL2 gate reads a verified level', () => {
  it('a verified AAL2 session renders the dashboard, with no warning and no Auth round trip', async () => {
    await signIn(sessionClaims({ aal: 'aal2' }));
    await expect(DashboardLayout({ children: null })).resolves.toBeTruthy();
    expect(insecureWarnings()).toBe(0);
    expect(server.calls['/user']).toBeUndefined();
  });

  it('a verified AAL1 session is sent to the MFA challenge', async () => {
    await signIn(sessionClaims({ aal: 'aal1' }));
    await expect(DashboardLayout({ children: null })).rejects.toThrow(TO_CHALLENGE);
  });

  it('a token edited to claim AAL2 is sent to the MFA challenge', async () => {
    const real = await signAccessToken(projectKey, sessionClaims({ aal: 'aal1' }));
    const forged = sessionClaims({ aal: 'aal2' });
    await signIn(forged, withEditedPayload(real, forged));
    await expect(DashboardLayout({ children: null })).rejects.toThrow(TO_CHALLENGE);
  });

  it("a token signed with another key under the project's key id is sent to the MFA challenge", async () => {
    const forged = sessionClaims({ aal: 'aal2' });
    await signIn(forged, await signAccessToken(attackerKey, forged, projectKey.kid));
    await expect(DashboardLayout({ children: null })).rejects.toThrow(TO_CHALLENGE);
  });

  it('an unsigned token claiming AAL2 is sent to the MFA challenge', async () => {
    const forged = sessionClaims({ aal: 'aal2' });
    await signIn(forged, unsignedToken(forged));
    await expect(DashboardLayout({ children: null })).rejects.toThrow(TO_CHALLENGE);
  });

  it('an expired AAL2 token that cannot be refreshed is sent to the MFA challenge', async () => {
    await signIn(sessionClaims({ aal: 'aal2', expiresIn: -120 }));
    await expect(DashboardLayout({ children: null })).rejects.toThrow(TO_CHALLENGE);
  });
});

/**
 * Page renders run in their own server function, apart from the proxy, so
 * they keep their own key set: auth-js caches it per instance for 10 minutes.
 * The first read in an instance (and the first after the cache expires)
 * fetches it from the Auth server. That fetch must run alongside the layout's
 * batch of reads, which already waits on the factor list's GoTrue round trip,
 * not after the batch, where it would add one more Supabase call in series.
 * A key id no client here has cached stands in for a cold cache: getClaims()
 * has to fetch the key set for it.
 */
describe('DashboardLayout — the verified claims read starts with the batch, not after it', () => {
  it('a cold key-set fetch is under way while the factor list is still pending', async () => {
    const coldKey = await makeSigningKey('project-kid-cold-layout');
    server = fakeAuthServer([projectKey, coldKey]);
    vi.stubGlobal('fetch', server.fetch);
    let answerFactors!: (factors: Array<{ status: string }>) => void;
    vi.mocked(getMfaFactorsForRequest).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answerFactors = resolve;
        }),
    );
    const claims = sessionClaims({ aal: 'aal2' });
    await signIn(claims, await signAccessToken(coldKey, claims));

    const rendering = DashboardLayout({ children: null });
    await vi.waitFor(() =>
      expect(server.calls['/.well-known/jwks.json']).toBeGreaterThanOrEqual(1),
    );
    // Only now does the factor list answer: the key set was already on its way.
    answerFactors([{ status: 'verified' }]);
    await expect(rendering).resolves.toBeTruthy();
    expect(server.calls['/.well-known/jwks.json']).toBe(1);
    expect(server.calls['/user']).toBeUndefined();
  });

  it('a member with no authenticator is never held by it, even when the key set never answers', async () => {
    const heldKey = await makeSigningKey('project-kid-held-layout');
    server = fakeAuthServer([projectKey, heldKey]);
    server.jwksGate = new Promise(() => {});
    vi.stubGlobal('fetch', server.fetch);
    vi.mocked(getMfaFactorsForRequest).mockResolvedValueOnce([]);
    const claims = sessionClaims({ aal: 'aal1' });
    await signIn(claims, await signAccessToken(heldKey, claims));

    // The gate applies to enrolled members only; nothing else awaits the read.
    await expect(DashboardLayout({ children: null })).resolves.toBeTruthy();
  });
});
