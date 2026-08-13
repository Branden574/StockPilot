/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE RACK HALF OF A PLACEMENT CONFIRMATION — its OWN channel, deliberately.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * THE DEFECT THIS CLOSES, reproduced against the real service: a book recorded
 * in crate "Blue Shelf" ON RACK 38-A, placed into the position-less crate
 * "Blue #Shelf". The CRATE does not change — ('blue','Shelf') normalises to
 * exactly what the book already records — so `compareBookCratePlacement`
 * correctly reports `changed: false` and the crate gate correctly stays silent.
 * The reconciliation then calls
 *
 *   inventory_set_book_placement { p_crate_color:'blue', p_crate_number:'Shelf',
 *                                  p_rack_number:null,   p_rack_row:null }
 *
 * and rack 38-A — a value a human typed by hand — is gone. Nobody was asked.
 *
 * ═══ WHY THE CRATE GATE COULD NOT SIMPLY BE WIDENED ═══
 *
 * `bookCrateFingerprint` covers the CRATE PAIR, and that is load-bearing in two
 * directions. Every already-shipped client — the mobile OTA is out — computes
 * its acknowledgement from the crate pair alone, so a widened fingerprint would
 * stop matching and dead-end every one of those devices on a refusal it has no
 * way to answer. And it would fire "Change this book's crate?" for moves where
 * the crate provably does not change, which is incoherent. The rack needs its
 * own channel, not a wider crate one. Hence this module: the SAME scoped,
 * per-item, fingerprint-matched shape as book-crate-placement.ts, over the RACK
 * PAIR only.
 *
 * ═══ THE ONE QUESTION THIS CHANNEL ASKS: AN ERASURE, NEVER A MOVE ═══
 *
 * `syncBookCratePlacementInner` derives the rack pair from the single location
 * a book's live stock resolves to, so a placement can do three things to it:
 *
 *   • the destination is a plain RACK          → the pair becomes that rack;
 *   • the destination is a POSITIONED crate    → the pair becomes the crate's
 *                                                own position (a crate sits on
 *                                                a rack: one place, two keys);
 *   • the destination states NO position and
 *     the move leaves it as the only placement → the pair is CLEARED.
 *
 * Only the third is a question. In the first two the operator can READ THE NEW
 * RACK OFF THE DESTINATION THEY JUST PICKED — they chose "22-B", or "Blue #13
 * on rack 38-B" — so the write replaces one true value with another true value
 * they were shown, and the audit trail records the swap. Asking about it would
 * put a modal in front of the single most common put-away in the warehouse and
 * train people to click through the one that matters. The ERASURE is the only
 * outcome that is not visible in anything the operator selected.
 *
 * That asymmetry is the same one `fieldOverwritten` applies to the crate pair,
 * pushed one step further by the rule that decides every case this module does
 * not anticipate:
 *
 *   A STALE RACK LABEL IS RECOVERABLE. A WIPED ONE IS NOT.
 *
 *   A label still reading 38-A after the stock moved is visibly wrong, the
 *   reader guards downrank it (holdings outrank the stored pair), and the audit
 *   row says what it was. A CLEARED label is gone — nothing remembers what it
 *   said, the count still reads healthy, and nobody on the floor knows where to
 *   stand. So: NEVER clear a rack label the operator was not shown. When in
 *   doubt, keep the stale value and report it — never erase and stay quiet.
 *
 * ═══ AND IT NEVER REFUSES A CALLER THAT CANNOT ANSWER ═══
 *
 * A refusal no client can answer is not a safety feature, it is an outage: the
 * first review of this feature found exactly that shape (a gate with no client
 * able to answer it) and put-away was impossible until it was caught. So the
 * server infers CAPABILITY from the request — a caller that sends a rack
 * acknowledgement list, even an EMPTY one, is a caller that understands the
 * question; its absence means "cannot answer". For a caller that cannot answer
 * the placement STILL SUCCEEDS and the rack pair is LEFT ALONE rather than
 * cleared, reported through the existing crateSync* flag vocabulary. Fail safe,
 * not fail closed. That reading is the right one for an old client and for a
 * forged request alike.
 *
 * PURE MODULE. No DB, no IO — the server does the reading, this decides.
 */

import {
  describeRackChange,
  formatRackPosition,
  hasRackPosition,
  normalizeRackFields,
  type RackOutcomeBasis,
  type RackPosition,
} from './rack-label';

export const BOOK_RACK_CLEAR_REQUIRES_CONFIRMATION =
  'BOOK_RACK_CLEAR_REQUIRES_CONFIRMATION' as const;

/**
 * A stable, comparable fingerprint of the rack a book is recorded on.
 *
 * DECOMPOSED FIRST, through the same `normalizeRackFields` every writer of these
 * keys uses, so the 2026-07-23 legacy shape — the whole label parked in the
 * number column, ("38-A", null) — fingerprints identically to the correct pair
 * ("38","A"). They name one rack; a fingerprint that told them apart would
 * refuse a placement forever on a row nobody can repair from the confirmation.
 *
 * Case-insensitive for the same reason `bookCrateFingerprint` is: this answers
 * "is this the same rack the operator was looking at", not "is this
 * byte-identical". A client that rendered "38-a" still matches a row storing
 * "38-A".
 *
 * JSON, not a joined string — a rack number is free text ("E2E-RACK") and any
 * literal separator can appear inside a value, so ('38-A', null) and
 * ('38','A') must not be told apart by where a delimiter happens to fall. Same
 * reasoning as `bookCrateFingerprint`.
 */
export function bookRackFingerprint(
  rackNumber: string | null | undefined,
  rackRow: string | null | undefined,
): string {
  const parts = normalizeRackFields({ number: rackNumber, row: rackRow });
  const number = parts.number.trim().toLowerCase();
  const row = (parts.row ?? '').trim().toLowerCase();
  return JSON.stringify([number || null, row || null]);
}

export interface BookRackChangeItem {
  itemId: string;
  itemName: string;
  /** "38-A" — the rack this book records today. Never null: no label, no conflict. */
  currentLabel: string;
  /**
   * The sentence to show. Always `describeRackChange`'s own words ("Rack 38-A
   * will be cleared."), never re-composed here — the confirmation and the
   * disclosure that rides on a crate line must be the same string, or the
   * client cannot dedupe them and the operator reads it twice.
   */
  line: string;
  /**
   * `bookRackFingerprint` of the rack this line described. The client echoes it
   * back to acknowledge THIS erasure and nothing else.
   */
  currentFingerprint: string;
}

/** One line of a scoped acknowledgement: "I was shown item X losing rack F." */
export interface BookRackAcknowledgedChange {
  itemId: string;
  currentFingerprint: string;
}

export interface BookRackChangeDetail {
  reason:
    | typeof BOOK_RACK_CLEAR_REQUIRES_CONFIRMATION
    | 'BOOK_CRATE_CHANGE_REQUIRES_CONFIRMATION';
  items: BookRackChangeItem[];
}

/**
 * ONE constructor for a rack-clear line, so the fingerprint can never drift
 * from the sentence it fingerprints. Returns null when there is nothing to ask.
 *
 * Three independent reasons to stay silent, and each is a real case:
 *
 *   • the destination STATES A RACK POSITION — this is a move, not an erasure,
 *     and the operator read the new rack off the destination they picked (see
 *     the header). `hasRackPosition` is checked explicitly rather than inferred
 *     from the sentence, because "Rack will change from 38-A to 22-B." is a
 *     sentence this channel must never turn into a blocking question;
 *   • the book RECORDS NO RACK — filling a blank destroys nothing, the same
 *     asymmetry `fieldOverwritten` applies to the crate pair;
 *   • the BASIS does not support the promise — the caller has not read the live
 *     holdings, or they say the book stays split, so the reconciliation will not
 *     clear anything and asking would be a false alarm. `describeRackChange`
 *     owns that rule; this delegates rather than restating it.
 */
export function describeBookRackClear(input: {
  itemId: string;
  itemName: string;
  /** The rack the ITEM is recorded on today (book_rack_number / book_rack_row). */
  current?: RackPosition | null;
  /** The DESTINATION's own rack position — its own for a rack, the crate's for a crate. */
  next?: RackPosition | null;
  basis: RackOutcomeBasis;
}): BookRackChangeItem | null {
  if (hasRackPosition(input.next)) return null;
  const currentLabel = formatRackPosition(input.current);
  if (!currentLabel) return null;
  const line = describeRackChange(input.current, input.next, input.basis);
  if (!line) return null;
  return {
    itemId: input.itemId,
    itemName: input.itemName,
    currentLabel,
    line,
    currentFingerprint: bookRackFingerprint(
      input.current?.rackNumber,
      input.current?.rackRow,
    ),
  };
}

/**
 * The acknowledgement for a set of rack-clear lines: exactly the ids and
 * fingerprints that were rendered, and nothing else.
 *
 * Derived from the SHOWN items rather than assembled by hand at each call site,
 * for the same reason `toBookCrateAcknowledgement` is — the defect the crate
 * gate had to delete was a flag that existed independently of what the user saw.
 */
export function toBookRackAcknowledgement(
  items: ReadonlyArray<Pick<BookRackChangeItem, 'itemId' | 'currentFingerprint'>>,
): BookRackAcknowledgedChange[] {
  return items.map((i) => ({ itemId: i.itemId, currentFingerprint: i.currentFingerprint }));
}

/**
 * Index an acknowledgement for lookup. FIRST entry per item wins: a caller that
 * sends two fingerprints for one book is trying to cover both answers to a
 * question it was only asked once.
 */
export function bookRackAcknowledgementIndex(
  ack: ReadonlyArray<BookRackAcknowledgedChange> | null | undefined,
): Map<string, string> {
  const out = new Map<string, string>();
  for (const a of ack ?? []) {
    if (!a || typeof a.itemId !== 'string') continue;
    if (out.has(a.itemId)) continue;
    out.set(a.itemId, a.currentFingerprint);
  }
  return out;
}

/** Was THIS erasure — this item, losing this rack, right now — the one shown? */
export function isBookRackChangeAcknowledged(
  index: ReadonlyMap<string, string>,
  change: Pick<BookRackChangeItem, 'itemId' | 'currentFingerprint'>,
): boolean {
  return index.get(change.itemId) === change.currentFingerprint;
}

/**
 * Did we already acknowledge EXACTLY this refusal?
 *
 * The client re-asks whenever the server's payload says something its last
 * acknowledgement did not cover — the stale-snapshot case. An identical refusal
 * falls through to the plain error rather than looping. Order-insensitive: a
 * 200-book batch must not re-ask because the server enumerated it differently.
 */
export function bookRackAcknowledgementsMatch(
  sent: ReadonlyArray<BookRackAcknowledgedChange> | null | undefined,
  required: ReadonlyArray<BookRackAcknowledgedChange>,
): boolean {
  // JSON-encoded, not joined: itemId and fingerprint are both
  // attacker-influenced strings, so any literal delimiter can be smuggled into
  // a value to make two different pairs share one key.
  const key = (a: BookRackAcknowledgedChange) => JSON.stringify([a.itemId, a.currentFingerprint]);
  const have = new Set((sent ?? []).map(key));
  return required.every((r) => have.has(key(r)));
}

/**
 * Narrow an error `details` blob to the RACK half of a confirmation payload.
 *
 * ═══ IT READS `rackItems`, WHATEVER THE `reason` SAYS ═══
 *
 * A single placement can raise the crate question and the rack question at
 * once, and they must reach the operator as ONE confirmation. The server
 * therefore throws ONE payload: `items` carries the crate lines, `rackItems`
 * carries these, and `reason` keeps naming the CRATE constant whenever there is
 * at least one crate line — so `parseBookCrateChangeDetail` (and every client
 * already shipped against it) reads that payload exactly as it always did and
 * simply ignores a key it has never heard of. A rack-ONLY refusal is the one
 * case that carries the rack reason, and it can only ever be sent to a caller
 * that declared it can answer.
 *
 * `currentFingerprint` and `line` are both REQUIRED, and a payload missing
 * either is rejected outright: a line that cannot be acknowledged cannot be
 * answered (the dialog would render Continue, send an acknowledgement matching
 * nothing, and be refused forever) and a line with no sentence is an empty
 * "are you sure?" with nothing in it. Falling back to the plain error message is
 * the honest outcome for both.
 */
export function parseBookRackChangeDetail(details: unknown): BookRackChangeDetail | null {
  if (!details || typeof details !== 'object') return null;
  const d = details as { reason?: unknown; rackItems?: unknown };
  if (
    d.reason !== BOOK_RACK_CLEAR_REQUIRES_CONFIRMATION &&
    d.reason !== 'BOOK_CRATE_CHANGE_REQUIRES_CONFIRMATION'
  ) {
    return null;
  }
  if (!Array.isArray(d.rackItems) || d.rackItems.length === 0) return null;
  const items: BookRackChangeItem[] = [];
  for (const raw of d.rackItems) {
    if (!raw || typeof raw !== 'object') return null;
    const it = raw as Record<string, unknown>;
    if (typeof it.itemId !== 'string' || typeof it.itemName !== 'string') return null;
    if (typeof it.currentLabel !== 'string' || it.currentLabel.length === 0) return null;
    if (typeof it.line !== 'string' || it.line.length === 0) return null;
    if (typeof it.currentFingerprint !== 'string' || it.currentFingerprint.length === 0) {
      return null;
    }
    items.push({
      itemId: it.itemId,
      itemName: it.itemName,
      currentLabel: it.currentLabel,
      line: it.line,
      currentFingerprint: it.currentFingerprint,
    });
  }
  return { reason: d.reason, items };
}

/**
 * ONE aggregated view of a BULK rack erasure, instead of N dialogs.
 *
 * The sentences are DEDUPED and grouped by the rack being lost, because they are
 * per-book and rarely distinct — 200 books coming off rack 38-A into one
 * position-less crate share a single "Rack 38-A will be cleared." — so repeating
 * it 200 times would bury the one line that differs. Ordered largest group
 * first, then alphabetically, so the same selection always reads the same way
 * however the server enumerated it.
 *
 * Structurally typed to the fields it reads: this is presentation and has no
 * business requiring the acknowledgement fingerprint just to count groups.
 */
export function summarizeBookRackClears(
  items: ReadonlyArray<Pick<BookRackChangeItem, 'currentLabel' | 'line'>>,
): {
  total: number;
  groups: Array<{ currentLabel: string; line: string; count: number }>;
  /** Every distinct sentence in this set, deduped and ordered — for surfaces with room for one list. */
  lines: string[];
} {
  const counts = new Map<string, { currentLabel: string; line: string; count: number }>();
  for (const it of items) {
    // JSON-encoded key: a rack label is free text, so no literal delimiter is
    // safe to join two fields on.
    const key = JSON.stringify([it.currentLabel, it.line]);
    const entry = counts.get(key) ?? { currentLabel: it.currentLabel, line: it.line, count: 0 };
    entry.count += 1;
    counts.set(key, entry);
  }
  const groups = [...counts.values()].sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    return a.currentLabel.localeCompare(b.currentLabel);
  });
  return {
    total: items.length,
    groups,
    lines: groups.map((g) => g.line),
  };
}
