import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildItemAdjustBody,
  classifyAdjustFailure,
  ITEM_ADJUST_DEFAULT_REASON,
  submitItemAdjust,
} from './item-adjust';

// ./api reaches for expo-constants, AsyncStorage and the Supabase client at
// import time, none of which exist under the node test environment. Same idiom
// as cycle-counts-api.test.ts. The status-bearing errors below are shaped like
// ApiError (status / code / details) because that is all the classifier reads.
const apiMock = vi.hoisted(() => ({ api: vi.fn(async (..._args: unknown[]) => ({}) as unknown) }));
vi.mock('./api', () => apiMock);

beforeEach(() => apiMock.api.mockReset());

function apiError(status: number, message: string, details?: unknown) {
  return Object.assign(new Error(message), { name: 'ApiError', status, details });
}

describe('submitItemAdjust — the item screen goes through the server route', () => {
  it('POSTs a +1 to /api/v1/items/<id>/adjust as an add, with the default reason', async () => {
    apiMock.api.mockResolvedValueOnce({ ok: true, quantityOnHand: 6 });

    await submitItemAdjust('item-1', 1);

    expect(apiMock.api).toHaveBeenCalledTimes(1);
    expect(apiMock.api).toHaveBeenCalledWith('/api/v1/items/item-1/adjust', {
      method: 'POST',
      body: { quantityChange: 1, movementType: 'add', reason: ITEM_ADJUST_DEFAULT_REASON },
    });
  });

  it.each([
    [-5, 'remove'],
    [-1, 'remove'],
    [1, 'add'],
    [5, 'add'],
  ] as const)('the %i button sends that delta as a %s', async (delta, kind) => {
    apiMock.api.mockResolvedValueOnce({ ok: true, quantityOnHand: 10 });

    await submitItemAdjust('item-1', delta);

    expect(apiMock.api.mock.calls[0]?.[1]).toEqual({
      method: 'POST',
      body: { quantityChange: delta, movementType: kind, reason: 'Mobile detail' },
    });
  });

  it('carries the sheet reason, trimmed', async () => {
    apiMock.api.mockResolvedValueOnce({ ok: true, quantityOnHand: 3 });

    await submitItemAdjust('item-1', -3, '  Damaged in transit  ');

    expect(apiMock.api.mock.calls[0]?.[1]).toEqual({
      method: 'POST',
      body: { quantityChange: -3, movementType: 'remove', reason: 'Damaged in transit' },
    });
  });

  it('shows the total the SERVER returned, not the old total plus the delta', async () => {
    // Someone else adjusted the item since this screen loaded: local
    // arithmetic would say 6; the atomic RPC says 42.
    apiMock.api.mockResolvedValueOnce({ ok: true, quantityOnHand: 42 });

    const out = await submitItemAdjust('item-1', 1);

    expect(out).toEqual({ kind: 'saved', quantityOnHand: 42 });
  });

  it('reports a saved write WITHOUT a total as null, so the screen re-reads instead of guessing', async () => {
    apiMock.api.mockResolvedValueOnce({ ok: true });

    expect(await submitItemAdjust('item-1', 1)).toEqual({ kind: 'saved', quantityOnHand: null });
  });

  it('never sends a zero or non-finite delta', async () => {
    for (const d of [0, Number.NaN, Number.POSITIVE_INFINITY]) {
      const out = await submitItemAdjust('item-1', d);
      expect(out.kind).toBe('refused');
    }
    expect(apiMock.api).not.toHaveBeenCalled();
  });

  it('never rejects, even when the transport throws a non-Error', async () => {
    apiMock.api.mockRejectedValueOnce(null);

    await expect(submitItemAdjust('item-1', 1)).resolves.toMatchObject({ kind: 'unconfirmed' });
  });
});

describe('submitItemAdjust — errors surface, and say whether anything was written', () => {
  it('a 400 from the service is a refusal carrying the server sentence', async () => {
    apiMock.api.mockRejectedValueOnce(
      apiError(400, 'Cannot adjust stock on an archived item. Unarchive it first.'),
    );

    const out = await submitItemAdjust('item-1', -1);

    expect(out).toEqual({
      kind: 'refused',
      alert: {
        title: 'Could not adjust',
        message: 'Cannot adjust stock on an archived item. Unarchive it first.',
      },
    });
  });

  it('a 403 for a missing permission is a refusal with the server sentence', async () => {
    apiMock.api.mockRejectedValueOnce(apiError(403, 'Missing permission: stock:adjust'));

    const out = await submitItemAdjust('item-1', 1);

    expect(out.kind).toBe('refused');
    expect(out.kind === 'refused' && out.alert.message).toBe('Missing permission: stock:adjust');
  });

  it('a 403 MFA step-up refusal tells the operator to sign in again with their code', async () => {
    apiMock.api.mockRejectedValueOnce(
      apiError(403, 'Re-authenticate with MFA before performing this action.', {
        reason: 'aal2_required',
      }),
    );

    const out = await submitItemAdjust('item-1', 1);

    expect(out.kind).toBe('refused');
    if (out.kind !== 'refused') return;
    expect(out.alert.title).toBe('Sign in again to adjust stock');
    expect(out.alert.message).toMatch(/authenticator app/);
    expect(out.alert.message).toMatch(/Nothing was changed/);
  });

  it('a 401 never puts the code word "unauthenticated" on screen', async () => {
    apiMock.api.mockRejectedValueOnce(apiError(401, 'unauthenticated'));

    const out = await submitItemAdjust('item-1', 1);

    expect(out.kind).toBe('refused');
    if (out.kind !== 'refused') return;
    expect(out.alert.message).not.toMatch(/unauthenticated/);
    expect(out.alert.message).toMatch(/Sign in again/);
  });

  it.each([
    ['a network failure', new TypeError('Network request failed')],
    ['the api() timeout', new Error('Request timed out. Check your connection and try again.')],
    ['a 500', apiError(500, 'internal_error')],
    [
      'a 504 gateway timeout (can land after the commit)',
      apiError(504, 'The server had a problem.'),
    ],
  ])(
    '%s is UNCONFIRMED — it may have been written, so it is never called a failure',
    async (_l, err) => {
      apiMock.api.mockRejectedValueOnce(err);

      const out = await submitItemAdjust('item-1', 1);

      expect(out.kind).toBe('unconfirmed');
      if (out.kind !== 'unconfirmed') return;
      expect(out.alert.message).toMatch(/may or may not have been saved/);
      expect(out.alert.message).toMatch(/not queued/);
      // Never the raw code word a bare 500 body carries.
      expect(out.alert.message).not.toMatch(/internal_error/);
    },
  );
});

describe('classifyAdjustFailure — decided on the HTTP status alone', () => {
  it('treats every 4xx as a refusal (nothing written) and everything else as unconfirmed', () => {
    for (const status of [400, 401, 403, 404, 408, 409, 422, 429]) {
      expect(classifyAdjustFailure(apiError(status, 'x')).kind).toBe('refused');
    }
    for (const status of [500, 502, 503, 504]) {
      expect(classifyAdjustFailure(apiError(status, 'x')).kind).toBe('unconfirmed');
    }
    expect(classifyAdjustFailure(new Error('boom')).kind).toBe('unconfirmed');
    expect(classifyAdjustFailure(undefined).kind).toBe('unconfirmed');
  });
});

describe('buildItemAdjustBody', () => {
  it('falls back to the default reason for a blank one', () => {
    expect(buildItemAdjustBody(2, '   ').reason).toBe(ITEM_ADJUST_DEFAULT_REASON);
    expect(buildItemAdjustBody(2).reason).toBe(ITEM_ADJUST_DEFAULT_REASON);
  });

  it('never sends a locationId — the service picks the rack/Unplaced, never Staging', () => {
    expect(Object.keys(buildItemAdjustBody(1, 'x')).sort()).toEqual([
      'movementType',
      'quantityChange',
      'reason',
    ]);
  });
});
