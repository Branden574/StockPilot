import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';
import { DEFAULT_MODULE_IDS, type ModuleId } from '@stockpilot/core';

const validateToken = vi.fn();
vi.mock('@/server/connectors/zendesk/client', () => ({
  ZendeskApiError: class extends Error { constructor(public status: number){ super('z'); } },
  ZendeskClient: vi.fn().mockImplementation(() => ({ validateToken })),
}));
vi.mock('@/server/connectors/secret-store', () => ({
  putConnectionSecret: vi.fn(async () => 'secret-id-1'),
  deleteConnectionSecret: vi.fn(async () => {}),
}));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }));

import { ZendeskClient } from '@/server/connectors/zendesk/client';
import { ConnectionsService } from './connections';

const withZ = () => new Set<ModuleId>([...DEFAULT_MODULE_IDS, 'zendesk']);
const input = { subdomain: 'acme', email: 'a@acme.com', apiToken: 'tok' };

beforeEach(() => {
  vi.mocked(ZendeskClient).mockImplementation(() => ({ validateToken }) as never);
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

  it('connects: validates, stores secret, upserts org_connections', async () => {
    validateToken.mockResolvedValueOnce(undefined);
    const stub = makeSupabaseStub({
      'org_connections.select': { data: null, error: null },
      'org_connections.upsert': { data: { id: 'conn-1' }, error: null },
    });
    const svc = new ConnectionsService(makeServiceContext(stub.client, { enabledModules: withZ(), role: 'admin' }));
    await svc.connectZendesk(input);
    expect(stub.fromCalls).toContain('org_connections');
  });

  it('getZendeskConnection returns null when never connected', async () => {
    const stub = makeSupabaseStub({ 'org_connections.select': { data: null, error: null } });
    const svc = new ConnectionsService(makeServiceContext(stub.client, { enabledModules: withZ(), role: 'admin' }));
    await expect(svc.getZendeskConnection()).resolves.toBeNull();
  });
});
