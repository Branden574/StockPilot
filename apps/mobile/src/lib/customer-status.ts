import {
  AUTHENTICATOR_SET_UP_OWED_COPY,
  CONTEXT_UNAVAILABLE_COPY,
  isRefusedBeforeAnyWrite,
} from '@stockpilot/core';

import { api } from './api';
import { CONNECTION_FAILURE_COPY, REQUEST_TIMED_OUT_COPY } from './connection-copy';

/**
 * Archiving and restoring a B2B customer account from the phone's Accounts
 * screen, over the route the website's Accounts page shares:
 *
 *   PATCH /api/v1/customers/[id]/status  { status: 'active' | 'archived' }
 *
 * The route runs CustomersService.setStatus under the caller's session: the
 * customer portal module, customers:manage and the organization's
 * authenticator rule are checked, the one status column is written, and one
 * `organization.updated` audit row is recorded. The same status again changes
 * nothing and records nothing (`changed: false`).
 *
 * ONLINE ONLY, as the switch has always been: no outbox kind, nothing kept to
 * try later. A request with no answer fails at once with the app's connection
 * sentence. Setting a status is safe to repeat, so a person may simply try
 * again.
 *
 * Every sentence a person reads is chosen here by the answer's status, code
 * and `details.reason`, never the server's permission, module or MFA words
 * (they name a permission or a module id). The 503 refused before any work is
 * read only through core's isRefusedBeforeAnyWrite.
 */

export type CustomerStatus = 'active' | 'archived';

export type CustomerStatusOutcome =
  | { kind: 'saved'; status: CustomerStatus; changed: boolean }
  | { kind: 'refused'; title: string; message: string; reload: boolean };

/** The alert's title, the one the Accounts screen has always used. */
export const CUSTOMER_STATUS_FAILED_TITLE = 'Could not update';

export const CUSTOMER_STATUS_COPY = {
  sessionEnded: 'Your session has ended. Sign in again.',
  codeOwed:
    'Your account uses an authenticator app, and this session has not been verified with it. Sign out, sign back in with your code, then try again.',
  notAllowed: 'You need manager access to change accounts.',
  moduleOff: 'B2B customer accounts are turned off for this workspace.',
  notFound: 'This account may have been removed.',
  changedMeanwhile: 'This account was just changed. Refresh and try again.',
  tooMany: 'Too many requests. Wait a moment and try again.',
  notChanged: 'This account was not changed. Try again.',
  serverProblem: 'The server had a problem. Try again in a moment.',
} as const;

/** The route's address for one account; the id is one path segment. */
export function customerStatusPath(customerId: string): string {
  return `/api/v1/customers/${encodeURIComponent(customerId)}/status`;
}

/**
 * Sends the change under `orgId`, the workspace whose list is on screen, and
 * says what came of it. Never throws.
 */
export async function changeCustomerStatus(
  customerId: string,
  status: CustomerStatus,
  orgId: string,
): Promise<CustomerStatusOutcome> {
  let answer: unknown;
  try {
    answer = await api<unknown>(customerStatusPath(customerId), {
      method: 'PATCH',
      body: { status },
      orgId,
    });
  } catch (e) {
    return { kind: 'refused', ...customerStatusFailure(e) };
  }
  const saved = parseSaved(answer);
  if (saved) return { kind: 'saved', ...saved };
  // A 200 the app cannot read: the account's status is not known here.
  return {
    kind: 'refused',
    title: CUSTOMER_STATUS_FAILED_TITLE,
    message: CUSTOMER_STATUS_COPY.serverProblem,
    reload: true,
  };
}

function parseSaved(answer: unknown): { status: CustomerStatus; changed: boolean } | null {
  if (answer === null || typeof answer !== 'object') return null;
  const a = answer as { status?: unknown; changed?: unknown };
  if (a.status !== 'active' && a.status !== 'archived') return null;
  if (typeof a.changed !== 'boolean') return null;
  return { status: a.status, changed: a.changed };
}

/** A sentence from the server, when it is one (api() puts a bare code in `message`). */
function serverSentence(e: unknown): string | null {
  if (!(e instanceof Error)) return null;
  const m = e.message.trim();
  if (!m || /^[a-z0-9_]+$/.test(m) || /^Request failed \(\d+\)\.$/.test(m)) return null;
  return m;
}

/**
 * What a failed change says, and whether the list is read again: `reload` is
 * true where the answer leaves the account's status unknown (it was removed
 * or changed meanwhile, or the server's answer does not say whether the change
 * was saved). Every other refusal changed nothing, so the row keeps its status.
 */
export function customerStatusFailure(e: unknown): {
  title: string;
  message: string;
  reload: boolean;
} {
  const say = (message: string, reload: boolean) => ({
    title: CUSTOMER_STATUS_FAILED_TITLE,
    message,
    reload,
  });

  // Before the status: the one 503 known to come before any work.
  if (isRefusedBeforeAnyWrite(e)) return say(CONTEXT_UNAVAILABLE_COPY, false);

  const fields =
    e !== null && typeof e === 'object'
      ? (e as { status?: unknown; code?: unknown; details?: unknown })
      : {};
  const status = typeof fields.status === 'number' ? fields.status : null;
  const code = typeof fields.code === 'string' ? fields.code : undefined;
  const reason =
    fields.details !== null && typeof fields.details === 'object'
      ? (fields.details as { reason?: unknown }).reason
      : undefined;

  if (status === null) {
    // api()'s own timeout: the request may have reached the server.
    if (e instanceof Error && e.message === REQUEST_TIMED_OUT_COPY) {
      return say(REQUEST_TIMED_OUT_COPY, true);
    }
    // A 2xx whose body is not JSON (res.json() throws): an answer came, the
    // app cannot read it.
    if (e instanceof SyntaxError) return say(CUSTOMER_STATUS_COPY.serverProblem, true);
    // No answer at all (offline, a dropped connection): never the platform's text.
    return say(CONNECTION_FAILURE_COPY, false);
  }
  // api() has already asked for the account probe on a 401.
  if (status === 401) return say(CUSTOMER_STATUS_COPY.sessionEnded, false);
  if (status === 403) {
    if (reason === 'mfa_required') return say(AUTHENTICATOR_SET_UP_OWED_COPY, false);
    if (reason === 'aal2_required') return say(CUSTOMER_STATUS_COPY.codeOwed, false);
    if (code === 'module_disabled') return say(CUSTOMER_STATUS_COPY.moduleOff, false);
    return say(CUSTOMER_STATUS_COPY.notAllowed, false);
  }
  if (status === 404) {
    if (code === 'not_found') return say(CUSTOMER_STATUS_COPY.notFound, true);
    // No route answered (api() words that 404 itself).
    return say(serverSentence(e) ?? CUSTOMER_STATUS_COPY.notChanged, false);
  }
  if (status === 409) return say(serverSentence(e) ?? CUSTOMER_STATUS_COPY.changedMeanwhile, true);
  if (status === 429) return say(CUSTOMER_STATUS_COPY.tooMany, false);
  if (status >= 500) return say(CUSTOMER_STATUS_COPY.serverProblem, true);
  return say(serverSentence(e) ?? CUSTOMER_STATUS_COPY.notChanged, false);
}
