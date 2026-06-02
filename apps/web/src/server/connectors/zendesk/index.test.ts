import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ConnectionRef, ConnectorDeps, ConnectorSecrets, OutboxEvent } from '@stockpilot/core';

const createTicket = vi.fn();
vi.mock('./client', () => ({
  ZendeskApiError: class ZendeskApiError extends Error {
    constructor(public status: number) {
      super(`z${status}`);
      this.name = 'ZendeskApiError';
    }
  },
  ZendeskClient: vi.fn().mockImplementation(() => ({ createTicket })),
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
  vi.mocked(ZendeskClient).mockImplementation(() => ({ createTicket }) as never);
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
