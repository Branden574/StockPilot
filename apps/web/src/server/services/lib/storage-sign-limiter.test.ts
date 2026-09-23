import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  STORAGE_SIGN_CONCURRENCY,
  STORAGE_SIGN_TIMEOUT_MS,
  StorageSignTimeoutError,
  storageSignSlotState,
  withStorageSignSlot,
} from './storage-sign-limiter';

afterEach(() => {
  vi.useRealTimers();
});

const tick = (ms = 1) => new Promise((r) => setTimeout(r, ms));

describe('withStorageSignSlot', () => {
  it(`keeps at most ${STORAGE_SIGN_CONCURRENCY} requests in flight and runs every one`, async () => {
    let inFlight = 0;
    let peak = 0;
    const results = await Promise.all(
      Array.from({ length: 300 }, (_, i) =>
        withStorageSignSlot(async () => {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          await tick();
          inFlight -= 1;
          return i;
        }),
      ),
    );
    expect(peak).toBe(STORAGE_SIGN_CONCURRENCY);
    expect(results).toEqual(Array.from({ length: 300 }, (_, i) => i));
    expect(storageSignSlotState()).toEqual({ inFlight: 0, waiting: 0 });
  });

  it('releases the slot when the request rejects, and passes the error through', async () => {
    const runs = Array.from({ length: 50 }, (_, i) =>
      withStorageSignSlot(async () => {
        await tick();
        if (i % 2 === 0) throw new Error(`fail ${i}`);
        return i;
      }),
    );
    const settled = await Promise.allSettled(runs);
    expect(settled.filter((s) => s.status === 'rejected')).toHaveLength(25);
    expect((settled[0] as PromiseRejectedResult).reason.message).toBe('fail 0');
    expect(storageSignSlotState()).toEqual({ inFlight: 0, waiting: 0 });
  });

  it('releases the slot when the function throws synchronously', async () => {
    await expect(
      withStorageSignSlot(() => {
        throw new Error('sync');
      }),
    ).rejects.toThrow('sync');
    expect(storageSignSlotState()).toEqual({ inFlight: 0, waiting: 0 });
  });
});

/**
 * Review of this branch: the admin client's fetch has no timeout, so during a
 * storage gateway stall 20 stuck createSignedUrl calls held every slot until
 * undici gave up (about 300 s), and every other signing request on the
 * instance (item photos, order attachments, procedure videos) waited behind
 * them. A slot is now held for at most STORAGE_SIGN_TIMEOUT_MS.
 */
describe('a signing request that never answers', () => {
  it(`gives up its slot after ${STORAGE_SIGN_TIMEOUT_MS} ms, so the requests queued behind it run`, async () => {
    vi.useFakeTimers();
    const stuck = Array.from({ length: STORAGE_SIGN_CONCURRENCY }, () =>
      withStorageSignSlot(() => new Promise<never>(() => {})),
    );
    const stuckSettled = Promise.allSettled(stuck);
    let queuedRan = false;
    const queued = withStorageSignSlot(async () => {
      queuedRan = true;
      return 'signed';
    });
    await vi.advanceTimersByTimeAsync(1);
    expect(queuedRan).toBe(false);
    expect(storageSignSlotState()).toEqual({
      inFlight: STORAGE_SIGN_CONCURRENCY,
      waiting: 1,
    });

    await vi.advanceTimersByTimeAsync(STORAGE_SIGN_TIMEOUT_MS);
    const settled = await stuckSettled;
    expect(settled.every((s) => s.status === 'rejected')).toBe(true);
    expect((settled[0] as PromiseRejectedResult).reason).toBeInstanceOf(StorageSignTimeoutError);
    await expect(queued).resolves.toBe('signed');
    expect(storageSignSlotState()).toEqual({ inFlight: 0, waiting: 0 });
  });

  it('a request that settles after its deadline changes nothing and is not an unhandled rejection', async () => {
    vi.useFakeTimers();
    const late = withStorageSignSlot(
      () =>
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('late')), STORAGE_SIGN_TIMEOUT_MS * 2),
        ),
    );
    const outcome = late.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(STORAGE_SIGN_TIMEOUT_MS);
    expect(await outcome).toBeInstanceOf(StorageSignTimeoutError);
    await vi.advanceTimersByTimeAsync(STORAGE_SIGN_TIMEOUT_MS * 2);
    expect(storageSignSlotState()).toEqual({ inFlight: 0, waiting: 0 });
  });

  it('a request that answers in time leaves no timer behind', async () => {
    vi.useFakeTimers();
    await Promise.all(Array.from({ length: 40 }, (_, i) => withStorageSignSlot(async () => i)));
    expect(vi.getTimerCount()).toBe(0);
  });
});
