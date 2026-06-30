import { describe, expect, it, vi } from 'vitest';
import { ZendeskApiError, ZendeskClient } from './client';

const cfg = { subdomain: 'acme', email: 'agent@acme.com', apiToken: 'tok_123' };
const bearerCfg = { subdomain: 'acme', accessToken: 'oauth_tok_abc' };

function mockFetch(status: number, body: unknown) {
  return vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  })) as unknown as typeof fetch;
}

/** Returns a fetch spy that returns different responses per call index. */
function mockFetchSequence(...responses: Array<{ status: number; body: unknown }>) {
  let callIndex = 0;
  return vi.fn(async () => {
    const r = responses[callIndex++] ?? responses[responses.length - 1]!;
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      json: async () => r.body,
      text: async () => JSON.stringify(r.body),
    };
  }) as unknown as typeof fetch;
}

describe('ZendeskClient', () => {
  // ── Existing Basic-auth tests ──────────────────────────────────────────────

  it('validateToken resolves on 200 and uses Basic auth against the right URL', async () => {
    const f = mockFetch(200, { user: { id: 1 } });
    await expect(new ZendeskClient(cfg, f).validateToken()).resolves.toBeUndefined();
    const call = (f as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]!;
    const url = call[0] as string;
    const init = call[1] as { headers: Record<string, string> };
    expect(url).toBe('https://acme.zendesk.com/api/v2/users/me.json');
    expect(init.headers.Authorization).toMatch(/^Basic /);
  });

  it('validateToken throws ZendeskApiError on 401', async () => {
    const f = mockFetch(401, { error: 'no' });
    await expect(new ZendeskClient(cfg, f).validateToken()).rejects.toBeInstanceOf(ZendeskApiError);
  });

  it('createTicket posts the ticket envelope and returns the new id', async () => {
    const f = mockFetch(201, { ticket: { id: 4242 } });
    const id = await new ZendeskClient(cfg, f).createTicket({
      subject: 'Return RMA-1', body: 'A return was created.', tags: ['stockpilot', 'return'],
      requesterName: 'Pat', requesterEmail: 'pat@x.com', priority: 'normal',
    });
    expect(id).toBe(4242);
    const call = (f as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]!;
    const url = call[0] as string;
    const init = call[1] as { method: string; body: string };
    expect(url).toBe('https://acme.zendesk.com/api/v2/tickets.json');
    expect(init.method).toBe('POST');
    const sent = JSON.parse(init.body);
    expect(sent.ticket.subject).toBe('Return RMA-1');
    expect(sent.ticket.comment.body).toBe('A return was created.');
    expect(sent.ticket.requester).toEqual({ name: 'Pat', email: 'pat@x.com' });
    expect(sent.ticket.tags).toEqual(['stockpilot', 'return']);
  });

  it('createTicket throws ZendeskApiError on a 422', async () => {
    const f = mockFetch(422, { error: 'bad' });
    await expect(
      new ZendeskClient(cfg, f).createTicket({ subject: 's', body: 'b' }),
    ).rejects.toBeInstanceOf(ZendeskApiError);
  });

  // ── Bearer-auth construction ───────────────────────────────────────────────

  it('sets Bearer auth header when constructed with ZendeskBearerConfig', async () => {
    const f = mockFetch(200, { user: { id: 1 } });
    await new ZendeskClient(bearerCfg, f).validateToken();
    const call = (f as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]!;
    const init = call[1] as { headers: Record<string, string> };
    expect(init.headers.Authorization).toBe('Bearer oauth_tok_abc');
  });

  it('uses the correct base URL for bearer config', async () => {
    const f = mockFetch(200, { user: { id: 1 } });
    await new ZendeskClient(bearerCfg, f).validateToken();
    const call = (f as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]!;
    const url = call[0] as string;
    expect(url).toBe('https://acme.zendesk.com/api/v2/users/me.json');
  });

  it('throws ZendeskApiError(400) on bad subdomain via bearer path (SSRF guard)', () => {
    expect(() => new ZendeskClient({ subdomain: '169.254.169.254#', accessToken: 'tok' }))
      .toThrow(ZendeskApiError);
    expect(() => new ZendeskClient({ subdomain: '169.254.169.254#', accessToken: 'tok' }))
      .toThrow(expect.objectContaining({ status: 400 }));
  });

  // ── listMyTickets ──────────────────────────────────────────────────────────

  it('listMyTickets defaults to assigned view and hits the search endpoint', async () => {
    const f = mockFetch(200, {
      results: [
        {
          id: 1, subject: 'Test ticket', status: 'open', priority: 'normal',
          description: 'A description', created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-02T00:00:00Z', requester_id: 99, assignee_id: 42,
        },
      ],
    });
    const tickets = await new ZendeskClient(bearerCfg, f).listMyTickets({});
    expect(tickets).toHaveLength(1);
    expect(tickets[0]).toMatchObject({
      id: 1,
      subject: 'Test ticket',
      status: 'open',
      priority: 'normal',
      description: 'A description',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-02T00:00:00Z',
      requesterId: 99,
      assigneeId: 42,
      url: 'https://acme.zendesk.com/agent/tickets/1',
    });
    const call = (f as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]!;
    const url = call[0] as string;
    expect(url).toContain('/api/v2/search.json?query=');
    expect(decodeURIComponent(url)).toContain('assignee:me');
    expect(decodeURIComponent(url)).toContain('type:ticket');
  });

  it('listMyTickets uses requester:me for requested view', async () => {
    const f = mockFetch(200, { results: [] });
    await new ZendeskClient(bearerCfg, f).listMyTickets({ view: 'requested' });
    const call = (f as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]!;
    const url = call[0] as string;
    expect(decodeURIComponent(url)).toContain('requester:me');
  });

  it('listMyTickets appends opts.query when provided', async () => {
    const f = mockFetch(200, { results: [] });
    await new ZendeskClient(bearerCfg, f).listMyTickets({ view: 'assigned', query: 'priority:high' });
    const call = (f as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]!;
    const url = call[0] as string;
    expect(decodeURIComponent(url)).toContain('priority:high');
  });

  it('listMyTickets throws ZendeskApiError on 401', async () => {
    const f = mockFetch(401, { error: 'Unauthorized' });
    await expect(
      new ZendeskClient(bearerCfg, f).listMyTickets({}),
    ).rejects.toBeInstanceOf(ZendeskApiError);
    await expect(
      new ZendeskClient(bearerCfg, mockFetch(401, {})).listMyTickets({}),
    ).rejects.toMatchObject({ status: 401 });
  });

  // ── getTicket ──────────────────────────────────────────────────────────────

  it('getTicket fetches ticket + comments in parallel and maps both', async () => {
    const f = mockFetchSequence(
      {
        status: 200,
        body: {
          ticket: {
            id: 7, subject: 'Help me', status: 'pending', priority: null,
            description: 'Full description', created_at: '2026-02-01T00:00:00Z',
            updated_at: '2026-02-02T00:00:00Z', requester_id: 10, assignee_id: null,
          },
        },
      },
      {
        status: 200,
        body: {
          comments: [
            { id: 100, author_id: 10, body: 'Hello', public: true, created_at: '2026-02-01T01:00:00Z' },
            { id: 101, author_id: null, body: 'Internal note', public: false, created_at: '2026-02-01T02:00:00Z' },
          ],
        },
      },
    );
    const result = await new ZendeskClient(bearerCfg, f).getTicket(7);
    expect(result.ticket).toMatchObject({
      id: 7,
      subject: 'Help me',
      status: 'pending',
      priority: null,
      description: 'Full description',
      createdAt: '2026-02-01T00:00:00Z',
      updatedAt: '2026-02-02T00:00:00Z',
      requesterId: 10,
      assigneeId: null,
      url: 'https://acme.zendesk.com/agent/tickets/7',
    });
    expect(result.comments).toHaveLength(2);
    expect(result.comments[0]).toMatchObject({
      id: 100,
      authorId: 10,
      body: 'Hello',
      public: true,
      createdAt: '2026-02-01T01:00:00Z',
    });
    expect(result.comments[1]).toMatchObject({
      id: 101,
      authorId: null,
      body: 'Internal note',
      public: false,
    });
    // Should have made exactly 2 fetch calls
    expect((f as unknown as { mock: { calls: unknown[][] } }).mock.calls).toHaveLength(2);
  });

  it('getTicket throws ZendeskApiError when the ticket fetch returns 404', async () => {
    const f = mockFetch(404, { error: 'RecordNotFound' });
    await expect(
      new ZendeskClient(bearerCfg, f).getTicket(999),
    ).rejects.toBeInstanceOf(ZendeskApiError);
    await expect(
      new ZendeskClient(bearerCfg, mockFetch(404, {})).getTicket(999),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('getTicket throws ZendeskApiError when the comments fetch returns 401', async () => {
    const f = mockFetchSequence(
      { status: 200, body: { ticket: { id: 7, subject: 'X', status: 'open', priority: null, description: 'D', created_at: '', updated_at: '', requester_id: 1, assignee_id: 1 } } },
      { status: 401, body: { error: 'Unauthorized' } },
    );
    await expect(
      new ZendeskClient(bearerCfg, f).getTicket(7),
    ).rejects.toBeInstanceOf(ZendeskApiError);
  });
});
