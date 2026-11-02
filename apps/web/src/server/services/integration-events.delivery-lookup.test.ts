/**
 * docket B49: the delivery catch dead-lettered every SsrfBlockedError, and a
 * failed lookup of a webhook's host (SsrfLookupFailedError, a subclass since
 * #414) is one. So a webhook whose host failed to resolve once, a transient
 * resolver failure, was marked dead on the spot and never sent. A failed
 * lookup now retries with backoff like any other network failure; a refusal
 * of the URL itself (a private address, a bad scheme, a chat URL on another
 * host) stays final.
 *
 * The SSRF guard and safeFetch run for real; only the resolver and undici's
 * pinned request are mocked, as lib/exports/export-images.test.ts does, so no
 * test here opens a network connection.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const reportError = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('@/lib/error-reporter', () => ({ reportError }));

const { lookupMock, undiciFetchMock } = vi.hoisted(() => ({
  lookupMock: vi.fn(),
  undiciFetchMock: vi.fn(),
}));
vi.mock('node:dns/promises', () => ({
  lookup: (...args: unknown[]) => lookupMock(...args),
}));
vi.mock('undici', () => ({
  Agent: class {
    async close() {
      /* no-op */
    }
  },
  fetch: (...args: unknown[]) => undiciFetchMock(...args),
}));

import { makeSupabaseStub } from '@/test/supabase-mock';

import { drainIntegrationDeliveries } from './integration-events';

const NOW = new Date('2026-11-01T12:00:00Z');

const WEBHOOK = {
  id: 'e1',
  organization_id: 'o1',
  type: 'webhook',
  url: 'https://hooks.example.test/stockpilot',
  secret: null,
};

/** One drain tick over one due delivery to `endpoint`, `attempts` tries in. */
async function drainOnce(endpoint: Record<string, unknown>, attempts = 0) {
  const stub = makeSupabaseStub({
    'integration_deliveries.select': {
      data: [
        {
          id: 'd1',
          endpoint_id: 'e1',
          event_type: 'order.approved',
          payload: {},
          attempts,
          max_attempts: 6,
        },
      ],
      error: null,
    },
    'integration_endpoints.select': { data: [endpoint], error: null },
    // The claim and the finalize each match the row.
    'integration_deliveries.update': { data: [{ id: 'd1' }], error: null },
    'integration_endpoints.update': { data: null, error: null },
  });
  const summary = await drainIntegrationDeliveries(stub.client, NOW);
  // The first update is the claim; the second writes the outcome.
  const updates = stub.chainArgsAll.get('integration_deliveries.update') ?? [];
  const outcome = updates[1]?.[0]?.[0] as Record<string, unknown> | undefined;
  return { summary, outcome };
}

beforeEach(() => {
  lookupMock.mockReset();
  undiciFetchMock.mockReset();
  reportError.mockClear();
});

describe('a webhook whose host lookup fails is retried, not marked dead', () => {
  it('a lookup that fails once leaves the delivery pending with backoff, and the next tick sends it', async () => {
    lookupMock.mockRejectedValueOnce(
      Object.assign(new Error('getaddrinfo EAI_AGAIN hooks.example.test'), { code: 'EAI_AGAIN' }),
    );
    const before = Date.now();
    const first = await drainOnce(WEBHOOK);
    expect(undiciFetchMock).not.toHaveBeenCalled();
    expect(first.outcome).toMatchObject({ status: 'pending', attempts: 1 });
    expect(String(first.outcome?.error)).toContain('DNS resolution failed');
    // The first backoff step: about a minute.
    const nextAttempt = new Date(String(first.outcome?.next_attempt_at)).getTime();
    expect(nextAttempt).toBeGreaterThanOrEqual(before + 60_000);
    expect(nextAttempt).toBeLessThanOrEqual(Date.now() + 60_000);

    lookupMock.mockResolvedValueOnce([{ address: '203.0.113.10', family: 4 }]);
    undiciFetchMock.mockResolvedValueOnce(new Response('ok', { status: 200 }));
    const second = await drainOnce(WEBHOOK, 1);
    expect(undiciFetchMock).toHaveBeenCalledTimes(1);
    expect(second.outcome).toMatchObject({ status: 'success', attempts: 2 });
    expect(second.summary).toEqual({ attempted: 1, delivered: 1 });
  });

  it('a lookup that answers no address leaves the delivery pending', async () => {
    lookupMock.mockResolvedValueOnce([]);
    const { outcome } = await drainOnce(WEBHOOK);
    expect(undiciFetchMock).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ status: 'pending', attempts: 1 });
    expect(String(outcome?.error)).toContain('DNS returned no addresses');
  });
});

describe('a refusal of the URL itself stays final (unchanged)', () => {
  it('a host that resolves to a private address is marked dead', async () => {
    lookupMock.mockResolvedValueOnce([{ address: '10.0.0.5', family: 4 }]);
    const { outcome } = await drainOnce(WEBHOOK);
    expect(undiciFetchMock).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ status: 'dead', attempts: 1 });
    expect(String(outcome?.error)).toContain('resolves to private IPv4');
  });

  it('a URL with a scheme other than http(s) is marked dead', async () => {
    const { outcome } = await drainOnce({ ...WEBHOOK, url: 'ftp://hooks.example.test/x' });
    expect(lookupMock).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ status: 'dead', attempts: 1 });
  });

  it('a Slack endpoint on a host other than hooks.slack.com is marked dead', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    try {
      const { outcome } = await drainOnce({
        ...WEBHOOK,
        type: 'slack',
        url: 'https://hooks.example.test/services/x',
      });
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(outcome).toMatchObject({ status: 'dead', attempts: 1 });
      expect(String(outcome?.error)).toContain('host not allowed for slack');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
