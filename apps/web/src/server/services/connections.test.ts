import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

// audit + admin client are side-effecting; stub them so the service runs in
// isolation and we can assert on calls. The Vault delete RPC goes through the
// admin (service-role) client per the secret invariant.
vi.mock('@/server/services/audit', () => ({
  audit: vi.fn(async () => undefined),
}));

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

const adminClientHolder = { client: { _admin: true } as unknown };
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: vi.fn(() => adminClientHolder.client),
}));

import { env } from '@/lib/env';
import { EasyPostApiError } from '@/server/connectors/easypost/client';
import { audit } from '@/server/services/audit';
import { ConnectionsService } from './connections';
import { ServiceError } from './context';

import type { ModuleId } from '@stockpilot/core';

// env.QBO_CLIENT_ID is optionalSecret (defaults to '' in the test env, which
// has no Intuit creds). beginConnect() now fast-fails when it's empty, so the
// happy-path tests need a non-empty client id; we stamp one per test and
// restore the original afterwards. The misconfiguration test overrides this
// back to '' inside its own body.
const ORIGINAL_QBO_CLIENT_ID = env.QBO_CLIENT_ID;

beforeEach(() => {
  vi.clearAllMocks();
  // Reset the EasyPost key validation to the happy path (good key); the
  // bad-key test overrides it.
  validateKeySpy.mockResolvedValue(undefined);
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

    // Connection upserted active with the Vault secret id + mode (test, from the
    // EZTK prefix). The raw key must NOT appear in settings.
    const upsertArgs = stub.chainArgsAll.get('org_connections.insert')?.[0]?.[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(upsertArgs.provider_id).toBe('easypost');
    expect(upsertArgs.status).toBe('active');
    expect(upsertArgs.secret_id).toBe('vault-secret-id-1');
    expect(upsertArgs.settings).toMatchObject({ mode: 'test' });
    expect(JSON.stringify(upsertArgs.settings)).not.toContain('EZTK_test_key_123');

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
      'org_connections.update': { data: null, error: null },
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
      'org_connections.update': { data: null, error: null },
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
      'org_connections.update': { data: null, error: null },
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
      'org_connections.update': { data: null, error: null },
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
    });

    const updateArgs = stub.chainArgsAll.get('org_connections.update')?.[0]?.[0]?.[0] as {
      settings: Record<string, unknown>;
    };
    expect(updateArgs.settings).toMatchObject({
      // Existing non-secret settings preserved (merge, not clobber).
      env: 'sandbox',
      accountIds: { billExpense: '54', inventoryAsset: '81', valuationOffset: '90' },
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
      }),
    ).rejects.toBeInstanceOf(ServiceError);
  });
});
