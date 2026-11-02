import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

// audit + admin client are side-effecting; stub them so the service runs in
// isolation and we can assert on calls. The Vault delete RPC goes through the
// admin (service-role) client per the secret invariant.
vi.mock('@/server/services/audit', () => ({
  audit: vi.fn(async () => undefined),
}));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn() }));

const deleteSpy = vi.fn(async (_admin: unknown, _secretId: string) => undefined);
const putSpy = vi.fn(
  async (_admin: unknown, _name: string, _secret: Record<string, unknown>) => 'vault-secret-id-1',
);
vi.mock('@/server/connectors/secret-store', () => ({
  deleteConnectionSecret: (admin: unknown, secretId: string) => deleteSpy(admin, secretId),
  putConnectionSecret: (admin: unknown, name: string, secret: Record<string, unknown>) =>
    putSpy(admin, name, secret),
}));

// EasyPost client: validateKey() resolves by default (good key). Tests that
// need a bad key set the spy to reject with an EasyPostApiError.
const validateKeySpy = vi.fn(async () => undefined);
vi.mock('@/server/connectors/easypost/client', () => ({
  EasyPostApiError: class EasyPostApiError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.name = 'EasyPostApiError';
      this.status = status;
    }
  },
  EasyPostClient: class EasyPostClient {
    constructor(_apiKey: string) {}
    validateKey() {
      return validateKeySpy();
    }
  },
}));

// Zendesk client: validateToken() resolves by default (good token), so a
// connect test never reaches the network.
const validateTokenSpy = vi.fn(async () => undefined);
vi.mock('@/server/connectors/zendesk/client', () => ({
  ZendeskApiError: class ZendeskApiError extends Error {
    status: number;
    constructor(status: number) {
      super(`Zendesk API error ${status}`);
      this.name = 'ZendeskApiError';
      this.status = status;
    }
  },
  ZendeskClient: class ZendeskClient {
    constructor(_cfg: unknown) {}
    validateToken() {
      return validateTokenSpy();
    }
  },
}));

const adminClientHolder = { client: { _admin: true } as unknown };
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: vi.fn(() => adminClientHolder.client),
}));

import { env } from '@/lib/env';
import { reportError } from '@/lib/error-reporter';
import { EasyPostApiError } from '@/server/connectors/easypost/client';
import { audit } from '@/server/services/audit';
import { ConnectionsService } from './connections';
import { ServiceError } from './context';
import { INTEGRATION_WRITE_REFUSED } from './integration-events';

import type { ModuleId } from '@stockpilot/core';

// env.QBO_CLIENT_ID is optionalSecret (defaults to '' in the test env, which
// has no Intuit creds). beginConnect() now fast-fails when it's empty, so the
// happy-path tests need a non-empty client id; we stamp one per test and
// restore the original afterwards. The misconfiguration test overrides this
// back to '' inside its own body.
const ORIGINAL_QBO_CLIENT_ID = env.QBO_CLIENT_ID;

beforeEach(() => {
  vi.clearAllMocks();
  adminClientHolder.client = { _admin: true };
  // Reset the EasyPost key validation to the happy path (good key); the
  // bad-key test overrides it.
  validateKeySpy.mockResolvedValue(undefined);
  validateTokenSpy.mockResolvedValue(undefined);
  (env as { QBO_CLIENT_ID: string }).QBO_CLIENT_ID = 'test-qbo-client-id';
});

afterEach(() => {
  (env as { QBO_CLIENT_ID: string }).QBO_CLIENT_ID = ORIGINAL_QBO_CLIENT_ID;
});

describe('ConnectionsService.beginConnect', () => {
  it('throws forbidden when the caller lacks integrations:manage', async () => {
    const stub = makeSupabaseStub();
    const svc = new ConnectionsService(
      makeServiceContext(stub.client, {
        role: 'staff',
        enabledModules: new Set<ModuleId>(['integrations']),
      }),
    );
    await expect(svc.beginConnect('quickbooks')).rejects.toMatchObject({
      code: 'forbidden',
    });
  });

  it('throws module_disabled when the integrations module is off', async () => {
    const stub = makeSupabaseStub();
    const svc = new ConnectionsService(
      makeServiceContext(stub.client, {
        role: 'owner',
        // Module gate fires BEFORE the permission gate; an empty module set
        // (integrations off) must produce module_disabled.
        enabledModules: new Set<ModuleId>(),
      }),
    );
    await expect(svc.beginConnect('quickbooks')).rejects.toMatchObject({
      code: 'module_disabled',
    });
  });

  it('upserts a pending row with oauth_state and returns the QBO authorize URL', async () => {
    const stub = makeSupabaseStub({
      // Fresh connect: no existing row to merge against.
      'org_connections.select': { data: [], error: null },
      'org_connections.insert': {
        data: [{ id: 'conn-1', oauth_state: 'ignored-by-test' }],
        error: null,
      },
    });
    const svc = new ConnectionsService(
      makeServiceContext(stub.client, {
        role: 'owner',
        enabledModules: new Set<ModuleId>(['integrations']),
      }),
    );

    const url = await svc.beginConnect('quickbooks');

    // Upserted a pending row carrying a generated CSRF state.
    const upsertArgs = stub.chainArgsAll.get('org_connections.insert')?.[0]?.[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(upsertArgs.organization_id).toBe('org-test');
    expect(upsertArgs.provider_id).toBe('quickbooks');
    expect(upsertArgs.status).toBe('pending');
    expect(typeof upsertArgs.oauth_state).toBe('string');
    expect((upsertArgs.oauth_state as string).length).toBeGreaterThan(16);
    // Fresh insert stamps the connector with the establishing user + env.
    expect(upsertArgs.created_by).toBe('user-test');
    expect(upsertArgs.settings).toMatchObject({ env: 'sandbox' });

    // Authorize URL built from the registry + env + callback redirect_uri + state.
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe(
      'https://appcenter.intuit.com/connect/oauth2',
    );
    expect(parsed.searchParams.get('response_type')).toBe('code');
    expect(parsed.searchParams.get('scope')).toBe('com.intuit.quickbooks.accounting');
    expect(parsed.searchParams.get('state')).toBe(upsertArgs.oauth_state);
    expect(parsed.searchParams.get('redirect_uri')).toContain(
      '/api/integrations/quickbooks/callback',
    );
  });

  it('preserves previously-saved settings.accountIds on reconnect (no clobber)', async () => {
    // Reconnect path: an existing row already carries an admin-saved account
    // mapping. beginConnect must NOT wipe settings.accountIds when it rotates
    // the CSRF state, otherwise the connector loses the config it needs to post
    // Bills + the valuation JournalEntry. It must also NOT overwrite created_by.
    const stub = makeSupabaseStub({
      'org_connections.select': {
        data: [
          {
            id: 'conn-1',
            settings: {
              env: 'sandbox',
              accountIds: { billExpense: '54', inventoryAsset: '81', valuationOffset: '90' },
              lastValuationSnapshotValue: 1234,
            },
            created_by: 'original-owner',
          },
        ],
        error: null,
      },
      'org_connections.insert': {
        data: [{ id: 'conn-1', oauth_state: 'rotated' }],
        error: null,
      },
    });
    const svc = new ConnectionsService(
      makeServiceContext(stub.client, {
        role: 'owner',
        userId: 'reconnecting-admin',
        enabledModules: new Set<ModuleId>(['integrations']),
      }),
    );

    await svc.beginConnect('quickbooks');

    const upsertArgs = stub.chainArgsAll.get('org_connections.insert')?.[0]?.[0]?.[0] as Record<
      string,
      unknown
    >;
    // accountIds + other non-secret settings survive; env still stamped.
    expect(upsertArgs.settings).toMatchObject({
      env: 'sandbox',
      accountIds: { billExpense: '54', inventoryAsset: '81', valuationOffset: '90' },
      lastValuationSnapshotValue: 1234,
    });
    // Original establisher attribution is retained, not the reconnecting admin.
    expect(upsertArgs.created_by).toBe('original-owner');
    // Status is reset to pending + a fresh CSRF state is rotated in.
    expect(upsertArgs.status).toBe('pending');
    expect(typeof upsertArgs.oauth_state).toBe('string');
  });

  it('throws validation_error when QBO_CLIENT_ID is not configured', async () => {
    // When integrations is enabled but the deployment lacks Intuit credentials,
    // fail fast BEFORE writing a pending row / redirecting the user to a
    // dead-end authorize URL. (afterEach restores the per-test client id.)
    (env as { QBO_CLIENT_ID: string }).QBO_CLIENT_ID = '';
    const stub = makeSupabaseStub({ 'org_connections.select': { data: [], error: null } });
    const svc = new ConnectionsService(
      makeServiceContext(stub.client, {
        role: 'owner',
        enabledModules: new Set<ModuleId>(['integrations']),
      }),
    );

    await expect(svc.beginConnect('quickbooks')).rejects.toMatchObject({
      code: 'validation_error',
    });
    // No pending row written when misconfigured.
    expect(stub.fromCalls).not.toContain('org_connections');
  });
});

describe('ConnectionsService.list', () => {
  // list() returns ALL org_connections regardless of provider; it backs the
  // shared Integrations settings page that hosts both the QuickBooks
  // (integrations) and EasyPost (shipping) cards. So the module gate is
  // `integrations` OR `shipping`, fail-closed when NEITHER is enabled.
  function listStub() {
    return makeSupabaseStub({
      'org_connections.select': {
        data: [
          { id: 'conn-qbo', provider_id: 'quickbooks', status: 'active', settings: {} },
          { id: 'conn-ep', provider_id: 'easypost', status: 'active', settings: { mode: 'test' } },
        ],
        error: null,
      },
      'connection_sync_log.select': { data: [], error: null },
    });
  }

  it('lists connections when only the integrations module is enabled', async () => {
    const stub = listStub();
    const svc = new ConnectionsService(
      makeServiceContext(stub.client, {
        role: 'owner',
        enabledModules: new Set<ModuleId>(['integrations']),
      }),
    );
    const { connections } = await svc.list();
    expect(connections.map((c) => c.providerId)).toEqual(['quickbooks', 'easypost']);
  });

  it('lists connections when only the shipping module is enabled (integrations off)', async () => {
    // The key regression: a shipping-only org must still be able to read its
    // connections (to render + manage the EasyPost card) even though the
    // integrations module is off.
    const stub = listStub();
    const svc = new ConnectionsService(
      makeServiceContext(stub.client, {
        role: 'owner',
        enabledModules: new Set<ModuleId>(['shipping']),
      }),
    );
    const { connections } = await svc.list();
    expect(connections.map((c) => c.providerId)).toContain('easypost');
  });

  it('throws module_disabled when NEITHER integrations nor shipping is enabled', async () => {
    const stub = listStub();
    const svc = new ConnectionsService(
      makeServiceContext(stub.client, {
        role: 'owner',
        enabledModules: new Set<ModuleId>(),
      }),
    );
    await expect(svc.list()).rejects.toMatchObject({ code: 'module_disabled' });
  });
});

describe('ConnectionsService.connectApiKey (EasyPost)', () => {
  it('validates the key, stores both secrets in Vault, and activates the connection', async () => {
    const stub = makeSupabaseStub({
      // Fresh connect: no existing easypost row.
      'org_connections.select': { data: [], error: null },
      'org_connections.insert': { data: [{ id: 'conn-ep-1' }], error: null },
    });
    const adminStub = makeSupabaseStub({
      'org_connections.update': { data: [{ id: 'conn-ep-1' }], error: null },
    });
    adminClientHolder.client = adminStub.client;
    const svc = new ConnectionsService(
      makeServiceContext(stub.client, {
        role: 'owner',
        enabledModules: new Set<ModuleId>(['shipping']),
      }),
    );

    await svc.connectApiKey('easypost', '  EZTK_test_key_123  ', 'whsec_abc');

    // Key validated against EasyPost before anything persisted.
    expect(validateKeySpy).toHaveBeenCalledTimes(1);

    // BOTH carrier secrets written to Vault via the service-role admin client —
    // never into org_connections.settings. The blob is ConnectorSecrets-shaped
    // (accessToken mirrors the key) and carries apiKey + webhookSecret (trimmed).
    expect(putSpy).toHaveBeenCalledTimes(1);
    const [adminArg, , secretArg] = putSpy.mock.calls[0] as [unknown, string, Record<string, unknown>];
    expect(adminArg).toBe(adminClientHolder.client);
    expect(secretArg).toMatchObject({
      apiKey: 'EZTK_test_key_123',
      webhookSecret: 'whsec_abc',
      accessToken: 'EZTK_test_key_123',
    });

    // The member's own write (the one the database checks) carries the row
    // only: no status, no secret_id (docket S27).
    const upsertArgs = stub.chainArgsAll.get('org_connections.insert')?.[0]?.[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(upsertArgs).toEqual({
      organization_id: 'org-test',
      provider_id: 'easypost',
      created_by: 'user-test',
    });
    // The service role activates that row with the Vault secret id + mode
    // (test, from the EZTK prefix). The raw key must NOT appear in settings.
    const activateArgs = adminStub.chainArgsAll.get(
      'org_connections.update',
    )?.[0]?.[0]?.[0] as Record<string, unknown>;
    expect(activateArgs.status).toBe('active');
    expect(activateArgs.secret_id).toBe('vault-secret-id-1');
    expect(activateArgs.settings).toMatchObject({ mode: 'test' });
    expect(JSON.stringify(activateArgs.settings)).not.toContain('EZTK_test_key_123');

    expect(audit).toHaveBeenCalledTimes(1);
    expect(vi.mocked(audit).mock.calls[0]?.[0].event).toBe('integration.connected');
  });

  it('throws validation_error when EasyPost rejects the key (no secret stored)', async () => {
    validateKeySpy.mockRejectedValueOnce(new EasyPostApiError('bad key', 401));
    const stub = makeSupabaseStub();
    const svc = new ConnectionsService(
      makeServiceContext(stub.client, {
        role: 'owner',
        enabledModules: new Set<ModuleId>(['shipping']),
      }),
    );

    await expect(svc.connectApiKey('easypost', 'EZAK_bad')).rejects.toMatchObject({
      code: 'validation_error',
    });
    // Nothing persisted on a bad key.
    expect(putSpy).not.toHaveBeenCalled();
  });

  it('throws forbidden when the caller lacks shipping:manage', async () => {
    const stub = makeSupabaseStub();
    const svc = new ConnectionsService(
      makeServiceContext(stub.client, {
        role: 'staff',
        enabledModules: new Set<ModuleId>(['shipping']),
      }),
    );
    await expect(svc.connectApiKey('easypost', 'EZAK_x')).rejects.toMatchObject({
      code: 'forbidden',
    });
    expect(validateKeySpy).not.toHaveBeenCalled();
  });

  it('throws module_disabled when the shipping module is off', async () => {
    const stub = makeSupabaseStub();
    const svc = new ConnectionsService(
      makeServiceContext(stub.client, {
        role: 'owner',
        // Shipping is OFF (even integrations on shouldn't help).
        enabledModules: new Set<ModuleId>(['integrations']),
      }),
    );
    await expect(svc.connectApiKey('easypost', 'EZAK_x')).rejects.toMatchObject({
      code: 'module_disabled',
    });
    expect(validateKeySpy).not.toHaveBeenCalled();
  });
});

describe('ConnectionsService.disconnect', () => {
  it('deletes the Vault secret via the service-role admin client, clears state, and audits', async () => {
    const stub = makeSupabaseStub({
      'org_connections.select': {
        data: [{ id: 'conn-1', secret_id: 'secret-uuid-123' }],
        error: null,
      },
      'org_connections.update': { data: [{ id: 'conn-1' }], error: null },
    });
    const svc = new ConnectionsService(
      makeServiceContext(stub.client, {
        role: 'owner',
        enabledModules: new Set<ModuleId>(['integrations']),
      }),
    );

    await svc.disconnect('quickbooks');

    // Secret deleted via the admin (service-role) client, not the request client.
    expect(deleteSpy).toHaveBeenCalledTimes(1);
    expect(deleteSpy).toHaveBeenCalledWith(adminClientHolder.client, 'secret-uuid-123');

    // Row set to disconnected with secret_id + oauth_state nulled.
    const updateArgs = stub.chainArgsAll.get('org_connections.update')?.[0]?.[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(updateArgs.status).toBe('disconnected');
    expect(updateArgs.secret_id).toBeNull();
    expect(updateArgs.oauth_state).toBeNull();

    expect(audit).toHaveBeenCalledTimes(1);
    expect(vi.mocked(audit).mock.calls[0]?.[0].event).toBe('integration.disconnected');
  });

  it('skips the Vault delete when there is no secret_id but still disconnects', async () => {
    const stub = makeSupabaseStub({
      'org_connections.select': {
        data: [{ id: 'conn-1', secret_id: null }],
        error: null,
      },
      'org_connections.update': { data: [{ id: 'conn-1' }], error: null },
    });
    const svc = new ConnectionsService(
      makeServiceContext(stub.client, {
        role: 'owner',
        enabledModules: new Set<ModuleId>(['integrations']),
      }),
    );

    await svc.disconnect('quickbooks');

    expect(deleteSpy).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledTimes(1);
  });

  it('throws forbidden without integrations:manage', async () => {
    const stub = makeSupabaseStub();
    const svc = new ConnectionsService(
      makeServiceContext(stub.client, {
        role: 'staff',
        enabledModules: new Set<ModuleId>(['integrations']),
      }),
    );
    await expect(svc.disconnect('quickbooks')).rejects.toBeInstanceOf(ServiceError);
  });

  it('throws module_disabled disconnecting quickbooks when the integrations module is off', async () => {
    // The module gate fires BEFORE the permission gate. An owner (who HAS
    // integrations:manage) must still be blocked with module_disabled when the
    // integrations module is off — proving the module check is not dropped.
    const stub = makeSupabaseStub();
    const svc = new ConnectionsService(
      makeServiceContext(stub.client, {
        role: 'owner',
        enabledModules: new Set<ModuleId>(),
      }),
    );
    await expect(svc.disconnect('quickbooks')).rejects.toMatchObject({ code: 'module_disabled' });
    // Gated before any DB read or Vault delete.
    expect(deleteSpy).not.toHaveBeenCalled();
    expect(stub.fromCalls).not.toContain('org_connections');
  });

  it('disconnects easypost under the shipping module + shipping:manage (owner)', async () => {
    // EasyPost is routed through the off-by-default `shipping` module +
    // `shipping:manage`, NOT integrations:manage. A shipping-only org with an
    // owner must be able to tear down its carrier connection.
    const stub = makeSupabaseStub({
      'org_connections.select': {
        data: [{ id: 'conn-ep', secret_id: 'ep-secret-1' }],
        error: null,
      },
      'org_connections.update': { data: [{ id: 'conn-ep' }], error: null },
    });
    const svc = new ConnectionsService(
      makeServiceContext(stub.client, {
        role: 'owner',
        enabledModules: new Set<ModuleId>(['shipping']),
      }),
    );

    await svc.disconnect('easypost');

    // Routed through shipping gating, the Vault secret was deleted + audited.
    expect(deleteSpy).toHaveBeenCalledTimes(1);
    expect(deleteSpy).toHaveBeenCalledWith(adminClientHolder.client, 'ep-secret-1');
    expect(vi.mocked(audit).mock.calls[0]?.[0].event).toBe('integration.disconnected');
  });

  it('throws forbidden disconnecting easypost without shipping:manage (shipping enabled)', async () => {
    // A role lacking shipping:manage (staff) must be blocked even with the
    // shipping module ON — and an integrations-only grant must NOT satisfy the
    // easypost branch's shipping:manage requirement.
    const stub = makeSupabaseStub();
    const svc = new ConnectionsService(
      makeServiceContext(stub.client, {
        role: 'staff',
        enabledModules: new Set<ModuleId>(['shipping', 'integrations']),
      }),
    );
    await expect(svc.disconnect('easypost')).rejects.toMatchObject({ code: 'forbidden' });
    expect(deleteSpy).not.toHaveBeenCalled();
    expect(stub.fromCalls).not.toContain('org_connections');
  });

  it('throws module_disabled disconnecting easypost when the shipping module is off', async () => {
    // The shipping module is OFF; integrations being on must NOT help the
    // easypost branch (it gates on `shipping`, not `integrations`). An owner is
    // still blocked with module_disabled.
    const stub = makeSupabaseStub();
    const svc = new ConnectionsService(
      makeServiceContext(stub.client, {
        role: 'owner',
        enabledModules: new Set<ModuleId>(['integrations']),
      }),
    );
    await expect(svc.disconnect('easypost')).rejects.toMatchObject({ code: 'module_disabled' });
    expect(deleteSpy).not.toHaveBeenCalled();
    expect(stub.fromCalls).not.toContain('org_connections');
  });
});

describe('ConnectionsService.listFailedSyncs (dead-letter view)', () => {
  function failedStub() {
    return makeSupabaseStub({
      'connection_sync_log.select': {
        data: [
          {
            id: 'sync-dead-1',
            topic: 'receipt.posted',
            status: 'dead',
            attempts: 8,
            external_id: null,
            last_error: 'QBO 400: invalid account id',
            next_attempt_at: null,
            completed_at: null,
            created_at: '2026-05-30T00:00:00Z',
            updated_at: '2026-05-30T01:00:00Z',
          },
        ],
        error: null,
      },
    });
  }

  it('returns only this org\'s failed rows, scoped + status-filtered', async () => {
    const stub = failedStub();
    const svc = new ConnectionsService(
      makeServiceContext(stub.client, {
        role: 'admin',
        enabledModules: new Set<ModuleId>(['integrations']),
      }),
    );

    const { rows } = await svc.listFailedSyncs();

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 'sync-dead-1', status: 'dead', attempts: 8 });

    // The query is org-scoped and restricted to error/dead rows.
    const chain = stub.chains.get('connection_sync_log.select') ?? [];
    expect(chain).toContain('eq');
    expect(chain).toContain('in');
    const args = stub.chainArgs.get('connection_sync_log.select') ?? [];
    expect(args).toContainEqual(['organization_id', 'org-test']);
    expect(args).toContainEqual(['status', ['error', 'dead']]);
  });

  it('throws forbidden when the caller lacks the manage permission', async () => {
    const stub = failedStub();
    const svc = new ConnectionsService(
      // staff has neither integrations:manage nor shipping:manage.
      makeServiceContext(stub.client, {
        role: 'staff',
        enabledModules: new Set<ModuleId>(['integrations']),
      }),
    );
    await expect(svc.listFailedSyncs()).rejects.toMatchObject({ code: 'forbidden' });
    // Gated before any DB read.
    expect(stub.fromCalls).not.toContain('connection_sync_log');
  });

  it('throws module_disabled when NEITHER integrations nor shipping is enabled', async () => {
    const stub = failedStub();
    const svc = new ConnectionsService(
      makeServiceContext(stub.client, {
        role: 'owner',
        enabledModules: new Set<ModuleId>(),
      }),
    );
    await expect(svc.listFailedSyncs()).rejects.toMatchObject({ code: 'module_disabled' });
  });

  it('is reachable for a shipping-only org with shipping:manage', async () => {
    const stub = failedStub();
    const svc = new ConnectionsService(
      makeServiceContext(stub.client, {
        role: 'owner',
        enabledModules: new Set<ModuleId>(['shipping']),
      }),
    );
    const { rows } = await svc.listFailedSyncs();
    expect(rows).toHaveLength(1);
  });
});

describe('ConnectionsService.replaySync', () => {
  it('flips a dead row to pending (attempts=0, next_attempt_at=null), org-scoped', async () => {
    const stub = makeSupabaseStub({
      'connection_sync_log.update': { data: [{ id: 'sync-dead-1' }], error: null },
    });
    const svc = new ConnectionsService(
      makeServiceContext(stub.client, {
        role: 'admin',
        enabledModules: new Set<ModuleId>(['integrations']),
      }),
    );

    await svc.replaySync('sync-dead-1');

    const updateArgs = stub.chainArgsAll.get('connection_sync_log.update')?.[0]?.[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(updateArgs.status).toBe('pending');
    expect(updateArgs.attempts).toBe(0);
    expect(updateArgs.next_attempt_at).toBeNull();

    // Org-scoped + status-restricted UPDATE (only error/dead rows are replayable).
    const chain = stub.chains.get('connection_sync_log.update') ?? [];
    expect(chain).toContain('in');
    const filterArgs = stub.chainArgs.get('connection_sync_log.update') ?? [];
    expect(filterArgs).toContainEqual(['id', 'sync-dead-1']);
    expect(filterArgs).toContainEqual(['organization_id', 'org-test']);
    expect(filterArgs).toContainEqual(['status', ['error', 'dead']]);

    expect(audit).toHaveBeenCalledTimes(1);
    expect(vi.mocked(audit).mock.calls[0]?.[0].event).toBe('integration.sync_replayed');
  });

  it('throws not_found when no replayable row matches (other-org / not failed)', async () => {
    const stub = makeSupabaseStub({
      // RLS / filters matched nothing → maybeSingle resolves null.
      'connection_sync_log.update': { data: [], error: null },
    });
    const svc = new ConnectionsService(
      makeServiceContext(stub.client, {
        role: 'admin',
        enabledModules: new Set<ModuleId>(['integrations']),
      }),
    );
    await expect(svc.replaySync('missing-id')).rejects.toMatchObject({ code: 'not_found' });
    // No audit emitted on a no-op replay.
    expect(audit).not.toHaveBeenCalled();
  });

  it('throws forbidden when the caller lacks the manage permission', async () => {
    const stub = makeSupabaseStub();
    const svc = new ConnectionsService(
      makeServiceContext(stub.client, {
        role: 'staff',
        enabledModules: new Set<ModuleId>(['integrations']),
      }),
    );
    await expect(svc.replaySync('sync-dead-1')).rejects.toMatchObject({ code: 'forbidden' });
    // Gated before any DB write.
    expect(stub.fromCalls).not.toContain('connection_sync_log');
  });

  it('throws module_disabled when NEITHER integrations nor shipping is enabled', async () => {
    const stub = makeSupabaseStub();
    const svc = new ConnectionsService(
      makeServiceContext(stub.client, {
        role: 'owner',
        enabledModules: new Set<ModuleId>(),
      }),
    );
    await expect(svc.replaySync('sync-dead-1')).rejects.toMatchObject({ code: 'module_disabled' });
    expect(stub.fromCalls).not.toContain('connection_sync_log');
  });
});

describe('ConnectionsService.saveAccountMapping', () => {
  it('persists the QBO account ids into settings.accountIds', async () => {
    const stub = makeSupabaseStub({
      'org_connections.select': {
        data: [{ id: 'conn-1', settings: { env: 'sandbox' } }],
        error: null,
      },
      'org_connections.update': { data: [{ id: 'conn-1' }], error: null },
    });
    const svc = new ConnectionsService(
      makeServiceContext(stub.client, {
        role: 'owner',
        enabledModules: new Set<ModuleId>(['integrations']),
      }),
    );

    await svc.saveAccountMapping('quickbooks', {
      billExpense: '54',
      inventoryAsset: '81',
      valuationOffset: '90',
      returnCredit: '47',
    });

    const updateArgs = stub.chainArgsAll.get('org_connections.update')?.[0]?.[0]?.[0] as {
      settings: Record<string, unknown>;
    };
    expect(updateArgs.settings).toMatchObject({
      // Existing non-secret settings preserved (merge, not clobber).
      env: 'sandbox',
      accountIds: {
        billExpense: '54',
        inventoryAsset: '81',
        valuationOffset: '90',
        returnCredit: '47',
      },
    });
  });

  it('throws forbidden without integrations:manage', async () => {
    const stub = makeSupabaseStub();
    const svc = new ConnectionsService(
      makeServiceContext(stub.client, {
        role: 'staff',
        enabledModules: new Set<ModuleId>(['integrations']),
      }),
    );
    await expect(
      svc.saveAccountMapping('quickbooks', {
        billExpense: '',
        inventoryAsset: '',
        valuationOffset: '',
        returnCredit: '',
      }),
    ).rejects.toBeInstanceOf(ServiceError);
  });
});

/**
 * docket S27: every integration write reports what the database did. The
 * service gates on the member's EFFECTIVE key, but org_connections' row rule
 * (0146) still asks for the admin role, so a member given Manage integrations
 * or Manage shipping passes the gate and is refused by the database. Before:
 *   - an update the rule refused changes 0 rows with no error, and disconnect
 *     went on to delete the Vault secret and audit "disconnected" (the row kept
 *     a dangling secret_id), and the settings saves reported success;
 *   - connect wrote the Vault secret BEFORE the write the database checks, so a
 *     refused reconnect had already replaced the live key in place;
 *   - an insert or upsert the rule refused (42501) read as an internal error.
 */
describe('ConnectionsService: writes report what the database did (docket S27)', () => {
  const REFUSED_42501 = {
    data: null,
    error: {
      code: '42501',
      message: 'new row violates row-level security policy for table "org_connections"',
    },
  };
  const REFUSED = { code: 'forbidden', message: INTEGRATION_WRITE_REFUSED };
  /** The Zendesk connect form, with placeholder values. */
  const FORM_VALUE = 'placeholder-1';
  const ZENDESK_FORM = { subdomain: 'example', email: 'agent@example.com', apiToken: FORM_VALUE };
  /** A member given the key, whom the database's admin-only rule refuses. */
  const keyHolder = (permissions: string[], modules: ModuleId[]) =>
    makeServiceContext(makeSupabaseStub().client, {
      role: 'manager',
      permissions: new Set(permissions),
      enabledModules: new Set<ModuleId>(modules),
    });
  const withClient = (
    stub: ReturnType<typeof makeSupabaseStub>,
    ctx: ReturnType<typeof keyHolder>,
  ) => new ConnectionsService({ ...ctx, supabase: stub.client });

  it('the refusal names no table, policy or code', () => {
    expect(INTEGRATION_WRITE_REFUSED).toBe(
      'This change was not saved: your access does not allow it. Ask an owner or an admin.',
    );
  });

  describe('a refused update (0 rows, no error)', () => {
    it('disconnect deletes no Vault secret and writes no audit', async () => {
      const stub = makeSupabaseStub({
        'org_connections.select': {
          data: [{ id: 'conn-1', secret_id: 'secret-uuid-123' }],
          error: null,
        },
        'org_connections.update': { data: [], error: null },
      });
      const svc = withClient(stub, keyHolder(['integrations:manage'], ['integrations']));
      await expect(svc.disconnect('quickbooks')).rejects.toMatchObject(REFUSED);
      expect(deleteSpy).not.toHaveBeenCalled();
      expect(audit).not.toHaveBeenCalled();
      // The update asks for the row it changed.
      expect(stub.chainsAll.get('org_connections.update')?.[0]).toContain('select');
    });

    it('saving the QuickBooks account mapping is refused, not reported saved', async () => {
      const stub = makeSupabaseStub({
        'org_connections.select': { data: [{ id: 'conn-1', settings: {} }], error: null },
        'org_connections.update': { data: [], error: null },
      });
      const svc = withClient(stub, keyHolder(['integrations:manage'], ['integrations']));
      await expect(
        svc.saveAccountMapping('quickbooks', {
          billExpense: '54',
          inventoryAsset: '81',
          valuationOffset: '90',
          returnCredit: '47',
        }),
      ).rejects.toMatchObject(REFUSED);
    });

    it('saving the Sage Intacct settings is refused, not reported saved', async () => {
      const stub = makeSupabaseStub({
        'org_connections.select': { data: [{ id: 'conn-si', settings: {} }], error: null },
        'org_connections.update': { data: [], error: null },
      });
      const svc = withClient(stub, keyHolder(['integrations:manage'], ['integrations']));
      await expect(
        svc.saveIntacctSettings({
          poTxnDefinition: 'Purchase Order',
          defaultItemId: 'NONINV',
          defaultVendorId: 'VDEF',
          journalSymbol: 'GJ',
          returnCredit: '4900',
          inventoryAsset: '1200',
        }),
      ).rejects.toMatchObject(REFUSED);
    });
  });

  describe('a refused insert or upsert (42501) is a refusal, never an internal error', () => {
    it('beginConnect; any other write error stays internal (matched by code, never by text)', async () => {
      const stub = makeSupabaseStub({
        'org_connections.select': { data: [], error: null },
        'org_connections.insert': REFUSED_42501,
      });
      const svc = withClient(stub, keyHolder(['integrations:manage'], ['integrations']));
      await expect(svc.beginConnect('quickbooks')).rejects.toMatchObject(REFUSED);

      const other = makeSupabaseStub({
        'org_connections.select': { data: [], error: null },
        'org_connections.insert': {
          data: null,
          error: { code: '23505', message: 'violates row-level security policy (a look-alike)' },
        },
      });
      await expect(
        withClient(other, keyHolder(['integrations:manage'], ['integrations'])).beginConnect(
          'quickbooks',
        ),
      ).rejects.toMatchObject({ code: 'internal_error' });
    });

    it('connectApiKey (EasyPost): refused before any Vault write', async () => {
      const stub = makeSupabaseStub({
        'org_connections.select': {
          data: [{ id: 'conn-ep', settings: {}, created_by: 'owner-1' }],
          error: null,
        },
        'org_connections.insert': REFUSED_42501,
      });
      const svc = withClient(stub, keyHolder(['shipping:manage'], ['shipping']));
      await expect(svc.connectApiKey('easypost', 'EZAK_live_key')).rejects.toMatchObject(REFUSED);
      expect(putSpy).not.toHaveBeenCalled();
      expect(audit).not.toHaveBeenCalled();
    });

    it('connectZendesk: refused before any Vault write', async () => {
      const stub = makeSupabaseStub({
        'org_connections.select': {
          data: [{ id: 'conn-zd', settings: {}, created_by: 'owner-1' }],
          error: null,
        },
        'org_connections.insert': REFUSED_42501,
      });
      const svc = withClient(stub, keyHolder(['integrations:manage'], ['zendesk']));
      await expect(svc.connectZendesk(ZENDESK_FORM)).rejects.toMatchObject(REFUSED);
      expect(putSpy).not.toHaveBeenCalled();
      expect(audit).not.toHaveBeenCalled();
    });

    it('setZendeskSubdomain', async () => {
      const stub = makeSupabaseStub({
        'org_connections.select': { data: [], error: null },
        'org_connections.insert': REFUSED_42501,
      });
      const svc = withClient(stub, keyHolder(['integrations:manage'], ['zendesk']));
      await expect(svc.setZendeskSubdomain('example')).rejects.toMatchObject(REFUSED);
      expect(audit).not.toHaveBeenCalled();
    });
  });

  describe('connect: the member writes the row, then Vault, then the service role activates it', () => {
    /** Every step, in the order it ran. */
    let steps: string[] = [];
    beforeEach(() => {
      steps = [];
      putSpy.mockImplementation(async (_admin, name) => {
        steps.push(`vault ${name}`);
        return 'vault-secret-id-1';
      });
      vi.mocked(audit).mockImplementation(async () => {
        steps.push('audit');
      });
    });
    afterEach(() => {
      putSpy.mockImplementation(async () => 'vault-secret-id-1');
      vi.mocked(audit).mockImplementation(async () => undefined);
    });

    function clients(existing: Array<Record<string, unknown>>) {
      const stub = makeSupabaseStub({
        'org_connections.select': { data: existing, error: null },
        'org_connections.insert': () => {
          steps.push('member upsert');
          return { data: [{ id: 'conn-row-1' }], error: null };
        },
      });
      const adminStub = makeSupabaseStub({
        'org_connections.update': () => {
          steps.push('service-role update');
          return { data: [{ id: 'conn-row-1' }], error: null };
        },
      });
      adminClientHolder.client = adminStub.client;
      return { stub, adminStub };
    }
    const activation = (adminStub: ReturnType<typeof makeSupabaseStub>) => ({
      values: adminStub.chainArgsAll.get('org_connections.update')?.[0]?.[0]?.[0] as Record<
        string,
        unknown
      >,
      filters: adminStub.chainArgsAll.get('org_connections.update')?.[0],
    });

    it('EasyPost: the secret is named by the row the database accepted, on a first connect too', async () => {
      const { stub, adminStub } = clients([]);
      const svc = withClient(stub, keyHolder(['shipping:manage'], ['shipping']));
      await svc.connectApiKey('easypost', 'EZTK_test_key_123');

      expect(steps).toEqual([
        'member upsert',
        'vault connector:conn-row-1',
        'service-role update',
        'audit',
      ]);
      expect(stub.chainArgsAll.get('org_connections.insert')?.[0]?.[0]?.[0]).toEqual({
        organization_id: 'org-test',
        provider_id: 'easypost',
        created_by: 'user-test',
      });
      const { values, filters } = activation(adminStub);
      expect(values).toMatchObject({
        status: 'active',
        secret_id: 'vault-secret-id-1',
        oauth_state: null,
        settings: { mode: 'test' },
      });
      expect(typeof values.last_connected_at).toBe('string');
      expect(filters).toContainEqual(['id', 'conn-row-1']);
      expect(filters).toContainEqual(['organization_id', 'org-test']);
      expect(vi.mocked(audit).mock.calls[0]?.[0]).toMatchObject({
        event: 'integration.connected',
        entityId: 'conn-row-1',
      });
    });

    it('Zendesk: the subdomain and email ride the service-role activation, keeping the saved settings', async () => {
      const { stub, adminStub } = clients([
        { id: 'conn-row-1', settings: { embedded: true }, created_by: 'owner-1' },
      ]);
      const svc = withClient(stub, keyHolder(['integrations:manage'], ['zendesk']));
      await svc.connectZendesk(ZENDESK_FORM);

      expect(steps).toEqual([
        'member upsert',
        'vault connector:conn-row-1',
        'service-role update',
        'audit',
      ]);
      expect(stub.chainArgsAll.get('org_connections.insert')?.[0]?.[0]?.[0]).toEqual({
        organization_id: 'org-test',
        provider_id: 'zendesk',
        created_by: 'owner-1',
      });
      expect(activation(adminStub).values).toMatchObject({
        status: 'active',
        secret_id: 'vault-secret-id-1',
        external_account_id: 'example',
        oauth_state: null,
        settings: { embedded: true, subdomain: 'example', email: 'agent@example.com' },
      });
    });

    it('a failed activation is reported and refused, never reported connected', async () => {
      const { stub } = clients([]);
      adminClientHolder.client = makeSupabaseStub({
        'org_connections.update': { data: null, error: { message: 'timeout' } },
      }).client;
      const svc = withClient(stub, keyHolder(['shipping:manage'], ['shipping']));
      await expect(svc.connectApiKey('easypost', 'EZTK_test_key_123')).rejects.toMatchObject({
        code: 'internal_error',
      });
      expect(audit).not.toHaveBeenCalled();
      expect(reportError).toHaveBeenCalledWith(expect.any(Error), {
        tag: 'integrations.connect.activate',
        extra: { connectionId: 'conn-row-1', provider: 'easypost' },
      });
    });

    // docket S27 review: an activation that changed no row (the row was
    // deleted between the member's write and the activation) answers no
    // error, so only the guard's "no row" half refuses it.
    it('an activation that updates no row is reported and refused, never reported connected', async () => {
      const { stub } = clients([]);
      adminClientHolder.client = makeSupabaseStub({
        'org_connections.update': { data: [], error: null },
      }).client;
      const svc = withClient(stub, keyHolder(['shipping:manage'], ['shipping']));
      await expect(svc.connectApiKey('easypost', 'EZTK_test_key_123')).rejects.toMatchObject({
        code: 'internal_error',
      });
      expect(audit).not.toHaveBeenCalled();
      expect(reportError).toHaveBeenCalledTimes(1);
      expect(reportError).toHaveBeenCalledWith(expect.any(Error), {
        tag: 'integrations.connect.activate',
        extra: { connectionId: 'conn-row-1', provider: 'easypost' },
      });
      expect((vi.mocked(reportError).mock.calls[0]?.[0] as Error).message).toBe(
        'org_connections activate: the activation updated no row',
      );
    });

    // docket S27 review: a member write that answers no row (an empty body,
    // no error) gives no id to name the Vault secret by. Without the guard
    // the secret was named `connector:undefined`, one name every organization
    // would share, and connector_secret_put updates a secret by name in place.
    it('a member write that answers no row is refused before any Vault write', async () => {
      const stub = makeSupabaseStub({
        'org_connections.select': { data: [], error: null },
        'org_connections.insert': { data: null, error: null },
      });
      const svc = withClient(stub, keyHolder(['shipping:manage'], ['shipping']));
      await expect(svc.connectApiKey('easypost', 'EZTK_test_key_123')).rejects.toMatchObject(
        REFUSED,
      );
      expect(putSpy).not.toHaveBeenCalled();
      expect(audit).not.toHaveBeenCalled();
    });
  });

  /**
   * docket S27 review: the dead-letter view lists a failed sync to every
   * member given either key (its select rule is member-level), but the replay
   * rule (0152) is admin-only, so a member's replay changed 0 rows and was
   * told "No replayable failed sync was found for that id." about a row on
   * their screen. A failed sync the member can still see is a refusal; any
   * other 0-row replay stays not found.
   */
  describe('a replay the database refused', () => {
    const BOTH = ['integrations', 'shipping'] as ModuleId[];
    const replayWith = (reread: { data: unknown; error: { message: string } | null }) => {
      const stub = makeSupabaseStub({
        'connection_sync_log.update': { data: [], error: null },
        'connection_sync_log.select': reread,
      });
      return { stub, svc: withClient(stub, keyHolder(['shipping:manage'], BOTH)) };
    };

    it.each([
      ['a dead', 'dead'],
      ['an error', 'error'],
    ])('on %s sync the member can see is a refusal, not "not found"', async (_label, status) => {
      const { stub, svc } = replayWith({ data: [{ id: 'sync-1', status }], error: null });
      await expect(svc.replaySync('sync-1')).rejects.toMatchObject(REFUSED);
      expect(audit).not.toHaveBeenCalled();
      // The second look is the member's own read of that row, in this organization.
      const reread = stub.chainArgsAll.get('connection_sync_log.select')?.[0];
      expect(reread).toContainEqual(['id', 'sync-1']);
      expect(reread).toContainEqual(['organization_id', 'org-test']);
    });

    it.each([
      ['a row the member cannot see', { data: [], error: null }],
      [
        'a sync that is no longer failed (replayed already)',
        { data: [{ id: 'sync-1', status: 'pending' }], error: null },
      ],
      [
        'a sync that has since succeeded',
        { data: [{ id: 'sync-1', status: 'success' }], error: null },
      ],
      ['a second look that fails', { data: null, error: { message: 'timeout' } }],
    ])('stays "not found" for %s', async (_case, reread) => {
      const { svc } = replayWith(reread);
      await expect(svc.replaySync('sync-1')).rejects.toMatchObject({
        code: 'not_found',
        message: 'No replayable failed sync was found for that id.',
      });
      expect(audit).not.toHaveBeenCalled();
    });
  });

  /**
   * The Integrations page loads the dead-letter view whenever a card shows:
   * the QuickBooks card for Manage integrations, the EasyPost card for Manage
   * shipping. assertSyncLogManage picked the key to assert by STATIC role, then
   * asserted it on the effective set, so it refused a manager given Manage
   * shipping and an admin whose Manage integrations was taken away: the page
   * crashed for both.
   */
  describe('the dead-letter view follows the key of each enabled module', () => {
    const BOTH = ['integrations', 'shipping'] as ModuleId[];
    const failedSyncs = (ctx: ReturnType<typeof keyHolder>) =>
      withClient(
        makeSupabaseStub({ 'connection_sync_log.select': { data: [], error: null } }),
        ctx,
      ).listFailedSyncs();

    it('a manager given Manage shipping reads it; a member with neither key is still refused', async () => {
      await expect(failedSyncs(keyHolder(['shipping:manage'], BOTH))).resolves.toEqual({
        rows: [],
      });
      await expect(failedSyncs(keyHolder(['items:read'], BOTH))).rejects.toMatchObject({
        code: 'forbidden',
      });
      // Manage shipping does not open it when only integrations is on.
      await expect(
        failedSyncs(keyHolder(['shipping:manage'], ['integrations'])),
      ).rejects.toMatchObject({
        code: 'forbidden',
      });
    });

    it('an admin whose Manage integrations was taken away, who kept Manage shipping, reads it and can replay', async () => {
      const ctx = makeServiceContext(makeSupabaseStub().client, {
        role: 'admin',
        permissions: new Set(['shipping:manage']),
        enabledModules: new Set<ModuleId>(BOTH),
      });
      const stub = makeSupabaseStub({
        'connection_sync_log.select': { data: [], error: null },
        'connection_sync_log.update': { data: [{ id: 'sync-1' }], error: null },
      });
      const svc = new ConnectionsService({ ...ctx, supabase: stub.client });
      await expect(svc.listFailedSyncs()).resolves.toEqual({ rows: [] });
      await expect(svc.replaySync('sync-1')).resolves.toBeUndefined();
    });

    it('the MFA gate still runs first', async () => {
      const ctx = makeServiceContext(makeSupabaseStub().client, {
        role: 'manager',
        permissions: new Set(['shipping:manage']),
        enabledModules: new Set<ModuleId>(BOTH),
        mfaRequired: true,
        mfaSatisfied: false,
      });
      await expect(new ConnectionsService(ctx).listFailedSyncs()).rejects.toMatchObject({
        code: 'forbidden',
        details: { reason: 'mfa_required' },
      });
      // With the session stepped up, the same member reads it.
      await expect(failedSyncs(keyHolder(['shipping:manage'], BOTH))).resolves.toEqual({
        rows: [],
      });
    });
  });
});
