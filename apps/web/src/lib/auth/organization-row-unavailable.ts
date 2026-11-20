import { ACCESS_UNCHECKED_DIGEST } from '@/lib/known-error-states';

/**
 * The organization row could not be read (getOrgRowForRequest in
 * lib/dashboard/request-cache.ts: a read that answered with an error).
 *
 * Also the answer when the row's authenticator policy was not read (the row
 * came back hidden, or with a value that is not a policy) for a member with
 * no verified authenticator: held to the strictest policy, they would owe
 * set-up, but whether their organization asks for it is not known
 * (lib/auth/step-up-gate.ts policyNotRead, and the service gate's
 * mfaGateError in server/services/context.ts).
 *
 * WHY AN EXCEPTION, AND NOT A ROW WITH DEFAULT SETTINGS. The row holds the
 * organization's authenticator policy. A page drawn with defaults would hold
 * the member to the strictest policy (lib/auth/mfa-policy.ts), and the
 * dashboard layout's hard gate would then send a member of an organization
 * that does not require an authenticator to authenticator setup during a
 * short outage. Nothing is allowed on this error: it is a check of the
 * caller's access that could not be made, the same state as a module state
 * that could not be read (ModulesUnavailableError).
 *
 * HOW IT IS ANSWERED.
 *   - A page: `digest` is fixed (lib/known-error-states has why only a digest
 *     reaches the browser), so the dashboard and root error cards show the
 *     plain state "This page couldn't be loaded" / "We couldn't check your
 *     access just now" with Try again, never "Something went wrong".
 *   - A Server Action: actionErrorResult and uncheckedAccessResult
 *     (server/lib/action-error-result.ts) answer this class's fixed
 *     try-again sentence, reported once as a warning.
 *   - An API route: internalErrorResponse (server/lib/api-error-response.ts)
 *     answers the route's 5xx with the same sentence, which the phone retries.
 *
 * The read's own error text stays in the server log, where the reader writes
 * it before it throws: the message here is one fixed sentence and the class
 * takes no argument (app/api/no-raw-error-text.guard.test.ts pins that).
 *
 * In memory only: no import beyond the digest, no read, no write.
 */
export class OrganizationRowUnavailableError extends Error {
  readonly code = 'ORGANIZATION_ROW_UNAVAILABLE';
  readonly digest = ACCESS_UNCHECKED_DIGEST;

  constructor() {
    super('Your access could not be checked. Please try again.');
    this.name = 'OrganizationRowUnavailableError';
  }
}
