/**
 * TDD tests for UserConnectionsService (Task 5).
 *
 * Strategy:
 *   - All Zendesk OAuth helpers, secret-store, and admin client are vi.mock'd.
 *   - Supabase interactions use makeSupabaseStub + makeServiceContext.
 *   - No network requests are ever made.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';
import { DEFAULT_MODULE_IDS, type ModuleId } from '@stockpilot/core';

// ── Mock dependencies before importing module under test ─────────────────────

vi.mock('@/server/connectors/zendesk/oauth', () => ({
  buildAuthorizeUrl: vi.fn(
    (subdomain: string, state: string, _scopes: string) =>
      `https://${subdomain}.zendesk.com/oauth/authorizations/new?state=${state}`,
  ),
  exchangeCode: vi.fn(async () => ({
    accessToken: 'at-new',
    refreshToken: 'rt-new',
    expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
  })),
  refreshTokens: vi.fn(async () => ({
    accessToken: 'at-refreshed',
    refreshToken: 'rt-rotated',
    expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
  })),
}));

vi.mock('@/server/connectors/zendesk/oauth-state', () => ({
  signState: vi.fn(
    ({ orgId, userId, platform }: { orgId: string; userId: string; platform: string }) =>
      `signed:${orgId}:${userId}:${platform}`,
  ),
  verifyState: vi.fn((state: string) => {
    if (state.startsWith('signed:')) {
      const [, orgId, userId, platform] = state.split(':');
      return { orgId, userId, platform };
    }
    return null;
  }),
}));

vi.mock('@/server/connectors/secret-store', () => ({
  putConnectionSecret: vi.fn(async () => 'vault-secret-id-1'),
  getConnectionSecret: vi.fn(async () => ({
    accessToken: 'at-stored',
    refreshToken: 'rt-stored',
    expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(), // future = valid
  })),
  deleteConnectionSecret: vi.fn(async () => {}),
}));

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }));

// Fetch stub for /users/me Zendesk API call during completeZendeskConnect
const mockFetch = vi.fn(async (_url: string) =>
  ({
    ok: true,
    json: async () => ({ user: { id: 42, email: 'agent@acme.com', name: 'Agent A' } }),
  } as Response),
) as unknown as typeof fetch;

// ── Import module under test (after mocks are registered) ────────────────────

import { buildAuthorizeUrl, exchangeCode, refreshTokens } from '@/server/connectors/zendesk/oauth';
import { signState, verifyState } from '@/server/connectors/zendesk/oauth-state';
import { putConnectionSecret, getConnectionSecret, deleteConnectionSecret } from '@/server/connectors/secret-store';
import { UserConnectionsService } from './user-connections';

// ── Helpers ──────────────────────────────────────────────────────────────────

const withZendesk = () => new Set<ModuleId>([...DEFAULT_MODULE_IDS, 'zendesk']);

/** Org-level Zendesk connection row returned by org_connections lookup. */
const orgConnRow = {
  external_account_id: 'acme',
  settings: { subdomain: 'acme' },
};

/** A user_connections row with a non-expired token. */
const activeUserConnRow = {
  id: 'uc-1',
  subdomain: 'acme',
  secret_id: 'vault-secret-id-1',
  status: 'active',
  external_account: { id: 42, email: 'agent@acme.com' },
};

beforeEach(() => {
  vi.clearAllMocks();
  // Reset getConnectionSecret to non-expired default
  vi.mocked(getConnectionSecret).mockResolvedValue({
    accessToken: 'at-stored',
    refreshToken: 'rt-stored',
    expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// beginZendeskConnect
// ─────────────────────────────────────────────────────────────────────────────

describe('UserConnectionsService.beginZendeskConnect', () => {
  it('throws module_disabled when zendesk module is off', async () => {
    const stub = makeSupabaseStub({});
    const svc = new UserConnectionsService(makeServiceContext(stub.client));
    await expect(svc.beginZendeskConnect('web')).rejects.toMatchObject({ code: 'module_disabled' });
  });

  it('throws forbidden when caller lacks zendesk:agent permission', async () => {
    const stub = makeSupabaseStub({});
    const svc = new UserConnectionsService(
      makeServiceContext(stub.client, { enabledModules: withZendesk(), role: 'viewer' }),
    );
    await expect(svc.beginZendeskConnect('web')).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('throws validation_error when no org-level Zendesk subdomain exists', async () => {
    const stub = makeSupabaseStub({
      'org_connections.select': { data: null, error: null },
    });
    const svc = new UserConnectionsService(
      makeServiceContext(stub.client, { enabledModules: withZendesk() }),
    );
    await expect(svc.beginZendeskConnect('web')).rejects.toMatchObject({ code: 'validation_error' });
  });

  it('returns an authorizeUrl containing a signed state for a valid org', async () => {
    const stub = makeSupabaseStub({
      'org_connections.select': { data: orgConnRow, error: null },
    });
    const svc = new UserConnectionsService(
      makeServiceContext(stub.client, { enabledModules: withZendesk() }),
    );
    const result = await svc.beginZendeskConnect('web');
    expect(result).toHaveProperty('authorizeUrl');
    expect(result.authorizeUrl).toContain('acme.zendesk.com');
    // The signed state must be embedded in the URL
    expect(result.authorizeUrl).toContain('signed:');
    // signState and buildAuthorizeUrl were called
    expect(signState).toHaveBeenCalledWith({ orgId: 'org-test', userId: 'user-test', platform: 'web' });
    expect(buildAuthorizeUrl).toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// completeZendeskConnect
// ─────────────────────────────────────────────────────────────────────────────

describe('UserConnectionsService.completeZendeskConnect', () => {
  it('throws module_disabled when zendesk module is off', async () => {
    const stub = makeSupabaseStub({});
    const svc = new UserConnectionsService(makeServiceContext(stub.client));
    await expect(
      svc.completeZendeskConnect('code-x', 'signed:org-test:user-test:web', mockFetch),
    ).rejects.toMatchObject({ code: 'module_disabled' });
    // No vault write and no upsert should have happened
    expect(putConnectionSecret).not.toHaveBeenCalled();
    expect(stub.fromCalls).not.toContain('user_connections');
  });

  it('throws forbidden when caller lacks zendesk:agent permission', async () => {
    const stub = makeSupabaseStub({});
    const svc = new UserConnectionsService(
      makeServiceContext(stub.client, { enabledModules: withZendesk(), role: 'viewer' }),
    );
    await expect(
      svc.completeZendeskConnect('code-x', 'signed:org-test:user-test:web', mockFetch),
    ).rejects.toMatchObject({ code: 'forbidden' });
    expect(putConnectionSecret).not.toHaveBeenCalled();
    expect(stub.fromCalls).not.toContain('user_connections');
  });

  it('throws forbidden when state is invalid (bad state)', async () => {
    const stub = makeSupabaseStub({});
    const svc = new UserConnectionsService(
      makeServiceContext(stub.client, { enabledModules: withZendesk() }),
    );
    await expect(svc.completeZendeskConnect('code-x', 'bad-state', mockFetch)).rejects.toMatchObject({
      code: 'forbidden',
    });
    // No vault write and no upsert should have happened
    expect(putConnectionSecret).not.toHaveBeenCalled();
    expect(stub.fromCalls).not.toContain('user_connections');
  });

  it('throws forbidden when state userId does not match ctx.userId', async () => {
    // signState embedded 'other-user', but ctx.userId is 'user-test'
    vi.mocked(verifyState).mockReturnValueOnce({
      orgId: 'org-test',
      userId: 'other-user',   // mismatch
      platform: 'web',
    });
    const stub = makeSupabaseStub({});
    const svc = new UserConnectionsService(
      makeServiceContext(stub.client, { enabledModules: withZendesk(), userId: 'user-test' }),
    );
    await expect(svc.completeZendeskConnect('code-x', 'signed:org-test:other-user:web', mockFetch)).rejects.toMatchObject({
      code: 'forbidden',
    });
    expect(putConnectionSecret).not.toHaveBeenCalled();
  });

  it('vaults the bundle and upserts user_connections with status=active on good state', async () => {
    const stub = makeSupabaseStub({
      'org_connections.select': { data: orgConnRow, error: null },
      'user_connections.insert': { data: { id: 'uc-1' }, error: null },
    });
    const svc = new UserConnectionsService(
      makeServiceContext(stub.client, { enabledModules: withZendesk() }),
    );
    const goodState = 'signed:org-test:user-test:web';

    await svc.completeZendeskConnect('auth-code', goodState, mockFetch);

    expect(exchangeCode).toHaveBeenCalledWith('acme', 'auth-code', mockFetch);
    expect(putConnectionSecret).toHaveBeenCalledWith(
      expect.anything(),
      'user:user-test:zendesk',
      expect.objectContaining({ accessToken: 'at-new' }),
    );
    // upsert should have landed on user_connections
    expect(stub.fromCalls).toContain('user_connections');
    // chain should include upsert
    const chain = stub.chains.get('user_connections.insert') ?? [];
    expect(chain).toContain('upsert');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getValidAccessToken
// ─────────────────────────────────────────────────────────────────────────────

describe('UserConnectionsService.getValidAccessToken', () => {
  it('throws not_found when the caller has no connection', async () => {
    const stub = makeSupabaseStub({
      'user_connections.select': { data: null, error: null },
    });
    const svc = new UserConnectionsService(
      makeServiceContext(stub.client, { enabledModules: withZendesk() }),
    );
    await expect(svc.getValidAccessToken()).rejects.toMatchObject({ code: 'not_found' });
  });

  it('returns stored token when it is not expired', async () => {
    const stub = makeSupabaseStub({
      'user_connections.select': { data: activeUserConnRow, error: null },
    });
    const svc = new UserConnectionsService(
      makeServiceContext(stub.client, { enabledModules: withZendesk() }),
    );
    const result = await svc.getValidAccessToken();
    expect(result.accessToken).toBe('at-stored');
    expect(result.subdomain).toBe('acme');
    expect(refreshTokens).not.toHaveBeenCalled();
  });

  it('refreshes when expiresAt is in the past and re-vaults the rotated token', async () => {
    vi.mocked(getConnectionSecret).mockResolvedValueOnce({
      accessToken: 'at-old',
      refreshToken: 'rt-old',
      expiresAt: new Date(Date.now() - 10_000).toISOString(), // past
    });
    const stub = makeSupabaseStub({
      'user_connections.select': { data: activeUserConnRow, error: null },
      'user_connections.update': { data: null, error: null },
    });
    const svc = new UserConnectionsService(
      makeServiceContext(stub.client, { enabledModules: withZendesk() }),
    );
    const result = await svc.getValidAccessToken();
    expect(refreshTokens).toHaveBeenCalledWith('acme', 'rt-old', expect.any(Function));
    expect(putConnectionSecret).toHaveBeenCalledWith(
      expect.anything(),
      'user:user-test:zendesk',
      expect.objectContaining({ accessToken: 'at-refreshed' }),
    );
    expect(result.accessToken).toBe('at-refreshed');
    // The row should have been updated (bump updated_at / last_connected_at)
    expect(stub.fromCalls).toContain('user_connections');
  });

  it('refreshes when expiresAt is within 60 seconds (near-expiry)', async () => {
    vi.mocked(getConnectionSecret).mockResolvedValueOnce({
      accessToken: 'at-nearexpiry',
      refreshToken: 'rt-nearexpiry',
      expiresAt: new Date(Date.now() + 30_000).toISOString(), // 30 s = within 60s buffer
    });
    const stub = makeSupabaseStub({
      'user_connections.select': { data: activeUserConnRow, error: null },
      'user_connections.update': { data: null, error: null },
    });
    const svc = new UserConnectionsService(
      makeServiceContext(stub.client, { enabledModules: withZendesk() }),
    );
    await svc.getValidAccessToken();
    expect(refreshTokens).toHaveBeenCalled();
  });

  it('ISOLATION: query filter includes user_id = ctx.userId and provider_id = zendesk', async () => {
    const stub = makeSupabaseStub({
      'user_connections.select': { data: activeUserConnRow, error: null },
    });
    const svc = new UserConnectionsService(
      makeServiceContext(stub.client, {
        enabledModules: withZendesk(),
        userId: 'user-test',
      }),
    );
    await svc.getValidAccessToken();
    // The chain for user_connections.select must contain an `eq` call with
    // 'user_id' as the first arg — proving the per-user filter is applied.
    const args = stub.chainArgs.get('user_connections.select') ?? [];
    const eqCalls = args.filter((callArgs) => callArgs[0] === 'user_id');
    expect(eqCalls.length).toBeGreaterThanOrEqual(1);
    expect(eqCalls[0]![1]).toBe('user-test');
    // The chain must also filter on provider_id = 'zendesk' so the full
    // row-uniqueness predicate is enforced (user_id alone is not unique).
    const providerEqCalls = args.filter((callArgs) => callArgs[0] === 'provider_id');
    expect(providerEqCalls.length).toBeGreaterThanOrEqual(1);
    expect(providerEqCalls[0]![1]).toBe('zendesk');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// status
// ─────────────────────────────────────────────────────────────────────────────

describe('UserConnectionsService.status', () => {
  it('returns connected=false when no row exists', async () => {
    const stub = makeSupabaseStub({
      'user_connections.select': { data: null, error: null },
    });
    const svc = new UserConnectionsService(makeServiceContext(stub.client, { enabledModules: withZendesk() }));
    const result = await svc.status();
    expect(result.connected).toBe(false);
    expect(result.account).toBeUndefined();
  });

  it('returns connected=true with account when row exists', async () => {
    const stub = makeSupabaseStub({
      'user_connections.select': { data: activeUserConnRow, error: null },
    });
    const svc = new UserConnectionsService(makeServiceContext(stub.client, { enabledModules: withZendesk() }));
    const result = await svc.status();
    expect(result.connected).toBe(true);
    expect(result.account).toMatchObject({ id: 42 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// disconnect
// ─────────────────────────────────────────────────────────────────────────────

describe('UserConnectionsService.disconnect', () => {
  it('no-ops cleanly when no row exists', async () => {
    const stub = makeSupabaseStub({
      'user_connections.select': { data: null, error: null },
    });
    const svc = new UserConnectionsService(makeServiceContext(stub.client, { enabledModules: withZendesk() }));
    await expect(svc.disconnect()).resolves.not.toThrow();
    expect(deleteConnectionSecret).not.toHaveBeenCalled();
  });

  it('deletes vault secret and the row when connected', async () => {
    const stub = makeSupabaseStub({
      'user_connections.select': { data: activeUserConnRow, error: null },
      'user_connections.delete': { data: null, error: null },
    });
    const svc = new UserConnectionsService(makeServiceContext(stub.client, { enabledModules: withZendesk() }));
    await svc.disconnect();
    expect(deleteConnectionSecret).toHaveBeenCalledWith(expect.anything(), 'vault-secret-id-1');
    expect(stub.fromCalls.filter((t) => t === 'user_connections').length).toBeGreaterThanOrEqual(2);
  });
});
