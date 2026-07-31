import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { audit } from '@/server/services/audit';
import { putConnectionSecret } from '@/server/connectors/secret-store';
import { exchangeCode } from '@/server/connectors/sage-intacct/oauth';
import { makeSupabaseStub, type QueryResult } from '@/test/supabase-mock';

import { GET } from './route';

/**
 * The Sage Intacct callback mirrors the QuickBooks one, including the fact that
 * it resolves its own principal with createClient() + auth.getUser() and is
 * therefore covered by NONE of the three account-status chokepoints. This file
 * exists mainly to hold that guard in place; the happy path is asserted
 * alongside it so a guard that refuses everyone cannot pass.
 */

vi.mock('@/lib/env', () => ({
  env: { NEXT_PUBLIC_APP_URL: 'https://app.example.com' },
}));

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn() }));
vi.mock('@/server/services/audit', () => ({ audit: vi.fn() }));
vi.mock('@/server/connectors/secret-store', () => ({ putConnectionSecret: vi.fn() }));
vi.mock('@/server/connectors/sage-intacct/oauth', () => ({ exchangeCode: vi.fn() }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn() }));

const SETTINGS_PATH = '/dashboard/settings/integrations';
const CONNECTION_ID = '33333333-3333-3333-3333-333333333333';
const ORG_ID = '44444444-4444-4444-4444-444444444444';
const USER_ID = 'user-sage-1';
const STATE = 'sage-csrf-state';
const COMPANY_ID = 'ACME-CO';

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
    'organization_modules.select': { data: [{ module_id: 'integrations' }], error: null },
    'organization_members.select': { data: [{ role: 'admin' }], error: null },
    // Account status (0308). Default = ACTIVE.
    'user_profiles.select': { data: [{ disabled_at: null }], error: null },
    ...overrides,
  });
  stub.client.auth.getUser = vi.fn(async () => ({ data: { user }, error: null }));
  return stub;
}

function adminClient(updateError: { message: string } | null = null) {
  const updates: Array<Record<string, unknown>> = [];
  const client = {
    from: vi.fn(() => ({
      update: vi.fn((payload: Record<string, unknown>) => {
        updates.push(payload);
        return { eq: vi.fn(() => Promise.resolve({ error: updateError })) };
      }),
    })),
  };
  return { client, updates };
}

function callbackUrl(params: Record<string, string>) {
  const url = new URL('https://app.example.com/api/integrations/sage_intacct/callback');
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return new Request(url.toString());
}

function location(res: Response) {
  return new URL(res.headers.get('location') ?? '');
}

describe('GET /api/integrations/sage_intacct/callback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(createClient).mockResolvedValue(userClient().client as never);
    vi.mocked(createAdminClient).mockReturnValue(adminClient().client as never);
    vi.mocked(putConnectionSecret).mockResolvedValue('sage-secret-handle');
    vi.mocked(exchangeCode).mockResolvedValue({
      accessToken: 'SAGE-ACCESS-SECRET',
      refreshToken: 'SAGE-REFRESH-SECRET',
      expiresAt: '2026-01-01T00:00:00.000Z',
      companyId: COMPANY_ID,
    } as never);
  });

  it('redirects to /signin when there is no session', async () => {
    vi.mocked(createClient).mockResolvedValueOnce(userClient({}, null).client as never);

    const res = await GET(callbackUrl({ code: 'c', state: STATE }));

    expect(res.status).toBe(302);
    expect(location(res).pathname).toBe('/signin');
    expect(exchangeCode).not.toHaveBeenCalled();
  });

  it('refuses a DISABLED account before exchanging the code or writing any secret', async () => {
    vi.mocked(createClient).mockResolvedValueOnce(
      userClient({
        'user_profiles.select': {
          data: [{ disabled_at: '2026-07-31T00:00:00.000Z' }],
          error: null,
        },
      }).client as never,
    );

    const res = await GET(callbackUrl({ code: 'auth-code', state: STATE }));

    expect(res.status).toBe(302);
    expect(location(res).searchParams.get('error')).toBe('forbidden');
    expect(exchangeCode).not.toHaveBeenCalled();
    expect(putConnectionSecret).not.toHaveBeenCalled();
    expect(createAdminClient).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it('refuses with internal_error (not forbidden) when the account status cannot be read', async () => {
    vi.mocked(createClient).mockResolvedValueOnce(
      userClient({
        'user_profiles.select': { data: null, error: { message: 'db down' } },
      }).client as never,
    );

    const res = await GET(callbackUrl({ code: 'auth-code', state: STATE }));

    expect(res.status).toBe(302);
    expect(location(res).searchParams.get('error')).toBe('internal_error');
    expect(exchangeCode).not.toHaveBeenCalled();
    expect(putConnectionSecret).not.toHaveBeenCalled();
  });

  it('happy path: an ACTIVE user still completes the connect', async () => {
    const admin = adminClient();
    vi.mocked(createAdminClient).mockReturnValue(admin.client as never);

    const res = await GET(callbackUrl({ code: 'auth-code', state: STATE }));

    expect(exchangeCode).toHaveBeenCalledWith('auth-code');
    expect(putConnectionSecret).toHaveBeenCalledTimes(1);
    expect(admin.updates[0]).toMatchObject({
      status: 'active',
      external_account_id: COMPANY_ID,
      secret_id: 'sage-secret-handle',
      oauth_state: null,
    });
    expect(audit).toHaveBeenCalledTimes(1);

    expect(res.status).toBe(302);
    const loc = location(res);
    expect(loc.pathname).toBe(SETTINGS_PATH);
    expect(loc.searchParams.get('connected')).toBe('sage_intacct');

    // SECRET INVARIANT: tokens must never reach the redirect URL.
    const redirect = res.headers.get('location') ?? '';
    expect(redirect).not.toContain('SAGE-ACCESS-SECRET');
    expect(redirect).not.toContain('SAGE-REFRESH-SECRET');
  });
});
