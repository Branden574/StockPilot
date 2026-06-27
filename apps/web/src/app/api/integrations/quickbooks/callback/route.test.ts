import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getServerSession } from '@/lib/auth/session';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { audit } from '@/server/services/audit';
import { putConnectionSecret } from '@/server/connectors/secret-store';
import { exchangeCode } from '@/server/connectors/quickbooks/oauth';
import { makeSupabaseStub, type QueryResult } from '@/test/supabase-mock';

import { GET } from './route';

// Pin the base URL so we can assert exact redirect targets. The route reads
// env.NEXT_PUBLIC_APP_URL to build every redirect.
vi.mock('@/lib/env', () => ({
  env: { NEXT_PUBLIC_APP_URL: 'https://app.example.com' },
}));

vi.mock('@/lib/auth/session', () => ({
  getServerSession: vi.fn(),
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
}));

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: vi.fn(),
}));

vi.mock('@/server/services/audit', () => ({
  audit: vi.fn(),
}));

vi.mock('@/server/connectors/secret-store', () => ({
  putConnectionSecret: vi.fn(),
}));

vi.mock('@/server/connectors/quickbooks/oauth', () => ({
  exchangeCode: vi.fn(),
}));

// reportError must be inert in tests (the real one ships to a reporter).
vi.mock('@/lib/error-reporter', () => ({
  reportError: vi.fn(),
}));

const SETTINGS_PATH = '/dashboard/settings/integrations';
const CONNECTION_ID = '11111111-1111-1111-1111-111111111111';
const ORG_ID = '22222222-2222-2222-2222-222222222222';
const USER_ID = 'user-1';
const STATE = 'csrf-state-token';
const REALM_ID = '9999999999';

function buildSession() {
  return {
    userId: USER_ID,
    email: 'admin@example.com',
    fullName: 'Admin',
    avatarUrl: null,
    defaultOrganizationId: ORG_ID,
  };
}

/**
 * Build the RLS-scoped user client. Defaults model the happy path:
 *  - the pending org_connections row matches the CSRF state,
 *  - the integrations module is enabled,
 *  - the caller is an admin (holds integrations:manage).
 * Override any key to exercise a specific gate.
 */
function userClient(
  overrides: Record<string, QueryResult> = {},
  user: { id: string } | null = { id: USER_ID },
) {
  const stub = makeSupabaseStub({
    'org_connections.select': {
      data: [
        {
          id: CONNECTION_ID,
          organization_id: ORG_ID,
          status: 'pending',
          oauth_state: STATE,
        },
      ],
      error: null,
    },
    'organization_modules.select': {
      data: [{ module_id: 'integrations' }],
      error: null,
    },
    'organization_members.select': {
      data: [{ role: 'admin' }],
      error: null,
    },
    ...overrides,
  });
  // The route now validates the cookie session via supabase.auth.getUser()
  // (not the proxy-only getServerSession header). Pin it to the test user, or
  // null to model "not signed in".
  stub.client.auth.getUser = vi.fn(async () => ({ data: { user }, error: null }));
  return stub;
}

/**
 * Service-role admin client. The route uses it only for the
 * org_connections.update(); putConnectionSecret is mocked separately so the
 * admin stub never needs the secret RPCs. Records the update payload.
 */
function adminClient(updateError: { message: string } | null = null) {
  const updates: Array<Record<string, unknown>> = [];
  const eqArgs: Array<unknown[]> = [];
  const client = {
    from: vi.fn(() => ({
      update: vi.fn((payload: Record<string, unknown>) => {
        updates.push(payload);
        return {
          eq: vi.fn((...args: unknown[]) => {
            eqArgs.push(args);
            return Promise.resolve({ error: updateError });
          }),
        };
      }),
    })),
  };
  return { client, updates, eqArgs };
}

function callbackUrl(params: Record<string, string>) {
  const url = new URL('https://app.example.com/api/integrations/quickbooks/callback');
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return new Request(url.toString());
}

function location(res: Response) {
  return new URL(res.headers.get('location') ?? '');
}

describe('GET /api/integrations/quickbooks/callback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: a signed-in admin. Individual tests override as needed.
    vi.mocked(getServerSession).mockResolvedValue(buildSession());
    vi.mocked(createClient).mockResolvedValue(userClient().client as never);
    vi.mocked(createAdminClient).mockReturnValue(adminClient().client as never);
    vi.mocked(putConnectionSecret).mockResolvedValue('secret-handle-1');
    vi.mocked(exchangeCode).mockResolvedValue({
      accessToken: 'ACCESS-TOKEN-SECRET',
      refreshToken: 'REFRESH-TOKEN-SECRET',
      expiresAt: '2026-01-01T00:00:00.000Z',
      realmId: REALM_ID,
    });
  });

  it('redirects to /signin (302) when there is no session', async () => {
    // No authenticated cookie user -> the route bounces to /signin.
    vi.mocked(createClient).mockResolvedValueOnce(userClient({}, null).client as never);

    const res = await GET(
      callbackUrl({ code: 'c', state: STATE, realmId: REALM_ID }),
    );

    expect(res.status).toBe(302);
    expect(location(res).pathname).toBe('/signin');
    expect(exchangeCode).not.toHaveBeenCalled();
  });

  it('redirects with error=access_denied when the user declined consent', async () => {
    const res = await GET(
      callbackUrl({ error: 'access_denied', state: STATE }),
    );

    expect(res.status).toBe(302);
    const loc = location(res);
    expect(loc.pathname).toBe(SETTINGS_PATH);
    expect(loc.searchParams.get('error')).toBe('access_denied');
    expect(exchangeCode).not.toHaveBeenCalled();
  });

  it('redirects with error=invalid_request when code/state/realmId are missing', async () => {
    // Missing code.
    const res = await GET(callbackUrl({ state: STATE, realmId: REALM_ID }));
    expect(res.status).toBe(302);
    expect(location(res).searchParams.get('error')).toBe('invalid_request');
    expect(exchangeCode).not.toHaveBeenCalled();
  });

  it('CSRF guard: redirects with error=invalid_state when no pending row matches the state', async () => {
    vi.mocked(createClient).mockResolvedValueOnce(
      userClient({ 'org_connections.select': { data: [], error: null } }).client as never,
    );

    const res = await GET(
      callbackUrl({ code: 'c', state: 'forged-state', realmId: REALM_ID }),
    );

    expect(res.status).toBe(302);
    expect(location(res).searchParams.get('error')).toBe('invalid_state');
    // The CSRF check happens before the token exchange — no tokens are fetched
    // for an unrecognized state.
    expect(exchangeCode).not.toHaveBeenCalled();
    expect(putConnectionSecret).not.toHaveBeenCalled();
  });

  it('redirects with error=module_disabled (and skips exchangeCode) when integrations is off', async () => {
    vi.mocked(createClient).mockResolvedValueOnce(
      userClient({ 'organization_modules.select': { data: [], error: null } }).client as never,
    );

    const res = await GET(
      callbackUrl({ code: 'c', state: STATE, realmId: REALM_ID }),
    );

    expect(res.status).toBe(302);
    expect(location(res).searchParams.get('error')).toBe('module_disabled');
    expect(exchangeCode).not.toHaveBeenCalled();
    expect(putConnectionSecret).not.toHaveBeenCalled();
  });

  it('redirects with error=forbidden (and skips exchangeCode) when the role lacks integrations:manage', async () => {
    // manager does NOT hold integrations:manage (admin-only permission).
    vi.mocked(createClient).mockResolvedValueOnce(
      userClient({
        'organization_members.select': { data: [{ role: 'manager' }], error: null },
      }).client as never,
    );

    const res = await GET(
      callbackUrl({ code: 'c', state: STATE, realmId: REALM_ID }),
    );

    expect(res.status).toBe(302);
    expect(location(res).searchParams.get('error')).toBe('forbidden');
    expect(exchangeCode).not.toHaveBeenCalled();
    expect(putConnectionSecret).not.toHaveBeenCalled();
  });

  it('redirects with error=forbidden when the user is not an accepted member', async () => {
    vi.mocked(createClient).mockResolvedValueOnce(
      userClient({
        'organization_members.select': { data: [], error: null },
      }).client as never,
    );

    const res = await GET(
      callbackUrl({ code: 'c', state: STATE, realmId: REALM_ID }),
    );

    expect(res.status).toBe(302);
    expect(location(res).searchParams.get('error')).toBe('forbidden');
    expect(exchangeCode).not.toHaveBeenCalled();
  });

  it('happy path: exchanges code, writes the token blob to Vault, activates the connection, audits, and redirects', async () => {
    const admin = adminClient();
    vi.mocked(createAdminClient).mockReturnValue(admin.client as never);

    const res = await GET(
      callbackUrl({ code: 'auth-code', state: STATE, realmId: REALM_ID }),
    );

    // Code exchange happened with the callback's code + realmId.
    expect(exchangeCode).toHaveBeenCalledWith('auth-code', REALM_ID);

    // Token blob is written to Vault under connector:<connectionId> with the
    // exact tokens from the exchange.
    expect(putConnectionSecret).toHaveBeenCalledTimes(1);
    const [, secretName, secretBlob] = vi.mocked(putConnectionSecret).mock.calls[0]!;
    expect(secretName).toBe(`connector:${CONNECTION_ID}`);
    expect(secretBlob).toEqual({
      accessToken: 'ACCESS-TOKEN-SECRET',
      refreshToken: 'REFRESH-TOKEN-SECRET',
      expiresAt: '2026-01-01T00:00:00.000Z',
    });

    // Connection flipped to active, realmId stamped, secret_id stored, oauth_state cleared.
    expect(admin.updates).toHaveLength(1);
    expect(admin.updates[0]).toMatchObject({
      status: 'active',
      external_account_id: REALM_ID,
      secret_id: 'secret-handle-1',
      oauth_state: null,
    });
    expect(admin.eqArgs[0]).toEqual(['id', CONNECTION_ID]);

    // Audited as integration.connected for this connection/org.
    expect(audit).toHaveBeenCalledTimes(1);
    const [auditPayload, auditCtx] = vi.mocked(audit).mock.calls[0]!;
    expect(auditPayload).toMatchObject({
      event: 'integration.connected',
      entityType: 'org_connection',
      entityId: CONNECTION_ID,
      extra: { provider: 'quickbooks' },
    });
    expect(auditCtx).toMatchObject({ organizationId: ORG_ID, userId: USER_ID });

    // 302 back to settings with connected=quickbooks.
    expect(res.status).toBe(302);
    const loc = location(res);
    expect(loc.pathname).toBe(SETTINGS_PATH);
    expect(loc.searchParams.get('connected')).toBe('quickbooks');
    expect(loc.searchParams.has('error')).toBe(false);

    // SECRET INVARIANT: tokens must NEVER leak into the redirect URL.
    const redirect = res.headers.get('location') ?? '';
    expect(redirect).not.toContain('ACCESS-TOKEN-SECRET');
    expect(redirect).not.toContain('REFRESH-TOKEN-SECRET');
  });

  it('redirects with error=internal_error when activating the connection fails', async () => {
    const admin = adminClient({ message: 'update boom' });
    vi.mocked(createAdminClient).mockReturnValue(admin.client as never);

    const res = await GET(
      callbackUrl({ code: 'auth-code', state: STATE, realmId: REALM_ID }),
    );

    expect(res.status).toBe(302);
    expect(location(res).searchParams.get('error')).toBe('internal_error');
    // The connection was never activated, so no audit event should fire.
    expect(audit).not.toHaveBeenCalled();
  });
});
