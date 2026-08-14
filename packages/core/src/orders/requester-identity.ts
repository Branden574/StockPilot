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
