/**
 * Maintenance-email recipients — the branded type and its only constructor.
 *
 * THE MAINTENANCE TWIN of `DeliveryRequestRecipients` in
 * `../orders/delivery-request.ts` (2026-08-16, per-org email routing). Until
 * now the maintenance builder was the one compose path in core that read a
 * recipient CONSTANT directly (`L4L_MAINTENANCE_EMAIL`) instead of taking
 * recipients as input — which meant the per-org seam the delivery feature
 * shipped with did not exist here at all. It does now: the builder reads
 * `input.recipients`, and this module is where a valid value comes from.
 *
 * A SEPARATE BRAND, deliberately, rather than reusing the delivery one. The
 * two features are configured independently per org and may route to
 * different mailboxes; a delivery recipients value passed to the maintenance
 * builder (or vice versa) would silently mail the wrong intake — a real bug
 * the type system can catch, so it does. Both factories share the same
 * runtime guards (`assertRoutableAddress`, `assertSafeDisplayName`), so a
 * value of either branded type carries the same validation guarantee.
 *
 * The brand is a `declare class` private member, not a `unique symbol` key,
 * for the reason measured on the delivery type: an object SPREAD reproduces
 * symbol-keyed properties, so `{ ...value, cc: 'wrong@addr.test' }` would
 * typecheck under a symbol brand. A private class member is the one property
 * TypeScript's spread does not carry over.
 */

import { assertRoutableAddress, normalizeDisplayName } from '../email/outlook-compose';

/**
 * NOMINAL BRAND, and nothing else. Ambient — emits no runtime code, cannot be
 * imported, named or forged by any other module.
 */
declare class MaintenanceRecipientsBrand {
  private readonly __maintenanceRecipientsBrand: true;
}

export interface MaintenanceEmailRecipients extends MaintenanceRecipientsBrand {
  /** The intake mailbox. Exactly one plain address. */
  readonly to: string;
  /**
   * The mandatory copy. Required, and required to be non-empty: the
   * maintenance workflow's acceptance gate is that this address receives a
   * copy, so "no cc" is not an expressible state.
   */
  readonly cc: string;
  /** Cosmetic OWA compose-chip name for `to`. Validated; optional. */
  readonly toName?: string;
  /** Cosmetic OWA compose-chip name for `cc`. Validated; optional. */
  readonly ccName?: string;
}

/**
 * THE ONLY CONSTRUCTOR for `MaintenanceEmailRecipients`.
 *
 * Validates before it brands: both addresses through `assertRoutableAddress`
 * (one plain mailbox or throw), both display names — when present — through
 * `assertSafeDisplayName` (no RFC 5322 specials that could split a name-addr
 * and silently drop the mandatory CC). Frozen so a stray assignment throws in
 * strict mode instead of silently redirecting warehouse mail.
 *
 * This is the seam the per-org routing feature calls with values read from
 * the org row — client-influenced data, which is exactly what the validation
 * exists for. A stored value that fails here fails CLOSED for that org: the
 * email action hides, and nothing ever falls back to another tenant's
 * mailboxes.
 */
export function maintenanceEmailRecipients(input: {
  to: string;
  cc: string;
  toName?: string;
  ccName?: string;
}): MaintenanceEmailRecipients {
  const value: Record<string, string> = {
    to: assertRoutableAddress('to', input.to),
    cc: assertRoutableAddress('cc', input.cc),
  };
  // Empty/whitespace-only names mean ABSENT (bare address), never a chip
  // with an invisible name — see `normalizeDisplayName`, shared with the
  // delivery twin so the two factories cannot drift (pattern #26).
  const toName = normalizeDisplayName(input.toName);
  const ccName = normalizeDisplayName(input.ccName);
  if (toName !== undefined) value.toName = toName;
  if (ccName !== undefined) value.ccName = ccName;
  return Object.freeze(value) as unknown as MaintenanceEmailRecipients;
}
