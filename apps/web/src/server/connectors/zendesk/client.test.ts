import { describe, expect, it, vi } from 'vitest';
import { ZendeskApiError, ZendeskClient } from './client';

const cfg = { subdomain: 'acme', email: 'agent@acme.com', apiToken: 'tok_123' };

function mockFetch(status: number, body: unknown) {
  return vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  })) as unknown as typeof fetch;
}

describe('ZendeskClient', () => {
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
});
