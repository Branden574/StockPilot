/**
 * Per-org compose-email routing — the ONE parser for `organizations.email_routing`.
 *
 * The column (migration 0337) is a jsonb object keyed by feature:
 *
 *   {
 *     "delivery_request":    { "to": "...", "cc": "...", "toName": "...", "ccName": "..." },
 *     "maintenance_request": { "to": "...", "cc": "...", "toName": "...", "ccName": "..." }
 *   }
 *
 * Every key is optional; NULL / absent key means that feature's email action
 * is HIDDEN for the org. The DB CHECK is a SHAPE floor only — address
 * validity is enforced HERE, by running the stored value through the same
 * branded recipient factory the compose builders require
 * (`deliveryRequestRecipients` / `maintenanceEmailRecipients`), never by a
 * parallel re-implementation that could drift from the real gate.
 *
 * THE STORED VALUE IS CLIENT-INFLUENCED DATA. An org admin can write any
 * value straight through PostgREST (`organizations_update` is not
 * column-scoped), which is exactly why every reader runs it through this
 * parser and why an invalid value fails CLOSED for that org — surfaces
 * behave as if unconfigured, admins see the guard's reason — and NEVER falls
 * back to the compiled constants. A fallback there would silently mail
 * another tenant's warehouse, the exact multi-tenant leak this feature
 * exists to end.
 *
 * ONE parser, both surfaces (recurring pattern #26): web server code and the
 * Expo app both resolve routing through this function; neither re-implements
 * the shape or the validity rules.
 *
 * Where the COMPILED constants still apply — the code-before-migration
 * deploy window (column missing, Postgres 42703) — is a READ-path concern,
 * not a parse concern: see `deliveryRecipientsForRouting` /
 * `maintenanceRecipientsForRouting`, which map that read state to the
 * compiled values so deploying code before the migration cannot outage
 * anything.
 */

import { deliveryRequestRecipients, type DeliveryRequestRecipients } from '../orders/delivery-request';
import { maintenanceEmailRecipients, type MaintenanceEmailRecipients } from '../maintenance/recipients';

export const ORG_EMAIL_ROUTING_FEATURES = ['delivery_request', 'maintenance_request'] as const;
export type OrgEmailRoutingFeature = (typeof ORG_EMAIL_ROUTING_FEATURES)[number];

/**
 * Recipients as PLAIN, serializable strings — the shape that crosses the
 * server -> client (RSC / REST) boundary. A brand cannot survive
 * serialization, so each consumer re-runs its feature's factory on this DTO
 * at its own seam to obtain the branded value; an invalid value therefore
 * throws AT THE SEAM (the render decision), never at compose time.
 */
export interface OrgEmailRoutingRecipientsDto {
  to: string;
  cc: string;
  toName?: string;
  ccName?: string;
}

export type OrgEmailRoutingState =
  /** Column NULL or the feature key absent — the email action is hidden. */
  | { state: 'unset' }
  /** Factory-validated recipients, as plain strings (see the DTO's doc). */
  | { state: 'valid'; recipients: OrgEmailRoutingRecipientsDto }
  /**
   * Present but rejected — wrong shape, malformed address, unsafe display
   * name. FAIL CLOSED for this org: members see the unconfigured behavior,
   * admins see `reason` (the guard's message, verbatim). Never fall back to
   * the compiled constants.
   */
  | { state: 'invalid'; reason: string };

/**
 * The read-path superset: 'fallback' means the COLUMN DOES NOT EXIST yet
 * (Postgres 42703 — code deployed before migration 0337).
 *
 * DEPLOY-ORDER SAFETY: the fallback state exists solely so code-before-
 * migration cannot outage anything — readers map it to the compiled
 * constants, byte-identical to the pre-feature behavior. Once the column
 * exists it is never produced: an org without a stored value is 'unset'
 * (action hidden), not 'fallback'.
 */
export type OrgEmailRoutingReadState = OrgEmailRoutingState | { state: 'fallback' };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Read an optional display-name field strictly: absent/null -> undefined,
 *  a non-string -> a parse error (fail closed, never coerce). */
function optionalName(
  entry: Record<string, unknown>,
  key: 'toName' | 'ccName',
): { ok: true; value: string | undefined } | { ok: false } {
  const v = entry[key];
  if (v === undefined || v === null) return { ok: true, value: undefined };
  if (typeof v !== 'string') return { ok: false };
  return { ok: true, value: v };
}

/**
 * Parse ONE feature's routing out of the raw `email_routing` jsonb value.
 *
 * `raw` is the whole column value as the client returned it (unknown on
 * purpose — this is the trust boundary). Validation IS the branded factory,
 * run inside try/catch: `delivery_request` values go through
 * `deliveryRequestRecipients`, `maintenance_request` values through
 * `maintenanceEmailRecipients`. The returned DTO carries the exact strings
 * the factory accepted.
 */
export function parseOrgEmailRouting(
  raw: unknown,
  feature: OrgEmailRoutingFeature,
): OrgEmailRoutingState {
  if (raw === null || raw === undefined) return { state: 'unset' };
  if (!isPlainObject(raw)) {
    return { state: 'invalid', reason: 'email_routing must be a JSON object keyed by feature.' };
  }
  const entry = raw[feature];
  if (entry === null || entry === undefined) return { state: 'unset' };
  if (!isPlainObject(entry)) {
    return { state: 'invalid', reason: `email_routing.${feature} must be a JSON object.` };
  }
  const { to, cc } = entry;
  if (typeof to !== 'string' || typeof cc !== 'string') {
    return {
      state: 'invalid',
      reason: `email_routing.${feature} must carry string "to" and "cc" addresses.`,
    };
  }
  const toName = optionalName(entry, 'toName');
  const ccName = optionalName(entry, 'ccName');
  if (!toName.ok || !ccName.ok) {
    return {
      state: 'invalid',
      reason: `email_routing.${feature} display names must be strings when present.`,
    };
  }
  try {
    // The factory is the acceptance gate — never a parallel zod shape that
    // could drift from what the compose builders actually enforce.
    const branded =
      feature === 'delivery_request'
        ? deliveryRequestRecipients({ to, cc, toName: toName.value, ccName: ccName.value })
        : maintenanceEmailRecipients({ to, cc, toName: toName.value, ccName: ccName.value });
    const recipients: OrgEmailRoutingRecipientsDto = { to: branded.to, cc: branded.cc };
    if (branded.toName !== undefined) recipients.toName = branded.toName;
    if (branded.ccName !== undefined) recipients.ccName = branded.ccName;
    return { state: 'valid', recipients };
  } catch (e) {
    return {
      state: 'invalid',
      reason: e instanceof Error ? e.message : 'Stored recipients failed validation.',
    };
  }
}

/**
 * Re-brand a routing DTO through the DELIVERY factory. Both mapping helpers
 * below need this and each surface's client seam does too, so it is exported
 * rather than re-spelled at call sites. Throws exactly what the factory
 * throws — callers at a render seam catch and hide.
 */
export function brandDeliveryRecipients(
  dto: OrgEmailRoutingRecipientsDto,
): DeliveryRequestRecipients {
  return deliveryRequestRecipients(dto);
}

/** The maintenance twin of `brandDeliveryRecipients`. */
export function brandMaintenanceRecipients(
  dto: OrgEmailRoutingRecipientsDto,
): MaintenanceEmailRecipients {
  return maintenanceEmailRecipients(dto);
}
