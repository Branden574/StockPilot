/**
 * WHOSE queued work is this, and may it be sent now? The one answer both
 * drains and every outbox counter use (recurring pattern #26: one predicate,
 * never a copy per caller).
 *
 * THE DEFECT (S4a). pending_actions rows carried no organization or user. Both
 * drains sent every row under whatever workspace header and bearer token were
 * live AT SEND TIME, so:
 *   - work queued in workspace A replayed into workspace B after a switch; the
 *     server answered 404/403, the drain classified that as a terminal
 *     rejection, and the queued count was lost for good (Unsent work has no
 *     retry), even after switching back;
 *   - on a shared phone, after "Use password instead" / "Use a different
 *     account" / a revoked session, the NEXT person's session sent the
 *     previous person's queued counts, recording the wrong counted_by or being
 *     refused for good on an assigned count.
 *
 * THE RULE (owner decision D4, 2026-09-24):
 *   - every row is stamped with the organization and user it was queued under;
 *   - it is sent under ITS OWN organization (api() `orgId`) and ONLY while the
 *     live session belongs to the user who queued it. That is checked before
 *     EACH send, not once per drain: a session can end or change mid-drain;
 *   - a row queued by another account is HELD: left exactly as it is (neither
 *     failed nor rejected, never deleted automatically) until that account
 *     signs in on this device again. Settings > Unsent work lists it as
 *     "Queued by another account" with Discard;
 *   - a LEGACY row (NULL user, written by an older binary or bundle) belongs to
 *     whoever drains it first, as it always has, and is stamped with that
 *     account at its first send so it is never sent under a second one. This
 *     code never writes one (session-scope.ts outboxWriteScope);
 *   - a row with no organization of its own (a legacy row, or one queued
 *     before any workspace was saved) is sent under the live account's OWN
 *     saved workspace (session-scope.ts liveOutboxScope), and HELD, as
 *     pending, while there is none: nothing saved, another account's, or an
 *     older build's with no owner (docket B10, integrator decision 3). It
 *     used to be sent with that null, so api() sent no X-Organization-Id and
 *     the server applied it in the account's default organization. The
 *     workspace load saves the account's own workspace and asks both drains
 *     for a pass (use-workspace.ts), so the hold ends as soon as it is saved;
 *   - with no session at all, nothing is sent.
 *
 * The SQL fragments below are the same rule for queries. `IS` / `IS NOT` are
 * SQLite's null-safe comparisons, so OWNED and HELD are exact complements for
 * every row and every live user, the signed-out case (live user NULL)
 * included. outbox-scope.test.ts runs both against a real SQLite.
 */

/** Who a queued row belongs to, as stored. NULL = queued by an older binary. */
export interface OutboxRowOwner {
  organizationId?: string | null;
  userId?: string | null;
}

/** The workspace and account live on the device right now. */
export interface LiveScope {
  orgId: string | null;
  userId: string | null;
}

export type OutboxSendDecision =
  | {
      send: true;
      /**
       * The organization to send under: the row's own, else the live
       * account's own saved one. Never empty: every queued send names its
       * workspace (api() sends X-Organization-Id for it).
       */
      orgId: string;
      /** The account that must hold the bearer token when the request leaves. */
      userId: string;
      /** The row is missing an owner column and is stamped at this send. */
      adopt: boolean;
    }
  | { send: false; reason: 'signed-out' | 'other-account' | 'workspace-loading' };

/** Is this row the live user's work (or legacy work anyone may adopt)? */
export function isOwnedBy(row: OutboxRowOwner, liveUserId: string | null): boolean {
  const owner = row.userId ?? null;
  return owner === null || owner === liveUserId;
}

export function outboxSendDecision(row: OutboxRowOwner, live: LiveScope): OutboxSendDecision {
  if (!live.userId) return { send: false, reason: 'signed-out' };
  if (!isOwnedBy(row, live.userId)) return { send: false, reason: 'other-account' };
  // An empty id is no workspace: api() names the workspace only for a
  // non-empty orgId, and would otherwise fall back to the saved one.
  const rowOrg = row.organizationId || null;
  const orgId = rowOrg ?? live.orgId;
  // No workspace of its own, and the live account's own is not saved yet:
  // HELD (left as it is, pending), never sent without a workspace.
  if (!orgId) return { send: false, reason: 'workspace-loading' };
  return {
    send: true,
    orgId,
    userId: live.userId,
    adopt: (row.userId ?? null) === null || rowOrg === null,
  };
}

/**
 * Rows the live user owns (their own and legacy ones). Bind the live user id,
 * or NULL when signed out (then only legacy rows match).
 */
export const OWNED_BY_USER_SQL = '(user_id is null or user_id is ?)';

/** Rows held for ANOTHER account: the exact complement of OWNED_BY_USER_SQL. */
export const HELD_FOR_OTHER_SQL = '(user_id is not null and user_id is not ?)';

/**
 * Thrown by api() when a request carrying `asUserId` finds the live session
 * belongs to somebody else (or to nobody) at the moment the bearer is read.
 * The drains treat it as "held", never as a failure: nothing was sent.
 */
export class OutboxSessionChangedError extends Error {
  constructor() {
    super('The signed-in account changed before this queued change was sent.');
    this.name = 'OutboxSessionChangedError';
  }
}

/**
 * Thrown by enqueue() and updateLocalLine() when no account can be named as
 * the owner of the row (nobody is signed in and nobody has been this run).
 * Refusing is the safe answer: a row queued with no owner is a legacy row,
 * and the next account to sign in would adopt it and send it as its own.
 */
export class OutboxOwnerUnknownError extends Error {
  constructor() {
    super('No signed-in account to queue this change for. Sign in and try again.');
    this.name = 'OutboxOwnerUnknownError';
  }
}

/**
 * Thrown by enqueue() and updateLocalLine() while the saved workspace is not
 * one the row's account saved itself (docket B10): ANOTHER account's (the
 * moment after a different account signs in, before its workspace load saves
 * its own choice, or longer when that load fails offline), or an older
 * build's with no owner (until this build's first workspace load records it:
 * integrator decision 3). The row's workspace cannot be named then. Queued
 * with none, it would be sent under whichever workspace this account saves
 * next, after a switch the wrong one (S4a); queued with the other account's,
 * the server refuses it and the change is lost, or it lands in a workspace
 * this account did not choose. Nothing is written. Retryable: the same save
 * works once this account's workspace has loaded.
 */
export class OutboxWorkspaceLoadingError extends Error {
  constructor() {
    super('Your workspace is still loading. Try again in a moment.');
    this.name = 'OutboxWorkspaceLoadingError';
  }
}

/**
 * The sentence a screen shows for a change the outbox refused to queue
 * (OutboxOwnerUnknownError, OutboxWorkspaceLoadingError), or null for any
 * other failure, whose own text is not written for people. Either way nothing
 * was saved.
 */
export function outboxRefusalSentence(e: unknown): string | null {
  return e instanceof OutboxOwnerUnknownError || e instanceof OutboxWorkspaceLoadingError
    ? e.message
    : null;
}

/**
 * last_error for another account's queued count of a line that a later count
 * on this device replaced. Newest-wins per line holds across accounts: sending
 * the older count when its owner returns would overwrite the newer one on the
 * server. The row is kept (rejected, visible to its owner), never sent.
 */
export const REPLACED_BY_LATER_COUNT =
  'Replaced by a later count of this line made on this device by another account. It was not sent.';
