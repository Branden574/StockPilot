/**
 * What the operator picked in a put-away dialog, and how to talk about it.
 *
 * Both dialogs need the same three answers about a chosen destination —
 * which crate pair it carries, what its label is, and how to name it in a
 * sentence — and both of them previously answered by re-deriving strings
 * inline. This is the one place that reads a `DestinationOption` (an EXISTING
 * location, whose crate columns are server truth) or the inline "+ New" fields
 * (a location that does not exist yet).
 *
 * Pure and client-safe. Nothing here is authority: the server re-reads the
 * destination row before it writes anything.
 */
import {
  formatCrateColorLabel,
  formatRackLabel,
  formatRackPosition,
  normalizeRackFields,
  planNewLocation,
  type NewLocationFields,
  type NewLocationPlan,
  type RackPosition,
} from '@stockpilot/core';

import type { DestinationOption } from './destination-option';

export type ChosenDestination =
  | { mode: 'existing'; option: DestinationOption }
  | { mode: 'new-rack'; rackNumber: string; rackRow: string }
  | {
      mode: 'new-crate';
      crateColor: string;
      crateNumber: string;
      /**
       * The rack this crate SITS ON — optional, and part of the crate's
       * identity when present. Two crates numbered "BIN" on different racks are
       * two physical bins; production has five of them.
       */
      rackNumber: string;
      rackRow: string;
    };

/**
 * The four planner fields a "+ New" choice carries — `null` for a destination
 * that already exists and therefore plans nothing.
 *
 * The CRATE branch hands over its rack pair too: that pair is the crate's
 * POSITION, part of its identity and part of the name migration 0270 dedupes
 * on. Withholding it here is how a positioned crate would come to be planned as
 * a position-less one.
 */
function newDestinationFields(dest: ChosenDestination): NewLocationFields | null {
  switch (dest.mode) {
    case 'existing':
      return null;
    case 'new-rack':
      return { rackNumber: dest.rackNumber, rackRow: dest.rackRow };
    case 'new-crate':
      return {
        crateColor: dest.crateColor,
        crateNumber: dest.crateNumber,
        rackNumber: dest.rackNumber,
        rackRow: dest.rackRow,
      };
  }
}

/**
 * WHAT THESE FIELDS DESCRIBE, decided by the ONE core planner — or `null` for a
 * destination that already exists.
 *
 * Every other question this file answers about a "+ New" choice (its name, and
 * the two below) runs through this, so a dialog cannot end up holding two
 * different opinions of the same four boxes.
 */
export function planNewDestination(dest: ChosenDestination): NewLocationPlan | null {
  const fields = newDestinationFields(dest);
  return fields ? planNewLocation(fields) : null;
}

/**
 * IS THIS DESTINATION COMPLETE ENOUGH TO SUBMIT?
 *
 * ═══ THE READINESS GATE IS THE PLANNER, OR IT DRIFTS FROM IT ═══
 *
 * All three web dialogs used to answer this with a hand-rolled field check —
 * `newKind === 'rack' ? rackNumber : crateNumber` non-empty — and within one
 * commit it disagreed with `planNewLocation` about the very fields that commit
 * added. A crate number plus a "Row" with no "On rack" number satisfied the
 * hand-rolled check and was REFUSED by the planner (`rack_needs_number`: a row
 * alone names no position), so the derived name was '' and the confirmation
 * rendered "Create new crate ? does not exist in Main Warehouse yet." — a
 * sentence naming nothing, in front of a server schema that refuses the same
 * input. The 2026-07-23 rule (the string confirmed IS the string created)
 * failing in its emptiest form.
 *
 * The phone never had that bug, because `newLocationReady` in
 * apps/mobile/src/lib/move-stock-form.ts has always delegated here. This is the
 * web twin, shared by all three dialogs — a fourth hand-rolled copy is how the
 * next divergence ships.
 *
 * An EXISTING destination is complete by definition: it plans nothing, so there
 * is nothing to be incomplete about.
 */
export function newDestinationReady(dest: ChosenDestination): boolean {
  const plan = planNewDestination(dest);
  return plan === null || plan.kind !== 'invalid';
}

/**
 * The planner's own refusal, to show INLINE under a "+ New" form — or `null`
 * when there is nothing to say.
 *
 * Silent on an UNTOUCHED form: with all four boxes empty the planner answers
 * `rack_needs_number`, and shouting "Give the rack a number." at a crate form
 * the operator has not started typing into is noise, not help. The moment any
 * box carries text the refusal is about something real and is shown. Submit is
 * gated by `newDestinationReady` either way, so the quiet period is never a
 * window in which an unnameable destination can be submitted.
 *
 * The WORDS are the planner's (NEW_LOCATION_MESSAGES), never re-typed here, so
 * the inline message, the toast and the server's zod issue are one sentence.
 */
export function newDestinationProblem(dest: ChosenDestination): string | null {
  const plan = planNewDestination(dest);
  if (plan === null || plan.kind !== 'invalid') return null;
  const fields = newDestinationFields(dest) ?? {};
  const typed = Object.values(fields).some((v) => (v ?? '').trim().length > 0);
  return typed ? plan.message : null;
}

/**
 * The crate pair this destination will record on a book — the `next` side of
 * `compareBookCratePlacement`.
 *
 * A RACK answers (null, null) on purpose: a book on a rack is in no crate, and
 * that erasure is exactly what the confirmation gate exists to ask about.
 */
export function destinationCrate(dest: ChosenDestination): {
  color: string | null;
  number: string | null;
} {
  switch (dest.mode) {
    case 'existing':
      return {
        color: dest.option.crateColor?.trim() || null,
        number: dest.option.crateNumber?.trim() || null,
      };
    case 'new-crate':
      return { color: dest.crateColor.trim() || null, number: dest.crateNumber.trim() || null };
    case 'new-rack':
      return { color: null, number: null };
  }
}

/** True when the destination is a crate rather than a rack. */
export function isCrateChoice(dest: ChosenDestination): boolean {
  if (dest.mode === 'existing') return dest.option.kind === 'crate';
  return dest.mode === 'new-crate';
}

/**
 * The rack POSITION this destination records on a book — the `next` side of
 * `describeRackChange`.
 *
 * A RACK answers with its own pair; a CRATE answers with the rack it SITS ON,
 * which may be nothing. Both are the same two `locations` columns, which is
 * exactly why one accessor serves both: a caller that reaches for
 * `option.rackNumber` only when `kind === 'rack'` is how a positioned crate's
 * rack came to be dropped on the floor.
 */
export function destinationPosition(dest: ChosenDestination): RackPosition | null {
  switch (dest.mode) {
    case 'existing':
      return { rackNumber: dest.option.rackNumber, rackRow: dest.option.rackRow };
    case 'new-rack':
      return { rackNumber: dest.rackNumber, rackRow: dest.rackRow };
    case 'new-crate':
      return { rackNumber: dest.rackNumber, rackRow: dest.rackRow };
  }
}

/** That position as a label — '' when the destination sits on no rack. */
export function destinationRackLabel(dest: ChosenDestination): string {
  return formatRackPosition(destinationPosition(dest));
}

/**
 * The destination's LABEL — `locations.name` for one that exists, and the name
 * it would be given for one that does not.
 *
 * The new-location branch goes through `planNewDestination` — the SAME planner
 * call `newDestinationReady` gates submit with, and the same one the server
 * actions name the row with — so the label the confirmation shows is
 * character-for-character the name that will be created (and therefore the one
 * migration 0270's dedupe index will match against). The position is part of
 * that name, which is why `newDestinationFields` hands it over.
 *
 * '' WHEN THE FIELDS NAME NOTHING. That is not a label a caller may render: a
 * confirmation built on it reads "Create new crate ?". `newDestinationReady`
 * is the gate that keeps it from ever reaching one.
 */
export function destinationLabel(dest: ChosenDestination): string {
  if (dest.mode === 'existing') return dest.option.name;
  const plan = planNewDestination(dest);
  return plan === null || plan.kind === 'invalid' ? '' : plan.name;
}

/**
 * How a success message names the destination: "into Blue crate 4 on rack
 * 38-B", "onto rack 38-A". Reads as English in a sentence, unlike the bare
 * label — "Placed 10 copies of The Outsiders into Blue #4" tells a worker
 * nothing about whether that is a rack or a bin.
 *
 * A crate names the rack it sits on, because the crate alone does not locate
 * it: "gray BIN" is five different bins in this warehouse.
 */
export function destinationPhrase(dest: ChosenDestination): string {
  const crate = destinationCrate(dest);
  if (isCrateChoice(dest) || crate.number || crate.color) {
    const color = formatCrateColorLabel(crate.color);
    const rack = destinationRackLabel(dest);
    const where = rack ? ` on rack ${rack}` : '';
    if (crate.number) {
      return color
        ? `into ${color} crate ${crate.number}${where}`
        : `into crate ${crate.number}${where}`;
    }
    // A crate location carrying no columns at all (legacy row): fall back to
    // its own name rather than inventing a number.
    return `into ${destinationLabel(dest)}`;
  }
  const label =
    dest.mode === 'new-rack'
      ? formatRackLabel(normalizeRackFields({ number: dest.rackNumber, row: dest.rackRow }))
      : destinationLabel(dest);
  return `onto rack ${label}`;
}
