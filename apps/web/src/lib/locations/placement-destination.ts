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
  type RackPosition,
} from '@stockpilot/core';

import { deriveLocationName } from './rack-name';
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
 * The new-location branch goes through `deriveLocationName`, the same helper
 * the server actions use, so the label the confirmation shows is character-for-
 * character the name that will be created (and therefore the one migration
 * 0270's dedupe index will match against).
 */
export function destinationLabel(dest: ChosenDestination): string {
  switch (dest.mode) {
    case 'existing':
      return dest.option.name;
    case 'new-rack':
      return deriveLocationName({ rackNumber: dest.rackNumber, rackRow: dest.rackRow });
    case 'new-crate':
      return deriveLocationName({
        crateColor: dest.crateColor,
        crateNumber: dest.crateNumber,
        // The position is part of the NAME, and therefore part of migration
        // 0270's dedupe key — see formatCrateLocationName. Dropping it here
        // would make the confirmation name one crate and the server create
        // another, which is the 2026-07-23 divergence all over again.
        rackNumber: dest.rackNumber,
        rackRow: dest.rackRow,
      });
  }
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
