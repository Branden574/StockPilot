/**
 * Who asked for an order, resolved ONCE for every surface.
 *
 * An order carries the requester's identity in two places, and which one holds
 * it depends on how the order was placed:
 *
 *  - INTERNAL SELF-SUBMIT (46 of 103 prod rows, 2026-08-13): the denormalized
 *    `order_requests.requester_name` / `requester_email` columns are NULL and
 *    the real values live on the joined `user_profiles` row.
 *  - ON-BEHALF-OF and PUBLIC-LINK: the columns carry free text and there is no
 *    linked profile.
 *
 * So every surface has the same two-source fallback to perform, and until now
 * each wrote its own.
 *
 * THE DEFECT THIS CLOSES (2026-08-13). The two spellings were one character
 * apart and disagreed on the empty string:
 *
 *   web    `(row.requester_email ?? null) || profile?.email?.trim() || null`
 *   mobile `order.requesterEmail ?? order.requesterProfileEmail ?? null`
 *
 * With `??`, an empty-string column is a PRESENT value and wins — so a row with
 * `requester_email = ''` resolved to the profile email on the web and to `''`
 * on the phone, where the draft builder's truthiness check then dropped it
 * entirely. The same order named a reachable contact in one delivery request
 * and no contact at all in the other. `||` is the correct operator here because
 * the question this fallback answers is "is there a usable value", and an empty
 * string is not one.
 *
 * REACHABILITY, stated honestly: 0 of 103 prod rows currently hold an empty or
 * whitespace-only `requester_email` or `requester_name`, and the one writer that
 * accepts an external address validates it with `z.string().trim().email()`. So
 * this is a latent divergence rather than a live incident — but the column is
 * plain nullable text with no CHECK, both surfaces claim to send the same
 * message, and the cost of the two disagreeing is a delivery request DC4 cannot
 * reply to. Unifying is a one-line change; discovering the drift from a
 * warehouse phone call is not.
 */

import { DELETED_USER_LABEL } from '../people/deleted-user';

/**
 * The denormalized column if it holds anything usable, else the joined
 * profile's value, else null.
 *
 * BOTH sides are trimmed, which is a deliberate narrowing of the web ancestor
 * (it trimmed only the profile side). A whitespace-only column value is not a
 * name or an address, and letting it win means the profile value that WOULD
 * have been usable is discarded. Downstream this was already inert — the draft
 * builder runs every value through `toPlainTextLine`, which collapses `'   '`
 * to `''` — so the trim changes nothing about what a body says today; it only
 * stops the asymmetry from being the next thing someone has to reason about.
 *
 * Returns null rather than '' so callers can distinguish "absent" with `??`
 * where they need to, and so nothing downstream has to re-ask the same
 * question with a different operator.
 */
export function resolveRequesterIdentity(
  denormalized: string | null | undefined,
  fromProfile: string | null | undefined,
): string | null {
  const column = typeof denormalized === 'string' ? denormalized.trim() : '';
  if (column) return column;
  const profile = typeof fromProfile === 'string' ? fromProfile.trim() : '';
  return profile || null;
}

/**
 * The requester label for an order whose requester deleted their account.
 * Owner decision O-A2-1 (2026-10-03): plain words, no name. Since 0394 every
 * deleted person reads the same words (people/deleted-user).
 */
export const DELETED_REQUESTER_LABEL = DELETED_USER_LABEL;

/**
 * Whether an order's requester deleted their account, read from the ROW's own
 * columns (never a resolved or profile-joined value).
 *
 * Migration 0388 lets an account that placed orders be deleted: the
 * user_profiles foreign key nulls `requester_user_id`, and a trigger stamps
 * `requester_deleted_at` in its place. `order_requests_identity_chk` then
 * holds, for every row:
 *   - internal: a requester id, an email or the stamp;
 *   - public link: an email;
 *   - portal: a requester id or the stamp.
 * So a row with NO requester id and NO requester email is exactly a row whose
 * requester was deleted (and that row held no email of its own). The app infers
 * it from those two columns rather than reading the new column, so every
 * deployed web build and every installed phone bundle reads the same rows the
 * same way whatever order the migration and the deploys land in.
 *
 * STRICT null on both: an empty-string email is a present (if useless) value
 * the CHECK accepts, so it is not proof the requester was deleted. Rows that
 * already held the deleted person's email or name keep showing it; nothing
 * about the person is copied onto any order when the account goes.
 */
export function isDeletedRequester(row: {
  requesterUserId: string | null | undefined;
  requesterEmail: string | null | undefined;
}): boolean {
  return row.requesterUserId === null && row.requesterEmail === null;
}
