/**
 * The caller's organization could not be chosen because a read it depends on
 * did not answer (lib/auth/api-context.ts pickActiveMembership): the
 * membership in the organization the request names, the profile's default
 * organization, the membership in it, or the oldest membership.
 *
 * WHY AN EXCEPTION. withApiContext answers "no membership" with the null every
 * route answers as 401, and the phone words a 401 as an identity answer (it
 * asks for an account probe, and an open add-lines or edit-line sheet closes).
 * The next step of the choice runs only on an answer from the one before. A
 * read that did not answer is neither "no membership" nor "go on": it is a
 * refusal the caller may send again, the same shape as
 * AccountStatusUnavailableError beside it in the same Promise.all.
 *
 * HOW IT IS ANSWERED. apiContextGate (server/lib/api-context-gate.ts) answers
 * it as its 503 marked as refused before any write; internalErrorResponse
 * (server/lib/api-error-response.ts) as the route's 5xx with this class's
 * sentence, reported as a warning; a route with no catch around the context
 * lets it reach Next, which answers 500. Every one is a 5xx the phone retries.
 *
 * In memory only: no import, no read, no write.
 */
export class MembershipUnavailableError extends Error {
  readonly code = 'MEMBERSHIP_UNAVAILABLE';

  constructor() {
    super('Your access could not be checked. Please try again.');
    this.name = 'MembershipUnavailableError';
  }
}
