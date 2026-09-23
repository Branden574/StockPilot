import 'server-only';

/**
 * A cap on storage signing requests in flight from one server instance.
 *
 * The per-path signers (item images, procedure videos, order attachments) run
 * inside `unstable_cache`: a warm path never reaches storage, a cold one makes
 * one `createSignedUrl` request. Their callers resolve whole lists with
 * Promise.all, so a cold cache turned a 356-item catalog or a 443-item export
 * into hundreds of signing requests started in the same moment; on the lab
 * org a cold run came back with 244 of 356 thumbnails and nothing said why.
 *
 * Only the storage request waits for a slot, never the cache read, so a warm
 * page is exactly as fast as before. The cap is per instance and shared by
 * every request it serves, which is the point: it bounds what one instance
 * puts on the storage gateway at once. 20 matches the storefront's
 * TRANSFORM_SIGN_CONCURRENCY (orders-new-catalog.ts).
 */
export const STORAGE_SIGN_CONCURRENCY = 20;

/**
 * The longest one request may hold a slot. The admin client's fetch has no
 * timeout, and createSignedUrl(s) takes no abort signal, so during a storage
 * gateway stall a request can hang until undici gives up (about 300 s). With
 * 20 of those holding every slot, every other signing request on the instance
 * would wait behind them, including ones storage would have answered at once.
 *
 * At the deadline the caller gets StorageSignTimeoutError, which every signer
 * already turns into "no photo" plus a report (a throw is never cached), and
 * the slot goes to the next caller. The abandoned request is not cancelled
 * (nothing can cancel it); it finishes or fails on its own and its result is
 * dropped. Signing normally answers in well under a second; the 1-8 s stalls
 * seen at the Supabase entry on 2026-09-22 still fit.
 */
export const STORAGE_SIGN_TIMEOUT_MS = 10_000;

export class StorageSignTimeoutError extends Error {
  constructor() {
    super(`Storage signing did not answer within ${STORAGE_SIGN_TIMEOUT_MS} ms`);
    this.name = 'StorageSignTimeoutError';
  }
}

let inFlight = 0;
const waiting: Array<() => void> = [];

function release(): void {
  const next = waiting.shift();
  if (next) {
    // Hand the slot straight to the next caller; inFlight stays the same.
    next();
    return;
  }
  inFlight -= 1;
}

/**
 * Run `fn` once a slot is free. The slot is released when `fn` settles,
 * whether it resolves or rejects, and its result or error passes through; or
 * at STORAGE_SIGN_TIMEOUT_MS, whichever comes first, and then the caller gets
 * StorageSignTimeoutError. Never hold a slot while waiting for another one
 * (no nested calls).
 */
export async function withStorageSignSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (inFlight < STORAGE_SIGN_CONCURRENCY) {
    inFlight += 1;
  } else {
    await new Promise<void>((resolve) => waiting.push(resolve));
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // Started inside the try so a synchronous throw still releases the slot.
    const work = Promise.resolve(fn());
    // After a timeout nobody awaits `work`; its late rejection must not
    // surface as an unhandled rejection.
    work.catch(() => {});
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new StorageSignTimeoutError()), STORAGE_SIGN_TIMEOUT_MS);
    });
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
    release();
  }
}

/** Test hook: requests currently holding a slot, and callers waiting for one. */
export function storageSignSlotState(): { inFlight: number; waiting: number } {
  return { inFlight, waiting: waiting.length };
}
