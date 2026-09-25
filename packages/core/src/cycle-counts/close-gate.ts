import type { Role } from '../constants/roles';
import { isManagerOrAbove } from '../constants/terminology';

/**
 * Who may POST or CANCEL a cycle count (F1-2's Post/Cancel fix).
 *
 * ledger.post_cycle_count refuses anyone below manager (has_org_role), and the
 * cycle_counts UPDATE policy a cancel runs under is manager-only too. The
 * screens used to offer Post to anyone with stock:adjust (web) or to the
 * assignee (phone), so staff tapped Post and got an error (the post answers a
 * staff caller "not found", because its FOR UPDATE runs under that policy).
 *
 * ONE predicate for the web page, the phone screen and the service that
 * refuses them (pattern #26): the role floor the database applies, plus the
 * permissions the service asserts.
 *   - Post: manager or above, and stock:adjust.
 *   - Cancel: manager or above, stock:adjust and cycle_counts:assign.
 */
export function cycleCountCloseGate(input: {
  role: Role;
  /** has stock:adjust (effective permissions). */
  canAdjust: boolean;
  /** has cycle_counts:assign (effective permissions). */
  canAssign: boolean;
}): { canPost: boolean; canCancel: boolean } {
  const manager = isManagerOrAbove(input.role);
  return {
    canPost: manager && input.canAdjust,
    canCancel: manager && input.canAdjust && input.canAssign,
  };
}

/** Shown in place of Post and Cancel to someone who cannot use them. */
export const CYCLE_COUNT_MANAGER_POSTS_COPY = 'A manager reviews and posts this count.';

/** The service's refusal when someone below manager tries to post. */
export const CYCLE_COUNT_POST_MANAGER_ONLY_COPY =
  'Only a manager can post a count. A manager reviews and posts this count.';

/** The service's refusal when someone below manager tries to cancel. */
export const CYCLE_COUNT_CANCEL_MANAGER_ONLY_COPY = 'Only a manager can cancel a count.';
