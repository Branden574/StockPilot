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
 * whether it resolves or rejects, and its result or error passes through.
 * Never hold a slot while waiting for another one (no nested calls).
 */
export async function withStorageSignSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (inFlight < STORAGE_SIGN_CONCURRENCY) {
    inFlight += 1;
  } else {
    await new Promise<void>((resolve) => waiting.push(resolve));
  }
  try {
    return await fn();
  } finally {
    release();
  }
}

/** Test hook: requests currently holding a slot, and callers waiting for one. */
export function storageSignSlotState(): { inFlight: number; waiting: number } {
  return { inFlight, waiting: waiting.length };
}
