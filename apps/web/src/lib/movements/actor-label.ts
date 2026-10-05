import { DELETED_USER_LABEL } from '@stockpilot/core';

/**
 * Who made a stock movement, in words: the Movements page (table and instant
 * mode), the dashboard's recent-activity widget and the AI tools share this so
 * the three never name the same row differently.
 *
 *  - the actor's full name, else email (their profile is readable);
 *  - "Unknown" when the row names a user whose profile the reader cannot see;
 *  - "Deleted user" when the row names nobody and its deleted_users marker
 *    records that the actor deleted their account (migration 0394;
 *    `actorDeleted`, computed by the service from the raw row);
 *  - "System" when the row names nobody and is not stamped: a movement written
 *    without a signed-in user, or a row from before 0394.
 *
 * Pure (no server-only import): the widget may render on either side.
 */
export interface MovementActorFields {
  user_id: string | null;
  actor: { fullName?: string | null; email?: string | null } | null;
  actorDeleted?: boolean;
}

export function movementActorLabel(m: MovementActorFields): string {
  return (
    m.actor?.fullName ??
    m.actor?.email ??
    (m.user_id ? 'Unknown' : m.actorDeleted ? DELETED_USER_LABEL : 'System')
  );
}
