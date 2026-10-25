import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from './api';
import { REQUEST_TIMED_OUT_COPY } from './connection-copy';
import {
  disconnect,
  getConnections,
  isForbiddenError,
  saveAccountMapping,
} from './integrations-api';

/**
 * Settings > Integrations shows "Access denied." when the server refuses the
 * connections read, the mapping save or the disconnect (the module was turned
 * off, or the member is no longer an owner or admin).
 *
 * THE DEFECT (docket B10). isForbiddenError tested the error's MESSAGE for
 * "API 403", the text api() threw before it threw a typed ApiError
 * (2026-07-31). An ApiError's message is the server's sentence and its status
 * is a field, so a 403 never matched: the screen printed the raw server
 * sentence in a red card and never showed its own Access denied state.
 *
 * These run the REAL api() against a stubbed fetch, so the classification is
 * pinned against what api() actually throws (the line-sheets-api-error.test.ts
 * idiom).
 */

// The API client reads __DEV__ and its native dependencies at load. vitest
// hoists vi.hoisted and vi.mock above the imports, so they run first.
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

function respondWith(status: number, body: string) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: status >= 200 && status < 300,
      status,
      text: async () => body,
      json: async () => JSON.parse(body),
    })),
  );
}

const MODULE_OFF = JSON.stringify({
  error: 'module_disabled',
  message: 'Module not enabled for this organization: integrations',
});

beforeEach(() => vi.clearAllMocks());

describe('Integrations: a refusal from the server is the Access denied state', () => {
  it('the 403 api() throws for a connections read is a refusal', async () => {
    respondWith(403, MODULE_OFF);
    const err = await getConnections().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(403);
    expect(isForbiddenError(err)).toBe(true);
  });

  it('a 403 whose body is not our JSON (an edge page) is a refusal too', async () => {
    respondWith(403, '<!doctype html><title>Forbidden</title>');
    const err = await getConnections().catch((e: unknown) => e);
    expect(isForbiddenError(err)).toBe(true);
  });

  it('a 403 from the mapping save and from the disconnect is a refusal', async () => {
    respondWith(403, JSON.stringify({ error: 'forbidden', message: 'Owners and admins only.' }));
    const saved = await saveAccountMapping('quickbooks', {
      billExpense: '1',
      inventoryAsset: '2',
      valuationOffset: '3',
    }).catch((e: unknown) => e);
    expect(isForbiddenError(saved)).toBe(true);
    const gone = await disconnect('quickbooks').catch((e: unknown) => e);
    expect(isForbiddenError(gone)).toBe(true);
  });

  it.each([401, 404, 409, 500])(
    'a %i is not a refusal of access to Integrations',
    async (status) => {
      respondWith(status, JSON.stringify({ error: 'x', message: 'Something else.' }));
      const err = await getConnections().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ApiError);
      expect(isForbiddenError(err)).toBe(false);
    },
  );

  it('no answer at all (a timeout, a dropped connection) is not a refusal', () => {
    expect(isForbiddenError(new Error(REQUEST_TIMED_OUT_COPY))).toBe(false);
    expect(isForbiddenError(new TypeError('Network request failed'))).toBe(false);
  });

  it('a value that is not an error is not a refusal', () => {
    expect(isForbiddenError({ status: 403 })).toBe(false);
    expect(isForbiddenError(null)).toBe(false);
    expect(isForbiddenError('403')).toBe(false);
  });
});
