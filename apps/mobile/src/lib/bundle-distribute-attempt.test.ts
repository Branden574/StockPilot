import { beforeEach, describe, expect, it, vi } from 'vitest';

import { screenFunction } from './__fixtures__/screen-functions';
import {
  distributeKeyFor,
  distributeNotSavedAlert,
  distributeSignature,
  type DistributeKey,
} from './bundle-distribute-attempt';
import { OutboxOwnerUnknownError, OutboxWorkspaceLoadingError } from './outbox-scope';

/**
 * docket B10, integrator decision 2: the outbox now refuses a new row while
 * the saved workspace is another account's (OutboxWorkspaceLoadingError), and
 * every enqueue caller says the refusal in the outbox's own sentence. The
 * Distribute screen let the refusal escape (an unhandled rejection: nothing
 * said), and a person who tried again sent a NEW idempotency key, so a first
 * try that had reached the server was distributed twice. Its distribute() is
 * RUN here from the screen's source (screen-functions.ts).
 */

const LOADING = 'Your workspace is still loading. Try again in a moment.';

describe('one distribution, one key', () => {
  const req = { bundleId: 'b1', quantity: 2, warehouseId: 'w1', allowShortage: false };

  it("the signature is what the server's idempotency check compares", () => {
    const same = distributeSignature({ ...req });
    expect(distributeSignature(req)).toBe(same);
    for (const other of [
      { ...req, bundleId: 'b2' },
      { ...req, quantity: 3 },
      { ...req, warehouseId: 'w2' },
      { ...req, allowShortage: true },
    ]) {
      expect(distributeSignature(other)).not.toBe(same);
    }
  });

  it('the kept key is used again for the same request; another request mints a new one', () => {
    const mint = vi.fn(() => 'fresh');
    const kept: DistributeKey = { signature: distributeSignature(req), key: 'kept' };
    expect(distributeKeyFor(kept, distributeSignature(req), mint)).toBe(kept);
    expect(mint).not.toHaveBeenCalled();
    const other = distributeSignature({ ...req, quantity: 3 });
    expect(distributeKeyFor(kept, other, mint)).toEqual({ signature: other, key: 'fresh' });
    expect(distributeKeyFor(null, other, mint)).toEqual({ signature: other, key: 'fresh' });
  });

  it("the alert names the connection failure and the outbox's sentence, never the store's raw text", () => {
    const offline = new Error('Network request failed');
    expect(distributeNotSavedAlert(offline, new OutboxWorkspaceLoadingError())).toEqual({
      title: 'Could not save offline',
      message: `Couldn't reach the server (Network request failed), and the distribution could not be saved on this phone: ${LOADING}`,
    });
    expect(distributeNotSavedAlert(offline, new OutboxOwnerUnknownError()).message).toMatch(
      /No signed-in account to queue this change for\. Sign in and try again\.$/,
    );
    expect(distributeNotSavedAlert(null, new Error('SQLITE_FULL')).message).toBe(
      "Couldn't reach the server (network error), and the distribution could not be saved on this phone: This phone could not save it. Try again.",
    );
  });
});

describe('the Distribute screen (app/bundles/[id].tsx) when the queue refuses', () => {
  const SCREEN = 'app/bundles/[id].tsx';

  /** api()'s refusal, as the screen tells it apart (status only). */
  class ApiError extends Error {
    constructor(
      readonly status: number,
      message: string,
    ) {
      super(message);
    }
  }

  // One screen visit: the ref survives re-renders, each render builds a new
  // distribute() over the quantity typed at that moment.
  let keptKey: { current: DistributeKey | null };
  let minted: number;
  let qty: string;
  const api = vi.fn();
  const enqueue = vi.fn();
  const alert = vi.fn();
  const setBusy = vi.fn();
  const syncNow = vi.fn();

  beforeEach(() => {
    keptKey = { current: null };
    minted = 0;
    qty = '2';
    for (const fn of [api, enqueue, alert, setBusy, syncNow]) fn.mockReset();
  });

  function distribute(): Promise<void> {
    return screenFunction<() => Promise<void>>(SCREEN, 'distribute', {
      bundle: { id: 'bundle-1' },
      preview: { hasShortage: false, totalShortageUnits: 0 },
      warehouseId: 'wh-1',
      qty,
      Alert: { alert },
      distributeSignature,
      distributeKeyFor,
      distributeNotSavedAlert,
      keptKey,
      newIdempotencyKey: () => `key-${++minted}`,
      setBusy,
      api,
      ApiError,
      router: { back: vi.fn() },
      enqueue,
      syncNow,
    })();
  }

  const sentKeys = () =>
    api.mock.calls.map(
      ([, opts]) => (opts as { body: { idempotencyKey: string } }).body.idempotencyKey,
    );
  const queuedKeys = () =>
    enqueue.mock.calls.map(([, , opts]) => (opts as { idempotencyKey: string }).idempotencyKey);

  it("server not reached and the queue refused: said in the outbox's sentence, never left unhandled", async () => {
    api.mockRejectedValueOnce(new Error('Network request failed'));
    enqueue.mockRejectedValueOnce(new OutboxWorkspaceLoadingError());

    await expect(distribute()).resolves.toBeUndefined();

    expect(alert.mock.calls).toEqual([
      [
        'Could not save offline',
        `Couldn't reach the server (Network request failed), and the distribution could not be saved on this phone: ${LOADING}`,
      ],
    ]);
    expect(setBusy.mock.calls.at(-1)).toEqual([false]);
    expect(syncNow).not.toHaveBeenCalled();
  });

  it('trying the same distribution again sends the same key, so the server makes it once', async () => {
    api.mockRejectedValueOnce(new Error('The request timed out'));
    enqueue.mockRejectedValueOnce(new OutboxWorkspaceLoadingError());
    await distribute();

    // A moment later: still no answer, and now the queue takes it.
    api.mockRejectedValueOnce(new Error('Network request failed'));
    enqueue.mockResolvedValueOnce({ id: 1, idempotencyKey: 'key-1' });
    await distribute();

    expect(sentKeys()).toEqual(['key-1', 'key-1']);
    expect(queuedKeys()).toEqual(['key-1', 'key-1']);
    expect(alert.mock.calls.at(-1)?.[0]).toBe('Queued');
    // Queued: the next tap is a new distribution.
    expect(keptKey.current).toBeNull();
  });

  it('a different quantity is a different distribution: a new key', async () => {
    api.mockRejectedValueOnce(new Error('Network request failed'));
    enqueue.mockRejectedValueOnce(new OutboxWorkspaceLoadingError());
    await distribute();

    qty = '3';
    api.mockResolvedValueOnce({ ok: true });
    await distribute();

    expect(sentKeys()).toEqual(['key-1', 'key-2']);
  });

  it('sent, or refused by the server: the next tap mints a new key and nothing is queued for a refusal', async () => {
    api.mockResolvedValueOnce({ ok: true });
    await distribute();
    expect(keptKey.current).toBeNull();

    api.mockRejectedValueOnce(new ApiError(409, 'Not enough stock'));
    await distribute();
    expect(keptKey.current).toBeNull();
    expect(enqueue).not.toHaveBeenCalled();
    expect(alert.mock.calls.at(-1)).toEqual(['Could not distribute', 'Not enough stock']);

    expect(sentKeys()).toEqual(['key-1', 'key-2']);
  });
});
