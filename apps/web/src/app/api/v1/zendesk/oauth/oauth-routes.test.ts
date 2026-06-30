import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// ── Mock withApiContext ────────────────────────────────────────────────────────
const withApiContext = vi.fn();
vi.mock('@/lib/auth/api-context', () => ({ withApiContext: (...a: unknown[]) => withApiContext(...a) }));

// ── Mock UserConnectionsService ───────────────────────────────────────────────
const beginZendeskConnect = vi.fn();
const completeZendeskConnect = vi.fn();
const completeFromState = vi.fn();
vi.mock('@/server/services/user-connections', () => ({
  UserConnectionsService: Object.assign(
    vi.fn().mockImplementation(() => ({ beginZendeskConnect, completeZendeskConnect })),
    { completeFromState: (...a: unknown[]) => completeFromState(...a) },
  ),
}));

// ── Mock verifyState ──────────────────────────────────────────────────────────
const verifyState = vi.fn();
vi.mock('@/server/connectors/zendesk/oauth-state', () => ({ verifyState: (...a: unknown[]) => verifyState(...a) }));

import { GET as startRoute } from './start/route';
import { GET as callbackRoute } from './callback/route';
import { UserConnectionsService } from '@/server/services/user-connections';

beforeEach(() => {
  vi.mocked(UserConnectionsService).mockImplementation(
    () => ({ beginZendeskConnect, completeZendeskConnect }) as never,
  );
  beginZendeskConnect.mockReset();
  completeZendeskConnect.mockReset();
  completeFromState.mockReset();
  withApiContext.mockReset();
  verifyState.mockReset();
});

const ctx = { userId: 'u1', organizationId: 'o1', role: 'admin' };

function greq(path: string) {
  return new NextRequest(`http://localhost${path}`, { method: 'GET' });
}

// ── start/route ───────────────────────────────────────────────────────────────
describe('GET /api/v1/zendesk/oauth/start', () => {
  it('returns 401 when withApiContext returns null', async () => {
    withApiContext.mockResolvedValueOnce(null);
    const res = await startRoute(greq('/api/v1/zendesk/oauth/start'));
    expect(res.status).toBe(401);
  });

  it('redirects (302) to authorizeUrl for web platform by default', async () => {
    withApiContext.mockResolvedValueOnce(ctx);
    beginZendeskConnect.mockResolvedValueOnce({ authorizeUrl: 'https://acme.zendesk.com/oauth/authorizations/new?...' });
    const res = await startRoute(greq('/api/v1/zendesk/oauth/start'));
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://acme.zendesk.com/oauth/authorizations/new?...');
    expect(beginZendeskConnect).toHaveBeenCalledWith('web');
  });

  it('calls beginZendeskConnect with "mobile" when ?platform=mobile', async () => {
    withApiContext.mockResolvedValueOnce(ctx);
    beginZendeskConnect.mockResolvedValueOnce({ authorizeUrl: 'https://acme.zendesk.com/oauth/authorizations/new?mobile=1' });
    const res = await startRoute(greq('/api/v1/zendesk/oauth/start?platform=mobile'));
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://acme.zendesk.com/oauth/authorizations/new?mobile=1');
    expect(beginZendeskConnect).toHaveBeenCalledWith('mobile');
  });

  it('maps ServiceError(module_disabled) to 403', async () => {
    withApiContext.mockResolvedValueOnce(ctx);
    const { ServiceError } = await import('@/server/services/context');
    beginZendeskConnect.mockRejectedValueOnce(new ServiceError('module_disabled', 'zendesk off'));
    const res = await startRoute(greq('/api/v1/zendesk/oauth/start'));
    expect(res.status).toBe(403);
  });

  it('maps ServiceError(forbidden) to 403', async () => {
    withApiContext.mockResolvedValueOnce(ctx);
    const { ServiceError } = await import('@/server/services/context');
    beginZendeskConnect.mockRejectedValueOnce(new ServiceError('forbidden', 'no zendesk:agent'));
    const res = await startRoute(greq('/api/v1/zendesk/oauth/start'));
    expect(res.status).toBe(403);
  });

  it('maps ServiceError(validation_error) to 400', async () => {
    withApiContext.mockResolvedValueOnce(ctx);
    const { ServiceError } = await import('@/server/services/context');
    beginZendeskConnect.mockRejectedValueOnce(new ServiceError('validation_error', 'no subdomain'));
    const res = await startRoute(greq('/api/v1/zendesk/oauth/start'));
    expect(res.status).toBe(400);
  });

  it('returns 500 when beginZendeskConnect throws a non-ServiceError', async () => {
    withApiContext.mockResolvedValueOnce(ctx);
    beginZendeskConnect.mockRejectedValueOnce(new Error('boom'));
    const res = await startRoute(greq('/api/v1/zendesk/oauth/start'));
    expect(res.status).toBe(500);
  });
});

// ── callback/route ────────────────────────────────────────────────────────────
describe('GET /api/v1/zendesk/oauth/callback', () => {
  it('ctx=null routes to completeFromState regardless of state.platform; redirect target derives from state.platform (here web → web error target on throw)', async () => {
    withApiContext.mockResolvedValueOnce(null);
    verifyState.mockReturnValueOnce({ orgId: 'o1', userId: 'u1', platform: 'web' });
    completeFromState.mockRejectedValueOnce(new Error('bad state'));
    const res = await callbackRoute(greq('/api/v1/zendesk/oauth/callback?code=abc&state=xyz'));
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('/dashboard/zendesk?error=connect_failed');
    expect(completeZendeskConnect).not.toHaveBeenCalled();
    expect(completeFromState).toHaveBeenCalledWith('abc', 'xyz');
  });

  it('calls completeZendeskConnect(code, state) and redirects to /dashboard/zendesk?connected=1 for web', async () => {
    withApiContext.mockResolvedValueOnce(ctx);
    verifyState.mockReturnValueOnce({ orgId: 'o1', userId: 'u1', platform: 'web' });
    completeZendeskConnect.mockResolvedValueOnce(undefined);
    const res = await callbackRoute(greq('/api/v1/zendesk/oauth/callback?code=mycode&state=mystate'));
    expect(completeZendeskConnect).toHaveBeenCalledWith('mycode', 'mystate');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('/dashboard/zendesk?connected=1');
  });

  it('redirects to stockpilot://zendesk/connected when platform is mobile', async () => {
    withApiContext.mockResolvedValueOnce(ctx);
    verifyState.mockReturnValueOnce({ orgId: 'o1', userId: 'u1', platform: 'mobile' });
    completeZendeskConnect.mockResolvedValueOnce(undefined);
    const res = await callbackRoute(greq('/api/v1/zendesk/oauth/callback?code=mycode&state=mystate'));
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('stockpilot://zendesk/connected');
  });

  it('redirects to error target (not 500/JSON) when completeZendeskConnect throws', async () => {
    withApiContext.mockResolvedValueOnce(ctx);
    verifyState.mockReturnValueOnce({ orgId: 'o1', userId: 'u1', platform: 'web' });
    const { ServiceError } = await import('@/server/services/context');
    completeZendeskConnect.mockRejectedValueOnce(new ServiceError('forbidden', 'bad state'));
    const res = await callbackRoute(greq('/api/v1/zendesk/oauth/callback?code=abc&state=xyz'));
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('/dashboard/zendesk?error=connect_failed');
  });

  it('redirects to mobile error target when platform is mobile and connect fails', async () => {
    withApiContext.mockResolvedValueOnce(ctx);
    verifyState.mockReturnValueOnce({ orgId: 'o1', userId: 'u1', platform: 'mobile' });
    const { ServiceError } = await import('@/server/services/context');
    completeZendeskConnect.mockRejectedValueOnce(new ServiceError('forbidden', 'bad state'));
    const res = await callbackRoute(greq('/api/v1/zendesk/oauth/callback?code=abc&state=xyz'));
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('stockpilot://zendesk/error');
  });

  it('redirects to error target when code or state is missing', async () => {
    withApiContext.mockResolvedValueOnce(ctx);
    verifyState.mockReturnValueOnce(null);
    const res = await callbackRoute(greq('/api/v1/zendesk/oauth/callback'));
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('/dashboard/zendesk?error=connect_failed');
  });

  it('redirects to error target when code is present but state is missing (no connect attempt)', async () => {
    withApiContext.mockResolvedValueOnce(ctx);
    const res = await callbackRoute(greq('/api/v1/zendesk/oauth/callback?code=abc'));
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('/dashboard/zendesk?error=connect_failed');
    expect(completeZendeskConnect).not.toHaveBeenCalled();
  });

  it('redirects to error target when state is present but code is missing (no connect attempt)', async () => {
    withApiContext.mockResolvedValueOnce(ctx);
    verifyState.mockReturnValueOnce({ orgId: 'o1', userId: 'u1', platform: 'web' });
    const res = await callbackRoute(greq('/api/v1/zendesk/oauth/callback?state=xyz'));
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('/dashboard/zendesk?error=connect_failed');
    expect(completeZendeskConnect).not.toHaveBeenCalled();
  });

  // ── Mobile path (ctx=null, completeFromState) ─────────────────────────────

  it('(mobile) ctx=null + valid mobile state + completeFromState resolves → 302 stockpilot://zendesk/connected', async () => {
    withApiContext.mockResolvedValueOnce(null);
    verifyState.mockReturnValueOnce({ orgId: 'o1', userId: 'u1', platform: 'mobile' });
    completeFromState.mockResolvedValueOnce(undefined);
    const res = await callbackRoute(greq('/api/v1/zendesk/oauth/callback?code=mycode&state=mystate'));
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('stockpilot://zendesk/connected');
    expect(completeFromState).toHaveBeenCalledWith('mycode', 'mystate');
    expect(completeZendeskConnect).not.toHaveBeenCalled();
  });

  it('(mobile) ctx=null + completeFromState throws → 302 stockpilot://zendesk/error', async () => {
    withApiContext.mockResolvedValueOnce(null);
    verifyState.mockReturnValueOnce({ orgId: 'o1', userId: 'u1', platform: 'mobile' });
    const { ServiceError } = await import('@/server/services/context');
    completeFromState.mockRejectedValueOnce(new ServiceError('forbidden', 'Invalid or expired OAuth state. Please start the connection again.'));
    const res = await callbackRoute(greq('/api/v1/zendesk/oauth/callback?code=bad&state=badstate'));
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('stockpilot://zendesk/error');
    expect(completeFromState).toHaveBeenCalledWith('bad', 'badstate');
    expect(completeZendeskConnect).not.toHaveBeenCalled();
  });
});
