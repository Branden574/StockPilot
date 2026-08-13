/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE ONE RULE for an inline-created placement destination.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Every put-away / transfer surface offers a "+ New" branch that mints a
 * `locations` row and immediately moves stock into it. Four fields feed it —
 * rack number, rack row, crate color, crate number — and until now each surface
 * decided for itself what that combination meant. That produced two live
 * defects, both on surfaces with no confirmation:
 *
 *   REPRO A (mobile). "RACK NUMBER *" = A1, "CRATE NUMBER" = 9 minted a
 *   brand-new "Crate #9" and moved the stock into it, while the operator
 *   believed they were placing onto rack A1 — re-opening the duplicate-location
 *   class migration 0270 and the 2026-07-23 guard exist to prevent. In A' the
 *   phone even ASKED "Create new rack A1?" and then created "Crate #9": the
 *   string confirmed and the string created differed character for character.
 *
 *   REPRO B (web Transfer). Rack "A1" + Row "Row 3" + Crate number "9" produced
 *   name "Crate #9", type 'bin', kind 'crate' — the row silently dropped, and
 *   the put-away stamp then wrote rack_number NULL over the rack the operator
 *   had typed. Before this branch the same input created rack "A1-Row 3".
 *
 * ═══ WHAT THOSE TWO DEFECTS ACTUALLY WERE — AND THE FIX THAT WAS WRONG ═══
 *
 * They were a WRITER mishandling a meaningful input, and the first fix read them
 * as an invalid input and forbade it: rack and crate became mutually exclusive,
 * on every surface and in the schema. That models a rack and a crate as
 * alternatives, and in this warehouse they are not.
 *
 *   A CRATE SITS ON A RACK. Both facts are true at once, and a picker needs
 *   both to find a book: go to rack 38-B, find crate 13 on it. The Books list
 *   has carried separate RACK and CRATE columns all along, showing exactly that.
 *
 * So "rack A1 + crate 9" is not a malformed request. It means A CRATE 9 LOCATED
 * AT RACK A1, and the honest response is to create exactly that and SAY so —
 * not to refuse it, and certainly not to silently keep one half.
 *
 * THE RULE, restated:
 *
 *   • RACK  — needs a number. Row optional. Name: "22-B" / "22" (rack-label.ts,
 *             so a whole label typed into the number box still decomposes).
 *   • CRATE — needs a NUMBER; the colour is an optional visual aid, and the rack
 *             position is an OPTIONAL part of its identity. Name:
 *             "Blue #42" / "Crate #42" position-less, "Blue #42 on rack 22-B"
 *             positioned — the DEDUPE KEY 0270's partial unique index is built
 *             on (see formatCrateLocationName in book-storage.ts for why the
 *             position belongs IN the name). A crate number is FREE TEXT:
 *             production holds 0, 1..16, "Bin", "BIN" and "Blue Shelf".
 *
 * Any crate field present means CRATE (`isCrateDestination`); the rack pair then
 * reads as that crate's POSITION rather than as a rival destination. A crate is
 * still stored with `kind:'crate'` and carries `rack_number` / `rack_row` as its
 * position — the `locations` table has had those columns on every row since
 * migration 0188, so this needs no migration.
 *
 * A colour with no number is NOT a crate identity. It used to fall back to the
 * rack number ("Blue #A1"), which is the both-fields GUESS — a different thing
 * from the both-fields TRUTH above, and still refused with its own message.
 * A rack ROW with no rack number does not name a position either, on a rack or
 * a crate, so it is refused rather than dropped.
 *
 * PURE MODULE — used by the web server actions, the mobile transfer route, both
 * web put-away dialogs, the web Transfer dialog and the native move-stock sheet.
 * One planner, one name, one confirmation noun, everywhere.
 */

import { z } from 'zod';

import { formatCrateLocationName } from './book-storage';
import { isCrateDestination } from './book-crate-placement';
import { formatRackLabel, normalizeRackFields } from './rack-label';

export interface NewLocationFields {
  rackNumber?: string | null;
  rackRow?: string | null;
  crateColor?: string | null;
  crateNumber?: string | null;
}

/**
 * Why a field combination cannot name a destination.
 *
 * `rack_and_crate` USED TO LIVE HERE and is deliberately gone: rack fields
 * alongside crate fields are a positioned crate, not a conflict. Do not
 * reintroduce it — see the header.
 */
export type NewLocationProblem =
  /** A crate with a colour (or nothing) but no number to identify it. */
  | 'crate_needs_number'
  /** Nothing to name a rack POSITION with (empty, or a row with no number). */
  | 'rack_needs_number';

export type NewLocationPlan =
  | {
      kind: 'rack';
      /** 'rack' | 'crate' — the noun every confirmation sentence uses. */
      noun: 'rack';
      /** `locations.name`, and the label the confirmation must show. */
      name: string;
      /** Decomposed for the `locations.rack_number` / `rack_row` columns. */
      rackNumber: string;
      rackRow: string | null;
      crateColor: null;
      crateNumber: null;
    }
  | {
      kind: 'crate';
      noun: 'crate';
      name: string;
      /**
       * The crate's POSITION — the rack it sits on — decomposed for the same
       * two `locations` columns a rack uses. Null when the crate is not on a
       * rack, which is a legitimate permanent shape (production holds one).
       */
      rackNumber: string | null;
      rackRow: string | null;
      crateColor: string | null;
      crateNumber: string;
    }
  | { kind: 'invalid'; problem: NewLocationProblem; message: string; field: 'rackNumber' | 'crateNumber' };

function trimmed(value: string | null | undefined): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** The message a user sees for each refusal. One wording, every surface. */
export const NEW_LOCATION_MESSAGES: Record<NewLocationProblem, string> = {
  crate_needs_number: 'Give the crate a number — a color on its own does not name a crate.',
  rack_needs_number: 'Give the rack a number.',
};

/**
 * Decide what these four fields describe, and what it will be called.
 *
 * Returns an `invalid` plan rather than throwing, so a form can render the
 * message inline and a zod schema can turn the same verdict into an issue —
 * one decision, three renderings.
 */
export function planNewLocation(input: NewLocationFields): NewLocationPlan {
  const rackNumber = trimmed(input.rackNumber);
  const rackRow = trimmed(input.rackRow);
  const crateColor = trimmed(input.crateColor);
  const crateNumber = trimmed(input.crateNumber);

  const hasRack = rackNumber.length > 0 || rackRow.length > 0;
  // ONE predicate for "the user named a crate field", shared with every other
  // reader of that question — a second copy is how the four write paths came to
  // disagree about what a crate is in the first place.
  const hasCrate = isCrateDestination({ crateColor, crateNumber });

  // CRATE WINS THE KIND; the rack pair becomes its POSITION. Checked first so
  // the two are never read as rivals — "rack A1 + crate 9" is crate 9 on rack
  // A1, and the name below says exactly that.
  if (hasCrate) {
    if (!crateNumber) {
      return {
        kind: 'invalid',
        problem: 'crate_needs_number',
        message: NEW_LOCATION_MESSAGES.crate_needs_number,
        field: 'crateNumber',
      };
    }
    // Decompose the POSITION through the same one parser a rack uses, so a
    // whole label typed into the "On rack" box is stored ("38","B") and never
    // composite (incident 2026-07-23 applies to a crate's position too).
    const parts = normalizeRackFields({ number: rackNumber, row: rackRow });
    if (hasRack && !parts.number) {
      // A row with no number is not a position. Refusing beats silently
      // dropping the row the operator typed — that drop is the original bug.
      return {
        kind: 'invalid',
        problem: 'rack_needs_number',
        message: NEW_LOCATION_MESSAGES.rack_needs_number,
        field: 'rackNumber',
      };
    }
    const position = parts.number ? { rackNumber: parts.number, rackRow: parts.row } : null;
    return {
      kind: 'crate',
      noun: 'crate',
      // "Blue #42" / "Blue #42 on rack 22-B" — the 0270 dedupe key, never
      // hand-composed. The position is IN the name on purpose: that is what
      // keeps five physically distinct "gray BIN" bins five locations rows.
      name: formatCrateLocationName(crateColor || null, crateNumber, position),
      rackNumber: position?.rackNumber ?? null,
      rackRow: position?.rackRow ?? null,
      crateColor: crateColor || null,
      crateNumber,
    };
  }

  // Rack. Decompose through the ONE parser so "22-B" typed into the number box
  // is stored as ("22","B") and named "22-B" (incident 2026-07-23).
  const parts = normalizeRackFields({ number: rackNumber, row: rackRow });
  if (!parts.number) {
    return {
      kind: 'invalid',
      problem: 'rack_needs_number',
      message: NEW_LOCATION_MESSAGES.rack_needs_number,
      field: 'rackNumber',
    };
  }
  return {
    kind: 'rack',
    noun: 'rack',
    name: formatRackLabel(parts),
    rackNumber: parts.number,
    rackRow: parts.row,
    crateColor: null,
    crateNumber: null,
  };
}

/**
 * The `locations.name` these fields will create — '' when they name nothing.
 *
 * THE ONLY way any surface may build that string. A hand-composed `${a}-${b}`
 * or `${color} #${n}` is the 2026-07-23 / 0270 shape and the rack-shape guard
 * fails the build on one.
 */
export function deriveNewLocationName(input: NewLocationFields): string {
  const plan = planNewLocation(input);
  return plan.kind === 'invalid' ? '' : plan.name;
}

/**
 * The four fields as a zod SHAPE (not a finished schema), so every server
 * surface can spread it into its own object — the web action needs
 * `warehouseId`/`parentId` alongside, the mobile route does not — and still
 * share one set of limits.
 *
 * They used to be two hand-maintained copies that had already drifted.
 */
export const newLocationFieldsShape = {
  // NOT required outright: a CRATE is identified by its own number, and
  // demanding a rack number for one is what made a number-only crate
  // unreachable on every surface.
  rackNumber: z.string().max(64).optional(),
  rackRow: z.string().max(64).optional(),
  crateColor: z.string().max(64).optional(),
  // FREE TEXT — production holds 0, 1..16, "Bin", "BIN", "Blue Shelf". Never
  // range-validate (see book-storage.ts).
  crateNumber: z.string().max(64).optional(),
} as const;

/**
 * The refinement that enforces the rule above. Pass to `.superRefine()` on any
 * schema carrying `newLocationFieldsShape`, so every surface refuses the same
 * incomplete inputs — a crate with no number, a rack row with no rack number —
 * with the same words.
 *
 * It no longer refuses rack fields alongside crate fields: that combination is
 * a crate ON a rack, which the planner names in full.
 */
export function refineNewLocation(value: NewLocationFields, ctx: z.RefinementCtx): void {
  const plan = planNewLocation(value);
  if (plan.kind !== 'invalid') return;
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    message: plan.message,
    path: [plan.field],
  });
}
