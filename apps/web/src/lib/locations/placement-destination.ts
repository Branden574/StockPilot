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
  bookCrateFingerprint,
  bookRackFingerprint,
  can,
  formatCrateColorLabel,
  formatRackLabel,
  formatRackPosition,
  getCrateColor,
  hasRackPosition,
  normalizeRackFields,
  planNewLocation,
  type BookStorageInfo,
  type NewLocationFields,
  type NewLocationPlan,
  type Permission,
  type RackPosition,
  type Role,
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

// ═══════════════════════════════════════════════════════════════════════════
// THE FOUR FIELDS ARE THE DESTINATION — put-away for BOOKS after Maus I
//
// THE DEFECT (L4L, 2026-08-17). The book dialogs offered a flat list of
// EXISTING location rows plus a "+ New rack / crate" sentinel that hid the
// crate fields two clicks deep on a "kind" toggle. Most crates in this
// warehouse are label-only — 113 of 124 books record a crate, the org has ONE
// crate row — so "Red 4 on rack 38-B", the crate the dialog had just told the
// operator the book was in, was NOT in the list. The reachable choices were the
// bare rack (which clears the crate; the gate then asked, and the operator had
// nowhere else to go but "Continue") or re-typing the crate from scratch on the
// hidden branch. Two labels were erased that evening.
//
// THE RULE. For a book the four fields — rack number, row, crate colour, crate
// number — ARE the "To" input, always visible, PRE-FILLED from the book's
// recorded storage, and the primary action places INTO exactly that crate on
// that rack (the server resolves-or-creates the row by name, migration 0270's
// dedupe key, which embeds the position). The existing-location dropdown stays
// as a shortcut that FILLS the four fields. Rack-only placement is still one
// blank away, and that is precisely the case that changes the crate pair, so
// that is when the gate asks — and only then.
//
// These helpers are the pure half of that rule, shared by all three web dialogs
// (staging put-away, bulk put-away, transfer) so no surface can hold its own
// opinion of "what do these four boxes mean". The phone has its own copy of the
// same decisions in apps/mobile/src/lib/move-stock-form.ts.
// ═══════════════════════════════════════════════════════════════════════════

/** The four boxes, as typed. Empty string means "blank". */
export interface DestinationFields {
  rackNumber: string;
  rackRow: string;
  /** A CRATE_COLORS slug or ''. The Select cannot hold anything else. */
  crateColor: string;
  crateNumber: string;
}

export const EMPTY_DESTINATION_FIELDS: DestinationFields = {
  rackNumber: '',
  rackRow: '',
  crateColor: '',
  crateNumber: '',
};

/**
 * PRE-FILL from the book's recorded storage — the default destination is
 * "where this book already lives".
 *
 * `unknownCrateColor` carries a recorded colour that is NOT one of
 * CRATE_COLORS (production has never stored one, but the column is free text
 * and the Select cannot render an unknown value): the box is left blank and the
 * dialog shows the raw text beside it so the operator can pick the nearest one
 * or leave it blank knowingly. Blank means the pair CHANGES (colour cleared),
 * so the gate will ask — honest, not silent.
 *
 * A null/undefined storage (a non-book, or a book with nothing recorded) seeds
 * nothing.
 */
export function seedDestinationFields(storage: BookStorageInfo | null | undefined): {
  fields: DestinationFields;
  unknownCrateColor: string | null;
} {
  if (!storage) return { fields: { ...EMPTY_DESTINATION_FIELDS }, unknownCrateColor: null };
  const rawColor = storage.crateColor?.trim() || '';
  const known = getCrateColor(rawColor);
  return {
    fields: {
      rackNumber: storage.rackNumber?.trim() ?? '',
      rackRow: storage.rackRow?.trim() ?? '',
      crateColor: known?.slug ?? '',
      crateNumber: storage.crateNumber?.trim() ?? '',
    },
    unknownCrateColor: rawColor && !known ? rawColor : null,
  };
}

/**
 * FILL from an existing location the operator picked in the dropdown — all
 * four boxes, from the row's own columns. A rack row fills the rack pair and
 * BLANKS the crate (picking a bare rack IS choosing "no crate", and the gate
 * will say so); a positioned crate fills all four; a legacy crate row with no
 * columns blanks everything (see `destinationFromFields` for how it is still
 * placeable by id).
 */
export function fieldsFromOption(option: DestinationOption): DestinationFields {
  const known = getCrateColor(option.crateColor);
  return {
    rackNumber: option.rackNumber?.trim() ?? '',
    rackRow: option.rackRow?.trim() ?? '',
    crateColor: known?.slug ?? '',
    crateNumber: option.crateNumber?.trim() ?? '',
  };
}

/**
 * Do the four boxes still say what this option's columns say? Compared with
 * the same fingerprints the gate uses (crate pair, rack pair), so "blue"/"4"
 * matches a row storing "Blue"/" 4 " and a rack typed "22-b" matches "22"/"B".
 *
 * True for a legacy crate row (no columns) against blank boxes: nothing has
 * been typed over it, so the row is still what the operator picked.
 */
export function destinationMatchesOption(
  fields: DestinationFields,
  option: DestinationOption,
): boolean {
  return (
    bookCrateFingerprint(fields.crateColor, fields.crateNumber) ===
      bookCrateFingerprint(option.crateColor, option.crateNumber) &&
    bookRackFingerprint(fields.rackNumber, fields.rackRow) ===
      bookRackFingerprint(option.rackNumber, option.rackRow)
  );
}

/**
 * THE DESTINATION THE FOUR BOXES DESCRIBE.
 *
 *   • An option is selected AND the boxes still equal its columns
 *     → `existing` by id (the server re-reads the row; nothing is created).
 *   • Any crate box carries text → `new-crate` on the typed position (the
 *     planner decides kind and name; the server resolves-or-creates by name).
 *   • Only rack boxes carry text → `new-rack`.
 *   • Nothing → null (nothing to submit).
 *
 * "new-" here means "described by fields", not "will be minted": the server's
 * findRackOrCrate reuses an existing "Red #4 on rack 38-B" or "38-B" by name
 * and mints only when no such row exists. That is why the four fields can be
 * the primary input without a "+ New" branch: the same fields name an existing
 * row and a not-yet-existing one alike.
 */
export function destinationFromFields(
  fields: DestinationFields,
  selected: DestinationOption | null,
): ChosenDestination | null {
  if (selected && destinationMatchesOption(fields, selected)) {
    return { mode: 'existing', option: selected };
  }
  const hasCrate = fields.crateColor.trim().length > 0 || fields.crateNumber.trim().length > 0;
  if (hasCrate) {
    return {
      mode: 'new-crate',
      crateColor: fields.crateColor,
      crateNumber: fields.crateNumber,
      rackNumber: fields.rackNumber,
      rackRow: fields.rackRow,
    };
  }
  const hasRack = fields.rackNumber.trim().length > 0 || fields.rackRow.trim().length > 0;
  if (hasRack) return { mode: 'new-rack', rackNumber: fields.rackNumber, rackRow: fields.rackRow };
  return null;
}

/**
 * IS THIS DESTINATION EXACTLY WHERE THE BOOK IS RECORDED? — same crate pair and
 * same rack position, by fingerprint.
 *
 * Used to SUPPRESS the "Create new crate Red #4 on rack 38-B?" typo guard on
 * the default path: for a label-only crate no row exists yet, so the guard would
 * fire on every put-away of every crated book in this warehouse — for a
 * destination the operator did not type but the record supplied. That is not a
 * typo to guard against; it is the recorded truth being minted as a row for the
 * first time. Any OTHER not-yet-existing label (typed, or filled from a
 * different option) keeps the guard and its near-match suggestions.
 *
 * A book with nothing recorded matches nothing (a blank record is not a place).
 */
export function destinationIsRecordedStorage(
  dest: ChosenDestination,
  storage: BookStorageInfo | null | undefined,
): boolean {
  if (!storage) return false;
  const recordedCrate = bookCrateFingerprint(storage.crateColor, storage.crateNumber);
  const recordedRack = bookRackFingerprint(storage.rackNumber, storage.rackRow);
  const nothingRecorded =
    recordedCrate === bookCrateFingerprint(null, null) &&
    recordedRack === bookRackFingerprint(null, null);
  if (nothingRecorded) return false;
  const crate = destinationCrate(dest);
  const position = destinationPosition(dest);
  return (
    bookCrateFingerprint(crate.color, crate.number) === recordedCrate &&
    bookRackFingerprint(position?.rackNumber, position?.rackRow) === recordedRack
  );
}

/**
 * THE ONE STORAGE A BATCH SHARES — or null.
 *
 * The bulk put-away sends N books to ONE destination, so "pre-fill from the
 * recorded storage" only means something when every selected book records the
 * same crate pair AND the same rack position (a case that is common: a
 * receiving batch of one title, or a shelf of one crate re-staged together).
 * A batch whose books disagree, or any book with nothing recorded, seeds
 * nothing — the operator names the destination, and the gate asks per book.
 *
 * Compared by the gate's own fingerprints so spelling and case never split a
 * batch that is physically one crate. Returns the FIRST storage (any of them
 * would do — they fingerprint the same).
 */
export function sharedRecordedStorage(
  storages: ReadonlyArray<BookStorageInfo | null | undefined>,
): BookStorageInfo | null {
  if (storages.length === 0) return null;
  const first = storages[0];
  if (!first) return null;
  const crate = bookCrateFingerprint(first.crateColor, first.crateNumber);
  const rack = bookRackFingerprint(first.rackNumber, first.rackRow);
  const nothing =
    crate === bookCrateFingerprint(null, null) && rack === bookRackFingerprint(null, null);
  if (nothing) return null;
  for (const s of storages) {
    if (!s) return null;
    if (bookCrateFingerprint(s.crateColor, s.crateNumber) !== crate) return null;
    if (bookRackFingerprint(s.rackNumber, s.rackRow) !== rack) return null;
  }
  return first;
}

/** True when the four boxes name a rack position but no crate — the one choice
 *  that CLEARS a recorded crate, and therefore the one the gate asks about. */
export function fieldsAreRackOnly(fields: DestinationFields): boolean {
  return (
    fields.crateColor.trim().length === 0 &&
    fields.crateNumber.trim().length === 0 &&
    hasRackPosition({ rackNumber: fields.rackNumber, rackRow: fields.rackRow })
  );
}

/**
 * ═══ MAY THIS USER MINT THE RACK OR CRATE A PUT-AWAY PLACES INTO? ═══
 *
 * The client's copy of the server's placement gate — the ONE derivation the
 * staging page and the item detail hand the three dialogs as
 * `canMintDestination`, so a dialog offers the default path to exactly the
 * users the server will let through, and never to one it will refuse.
 *
 * Owner decision D1 (2026-08-17): putting stock into the crate a book's own
 * label names — the dialogs' DEFAULT destination, seeded from the recorded
 * storage — is a STOCK operation, not location administration. For 113 of
 * L4L's 124 books that crate exists ONLY as the label, so the put-away must
 * mint the row, and the server does that under `stock:transfer` (or
 * `locations:manage`) through the SECURITY DEFINER `mint_placement_location`
 * (migration 0340), invoked ONLY from the placement path
 * (`LocationsService.findOrCreatePlacementDestination`, called by the three
 * put-away/transfer actions and the mobile transfer route). Before this the
 * mint asserted `locations:manage`; the Staff preset holds `stock:transfer`
 * only, so staff saw "needs the Manage locations permission" on every crated
 * book and could only place onto the bare rack — the crate-erasing path.
 *
 * So the answer is: manager-or-above, OR the effective `stock:transfer`, OR
 * the effective `locations:manage` — the same three grants the database
 * function accepts. `can` reads the EFFECTIVE set when the context carries one
 * (overrides applied), else the static role defaults.
 *
 * Cosmetic, like every client gate: the action re-asserts, and the function
 * re-checks membership + permission inside. The phone's copy is
 * apps/mobile/src/lib/move-stock-form.ts `canMintPlacementDestination`.
 */
export function canMintPlacementDestination(ctx: {
  role: Role;
  permissions?: ReadonlySet<Permission>;
}): boolean {
  if (ctx.role === 'owner' || ctx.role === 'admin' || ctx.role === 'manager') return true;
  return can(ctx, 'stock:transfer') || can(ctx, 'locations:manage');
}
