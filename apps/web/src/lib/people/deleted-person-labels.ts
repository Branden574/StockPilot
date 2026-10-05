import { DELETED_USER_LABEL, isDeletedPerson } from '@stockpilot/core';

/**
 * The page-level person labels that changed with migration 0393 (every member
 * can delete their account; their rows keep a deleted_users stamp). Pure, so
 * each surface's wording is unit-tested here rather than through a server
 * component render. The rule everywhere: a stamped null column reads
 * "Deleted user"; an unstamped null keeps the surface's existing words.
 */

/** The audit log's Actor cell (/dashboard/audit). */
export function auditActorName(row: {
  actor: { fullName: string | null; email: string | null } | null;
  actorDeleted: boolean;
}): string {
  return (
    row.actor?.fullName ??
    row.actor?.email ??
    (row.actor ? 'Unknown' : row.actorDeleted ? DELETED_USER_LABEL : 'System')
  );
}

/**
 * An order timeline entry's actor: the member's name, else email; "Unknown
 * user" for a member the reader cannot see; "Public" for a public-link step
 * (no user); "Deleted user" when the row names no user and is stamped.
 */
export function orderTimelineActor(
  profile: { full_name: string | null; email: string | null } | null,
  row: { user_id: string | null; deleted_users?: unknown },
): string {
  return (
    profile?.full_name ??
    profile?.email ??
    (row.user_id
      ? 'Unknown user'
      : isDeletedPerson(row.user_id, row.deleted_users, 'user_id')
        ? DELETED_USER_LABEL
        : 'Public')
  );
}

/**
 * A return's Requester row: the name the return recorded (a public request
 * snapshots the order's name), else "Deleted user" when the member who asked
 * deleted their account, else nothing (the row is hidden).
 */
export function returnRequesterLabel(row: {
  requester_name: string | null;
  requested_by: string | null;
  deleted_users?: unknown;
}): string | null {
  return (
    row.requester_name ??
    (isDeletedPerson(row.requested_by, row.deleted_users, 'requested_by')
      ? DELETED_USER_LABEL
      : null)
  );
}

/** The platform audit's Actor cell: the recorded email, prefixed when the admin deleted their account. */
export function platformAuditActorLabel(row: {
  actorEmail: string;
  actorDeleted: boolean;
}): string {
  return row.actorDeleted ? `${DELETED_USER_LABEL} · ${row.actorEmail}` : row.actorEmail;
}

/** The platform audit's Target cell: email, else the uuid, else "Deleted user" or "—". */
export function platformAuditTargetLabel(row: {
  targetUserEmail: string | null;
  targetUserId: string | null;
  targetDeleted: boolean;
}): string {
  return row.targetUserEmail ?? row.targetUserId ?? (row.targetDeleted ? DELETED_USER_LABEL : '—');
}
