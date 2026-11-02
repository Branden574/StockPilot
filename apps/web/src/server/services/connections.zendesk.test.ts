import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';
import { DEFAULT_MODULE_IDS, type ModuleId } from '@stockpilot/core';

const validateToken = vi.fn();
vi.mock('@/server/connectors/zendesk/client', () => ({
  ZendeskApiError: class extends Error { constructor(public status: number){ super('z'); } },
  ZendeskClient: vi.fn().mockImplementation(function () {
    return { validateToken };
  }),
}));
vi.mock('@/server/connectors/secret-store', () => ({
  putConnectionSecret: vi.fn(async () => 'secret-id-1'),
  deleteConnectionSecret: vi.fn(async () => {}),
}));
const adminHolder = vi.hoisted(() => ({ client: {} as unknown }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => adminHolder.client }));

import { ZendeskClient } from '@/server/connectors/zendesk/client';
import { ConnectionsService } from './connections';

const withZ = () => new Set<ModuleId>([...DEFAULT_MODULE_IDS, 'zendesk']);
const input = { subdomain: 'acme', email: 'a@acme.com', apiToken: 'tok' };

beforeEach(() => {
  vi.mocked(ZendeskClient).mockImplementation(function () {
    return { validateToken } as never;
  });
  validateToken.mockReset();
});

describe('ConnectionsService.connectZendesk', () => {
  it('throws module_disabled when zendesk is off', async () => {
    const stub = makeSupabaseStub({});
    const svc = new ConnectionsService(makeServiceContext(stub.client));
    await expect(svc.connectZendesk(input)).rejects.toMatchObject({ code: 'module_disabled' });
  });

  it('throws forbidden for a non-admin', async () => {
    const stub = makeSupabaseStub({});
    const svc = new ConnectionsService(makeServiceContext(stub.client, { enabledModules: withZ(), role: 'staff' }));
    await expect(svc.connectZendesk(input)).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('rejects a bad token as validation_error', async () => {
    validateToken.mockRejectedValueOnce(Object.assign(new Error('z'), { status: 401 }));
    const stub = makeSupabaseStub({ 'org_connections.select': { data: null, error: null } });
    const svc = new ConnectionsService(makeServiceContext(stub.client, { enabledModules: withZ(), role: 'admin' }));
    await expect(svc.connectZendesk(input)).rejects.toMatchObject({ code: 'validation_error' });
  });

  it('connects: validates, writes the row, stores the secret, then activates it with the service role', async () => {
    validateToken.mockResolvedValueOnce(undefined);
    const stub = makeSupabaseStub({
      'org_connections.select': { data: null, error: null },
      // upsert() resolves under the insert key; .select('id') answers the row.
      'org_connections.insert': { data: [{ id: 'conn-1' }], error: null },
    });
    const admin = makeSupabaseStub({
      'org_connections.update': { data: [{ id: 'conn-1' }], error: null },
    });
    adminHolder.client = admin.client;
    const svc = new ConnectionsService(makeServiceContext(stub.client, { enabledModules: withZ(), role: 'admin' }));
    await svc.connectZendesk(input);
    expect(stub.fromCalls).toContain('org_connections');
    // The member's write carries no secret: the service role sets secret_id (docket S27).
    expect(stub.chainArgsAll.get('org_connections.insert')?.[0]?.[0]?.[0]).not.toHaveProperty(
      'secret_id',
    );
    expect(admin.chainArgsAll.get('org_connections.update')?.[0]?.[0]?.[0]).toMatchObject({
      status: 'active',
      secret_id: 'secret-id-1',
      external_account_id: 'acme',
    });
  });

  it('getZendeskConnection returns null when never connected', async () => {
    const stub = makeSupabaseStub({ 'org_connections.select': { data: null, error: null } });
    const svc = new ConnectionsService(makeServiceContext(stub.client, { enabledModules: withZ(), role: 'admin' }));
    await expect(svc.getZendeskConnection()).resolves.toBeNull();
  });
});
