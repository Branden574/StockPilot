/**
 * Tests for the current-user Zendesk API proxy endpoints.
 *
 * Isolation is the top concern: all connections are resolved from the
 * authenticated `ctx`, never from request body/params. We verify that when a
 * caller has no connection (User B), the ZendeskClient is never constructed
 * and no ticket data leaks.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// ─── Hoisted mocks (must be declared before vi.mock factories run) ───────────
const {
  withApiContext,
  statusMock,
  getValidAccessTokenMock,
  disconnectMock,
  ZendeskClientMock,
  listMyTicketsMock,
  getTicketMock,
  ZendeskApiErrorMock,
} = vi.hoisted(() => {
  const listMyTicketsMock = vi.fn();
  const getTicketMock = vi.fn();
  const ZendeskClientMock = vi.fn().mockImplementation(() => ({
    listMyTickets: listMyTicketsMock,
    getTicket: getTicketMock,
  }));

  // ZendeskApiError defined in the hoisted block so it's the SAME class
  // referenced by both the vi.mock factory and the route module — ensuring
  // `instanceof ZendeskApiError` checks in the routes work correctly.
  class ZendeskApiErrorMock extends Error {
    status: number;
    constructor(status: number, message = `Zendesk API error ${status}`) {
      super(message);
      this.name = 'ZendeskApiError';
      this.status = status;
    }
  }

  return {
    withApiContext: vi.fn(),
    statusMock: vi.fn(),
    getValidAccessTokenMock: vi.fn(),
    disconnectMock: vi.fn(),
    ZendeskClientMock,
    listMyTicketsMock,
    getTicketMock,
    ZendeskApiErrorMock,
  };
});

// ─── Module mocks ────────────────────────────────────────────────────────────
vi.mock('@/lib/auth/api-context', () => ({
  withApiContext: (...a: unknown[]) => withApiContext(...a),
}));

vi.mock('@/server/services/user-connections', () => ({
  UserConnectionsService: vi.fn().mockImplementation(() => ({
    status: statusMock,
    getValidAccessToken: getValidAccessTokenMock,
    disconnect: disconnectMock,
  })),
}));

vi.mock('@/server/connectors/zendesk/client', () => ({
  ZendeskClient: ZendeskClientMock,
  ZendeskApiError: ZendeskApiErrorMock,
}));

// ─── Import routes (after mocks are registered) ──────────────────────────────
import { GET as getMe } from './route';
import { GET as getTickets } from './tickets/route';
import { GET as getTicket } from './tickets/[id]/route';
import { POST as postDisconnect } from './disconnect/route';
import { UserConnectionsService } from '@/server/services/user-connections';

// ─── Helpers ─────────────────────────────────────────────────────────────────
const ctxA = { userId: 'user-a', organizationId: 'org-1', role: 'agent' };
const ctxB = { userId: 'user-b', organizationId: 'org-1', role: 'agent' };

function makeReq(path: string, method = 'GET'): NextRequest {
  return new NextRequest(`http://localhost${path}`, { method });
}

function makeReqWithQuery(path: string, qs: Record<string, string>): NextRequest {
  const url = new URL(`http://localhost${path}`);
  for (const [k, v] of Object.entries(qs)) url.searchParams.set(k, v);
  return new NextRequest(url.toString(), { method: 'GET' });
}

beforeEach(() => {
  vi.mocked(UserConnectionsService).mockImplementation(() => ({
    status: statusMock,
    getValidAccessToken: getValidAccessTokenMock,
    disconnect: disconnectMock,
  }) as never);
  statusMock.mockReset();
  getValidAccessTokenMock.mockReset();
  disconnectMock.mockReset();
  ZendeskClientMock.mockReset();
  ZendeskClientMock.mockImplementation(() => ({
    listMyTickets: listMyTicketsMock,
    getTicket: getTicketMock,
  }));
  listMyTicketsMock.mockReset();
  getTicketMock.mockReset();
  withApiContext.mockReset();
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /me
// ─────────────────────────────────────────────────────────────────────────────
describe('GET /me', () => {
  it('returns 401 when unauthenticated', async () => {
    withApiContext.mockResolvedValueOnce(null);
    const res = await getMe(makeReq('/api/v1/zendesk/me'));
    expect(res.status).toBe(401);
  });

  it('returns { connected: true, account } when user has a connection', async () => {
    withApiContext.mockResolvedValueOnce(ctxA);
    statusMock.mockResolvedValueOnce({ connected: true, account: { name: 'Agent A', email: 'a@acme.com' } });
    const res = await getMe(makeReq('/api/v1/zendesk/me'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.connected).toBe(true);
    expect(body.account.name).toBe('Agent A');
  });

  it('returns { connected: false } for a user with no connection (User B)', async () => {
    withApiContext.mockResolvedValueOnce(ctxB);
    statusMock.mockResolvedValueOnce({ connected: false });
    const res = await getMe(makeReq('/api/v1/zendesk/me'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.connected).toBe(false);
  });

  it('maps ServiceError to correct HTTP status', async () => {
    const { ServiceError } = await import('@/server/services/context');
    withApiContext.mockResolvedValueOnce(ctxA);
    statusMock.mockRejectedValueOnce(new ServiceError('module_disabled', 'off'));
    const res = await getMe(makeReq('/api/v1/zendesk/me'));
    expect(res.status).toBe(403);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /me/tickets
// ─────────────────────────────────────────────────────────────────────────────
describe('GET /me/tickets', () => {
  it('returns 401 when unauthenticated', async () => {
    withApiContext.mockResolvedValueOnce(null);
    const res = await getTickets(makeReq('/api/v1/zendesk/me/tickets'));
    expect(res.status).toBe(401);
  });

  it('returns ticket list with defaults (view=assigned)', async () => {
    withApiContext.mockResolvedValueOnce(ctxA);
    getValidAccessTokenMock.mockResolvedValueOnce({ subdomain: 'acme', accessToken: 'tok-a' });
    const tickets = [{ id: 1, subject: 'Ticket 1', status: 'open' }];
    listMyTicketsMock.mockResolvedValueOnce(tickets);

    const res = await getTickets(makeReq('/api/v1/zendesk/me/tickets'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tickets).toEqual(tickets);
    // Default view is 'assigned'
    expect(listMyTicketsMock).toHaveBeenCalledWith({ view: 'assigned', query: undefined });
  });

  it('passes view=requested and query from query string', async () => {
    withApiContext.mockResolvedValueOnce(ctxA);
    getValidAccessTokenMock.mockResolvedValueOnce({ subdomain: 'acme', accessToken: 'tok-a' });
    listMyTicketsMock.mockResolvedValueOnce([]);

    const res = await getTickets(
      makeReqWithQuery('/api/v1/zendesk/me/tickets', { view: 'requested', query: 'priority:high' }),
    );
    expect(res.status).toBe(200);
    expect(listMyTicketsMock).toHaveBeenCalledWith({ view: 'requested', query: 'priority:high' });
  });

  it('ignores unknown view values and defaults to assigned', async () => {
    withApiContext.mockResolvedValueOnce(ctxA);
    getValidAccessTokenMock.mockResolvedValueOnce({ subdomain: 'acme', accessToken: 'tok-a' });
    listMyTicketsMock.mockResolvedValueOnce([]);

    const res = await getTickets(
      makeReqWithQuery('/api/v1/zendesk/me/tickets', { view: 'whatever' }),
    );
    expect(res.status).toBe(200);
    expect(listMyTicketsMock).toHaveBeenCalledWith({ view: 'assigned', query: undefined });
  });

  // ── ISOLATION ──────────────────────────────────────────────────────────────
  it('(isolation) User B with no connection gets 404 and ZendeskClient is NEVER constructed', async () => {
    const { ServiceError } = await import('@/server/services/context');
    withApiContext.mockResolvedValueOnce(ctxB);
    getValidAccessTokenMock.mockRejectedValueOnce(new ServiceError('not_found', 'No connection'));

    const res = await getTickets(makeReq('/api/v1/zendesk/me/tickets'));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('not_connected');

    // The ZendeskClient must NEVER have been instantiated — so User A's token
    // was never touched.
    expect(ZendeskClientMock).not.toHaveBeenCalled();
    expect(listMyTicketsMock).not.toHaveBeenCalled();
  });

  // ── ZENDESK ERROR SANITIZATION ─────────────────────────────────────────────
  it('maps ZendeskApiError(401) → 401 reauth_required (no token in body)', async () => {
    withApiContext.mockResolvedValueOnce(ctxA);
    getValidAccessTokenMock.mockResolvedValueOnce({ subdomain: 'acme', accessToken: 'SUPER_SECRET_TOKEN' });
    listMyTicketsMock.mockRejectedValueOnce(new ZendeskApiErrorMock(401));

    const res = await getTickets(makeReq('/api/v1/zendesk/me/tickets'));
    expect(res.status).toBe(401);
    const text = await res.text();
    expect(text).not.toContain('SUPER_SECRET_TOKEN');
    const body = JSON.parse(text);
    expect(body.error).toBe('reauth_required');
  });

  it('maps ZendeskApiError(500) → 502 zendesk_unavailable (no raw message)', async () => {
    withApiContext.mockResolvedValueOnce(ctxA);
    getValidAccessTokenMock.mockResolvedValueOnce({ subdomain: 'acme', accessToken: 'tok-a' });
    listMyTicketsMock.mockRejectedValueOnce(new ZendeskApiErrorMock(500, 'Internal Zendesk raw error msg'));

    const res = await getTickets(makeReq('/api/v1/zendesk/me/tickets'));
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(text).not.toContain('Internal Zendesk raw error msg');
    const body = JSON.parse(text);
    expect(body.error).toBe('zendesk_unavailable');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /me/tickets/[id]
// ─────────────────────────────────────────────────────────────────────────────
describe('GET /me/tickets/[id]', () => {
  function makeIdReq(id: string): [NextRequest, { params: Promise<{ id: string }> }] {
    return [
      makeReq(`/api/v1/zendesk/me/tickets/${id}`),
      { params: Promise.resolve({ id }) },
    ];
  }

  it('returns 401 when unauthenticated', async () => {
    withApiContext.mockResolvedValueOnce(null);
    const [req, ctx] = makeIdReq('42');
    const res = await getTicket(req, ctx);
    expect(res.status).toBe(401);
  });

  it('returns 400 for a non-numeric id', async () => {
    withApiContext.mockResolvedValueOnce(ctxA);
    const [req, ctx] = makeIdReq('abc');
    const res = await getTicket(req, ctx);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid_id');
  });

  it('returns 400 for id=0', async () => {
    withApiContext.mockResolvedValueOnce(ctxA);
    const [req, ctx] = makeIdReq('0');
    const res = await getTicket(req, ctx);
    expect(res.status).toBe(400);
  });

  it('returns 400 for a negative id', async () => {
    withApiContext.mockResolvedValueOnce(ctxA);
    const [req, ctx] = makeIdReq('-5');
    const res = await getTicket(req, ctx);
    expect(res.status).toBe(400);
  });

  it('returns { ticket, comments } for a valid numeric id', async () => {
    withApiContext.mockResolvedValueOnce(ctxA);
    getValidAccessTokenMock.mockResolvedValueOnce({ subdomain: 'acme', accessToken: 'tok-a' });
    const ticket = { id: 42, subject: 'Hello', status: 'open' };
    const comments = [{ id: 1, body: 'first comment', authorId: 99, public: true, createdAt: '' }];
    getTicketMock.mockResolvedValueOnce({ ticket, comments });

    const [req, ctx] = makeIdReq('42');
    const res = await getTicket(req, ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ticket).toEqual(ticket);
    expect(body.comments).toEqual(comments);
    expect(getTicketMock).toHaveBeenCalledWith(42);
  });

  it('(isolation) not_found from getValidAccessToken → 404, ZendeskClient never called', async () => {
    const { ServiceError } = await import('@/server/services/context');
    withApiContext.mockResolvedValueOnce(ctxB);
    getValidAccessTokenMock.mockRejectedValueOnce(new ServiceError('not_found', 'No connection'));

    const [req, ctx] = makeIdReq('42');
    const res = await getTicket(req, ctx);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('not_connected');
    expect(ZendeskClientMock).not.toHaveBeenCalled();
    expect(getTicketMock).not.toHaveBeenCalled();
  });

  it('maps ZendeskApiError(401) → 401 reauth_required', async () => {
    withApiContext.mockResolvedValueOnce(ctxA);
    getValidAccessTokenMock.mockResolvedValueOnce({ subdomain: 'acme', accessToken: 'SUPER_SECRET_TOKEN' });
    getTicketMock.mockRejectedValueOnce(new ZendeskApiErrorMock(401));

    const [req, ctx] = makeIdReq('42');
    const res = await getTicket(req, ctx);
    expect(res.status).toBe(401);
    const text = await res.text();
    expect(text).not.toContain('SUPER_SECRET_TOKEN');
    const body = JSON.parse(text);
    expect(body.error).toBe('reauth_required');
  });

  it('maps ZendeskApiError(500) → 502 zendesk_unavailable (sanitized)', async () => {
    withApiContext.mockResolvedValueOnce(ctxA);
    getValidAccessTokenMock.mockResolvedValueOnce({ subdomain: 'acme', accessToken: 'tok-a' });
    getTicketMock.mockRejectedValueOnce(new ZendeskApiErrorMock(500, 'Internal Zendesk raw error msg'));

    const [req, ctx] = makeIdReq('42');
    const res = await getTicket(req, ctx);
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(text).not.toContain('Internal Zendesk raw error msg');
    const body = JSON.parse(text);
    expect(body.error).toBe('zendesk_unavailable');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /me/disconnect
// ─────────────────────────────────────────────────────────────────────────────
describe('POST /me/disconnect', () => {
  it('returns 401 when unauthenticated', async () => {
    withApiContext.mockResolvedValueOnce(null);
    const res = await postDisconnect(
      new NextRequest('http://localhost/api/v1/zendesk/me/disconnect', { method: 'POST' }),
    );
    expect(res.status).toBe(401);
  });

  it('calls disconnect() and returns { ok: true }', async () => {
    withApiContext.mockResolvedValueOnce(ctxA);
    disconnectMock.mockResolvedValueOnce(undefined);
    const res = await postDisconnect(
      new NextRequest('http://localhost/api/v1/zendesk/me/disconnect', { method: 'POST' }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(disconnectMock).toHaveBeenCalledOnce();
  });

  it('maps ServiceError to correct HTTP status', async () => {
    const { ServiceError } = await import('@/server/services/context');
    withApiContext.mockResolvedValueOnce(ctxA);
    disconnectMock.mockRejectedValueOnce(new ServiceError('forbidden', 'Cannot disconnect'));
    const res = await postDisconnect(
      new NextRequest('http://localhost/api/v1/zendesk/me/disconnect', { method: 'POST' }),
    );
    expect(res.status).toBe(403);
  });

  it('returns 500 on unknown errors', async () => {
    withApiContext.mockResolvedValueOnce(ctxA);
    disconnectMock.mockRejectedValueOnce(new Error('db gone'));
    const res = await postDisconnect(
      new NextRequest('http://localhost/api/v1/zendesk/me/disconnect', { method: 'POST' }),
    );
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe('internal_error');
  });
});
