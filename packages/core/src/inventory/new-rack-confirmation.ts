/**
 * "Create new rack 1-B?" asked by the SERVER, so no create path can skip it.
 *
 * THE INCIDENT (2026-09-24). An item added from the phone as rack 17-B reached
 * the server as "1-B". A manual create resolves-or-CREATES the rack its opening
 * stock is typed onto, so a new rack 1-B appeared in DC4 and all 130 units
 * moved onto it. The phone has asked first since then (#249). The web item form
 * never did, and the server created whatever rack any caller typed.
 *
 * Now the create request says whether the person confirmed a new rack
 * (`confirmNewRack`). When the typed rack does not exist and the request does
 * not confirm it, the create is refused BEFORE anything is written, with the
 * payload below: the rack the server would create, and the sentence and the
 * near-matches every client shows. The words are describeNewRackPlacement's, so
 * the web dialog and the phone alert say the same thing for the same situation.
 * The client asks, then sends the same request again with `confirmNewRack:
 * true`, or with the near-match the person picked instead.
 *
 * The answer is a safety question, never a permission: creating the rack still
 * needs the permission it always needed. So the question is worded for what
 * THIS person's yes can do (2026-10-25). A Staff member cannot create racks
 * (no Manage locations), and their yes never could: the placement's create
 * was refused, and the stock stayed where it was seeded. For them the question
 * says so, and the yes is "Save anyway" (`canCreateRack: false`).
 */

import { can, type Permission } from '../constants/permissions';
import type { Role } from '../constants/roles';

import { describeNewRackPlacement, type NewRackBlocker } from './rack-near-match';

/** `ServiceError.details.reason` of the refusal. */
export const NEW_RACK_REQUIRES_CONFIRMATION = 'NEW_RACK_REQUIRES_CONFIRMATION' as const;

/** The request field that carries the person's answer. */
export const CONFIRM_NEW_RACK_FIELD = 'confirmNewRack' as const;

export interface NewRackConfirmationDetail {
  reason: typeof NEW_RACK_REQUIRES_CONFIRMATION;
  /** The rack the create would make, named the way the server names it ("1-B"). */
  label: string;
  /** "Create new rack 1-B?" */
  title: string;
  /**
   * "1-B does not exist in DC4 yet. Continuing creates it and moves 130 units
   * into it. Did you mean 17-B?"
   */
  message: string;
  /** Existing racks in that warehouse that could explain a typo, closest first. */
  suggestions: string[];
  /**
   * Whether this person's yes creates the rack and moves the stock onto it.
   * False for a member without Manage locations or Transfer stock (see
   * newRackBlockerFor): the words then say that saving does not put the stock
   * on a rack, and the confirm button is "Save anyway".
   */
  canCreateRack: boolean;
}

/**
 * What stops this member's yes from putting the stock on a NEW rack, or null
 * when nothing does. The item create's placement creates the rack through
 * LocationsService.create, which asserts `locations:manage`, and moves the
 * stock with transferStock, which asserts `stock:transfer`; this reads the
 * same two permissions the same way (`can`: the effective set when the context
 * carries one, else the role's defaults). The server words its question with
 * it, and the phone words its own question with it, so both say the same.
 */
export function newRackBlockerFor(ctx: {
  readonly role: Role;
  readonly permissions?: ReadonlySet<Permission>;
}): NewRackBlocker | null {
  if (!can(ctx, 'locations:manage')) return 'create_rack';
  if (!can(ctx, 'stock:transfer')) return 'move_stock';
  return null;
}

/**
 * The refusal for a rack the caller's own lookup did not find.
 *
 * Returns null when `existingLabels` holds the rack after all. The service
 * decides existence with the auto-place's own lookup and reads the labels for
 * the near-matches in a second query, so a rack another person created between
 * the two reads shows up here. It then exists, there is nothing new to create,
 * and the create goes on without a question.
 */
export function newRackConfirmationDetail(input: {
  label: string;
  warehouseName?: string | null;
  quantity: number;
  existingLabels: readonly string[];
  /** What stops this member's yes (newRackBlockerFor); null or absent: nothing. */
  blockedBy?: NewRackBlocker | null;
}): NewRackConfirmationDetail | null {
  const decision = describeNewRackPlacement({
    label: input.label,
    warehouseName: input.warehouseName,
    quantity: input.quantity,
    existingLabels: input.existingLabels,
    noun: 'rack',
    blockedBy: input.blockedBy ?? null,
  });
  if (decision.exists) return null;
  return {
    reason: NEW_RACK_REQUIRES_CONFIRMATION,
    label: decision.label,
    title: decision.title,
    message: decision.message,
    suggestions: [...decision.suggestions],
    canCreateRack: !input.blockedBy,
  };
}

/**
 * Narrow an error's `details` to the refusal, or null.
 *
 * Server actions type `details` as `Record<string, unknown>` and the phone gets
 * it from JSON, so this checks rather than casts. Anything that is not exactly
 * this payload returns null and the caller shows the plain message: a
 * malformed payload must never open an empty "are you sure?" with nothing in
 * it.
 */
export function parseNewRackConfirmationDetail(details: unknown): NewRackConfirmationDetail | null {
  if (!details || typeof details !== 'object') return null;
  const d = details as Record<string, unknown>;
  if (d.reason !== NEW_RACK_REQUIRES_CONFIRMATION) return null;
  const text = (v: unknown) => (typeof v === 'string' && v.trim().length > 0 ? v : null);
  const label = text(d.label);
  const title = text(d.title);
  const message = text(d.message);
  if (!label || !title || !message) return null;
  const suggestions = Array.isArray(d.suggestions)
    ? d.suggestions.filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
    : [];
  // Only an explicit false says the yes does not create the rack. Read the
  // other way, a payload without the flag would label a yes that DOES create
  // a rack "Save anyway", the one wrong answer this question exists to stop.
  const canCreateRack = d.canCreateRack !== false;
  return {
    reason: NEW_RACK_REQUIRES_CONFIRMATION,
    label,
    title,
    message,
    suggestions,
    canCreateRack,
  };
}

/**
 * Does this request body ANSWER the new-rack question at all?
 *
 * The key's PRESENCE is how a client says it can be asked, the same rule the
 * transfer route applies to `acknowledgedRackChanges`. A phone on the build in
 * the field today sends no such key: it asks "Create new rack?" on its own
 * screen before it sends (apps/mobile/app/item/new.tsx, confirmRackForCreate),
 * and it cannot answer a refusal it has never heard of. So the phone API routes
 * read an absent key as that client and create the rack as before; a body that
 * carries the key gets the server's question.
 */
export function bodyAnswersNewRack(body: unknown): boolean {
  return (
    body !== null &&
    typeof body === 'object' &&
    !Array.isArray(body) &&
    Object.prototype.hasOwnProperty.call(body, CONFIRM_NEW_RACK_FIELD)
  );
}
