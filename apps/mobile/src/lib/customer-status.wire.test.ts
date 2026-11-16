import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CONTEXT_UNAVAILABLE_COPY, contextUnavailableBody } from '@stockpilot/core';

import { notifyUnauthorized } from './account-eviction';
import { changeCustomerStatus, CUSTOMER_STATUS_COPY } from './customer-status';

/**
 * The customer status change through the REAL api(), on a stubbed fetch: the
 * method, the address, the JSON body and the headers every /api/v1 call sends
 * (the bearer of the session, the workspace, the content type), and the 401
 * probe api() asks for.
 */

// api() resolves its base URL AT LOAD and reads React Native's __DEV__, so this
// must run before the imports above (the setup of refused-before-write.wire.test.ts).
vi.hoisted(() => {
  (globalThis as Record<string, unknown>).__DEV__ = true;
});

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: vi.fn(async () => null) },
}));
vi.mock('expo-constants', () => ({ default: { expoConfig: { extra: {} } } }));
vi.mock('./supabase', () => ({
  supabase: {
    auth: {
      getSession: vi.fn(async () => ({
        data: { session: { access_token: 'test-access-token', user: { id: 'u1' } } },
      })),
    },
  },
}));
vi.mock('./account-eviction', () => ({ notifyUnauthorized: vi.fn() }));
vi.mock('./request-cancellation', () => ({ registerInFlight: vi.fn(() => vi.fn()) }));

const CUSTOMER = 'c0ffee00-0000-4000-8000-00000000c001';
const ORG = 'a0000000-0000-4000-8000-00000000000a';

function respondWith(status: number, body: string) {
  const fetchMock = vi.fn(async (..._a: unknown[]) => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
    json: async () => JSON.parse(body),
  }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('the customer status change on the wire', () => {
  it('is a PATCH to the route with the JSON body, the bearer and the workspace', async () => {
    const fetchMock = respondWith(
      200,
      JSON.stringify({ ok: true, status: 'archived', changed: true }),
    );
    await expect(changeCustomerStatus(CUSTOMER, 'archived', ORG)).resolves.toEqual({
      kind: 'saved',
      status: 'archived',
      changed: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(new RegExp(`/api/v1/customers/${CUSTOMER}/status$`));
    expect(init.method).toBe('PATCH');
    expect(init.body).toBe(JSON.stringify({ status: 'archived' }));
    expect(init.headers).toEqual({
      'Content-Type': 'application/json',
      Authorization: 'Bearer test-access-token',
      'X-Organization-Id': ORG,
    });
  });

  it('a 401 asks for the account probe and says the session ended, never the code word', async () => {
    respondWith(401, JSON.stringify({ error: 'unauthenticated' }));
    const outcome = await changeCustomerStatus(CUSTOMER, 'active', ORG);
    expect(notifyUnauthorized).toHaveBeenCalledWith({ status: 401 });
    expect(outcome).toEqual({
      kind: 'refused',
      title: 'Could not update',
      message: CUSTOMER_STATUS_COPY.sessionEnded,
      reload: false,
    });
  });

  it('the gate 503 reads as nothing changed, try again', async () => {
    respondWith(503, JSON.stringify(contextUnavailableBody()));
    await expect(changeCustomerStatus(CUSTOMER, 'active', ORG)).resolves.toEqual({
      kind: 'refused',
      title: 'Could not update',
      message: CONTEXT_UNAVAILABLE_COPY,
      reload: false,
    });
  });

  it('an HTML error page never reaches the screen', async () => {
    respondWith(502, '<!doctype html><title>502 Bad Gateway</title>');
    await expect(changeCustomerStatus(CUSTOMER, 'active', ORG)).resolves.toEqual({
      kind: 'refused',
      title: 'Could not update',
      message: CUSTOMER_STATUS_COPY.serverProblem,
      reload: true,
    });
  });
});
