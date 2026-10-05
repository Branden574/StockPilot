/**
 * "Deleted user" on the phone (migration 0394, security slice A3): every
 * member can delete their own account, and the records they made stay. On the
 * tables 0394 marks (stock movements, the audit log, receipts, PO imports and
 * the other refusing-key tables) the person column is nulled and the row's
 * `deleted_users` jsonb records `{ "<column>": "<when>" }` in the same write.
 * Only the database writes it, so a stamped null column is proof the person
 * deleted their account. An unstamped null keeps the screen's own words
 * ("system", "Unknown"): system rows, or rows from before 0394.
 *
 * The rule and the words come from @stockpilot/core (people/deleted-user), the
 * same helpers the web uses, so no platform names the same row differently.
 *
 * DEPLOY ORDER: the screens select `deleted_users`, a column that exists only
 * once 0394 is pushed; this ships in an OTA after the push (plan 9.4).
 *
 * Pure: no React, no supabase import.
 */

import { DELETED_USER_LABEL, isDeletedPerson } from '@stockpilot/core';

/** A row as PostgREST returns it: the person column and the marker ride along. */
type RawRow = Record<string, unknown>;

/**
 * Whether the person in `column` deleted their account: the column is null
 * and the row's deleted_users stamps it. A row from an old select without the
 * marker is never "deleted".
 */
export function isRowPersonDeleted(row: RawRow, column: string = 'user_id'): boolean {
  const id = row[column];
  return isDeletedPerson(typeof id === 'string' ? id : null, row.deleted_users, column);
}

/**
 * Who did it, for a movement or audit card: the actor's full name, else email;
 * "Deleted user" when the row names nobody because the actor deleted their
 * account; otherwise the phone's existing "system".
 */
export function actorText(
  actor: { full_name: string | null; email: string | null } | null | undefined,
  actorDeleted: boolean | undefined,
): string {
  return actor?.full_name ?? actor?.email ?? (actorDeleted ? DELETED_USER_LABEL : 'system');
}

/**
 * A receipt's "received by": the receiver's name (from the screen's profile
 * read); "Deleted user" when the receiver deleted their account (null and
 * stamped); otherwise the existing "Unknown" (a profile the reader cannot see).
 */
export function receiverText(
  nameById: ReadonlyMap<string, string>,
  row: RawRow,
): string {
  const receivedBy = typeof row.received_by === 'string' ? row.received_by : null;
  if (receivedBy) return nameById.get(receivedBy) ?? 'Unknown';
  return isRowPersonDeleted(row, 'received_by') ? DELETED_USER_LABEL : 'Unknown';
}

/**
 * The signature pad's default signer email: the address the order kept, so the
 * requester who usually signs need not type it. Never the address of a
 * requester who deleted their account (0388 requester_deleted_at): the signer
 * receipt goes to whatever is submitted, and a deleted requester is never
 * emailed again (A3). The server refuses that receipt too, for old bundles.
 * requester_deleted_at exists since 0388, so this needs no 0394 deploy order.
 */
export function signerEmailDefault(order: {
  requesterEmail: string | null;
  requesterDeletedAt: string | null;
}): string {
  if (order.requesterDeletedAt) return '';
  return order.requesterEmail ?? '';
}

/**
 * The Settings "Delete your account?" text (A3 plan 9.5). Ownership moves on
 * the web Team page only (O-A3-8), so the last-owner line points there.
 */
export const DELETE_ACCOUNT_CONFIRM_COPY =
  'This permanently deletes your account, your profile photo, sign-in devices and notifications, and your access to every StockPilot organization. Your organization keeps what you recorded, shown as “Deleted user”, and work assigned to you becomes unassigned.\n\nIf you are the only owner of an organization with other members, make another member the owner on the web first.\n\nThis cannot be undone.';
