import type { ServiceError } from '@/server/services/context';

/** A reason that is forwarded: a fixed lower-case word of at most 64 characters. */
const REASON_WORD = /^[a-z][a-z0-9_]{0,63}$/;

/**
 * The part of a refused ServiceError's `details` that the routes the phone's
 * outbox sends queued changes to put in their answer: `{ details: { reason } }`
 * when the details hold a `reason` that is a fixed word, else nothing. Nothing
 * else from `details` is forwarded (no id, name or other field), and an
 * internal_error forwards nothing at all, so its answer stays the fixed
 * sentence.
 *
 * A fixed word: a lower-case letter, then at most 63 lower-case letters,
 * digits or underscores (REASON_WORD); any other string forwards nothing.
 *
 * The reason is what tells the phone apart answers that share a status and a
 * code: the authenticator gate's 'mfa_required' (set one up) and
 * 'aal2_required' (enter its code), or 'assigned_to_another_user', are each a
 * 403 'forbidden', as a missing permission is (with no details).
 *
 * Spread it into the answer's body: `{ error, message, ...refusalReasonDetails(e) }`.
 */
export function refusalReasonDetails(
  e: Pick<ServiceError, 'code' | 'details'>,
): { details: { reason: string } } | Record<string, never> {
  if (e.code === 'internal_error') return {};
  const reason = e.details?.reason;
  return typeof reason === 'string' && REASON_WORD.test(reason) ? { details: { reason } } : {};
}
