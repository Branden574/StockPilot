import type { ServiceError } from '@/server/services/context';

/**
 * The part of a refused ServiceError's `details` that the routes the phone's
 * outbox sends queued changes to put in their answer: `{ details: { reason } }`
 * when the details hold a string `reason`, else nothing. Nothing else from
 * `details` is forwarded (no id, name or other field), and an internal_error
 * forwards nothing at all, so its answer stays the fixed sentence.
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
  return typeof reason === 'string' ? { details: { reason } } : {};
}
