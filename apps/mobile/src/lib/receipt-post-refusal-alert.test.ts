import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RECEIVE_POST_MANAGER_ONLY_COPY } from '@stockpilot/core';

/**
 * What the PO screen alerts when POST /api/v1/po/<id>/receipts refuses a
 * receipt: the real api() over a stubbed fetch, then the screen's own failure
 * arm (app/po/[id].tsx), which every installed build has had since #185.
 *
 * That arm feeds details.reason to mapPostReceiptError IN PLACE OF the
 * server's sentence whenever the reason is a string, and the mapper's default
 * arm shows its input as it is. So the receipts route may send only a reason
 * the mapper knows (idempotency_conflict); the web pins that side in
 * apps/web/src/app/api/v1/po/[id]/receipts/route.phone-contract.test.ts.
 * Review 2026-11-01: the manager refusal carried { reason: 'manager_posts' },
 * and staff read an alert saying "manager_posts".
 */

// api() resolves its base URL at load and reads React Native's __DEV__ (the
// api-error-details.test.ts harness).
vi.hoisted(() => {
  (globalThis as Record<string, unknown>).__DEV__ = true;
});
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: vi.fn(async () => null) },
}));
vi.mock('expo-constants', () => ({ default: { expoConfig: { extra: {} } } }));
vi.mock('./supabase', () => ({
  supabase: { auth: { getSession: vi.fn(async () => ({ data: { session: null } })) } },
}));
vi.mock('./account-eviction', () => ({ notifyUnauthorized: vi.fn() }));
vi.mock('./request-cancellation', () => ({ registerInFlight: vi.fn(() => vi.fn()) }));

import { api, ApiError } from './api';
import { mapPostReceiptError } from './receipt-post-error';

function respondWith(status: number, body: unknown) {
  const text = JSON.stringify(body);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: status >= 200 && status < 300,
      status,
      text: async () => text,
      json: async () => JSON.parse(text),
    })),
  );
}

const SCREEN = readFileSync(join(__dirname, '../../app/po/[id].tsx'), 'utf8');

/** The screen's failure arm, word for word (the first test checks it still is). */
function screenAlert(failure: unknown) {
  const reason =
    failure instanceof ApiError &&
    typeof (failure.details as { reason?: unknown } | undefined)?.reason === 'string'
      ? (failure.details as { reason: string }).reason
      : null;
  return mapPostReceiptError({
    message: reason ?? (failure instanceof Error ? failure.message : String(failure)),
  });
}

async function postRefused(status: number, body: unknown) {
  respondWith(status, body);
  const failure = await api('/api/v1/po/p1/receipts', { method: 'POST', body: {} }).then(
    () => null,
    (e: unknown) => e,
  );
  expect(failure).toBeInstanceOf(ApiError);
  return screenAlert(failure);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('the PO screen alerts a refused receipt post', () => {
  it('the screen still feeds details.reason to the mapper, as above', () => {
    expect(SCREEN.replace(/\s+/g, ' ')).toContain(
      "const reason = failure instanceof ApiError && typeof (failure.details as { reason?: unknown } | undefined)?.reason === 'string' ? (failure.details as { reason: string }).reason : null; const action = mapPostReceiptError({ message: reason ?? (failure instanceof Error ? failure.message : String(failure)), });",
    );
  });

  it('the manager refusal (no details) shows the manager sentence and keeps the key', async () => {
    const action = await postRefused(403, {
      error: 'forbidden',
      message: RECEIVE_POST_MANAGER_ONLY_COPY,
    });
    expect(action).toEqual({
      title: 'Receive failed',
      body: RECEIVE_POST_MANAGER_ONLY_COPY,
      resetIntent: false,
      reload: false,
    });
  });

  it('the first post having landed (details.reason idempotency_conflict) retires the key and reloads', async () => {
    const action = await postRefused(409, {
      error: 'conflict',
      message:
        'A different receipt was already submitted with this idempotency key. Refresh and try again.',
      details: { reason: 'idempotency_conflict' },
    });
    expect(action).toMatchObject({ title: 'Already received', resetIntent: true, reload: true });
  });

  // Why the route may send no other reason: an installed screen shows a reason
  // its mapper does not know as the alert's text, instead of the sentence.
  it('a reason the mapper does not know replaces the sentence', async () => {
    const action = await postRefused(403, {
      error: 'forbidden',
      message: RECEIVE_POST_MANAGER_ONLY_COPY,
      details: { reason: 'some_new_reason' },
    });
    expect(action.body).toBe('some_new_reason');
  });
});
