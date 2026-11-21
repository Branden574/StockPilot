import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AUTHENTICATOR_SET_UP_OWED_COPY,
  CONTEXT_UNAVAILABLE_COPY,
  contextUnavailableBody,
} from '@stockpilot/core';

import { notifyUnauthorized } from './account-eviction';
import { SIGN_IN_AGAIN_COPY } from './api-error-body';
import { CONNECTION_FAILURE_COPY } from './connection-copy';
import { changeCustomerStatus, CUSTOMER_STATUS_COPY } from './customer-status';
import { registerSetUpInputsSource, resetSetUpInputsForTests } from './set-up-inputs';
import { supabase } from './supabase';

/**
 * The customer status change through the REAL api(), on a stubbed fetch: the
 * method, the address, the JSON body and the headers every /api/v1 call sends
 * (the bearer of the session, the workspace, the content type), the account
 * the list was read for, the 401 probe api() asks for, and the answers that
 * reach the phone only as the real api() reads them.
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
const USER = 'u1';

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
    await expect(changeCustomerStatus(CUSTOMER, 'archived', ORG, USER)).resolves.toEqual({
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

  it('is sent only under the account the list was read for', async () => {
    const fetchMock = respondWith(
      200,
      JSON.stringify({ ok: true, status: 'archived', changed: true }),
    );
    // The signed-in session is u1; the list was read for another account.
    await expect(changeCustomerStatus(CUSTOMER, 'archived', ORG, 'u2')).resolves.toEqual({
      kind: 'refused',
      title: 'Could not update',
      message: CUSTOMER_STATUS_COPY.notChanged,
      reload: false,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('with no session at the send (offline, token expired): nothing sent, try again, never sign in', async () => {
    const fetchMock = respondWith(
      200,
      JSON.stringify({ ok: true, status: 'archived', changed: true }),
    );
    vi.mocked(supabase.auth.getSession).mockResolvedValueOnce({
      data: { session: null },
    } as never);
    const outcome = await changeCustomerStatus(CUSTOMER, 'archived', ORG, USER);
    expect(outcome).toEqual({
      kind: 'refused',
      title: 'Could not update',
      message: CUSTOMER_STATUS_COPY.notChanged,
      reload: false,
    });
    expect(outcome).not.toMatchObject({ message: SIGN_IN_AGAIN_COPY });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a 401 asks for the account probe and says sign in again, never the code word', async () => {
    respondWith(401, JSON.stringify({ error: 'unauthenticated' }));
    const outcome = await changeCustomerStatus(CUSTOMER, 'active', ORG, USER);
    expect(notifyUnauthorized).toHaveBeenCalledWith({ status: 401 });
    expect(outcome).toEqual({
      kind: 'refused',
      title: 'Could not update',
      message: SIGN_IN_AGAIN_COPY,
      reload: false,
    });
  });

  it('the gate 503 reads as nothing changed, try again', async () => {
    respondWith(503, JSON.stringify(contextUnavailableBody()));
    await expect(changeCustomerStatus(CUSTOMER, 'active', ORG, USER)).resolves.toEqual({
      kind: 'refused',
      title: 'Could not update',
      message: CONTEXT_UNAVAILABLE_COPY,
      reload: false,
    });
  });

  it('an HTML error page never reaches the screen', async () => {
    respondWith(502, '<!doctype html><title>502 Bad Gateway</title>');
    await expect(changeCustomerStatus(CUSTOMER, 'active', ORG, USER)).resolves.toEqual({
      kind: 'refused',
      title: 'Could not update',
      message: CUSTOMER_STATUS_COPY.serverProblem,
      reload: true,
    });
  });

  it('a 403 with details.reason mfa_required reads as the set-up sentence', async () => {
    respondWith(
      403,
      JSON.stringify({
        error: 'forbidden',
        message:
          'Multi-factor authentication required. Enroll in MFA before performing this action.',
        details: { reason: 'mfa_required' },
      }),
    );
    await expect(changeCustomerStatus(CUSTOMER, 'active', ORG, USER)).resolves.toEqual({
      kind: 'refused',
      title: 'Could not update',
      message: AUTHENTICATOR_SET_UP_OWED_COPY,
      reload: false,
    });
  });

  it('that answer asks for the set-up read once, from api() itself; another 403 asks for none', async () => {
    resetSetUpInputsForTests();
    const read = vi.fn(async () => undefined);
    await registerSetUpInputsSource({
      storage: { getAllKeys: async () => [], getItem: async () => null, setItem: async () => {} },
      read,
    });
    respondWith(403, JSON.stringify({ error: 'forbidden', details: { reason: 'aal2_required' } }));
    await changeCustomerStatus(CUSTOMER, 'active', ORG, USER);
    expect(read).not.toHaveBeenCalled();
    respondWith(
      403,
      JSON.stringify({
        error: 'forbidden',
        message: 'Set up first.',
        details: { reason: 'mfa_required' },
      }),
    );
    await changeCustomerStatus(CUSTOMER, 'active', ORG, USER);
    expect(read).toHaveBeenCalledTimes(1);
    resetSetUpInputsForTests();
  });

  it('a rejected fetch says the connection sentence, never the platform text', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError(
          'fetch failed: UnexpectedException: Could not connect to the server. (at ExpoModulesCore/Promise.swift:56)',
        );
      }),
    );
    await expect(changeCustomerStatus(CUSTOMER, 'active', ORG, USER)).resolves.toEqual({
      kind: 'refused',
      title: 'Could not update',
      message: CONNECTION_FAILURE_COPY,
      reload: false,
    });
  });

  it('a 200 whose body is not JSON: the server sentence and a re-read', async () => {
    respondWith(200, '');
    await expect(changeCustomerStatus(CUSTOMER, 'active', ORG, USER)).resolves.toEqual({
      kind: 'refused',
      title: 'Could not update',
      message: CUSTOMER_STATUS_COPY.serverProblem,
      reload: true,
    });
  });

  it('a server without the route (a framework 404 page): the update-the-app sentence', async () => {
    respondWith(404, '<!DOCTYPE html><html><body>404: This page could not be found.</body></html>');
    await expect(changeCustomerStatus(CUSTOMER, 'active', ORG, USER)).resolves.toEqual({
      kind: 'refused',
      title: 'Could not update',
      message: 'That is not available on this version of the app. Update the app and try again.',
      reload: false,
    });
  });
});
