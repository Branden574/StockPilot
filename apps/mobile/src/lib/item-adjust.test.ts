import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildItemAdjustBody,
  classifyAdjustFailure,
  ITEM_ADJUST_DEFAULT_REASON,
  SCAN_ADJUST_REASON,
  submitItemAdjust,
} from './item-adjust';
import { UNCONFIRMED_SETTLE_MS, unconfirmedStock } from './unconfirmed-stock';

// ./api reaches for expo-constants, AsyncStorage and the Supabase client at
// import time, none of which exist under the node test environment. Same idiom
// as cycle-counts-api.test.ts. The status-bearing errors below are shaped like
// ApiError (status / code / details) because that is all the classifier reads.
const apiMock = vi.hoisted(() => ({ api: vi.fn(async (..._args: unknown[]) => ({}) as unknown) }));
vi.mock('./api', () => apiMock);

beforeEach(() => {
  apiMock.api.mockReset();
  unconfirmedStock.resetForTests();
});

// The store schedules a timer per item in doubt; never leave one running.
afterEach(() => unconfirmedStock.resetForTests());

/** What the item screen passes: the total on screen when the operator tapped. */
const SHOWN = { shownTotal: 5 };

function apiError(status: number, message: string, details?: unknown) {
  return Object.assign(new Error(message), { name: 'ApiError', status, details });
}

describe('submitItemAdjust — the item screen goes through the server route', () => {
  it('POSTs a +1 to /api/v1/items/<id>/adjust as an add, with the default reason', async () => {
    apiMock.api.mockResolvedValueOnce({ ok: true, quantityOnHand: 6 });

    await submitItemAdjust('item-1', 1, SHOWN);

    expect(apiMock.api).toHaveBeenCalledTimes(1);
    expect(apiMock.api).toHaveBeenCalledWith('/api/v1/items/item-1/adjust', {
      method: 'POST',
      body: { quantityChange: 1, movementType: 'add', reason: ITEM_ADJUST_DEFAULT_REASON },
      // api() calls it as the request is handed to fetch (see below).
      onSend: expect.any(Function),
    });
  });

  it.each([
    [-5, 'remove'],
    [-1, 'remove'],
    [1, 'add'],
    [5, 'add'],
  ] as const)('the %i button sends that delta as a %s', async (delta, kind) => {
    apiMock.api.mockResolvedValueOnce({ ok: true, quantityOnHand: 10 });

    await submitItemAdjust('item-1', delta, SHOWN);

    expect(apiMock.api.mock.calls[0]?.[1]).toEqual({
      method: 'POST',
      body: { quantityChange: delta, movementType: kind, reason: 'Mobile detail' },
      onSend: expect.any(Function),
    });
  });

  it('carries the sheet reason, trimmed', async () => {
    apiMock.api.mockResolvedValueOnce({ ok: true, quantityOnHand: 3 });

    await submitItemAdjust('item-1', -3, { ...SHOWN, reason: '  Damaged in transit  ' });

    expect(apiMock.api.mock.calls[0]?.[1]).toEqual({
      method: 'POST',
      body: { quantityChange: -3, movementType: 'remove', reason: 'Damaged in transit' },
      onSend: expect.any(Function),
    });
  });

  it('shows the total the SERVER returned, not the old total plus the delta', async () => {
    // Someone else adjusted the item since this screen loaded: local
    // arithmetic would say 6; the atomic RPC says 42.
    apiMock.api.mockResolvedValueOnce({ ok: true, quantityOnHand: 42 });

    const out = await submitItemAdjust('item-1', 1, SHOWN);

    expect(out).toEqual({ kind: 'saved', quantityOnHand: 42 });
  });

  it('reports a saved write WITHOUT a total as null, so the screen re-reads instead of guessing', async () => {
    apiMock.api.mockResolvedValueOnce({ ok: true });

    expect(await submitItemAdjust('item-1', 1, SHOWN)).toEqual({ kind: 'saved', quantityOnHand: null });
  });

  it('never sends a zero or non-finite delta', async () => {
    for (const d of [0, Number.NaN, Number.POSITIVE_INFINITY]) {
      const out = await submitItemAdjust('item-1', d, SHOWN);
      expect(out.kind).toBe('refused');
    }
    expect(apiMock.api).not.toHaveBeenCalled();
  });

  it('never rejects, even when the transport throws a non-Error', async () => {
    apiMock.api.mockRejectedValueOnce(null);

    await expect(submitItemAdjust('item-1', 1, SHOWN)).resolves.toMatchObject({ kind: 'unconfirmed' });
  });
});

describe('submitItemAdjust — errors surface, and say whether anything was written', () => {
  it('a 400 from the service is a refusal carrying the server sentence, and says nothing changed', async () => {
    apiMock.api.mockRejectedValueOnce(
      apiError(400, 'Cannot adjust stock on an archived item. Unarchive it first.'),
    );

    const out = await submitItemAdjust('item-1', -1, SHOWN);

    expect(out).toEqual({
      kind: 'refused',
      alert: {
        title: 'Could not adjust',
        message:
          'Cannot adjust stock on an archived item. Unarchive it first. Nothing was changed.',
      },
    });
  });

  it('a 403 for a missing permission is a clear refusal: not allowed, nothing changed', async () => {
    apiMock.api.mockRejectedValueOnce(apiError(403, 'Missing permission: stock:adjust'));

    const out = await submitItemAdjust('item-1', 1, SHOWN);

    expect(out).toEqual({
      kind: 'refused',
      alert: {
        title: 'Not allowed to adjust',
        message: 'Missing permission: stock:adjust. Nothing was changed.',
      },
    });
  });

  // The route answered this as a 500 until 2026-09-22, which this file had to
  // report as "may or may not have been saved" on a write refused before it
  // ran. It is now the 403 it is, and must read as a refusal.
  it("a 403 warehouse-write refusal is a refusal, never 'may or may not have been saved'", async () => {
    apiMock.api.mockRejectedValueOnce(
      apiError(403, "You do not have write access to this item's warehouse."),
    );

    const out = await submitItemAdjust('item-1', 1, SHOWN);

    expect(out.kind).toBe('refused');
    if (out.kind !== 'refused') return;
    expect(out.alert.title).toBe('Not allowed to adjust');
    expect(out.alert.message).toBe(
      "You do not have write access to this item's warehouse. Nothing was changed.",
    );
    expect(out.alert.message).not.toMatch(/may or may not/);
    // A refusal leaves no doubt over the total on screen.
    expect(unconfirmedStock.get('item-1')).toBeNull();
  });

  it('a 403 MFA step-up refusal tells the operator to sign in again with their code', async () => {
    apiMock.api.mockRejectedValueOnce(
      apiError(403, 'Re-authenticate with MFA before performing this action.', {
        reason: 'aal2_required',
      }),
    );

    const out = await submitItemAdjust('item-1', 1, SHOWN);

    expect(out.kind).toBe('refused');
    if (out.kind !== 'refused') return;
    expect(out.alert.title).toBe('Sign in again to adjust stock');
    expect(out.alert.message).toMatch(/authenticator app/);
    expect(out.alert.message).toMatch(/Nothing was changed/);
  });

  it('a 401 never puts the code word "unauthenticated" on screen', async () => {
    apiMock.api.mockRejectedValueOnce(apiError(401, 'unauthenticated'));

    const out = await submitItemAdjust('item-1', 1, SHOWN);

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

      const out = await submitItemAdjust('item-1', 1, SHOWN);

      expect(out.kind).toBe('unconfirmed');
      if (out.kind !== 'unconfirmed') return;
      expect(out.alert.message).toMatch(/may or may not have been saved/);
      expect(out.alert.message).toMatch(/may still be saving/);
      expect(out.alert.message).toMatch(/not queued/);
      // Never the raw code word a bare 500 body carries.
      expect(out.alert.message).not.toMatch(/internal_error/);
    },
  );
});

describe('submitItemAdjust — records what the answer means for the total on screen', () => {
  // Review finding: the window was started before post(), but api() first
  // awaits the session (a token refresh can take seconds), so it could close
  // while the write could still land. It starts at api()'s hand-off to fetch.
  it('an unconfirmed write puts the item in doubt, bounded from when api() HANDED IT TO fetch', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000_000);
      // A 5 s token refresh, then the hand-off, then api()'s 20 s timeout.
      apiMock.api.mockImplementationOnce(async (..._args: unknown[]) => {
        const opts = _args[1] as { onSend?: () => void };
        vi.setSystemTime(1_005_000);
        opts.onSend?.();
        vi.setSystemTime(1_025_000);
        throw new Error('Request timed out. Check your connection and try again.');
      });

      const out = await submitItemAdjust('item-1', 3, { shownTotal: 10 });

      expect(out.kind).toBe('unconfirmed');
      expect(unconfirmedStock.get('item-1')).toEqual({
        expectedTotal: 13,
        settlesAt: 1_005_000 + UNCONFIRMED_SETTLE_MS,
        mayStillLand: true,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('with no hand-off reported, the window starts at the failure: later, never earlier', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000_000);
      apiMock.api.mockImplementationOnce(async () => {
        vi.setSystemTime(1_020_000);
        throw new TypeError('Network request failed');
      });

      await submitItemAdjust('item-1', 3, { shownTotal: 10 });

      expect(unconfirmedStock.get('item-1')?.settlesAt).toBe(1_020_000 + UNCONFIRMED_SETTLE_MS);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a refusal leaves no write behind, in flight or in doubt', async () => {
    apiMock.api.mockRejectedValueOnce(apiError(422, 'Not enough stock.'));

    await submitItemAdjust('item-1', -3, { shownTotal: 1 });

    expect(unconfirmedStock.writes('item-1').size).toBe(0);
  });

  it('a saved write with a total leaves no doubt', async () => {
    apiMock.api.mockResolvedValueOnce({ ok: true, quantityOnHand: 6 });

    await submitItemAdjust('item-1', 1, SHOWN);

    expect(unconfirmedStock.get('item-1')).toBeNull();
  });

  it('a saved write WITHOUT a total marks the number old until a later read', async () => {
    apiMock.api.mockResolvedValueOnce({ ok: true });

    await submitItemAdjust('item-1', 1, SHOWN);

    expect(unconfirmedStock.get('item-1')).toMatchObject({
      expectedTotal: null,
      mayStillLand: false,
    });
  });

  it('a saved write while an earlier one is in doubt keeps the doubt, without its shortcut', async () => {
    apiMock.api.mockRejectedValueOnce(apiError(504, 'The server had a problem.'));
    await submitItemAdjust('item-1', 1, { shownTotal: 10 });
    apiMock.api.mockResolvedValueOnce({ ok: true, quantityOnHand: 12 });

    await submitItemAdjust('item-1', 1, { shownTotal: 10 });

    // The earlier write may still land on top of 12; "10 + 1" proves nothing now.
    expect(unconfirmedStock.get('item-1')).toMatchObject({
      expectedTotal: null,
      mayStillLand: true,
    });
  });

  // Review finding: a second write sent while a first was unconfirmed only
  // switched off the first's "base + delta" proof when its answer arrived, so
  // a read landing while it was in flight could clear the first write's label.
  it('a read while a second write is IN FLIGHT cannot clear the first one in doubt', async () => {
    apiMock.api.mockRejectedValueOnce(apiError(504, 'The server had a problem.'));
    await submitItemAdjust('item-1', 1, { shownTotal: 10 });
    expect(unconfirmedStock.get('item-1')).toMatchObject({ expectedTotal: 11 });

    let answer!: (r: unknown) => void;
    apiMock.api.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
    const second = submitItemAdjust('item-1', 1, { shownTotal: 10 });

    // 11 may be the SECOND write landing with the first still running.
    unconfirmedStock.recordRead('item-1', 11, Date.now());
    expect(unconfirmedStock.get('item-1')).not.toBeNull();

    answer({ ok: true, quantityOnHand: 11 });
    await second;
    unconfirmedStock.recordRead('item-1', 11, Date.now());
    expect(unconfirmedStock.get('item-1')).toMatchObject({ expectedTotal: null, mayStillLand: true });
  });

  it('a second write that is REFUSED gives the first its proof back', async () => {
    apiMock.api.mockRejectedValueOnce(apiError(504, 'The server had a problem.'));
    await submitItemAdjust('item-1', 1, { shownTotal: 10 });
    apiMock.api.mockRejectedValueOnce(apiError(403, 'Missing permission: stock:adjust'));
    await submitItemAdjust('item-1', 1, { shownTotal: 10 });

    unconfirmedStock.recordRead('item-1', 11, Date.now());

    expect(unconfirmedStock.get('item-1')).toBeNull();
  });

  it('the scan tab sends its own history label', async () => {
    apiMock.api.mockResolvedValueOnce({ ok: true, quantityOnHand: 26 });

    await submitItemAdjust('item-1', 25, { shownTotal: 1, defaultReason: SCAN_ADJUST_REASON });

    expect(apiMock.api.mock.calls[0]?.[1]).toEqual({
      method: 'POST',
      body: { quantityChange: 25, movementType: 'add', reason: 'Mobile scan' },
      onSend: expect.any(Function),
    });
  });
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

describe('submitItemAdjust — offline (the item screen): queued only when nothing was sent', () => {
  const NOW = Date.UTC(2026, 8, 25, 17, 2, 3);

  function offlineQueue(online: boolean | (() => Promise<boolean>)) {
    const enqueue = vi.fn(async (_payload: Record<string, unknown>) => ({ id: 1 }));
    return {
      enqueue,
      offline: {
        isOnline: typeof online === 'function' ? online : async () => online,
        enqueue,
        itemLabel: 'Polo S (POLO-S)',
        now: () => NOW,
      },
    };
  }

  it('with no connection it sends NOTHING and saves the row in the outbox', async () => {
    const q = offlineQueue(false);

    const outcome = await submitItemAdjust('item-1', -1, { ...SHOWN, offline: q.offline });

    expect(outcome.kind).toBe('queued');
    expect(apiMock.api).not.toHaveBeenCalled();
    expect(q.enqueue).toHaveBeenCalledTimes(1);
    expect(q.enqueue).toHaveBeenCalledWith({
      itemId: 'item-1',
      quantityChange: -1,
      movementType: 'remove',
      reason: ITEM_ADJUST_DEFAULT_REASON,
      notes: 'Queued offline on the phone at 2026-09-25T17:02:03.000Z (phone clock).',
      itemLabel: 'Polo S (POLO-S)',
    });
  });

  it('keeps the sheet reason on the queued row', async () => {
    const q = offlineQueue(false);

    await submitItemAdjust('item-1', 4, { ...SHOWN, reason: ' Found on shelf ', offline: q.offline });

    expect(q.enqueue.mock.calls[0]?.[0]).toMatchObject({
      quantityChange: 4,
      movementType: 'add',
      reason: 'Found on shelf',
    });
  });

  it('a queued change puts nothing in doubt: nothing is in flight', async () => {
    const q = offlineQueue(false);

    await submitItemAdjust('item-1', 1, { ...SHOWN, offline: q.offline });

    expect(unconfirmedStock.writes('item-1').size).toBe(0);
    expect(unconfirmedStock.get('item-1')).toBeNull();
  });

  it('says it was saved offline and that the total changes only once it is sent', async () => {
    const q = offlineQueue(false);

    const outcome = await submitItemAdjust('item-1', -5, { ...SHOWN, offline: q.offline });

    expect(outcome).toMatchObject({ kind: 'queued', alert: { title: 'Saved offline' } });
    const message = (outcome as { alert: { message: string } }).alert.message;
    expect(message).toContain('−5');
    expect(message).toMatch(/sent when it is back online/);
    expect(message).toMatch(/Unsent work/);
  });

  it('with a connection it POSTs as before and queues nothing', async () => {
    const q = offlineQueue(true);
    apiMock.api.mockResolvedValueOnce({ ok: true, quantityOnHand: 6 });

    const outcome = await submitItemAdjust('item-1', 1, { ...SHOWN, offline: q.offline });

    expect(outcome).toEqual({ kind: 'saved', quantityOnHand: 6 });
    expect(q.enqueue).not.toHaveBeenCalled();
  });

  it('a request that was SENT and failed is never queued: it may have landed', async () => {
    const q = offlineQueue(true);
    apiMock.api.mockRejectedValueOnce(new Error('Network request failed'));

    const outcome = await submitItemAdjust('item-1', 1, { ...SHOWN, offline: q.offline });

    expect(outcome.kind).toBe('unconfirmed');
    expect(q.enqueue).not.toHaveBeenCalled();
  });

  it('a connection check that throws means "try online" (the rule sync.ts isOnline keeps)', async () => {
    const q = offlineQueue(async () => {
      throw new Error('expo-network unavailable');
    });
    apiMock.api.mockResolvedValueOnce({ ok: true, quantityOnHand: 6 });

    await submitItemAdjust('item-1', 1, { ...SHOWN, offline: q.offline });

    expect(apiMock.api).toHaveBeenCalledTimes(1);
    expect(q.enqueue).not.toHaveBeenCalled();
  });

  it('when the outbox refuses (no account to own the row) it says nothing was saved or changed', async () => {
    const q = offlineQueue(false);
    q.enqueue.mockRejectedValueOnce(
      new Error('No signed-in account to queue this change for. Sign in and try again.'),
    );

    const outcome = await submitItemAdjust('item-1', 1, { ...SHOWN, offline: q.offline });

    expect(outcome).toMatchObject({ kind: 'refused', alert: { title: 'Could not save offline' } });
    const message = (outcome as { alert: { message: string } }).alert.message;
    expect(message).toMatch(/No signed-in account/);
    expect(message).toMatch(/Nothing was changed\.$/);
    expect(apiMock.api).not.toHaveBeenCalled();
  });

  it('a zero is refused before the connection is even checked', async () => {
    const isOnline = vi.fn(async () => false);
    const q = offlineQueue(isOnline);

    const outcome = await submitItemAdjust('item-1', 0, { ...SHOWN, offline: q.offline });

    expect(outcome.kind).toBe('refused');
    expect(isOnline).not.toHaveBeenCalled();
    expect(q.enqueue).not.toHaveBeenCalled();
  });

  it('without `offline` (the scan tab) a tap is always attempted, never queued', async () => {
    apiMock.api.mockRejectedValueOnce(new Error('Network request failed'));

    const outcome = await submitItemAdjust('item-1', 1, SHOWN);

    expect(outcome.kind).toBe('unconfirmed');
    expect(apiMock.api).toHaveBeenCalledTimes(1);
  });
});
