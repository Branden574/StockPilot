/**
 * "Deleted user": how every surface names a person whose account was deleted.
 *
 * Migration 0393 (security slice A3) lets every member delete their own
 * account. The business records they appear on stay: the foreign key nulls the
 * person column, and on the tables 0393 marks (receipts, PO imports, approvals,
 * AI scans, putaway moves, size samples, schedule entries, returns, unit
 * conversions, connections, modules, carrier shipments, the platform audit,
 * invites, audit_logs and stock_movements) the row's `deleted_users` jsonb
 * records `{ "<person column>": "<when>" }` in the same write. Only the
 * database writes it (a trigger that stamps a column only when its account no
 * longer exists), so a stamped null column is proof the person deleted their
 * account, never a guess. An unstamped null keeps the surface's own wording
 * ("System", "—", "Unknown"): those are system rows, or rows from before 0393.
 *
 * Orders keep 0388's own marker for the requester (isDeletedRequester in
 * ../orders/requester-identity), which uses this same label.
 */

/** The words for a person whose account was deleted (owner decision O-A2-1). */
export const DELETED_USER_LABEL = 'Deleted user';

/** The existing wording for a person the reader cannot see (they left the organization). */
export const FORMER_MEMBER_LABEL = 'Former member';

/**
 * Whether `column` is stamped in a row's `deleted_users` value: an own key
 * holding a non-empty string (the database writes an ISO timestamp). Anything
 * else (null, an array, a number, an inherited key) is not a stamp.
 */
export function isDeletedUserRef(marks: unknown, column: string): boolean {
  if (marks === null || typeof marks !== 'object' || Array.isArray(marks)) return false;
  if (!Object.prototype.hasOwnProperty.call(marks, column)) return false;
  const value = (marks as Record<string, unknown>)[column];
  return typeof value === 'string' && value.length > 0;
}

/**
 * Whether the person in `column` deleted their account: the column is null and
 * stamped. A column that still names someone is never "deleted", whatever the
 * marks say (the database drops a stamp when the column names a live person).
 */
export function isDeletedPerson(
  id: string | null | undefined,
  marks: unknown,
  column: string,
): boolean {
  return (id === null || id === undefined || id === '') && isDeletedUserRef(marks, column);
}

export interface PersonLabelInput {
  /** The person id on the row; null once the account was deleted. */
  id: string | null | undefined;
  /** The name the reader resolved for that id (full name, else email), if any. */
  name?: string | null;
  /** The row's `deleted_users` value. */
  marks?: unknown;
  /** The person column the label is for. */
  column: string;
  /** The surface's existing text for a null person ("System", "—", "Unknown"). */
  nullLabel: string;
  /** The text for an id whose profile the reader cannot see. */
  hiddenLabel?: string;
}

/**
 * One person's label, in this order:
 *   1. a null column that is stamped: "Deleted user";
 *   2. a null column that is not: the surface's `nullLabel`;
 *   3. an id with a resolved name: the name (trimmed);
 *   4. an id with no readable profile: `hiddenLabel` ("Former member").
 * The raw id is never returned.
 */
export function personLabel(input: PersonLabelInput): string {
  const id = typeof input.id === 'string' && input.id.length > 0 ? input.id : null;
  if (id === null) {
    return isDeletedUserRef(input.marks, input.column) ? DELETED_USER_LABEL : input.nullLabel;
  }
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (name) return name;
  return input.hiddenLabel ?? FORMER_MEMBER_LABEL;
}
