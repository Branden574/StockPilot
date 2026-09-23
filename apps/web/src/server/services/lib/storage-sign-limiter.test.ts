import { describe, expect, it } from 'vitest';

import {
  STORAGE_SIGN_CONCURRENCY,
  storageSignSlotState,
  withStorageSignSlot,
} from './storage-sign-limiter';

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
