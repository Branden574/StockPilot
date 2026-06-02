import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const withApiContext = vi.fn();
vi.mock('@/lib/auth/api-context', () => ({ withApiContext: (...a: unknown[]) => withApiContext(...a) }));
const getZendeskConnection = vi.fn();
const connectZendesk = vi.fn();
const disconnect = vi.fn();
vi.mock('@/server/services/connections', () => ({
  ConnectionsService: vi.fn().mockImplementation(() => ({ getZendeskConnection, connectZendesk, disconnect })),
}));

import { GET as getConnection } from './connection/route';
import { POST as postConnect } from './connect/route';
import { POST as postDisconnect } from './disconnect/route';
import { ConnectionsService } from '@/server/services/connections';

beforeEach(() => {
  vi.mocked(ConnectionsService).mockImplementation(() => ({ getZendeskConnection, connectZendesk, disconnect }) as never);
  getZendeskConnection.mockReset(); connectZendesk.mockReset(); disconnect.mockReset();
});

const ctx = { userId: 'u1', organizationId: 'o1', role: 'admin' };
function jreq(path: string, body?: unknown) {
  return new NextRequest(`http://localhost${path}`, body === undefined ? { method: 'GET' } : { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
}

describe('zendesk mobile endpoints', () => {
  it('GET connection 401 unauth', async () => {
    withApiContext.mockResolvedValueOnce(null);
    expect((await getConnection(jreq('/api/v1/zendesk/connection'))).status).toBe(401);
  });
  it('GET connection returns connection + canManage', async () => {
    withApiContext.mockResolvedValueOnce(ctx);
    getZendeskConnection.mockResolvedValueOnce({ status: 'active', subdomain: 'acme', lastConnectedAt: null, lastError: null });
    const res = await getConnection(jreq('/api/v1/zendesk/connection'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.connection.subdomain).toBe('acme');
    expect(body.canManage).toBe(true);
  });
  it('POST connect 400 on bad body', async () => {
    withApiContext.mockResolvedValueOnce(ctx);
    expect((await postConnect(jreq('/api/v1/zendesk/connect', { subdomain: '', email: 'x', apiToken: '' }))).status).toBe(400);
  });
  it('POST connect delegates', async () => {
    withApiContext.mockResolvedValueOnce(ctx);
    connectZendesk.mockResolvedValueOnce(undefined);
    const res = await postConnect(jreq('/api/v1/zendesk/connect', { subdomain: 'acme', email: 'a@acme.com', apiToken: 'tok' }));
    expect(res.status).toBe(200);
    expect(connectZendesk).toHaveBeenCalledOnce();
  });
  it('POST disconnect delegates', async () => {
    withApiContext.mockResolvedValueOnce(ctx);
    disconnect.mockResolvedValueOnce(undefined);
    const res = await postDisconnect(jreq('/api/v1/zendesk/disconnect'));
    expect(res.status).toBe(200);
    expect(disconnect).toHaveBeenCalledWith('zendesk');
  });
  it('maps module_disabled to 403', async () => {
    withApiContext.mockResolvedValueOnce(ctx);
    const { ServiceError } = await import('@/server/services/context');
    getZendeskConnection.mockRejectedValueOnce(new ServiceError('module_disabled', 'off'));
    expect((await getConnection(jreq('/api/v1/zendesk/connection'))).status).toBe(403);
  });
});
