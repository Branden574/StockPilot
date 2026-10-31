import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ConnectionRef, ConnectorDeps, ConnectorSecrets, OutboxEvent } from '@stockpilot/core';

import { callArgs, makeSupabaseStub, type MockCall } from '@/test/supabase-mock';

const createTicket = vi.fn();
vi.mock('./client', () => ({
  ZendeskApiError: class ZendeskApiError extends Error {
    constructor(public status: number) {
      super(`z${status}`);
      this.name = 'ZendeskApiError';
    }
  },
  ZendeskClient: vi.fn().mockImplementation(function () {
    return { createTicket };
  }),
}));

import { ZendeskApiError, ZendeskClient } from './client';
import { zendeskConnector } from './index';

const conn = {
  id: 'c1',
  organizationId: 'org1',
  providerId: 'zendesk',
  status: 'active',
  externalAccountId: 'acme',
  settings: { subdomain: 'acme', email: 'a@acme.com' },
} as unknown as ConnectionRef;
const secrets = { accessToken: 'tok', refreshToken: '', expiresAt: '' } as ConnectorSecrets;
const deps = {
  admin: {},
  fetch: globalThis.fetch,
  getMapping: vi.fn(),
  putMapping: vi.fn(),
} as unknown as ConnectorDeps;
const evt = (topic: string, payload: Record<string, unknown>) =>
  ({
    id: 'e1',
    organizationId: 'org1',
    topic,
    aggregateType: 'x',
    aggregateId: 'a1',
    payload,
    dedupeKey: null,
    createdAt: '2026-06-02T00:00:00Z',
  }) as OutboxEvent;

// setup.ts runs vi.restoreAllMocks() in afterEach, which wipes the constructor
// mock's implementation after the first test — re-arm it (mirrors cycle-counts
// route.test.ts). createTicket is re-armed per test via mock*Once below.
beforeEach(() => {
  vi.mocked(ZendeskClient).mockImplementation(function () {
    return { createTicket } as never;
  });
});

describe('zendeskConnector', () => {
  it('subscribes to the 3 shell topics', () => {
    expect(zendeskConnector.subscribedTopics).toEqual([
      'return.created',
      'public_request.created',
      'order.problem',
    ]);
  });

  it('creates a ticket for return.created and returns the external id', async () => {
    createTicket.mockResolvedValueOnce(99);
    const r = await zendeskConnector.handleOutboxEvent(
      evt('return.created', { returnNumber: 'RMA-1', orderRequestId: 'o1', requesterEmail: 'p@x.com' }),
      conn,
      secrets,
      deps,
    );
    expect(r.ok).toBe(true);
    expect(r.externalId).toBe('99');
    expect(createTicket).toHaveBeenCalledOnce();
  });

  it('treats a 4xx as non-retryable (dead-letter)', async () => {
    createTicket.mockRejectedValueOnce(new ZendeskApiError(422));
    const r = await zendeskConnector.handleOutboxEvent(evt('order.problem', { reason: 'x' }), conn, secrets, deps);
    expect(r.ok).toBe(false);
    expect(r.retryable).toBe(false);
  });

  it('treats a 5xx as retryable', async () => {
    createTicket.mockRejectedValueOnce(new ZendeskApiError(503));
    const r = await zendeskConnector.handleOutboxEvent(
      evt('public_request.created', { requesterEmail: 'p@x.com' }),
      conn,
      secrets,
      deps,
    );
    expect(r.ok).toBe(false);
    expect(r.retryable).toBe(true);
  });

  it('returns non-retryable for an unsupported topic', async () => {
    const r = await zendeskConnector.handleOutboxEvent(evt('receipt.posted', {}), conn, secrets, deps);
    expect(r.ok).toBe(false);
    expect(r.retryable).toBe(false);
  });
});

// B23: an event is queued with the order's requester as it read then, and the
// drainer may send it much later (backoff, a connection repaired days on). A
// requester who deleted their account in between would become the ticket's
// requester, and Zendesk emails a ticket's requester. The order is read again
// at send time, in the connection's organization, and the requester stays on
// the ticket only while the order still says their account exists.
describe('zendeskConnector: a requester who deleted their account after the event was queued (B23)', () => {
  function depsWith(order: (call: MockCall) => { data: unknown; error: unknown }) {
    const reads: MockCall[] = [];
    const stub = makeSupabaseStub({
      'order_requests.select': (call) => {
        reads.push(call);
        return order(call) as never;
      },
    });
    return { deps: { ...deps, admin: stub.client } as unknown as ConnectorDeps, reads };
  }
  const PERSON = { requesterEmail: 'requester@example.com', requesterName: 'Test Requester' };
  const sentTicket = () => createTicket.mock.calls.at(-1)?.[0] as Record<string, unknown>;

  beforeEach(() => {
    createTicket.mockReset();
  });

  it.each(['order.problem', 'public_request.created'])(
    '%s: leaves the requester off the ticket when the order says their account was deleted',
    async (topic) => {
      createTicket.mockResolvedValueOnce(7);
      const { deps: d, reads } = depsWith(() => ({
        data: { requester_deleted_at: '2026-10-20T15:04:05.000Z' },
        error: null,
      }));
      const r = await zendeskConnector.handleOutboxEvent(
        evt(topic, { orderRequestId: 'o1', reason: 'x', ...PERSON }),
        conn,
        secrets,
        d,
      );
      expect(r).toMatchObject({ ok: true, externalId: '7' });
      expect(sentTicket().requesterEmail).toBeUndefined();
      expect(sentTicket().requesterName).toBeUndefined();
      expect(JSON.stringify(sentTicket())).not.toContain('requester@example.com');
      expect(JSON.stringify(sentTicket())).not.toContain('Test Requester');
      // Read in the connection's organization, by the payload's order.
      expect(reads).toHaveLength(1);
      expect(callArgs(reads[0]!, 'select')?.[0]).toBe('requester_deleted_at');
      const eqs = reads[0]!.methods
        .map((m, i) => [m, reads[0]!.args[i]] as const)
        .filter(([m]) => m === 'eq')
        .map(([, a]) => a);
      expect(eqs).toEqual(
        expect.arrayContaining([
          ['organization_id', 'org1'],
          ['id', 'o1'],
        ]),
      );
    },
  );

  it('keeps the requester while the order still has them', async () => {
    createTicket.mockResolvedValueOnce(8);
    const { deps: d } = depsWith(() => ({ data: { requester_deleted_at: null }, error: null }));
    const r = await zendeskConnector.handleOutboxEvent(
      evt('order.problem', { orderRequestId: 'o1', reason: 'x', ...PERSON }),
      conn,
      secrets,
      d,
    );
    expect(r.ok).toBe(true);
    expect(sentTicket()).toMatchObject(PERSON);
  });

  it('an order that is gone names no requester (nothing says the person may be named)', async () => {
    createTicket.mockResolvedValueOnce(9);
    const { deps: d } = depsWith(() => ({ data: null, error: null }));
    await zendeskConnector.handleOutboxEvent(
      evt('order.problem', { orderRequestId: 'o1', reason: 'x', ...PERSON }),
      conn,
      secrets,
      d,
    );
    expect(sentTicket().requesterEmail).toBeUndefined();
    expect(sentTicket().requesterName).toBeUndefined();
  });

  it('a failed read sends nothing and tries again later (fail closed)', async () => {
    const { deps: d } = depsWith(() => ({ data: null, error: { message: 'fetch failed' } }));
    const r = await zendeskConnector.handleOutboxEvent(
      evt('order.problem', { orderRequestId: 'o1', reason: 'x', ...PERSON }),
      conn,
      secrets,
      d,
    );
    expect(r).toMatchObject({ ok: false, retryable: true });
    expect(createTicket).not.toHaveBeenCalled();
  });

  it('a read that throws sends nothing and tries again later (fail closed)', async () => {
    const { deps: d, reads } = depsWith(() => {
      throw new TypeError('fetch failed');
    });
    const r = await zendeskConnector.handleOutboxEvent(
      evt('order.problem', { orderRequestId: 'o1', reason: 'x', ...PERSON }),
      conn,
      secrets,
      d,
    );
    expect(reads).toHaveLength(1);
    expect(r).toMatchObject({ ok: false, retryable: true });
    expect(createTicket).not.toHaveBeenCalled();
  });

  it('a payload that names a requester but no order sends the ticket without them, and reads nothing', async () => {
    createTicket.mockResolvedValueOnce(11);
    const { deps: d, reads } = depsWith(() => ({
      data: { requester_deleted_at: null },
      error: null,
    }));
    const r = await zendeskConnector.handleOutboxEvent(
      evt('order.problem', { reason: 'x', ...PERSON }),
      conn,
      secrets,
      d,
    );
    expect(r).toMatchObject({ ok: true, externalId: '11' });
    expect(reads).toHaveLength(0);
    expect(createTicket).toHaveBeenCalledOnce();
    expect(sentTicket().requesterEmail).toBeUndefined();
    expect(sentTicket().requesterName).toBeUndefined();
    expect(JSON.stringify(sentTicket())).not.toContain('requester@example.com');
    expect(JSON.stringify(sentTicket())).not.toContain('Test Requester');
  });

  it('a payload that names no requester is sent without a read', async () => {
    createTicket.mockResolvedValueOnce(10);
    const { deps: d, reads } = depsWith(() => ({ data: null, error: { message: 'unused' } }));
    const r = await zendeskConnector.handleOutboxEvent(
      evt('order.problem', {
        orderRequestId: 'o1',
        reason: 'x',
        requesterEmail: null,
        requesterName: null,
      }),
      conn,
      secrets,
      d,
    );
    expect(r.ok).toBe(true);
    expect(reads).toHaveLength(0);
  });
});
