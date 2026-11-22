import 'server-only';

import { factorsOf, type MfaFactor, type MfaFactorList } from '@/lib/auth/mfa-factors';

/**
 * The factor list read a service context (server/services/context.ts
 * withContext) started, kept beside the context so an action can look at
 * the factors' names without a second GoTrue round trip (review 2-3 finding
 * 5: inside a Server Action React cache() does not memoize, so reading the
 * list again is another request to Auth).
 *
 * Kept in a WeakMap keyed on the context object: the context's type and
 * shape are unchanged, and the entry goes with the context.
 */
const READS = new WeakMap<object, Promise<MfaFactorList>>();

/** withContext() hands over the read it started, once the context is built. */
export function keepContextFactorListRead(ctx: object, read: Promise<MfaFactorList>): void {
  READS.set(ctx, read);
}

/**
 * The factors of `userId` from the read `ctx` keeps, or null when there is no
 * answer: the context keeps no read (one not built by withContext()), the
 * read failed (withContext() already failed its own gate closed on it), or
 * the list is another account's (factorsOf: the session moved). A caller
 * treats null as "no names known". Never throws.
 */
export async function contextFactorsOf(ctx: object, userId: string): Promise<MfaFactor[] | null> {
  const read = READS.get(ctx);
  if (!read) return null;
  try {
    return factorsOf(await read, userId);
  } catch {
    return null;
  }
}
