import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

// audit + admin client are side-effecting; stub them so the service runs in
// isolation and we can assert on calls. The Vault delete RPC goes through the
// admin (service-role) client per the secret invariant.
vi.mock('@/server/services/audit', () => ({
  audit: vi.fn(async () => undefined),
}));

const deleteSpy = vi.fn(async (_admin: unknown, _secretId: string) => undefined);
vi.mock('@/server/connectors/secret-store', () => ({
  deleteConnectionSecret: (admin: unknown, secretId: string) => deleteSpy(admin, secretId),
}));

const adminClientHolder = { client: { _admin: true } as unknown };
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: vi.fn(() => adminClientHolder.client),
}));

import { env } from '@/lib/env';
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
