/**
 * THE single definition of how a rack label decomposes and recomposes.
 *
 * A rack is stored in TWO columns/keys — a number and a row:
 *   locations.rack_number / locations.rack_row
 *   inventory_items.custom_fields.rack_number      / .rack_row       (non-books)
 *   inventory_items.custom_fields.book_rack_number / .book_rack_row  (books)
 * and is SHOWN to humans as one label: "22-B".
 *
 * The 2026-07-23 incident: a rack was created with the WHOLE label parked in
 * the number column — ("22-B", null) instead of ("22","B"). Put-away faithfully
 * stamped that pair onto every item it placed there, the Rack column still
 * printed "22-B" (display just joins), but the Items filter — which splits the
 * selected label and requires number="22" AND row="B" — matched nothing. Eight
 * items went invisible to their own rack filter. The writer and the reader
 * disagreed about the SHAPE of a label and nothing enforced one.
 *
 * So: every writer decomposes through `parseRackLabel` / `normalizeRackFields`,
 * every display composes through `formatRackLabel`, and every reader uses
 * `isCompositeRackNumber` to stay tolerant of a legacy composite row (an
 * import, a restored backup, a writer we missed) instead of going blind again.
 *
 * Splitting is on the LAST dash — "22-B" is 22/B, and a rack legitimately named
 * "E2E-RACK-1" is E2E-RACK/1. Casing is preserved verbatim: this module is pure
 * decomposition, and the read path filters with an exact `eq`, so uppercasing
 * here would silently stop matching any row stored lowercase. Writers that want
 * a canonical uppercase row keep doing that themselves (they already did).
 */

export interface RackLabelParts {
  /** The rack number as stored in the *_rack_number column/key. Never contains a trailing row. */
  number: string;
  /** The row as stored in the *_rack_row column/key, or null for a number-only rack. */
  row: string | null;
}

/** Strip surrounding whitespace and any leading/trailing dashes ("22-" is just 22). */
function tidy(value: string): string {
  return value.trim().replace(/^-+|-+$/g, '').trim();
}

/**
 * Decompose a user-entered / stored label into its number and row.
 *
 *   "22"          -> { number: '22',       row: null }
 *   "22-B"        -> { number: '22',       row: 'B'  }
 *   "E2E-RACK-1"  -> { number: 'E2E-RACK', row: '1'  }
 *   "22-b"        -> { number: '22',       row: 'b'  }  (casing preserved)
 *   ""  / "   "   -> { number: '',         row: null }
 */
export function parseRackLabel(label: string | null | undefined): RackLabelParts {
  const cleaned = tidy(label ?? '');
  if (!cleaned) return { number: '', row: null };

  const idx = cleaned.lastIndexOf('-');
  // tidy() already removed edge dashes, so a surviving dash always has content
  // on both sides — but re-check rather than trust it, since an interior run
  // like "22--B" would leave an empty left/right half.
  if (idx <= 0 || idx >= cleaned.length - 1) return { number: cleaned, row: null };

  // tidy() each half too, so a doubled dash ("22--B") still yields ("22","B")
  // instead of parking a stray dash in the number column.
  const number = tidy(cleaned.slice(0, idx));
  const row = tidy(cleaned.slice(idx + 1));
  if (!number || !row) return { number: cleaned, row: null };
  return { number, row };
}

/**
 * Recompose the display label. This is the ONLY way a label should be built —
 * "do not change what a user sees a rack called" means every surface joins the
 * same way. Returns '' when there is no number (nothing to show).
 */
export function formatRackLabel(parts: {
  number: string | null | undefined;
  row?: string | null;
}): string {
  const number = (parts.number ?? '').trim();
  if (!number) return '';
  const row = (parts.row ?? '').trim();
  return row ? `${number}-${row}` : number;
}

/**
 * True when a value sitting in a *_rack_number column is actually a WHOLE
 * label ("22-B") rather than a bare number — i.e. the shape that caused the
 * incident. Readers use this to stay tolerant of legacy rows; the writer-guard
 * test uses it to fail the build if a writer ever stores one again.
 */
export function isCompositeRackNumber(rackNumber: string | null | undefined): boolean {
  return parseRackLabel(rackNumber).row !== null;
}

/**
 * The writers' entry point: take whatever a caller has (a number field a human
 * may have typed a full label into, plus an optional separate row) and return
 * the DECOMPOSED pair to store.
 *
 * A user typing "22-B" into the rack-number box is not an error — the label is
 * how humans name racks — so it is split, never rejected.
 *
 * When an explicit row IS supplied the number is trusted as already decomposed,
 * because splitting it would wreck a rack legitimately named "E2E-RACK" with
 * row "1". The one exception is double entry — "22-B" typed in the number box
 * AND "B" picked as the row — where the trailing segment is dropped rather than
 * stored as ("22-B","B") and rendered "22-B-B".
 */
export function normalizeRackFields(input: {
  number: string | null | undefined;
  row?: string | null;
}): RackLabelParts {
  const explicitRow = (input.row ?? '').trim();
  if (!explicitRow) return parseRackLabel(input.number);

  const parsed = parseRackLabel(input.number);
  const number =
    parsed.row !== null && parsed.row.toLowerCase() === explicitRow.toLowerCase()
      ? parsed.number
      : tidy(input.number ?? '');
  return { number, row: explicitRow };
}

/**
 * A rack POSITION as every app-layer surface spells it — the camelCase twin of
 * the `rack_number` / `rack_row` columns.
 *
 * It exists because a rack position is no longer only "what a rack is": a CRATE
 * SITS ON A RACK, so a crate row carries the same pair as its position (see
 * new-location.ts). Passing the pair around as one object is what stops the two
 * halves being separated and one of them dropped — which is the shape of both
 * the 2026-07-23 incident and the crate bug this type was added for.
 */
export interface RackPosition {
  rackNumber?: string | null;
  rackRow?: string | null;
}

/**
 * The display label for a position — '' when there is none.
 *
 * Decomposes first, so a whole label parked in the number field ("38-B" typed
 * into an "On rack" box) reads as "38-B" rather than "38-B-" or "38-B-B", and
 * a row with no number reads as '' rather than inventing the rack "B".
 */
export function formatRackPosition(position: RackPosition | null | undefined): string {
  if (!position) return '';
  return formatRackLabel(normalizeRackFields({ number: position.rackNumber, row: position.rackRow }));
}

/** True when the pair names a rack position at all (a number is required). */
export function hasRackPosition(position: RackPosition | null | undefined): boolean {
  return formatRackPosition(position).length > 0;
}

/**
 * WHAT THE CALLER KNOWS about where this book's stock will end up — the one
 * fact that decides whether a clear may be promised.
 *
 * It is a required argument rather than an option with a default because both
 * mistakes are silent: a caller that forgets it would either promise a clear it
 * cannot support, or lose one it could. Spelling it makes every call site state,
 * in the diff, whether it read the holdings.
 */
export type RackOutcomeBasis =
  /**
   * The LIVE HOLDINGS have been read, and this placement leaves the destination
   * as the book's ONLY placement — so `syncBookCratePlacement` will derive the
   * pair from the destination, and a destination with no rack position CLEARS
   * it. Only a caller that actually performed that read may pass this.
   */
  | 'resolves-to-destination'
  /**
   * Not knowable here — no holdings read, or the read did not answer. Never
   * promises a clear. A missing sentence is a gap; a wrong one is a lie.
   */
  | 'unknown';

/**
 * Fail-closed translation of a holdings prediction into a basis.
 *
 * `undefined` is NOT knowledge. `bookCratePlacementWillSync` is only consulted
 * for items the gate could describe (it needs a destination id and a per-item
 * move), and an item it could not describe comes back absent — which the gate
 * already treats as "assume the sync writes" so it still ASKS. That fail-closed
 * default is right for asking and wrong for asserting: "we could not tell" must
 * never become "the rack will be cleared". Only an explicit `true` earns the
 * claim.
 */
export function rackOutcomeBasis(willSync: boolean | undefined): RackOutcomeBasis {
  return willSync === true ? 'resolves-to-destination' : 'unknown';
}

/**
 * The ONE sentence a confirmation shows when a placement moves — or erases —
 * the RACK a book is recorded on. Null when it says nothing.
 *
 * ═══ THE RACK LINE IS A SEPARATE COMPARISON FROM THE CRATE LINE ═══
 *
 * A crate sits on a rack, so a placement can change the crate, the rack, both,
 * or neither, and the four cases are genuinely independent facts. Merging them
 * into one predicate is how "rack A1 + crate 9" came to be read as a single
 * malformed input instead of two true statements. `compareBookCratePlacement`
 * answers the crate half; this answers the rack half, and callers render both.
 *
 * ═══ IT USED TO NEVER SAY "CLEARED", AND THAT RESTRAINT WENT STALE ═══
 *
 * The original reason was that the writer left the rack keys alone, so a
 * clear-promise would have been a lie about a write that never happened. That
 * is no longer true. Since the holdings-derivation landed with migration 0336,
 * `syncBookCratePlacementInner` derives BOTH pairs from the single location the
 * book's live stock resolves to — so a full move into a POSITION-LESS crate
 * really does clear `book_rack_number` / `book_rack_row`.
 *
 * The owner walked exactly that: a book on rack 38-A, all 18 units in staging,
 * placed into "Blue #Shelf". The confirmation named both crate fields and said
 * nothing about the rack; at rest, the rack pair was gone. Clearing it was
 * CORRECT — no stock remained on any rack — but a human-entered value changed
 * without telling the human, which is the class of failure this feature exists
 * to close. The comment described behaviour that had been replaced, and its
 * restraint had become the bug.
 *
 * So the restraint moved from NEVER to NOT WITHOUT A BASIS. Whether the move is
 * full or split is still unknowable from two positions — that fact never
 * changed — so the caller that read the holdings supplies the answer, and a
 * caller that did not read them says `'unknown'` and stays silent. The four
 * outcomes match `syncBookCratePlacementInner` exactly:
 *
 *   destination is a RACK              → "Rack will change from 38-A to 22-B."
 *   destination is a POSITIONED crate  → the same sentence; the pair becomes the
 *                                        crate's own position (a crate SITS ON a
 *                                        rack: one place, two keys)
 *   POSITION-LESS crate, move resolves → "Rack 38-A will be cleared."
 *   SPLIT / not knowable               → null. The gate drops a conflict whose
 *                                        sync provably will not write, so the
 *                                        split case shows no sentence at all.
 *
 * Filling a BLANK rack is not announced in any of them: nothing a human
 * recorded is being replaced, which is the same asymmetry `fieldOverwritten`
 * applies to the crate pair.
 */
export function describeRackChange(
  current: RackPosition | null | undefined,
  next: RackPosition | null | undefined,
  basis: RackOutcomeBasis,
): string | null {
  const from = formatRackPosition(current);
  // Nothing recorded, nothing to lose — and nothing to warn about.
  if (!from) return null;
  const to = formatRackPosition(next);
  if (!to) {
    // The destination states no rack position. Whether the pair CLEARS depends
    // on the live holdings, and only a caller that read them may say so.
    return basis === 'resolves-to-destination' ? `Rack ${from} will be cleared.` : null;
  }
  if (from.trim().toLowerCase() === to.trim().toLowerCase()) return null;
  return `Rack will change from ${from} to ${to}.`;
}
