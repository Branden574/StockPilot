import { DELETED_REQUESTER_LABEL, isDeletedRequester } from '@stockpilot/core';

/**
 * The requester name the pick page and the pick slip print, from
 * OrderRequestsService.get()'s detail: the resolved name (the row's
 * requester_name, else the requester's profile), else "Deleted user" when the
 * requester deleted their account (migration 0388: the ROW has no requester id
 * and no requester email, core `isDeletedRequester`, strict null), else null
 * so the caller keeps its own fallback. The order page, the list, print and
 * the exports already say "Deleted user" (review R9).
 *
 * The packing slips are deliberately not routed here: their name is the
 * SHIP-TO block of an address (the charter for a delivery), where "—" is the
 * right answer when there is no person to ship to.
 */
export function detailRequesterName(detail: {
  request: { requester_user_id?: string | null; requester_email?: string | null };
  requesterName: string | null;
}): string | null {
  if (detail.requesterName) return detail.requesterName;
  return isDeletedRequester({
    requesterUserId: detail.request.requester_user_id,
    requesterEmail: detail.request.requester_email,
  })
    ? DELETED_REQUESTER_LABEL
    : null;
}
