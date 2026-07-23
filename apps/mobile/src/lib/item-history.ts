/**
 * Item movement HISTORY — the pure half of the native history sheet.
 *
 * The owner's question was "who moved them… when, where, notes, why,
 * everything", asked because the staging list shows an em dash for anything
 * that did not arrive on a purchase order. The answer is a HISTORY: the
 * stock_movements rows as they are, not an inferred "source" label. Two earlier
 * attempts inferred one winning movement per holding and both got it
 * confidently wrong, so nothing in this module picks a winner either.
 *
 * WHAT LIVES HERE vs WHERE. The WORDS come from @stockpilot/core's
 * `formatHistoryMovement` — the one formatter the web dialog also calls, so the
 * phone and the browser describe the same movement identically. This module
 * only does the things a client has to do for itself: build the request path,
 * parse the wire payload, page through it, and render the timestamp in the
 * VIEWER's timezone. No React, no Supabase, no expo modules, because
 * apps/mobile has no component-test harness and this is where coverage can
 * actually live (same split as staging-worklist.ts / movement-display.ts).
 *
 * THE READ ITSELF IS NOT HERE AND MUST NOT BE. Rows come from
 * GET /api/v1/items/[id]/history, which calls the very same
 * InventoryService.itemMovementHistory() the web dialog renders. A second query
 * on the phone would rebuild exactly the web/mobile disagreement this whole
 * feature exists to end.
 */

import type { ItemHistoryMovement, ItemHistoryPage } from '@stockpilot/core';

// ── Request ────────────────────────────────────────────────────────────────

/**
 * Rows per request.
 *
 * This is a PAGE SIZE, not a guess at a server cap. The distinction matters:
 * client-side constants that guessed the PostgREST 1000-row ceiling have caused
 * three separate defects in this codebase. Nothing here infers how much data
 * exists — `total` and `hasMore` are facts the server states, and the screen
 * asks for another page only when the server says there is one.
 */
export const ITEM_HISTORY_PAGE_SIZE = 50;

/**
 * The Bearer endpoint path for one page of an item's history.
 *
 * Built by hand, NOT with URLSearchParams: React Native's polyfill throws
 * 'not implemented' from .set(), and it would only throw on a device — vitest
 * runs on node, where the real class exists, so the crash would ship green.
 * (Same reason staging-worklist.ts builds its query string by hand.)
 *
 * `limit`/`offset` are always sent so the window the phone renders is the
 * window it asked for, never a server default that could drift from
 * ITEM_HISTORY_PAGE_SIZE and make `nextHistoryOffset` skip or repeat rows.
 */
export function itemHistoryPath(
  itemId: string,
  opts: { limit?: number; offset?: number } = {},
): string {
  const limit = Math.max(1, Math.floor(opts.limit ?? ITEM_HISTORY_PAGE_SIZE));
  const offset = Math.max(0, Math.floor(opts.offset ?? 0));
  return `/api/v1/items/${encodeURIComponent(itemId)}/history?limit=${limit}&offset=${offset}`;
}

// ── Wire parsing ───────────────────────────────────────────────────────────

function asString(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

function asNullableString(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function asNumber(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function asNullableNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * The reversal pairing, when the server recorded one.
 *
 * The role is read, never derived: the service takes it from
 * `receipts.reversed_receipt_id` and the receipt's own status. An unrecognised
 * role is dropped rather than coerced — claiming a movement "reverses" another
 * on the strength of a string we do not understand is exactly the kind of
 * confident wrongness this feature was rebuilt to avoid.
 */
function normalizeReversal(raw: unknown): ItemHistoryMovement['reversal'] {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (r.role !== 'reversed' && r.role !== 'reversal') return null;
  return {
    role: r.role,
    counterpartMovementId: asNullableString(r.counterpartMovementId),
    counterpartReceiptNumber: asNullableString(r.counterpartReceiptNumber),
  };
}

/**
 * One wire row → a typed movement, or null when it cannot be told as a story.
 *
 * Only `id` and `at` are load-bearing: without an id the list cannot key or
 * de-duplicate the row, and without a timestamp it cannot be placed in the
 * order the whole screen is FOR. Everything else has an honest fallback — an
 * absent actor stays absent (never "System" dressed up as a person), an absent
 * note stays absent (never a token or a uuid).
 */
function normalizeMovement(raw: unknown): ItemHistoryMovement | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const id = asNullableString(r.id);
  const at = asNullableString(r.at);
  if (!id || !at) return null;

  return {
    id,
    at,
    movementType: asString(r.movementType),
    quantityChange: asNumber(r.quantityChange),
    movedQuantity: asNullableNumber(r.movedQuantity),
    previousQuantity: asNumber(r.previousQuantity),
    newQuantity: asNumber(r.newQuantity),
    actorName: asNullableString(r.actorName),
    actorEmail: asNullableString(r.actorEmail),
    fromLocationName: asNullableString(r.fromLocationName),
    toLocationName: asNullableString(r.toLocationName),
    note: asNullableString(r.note),
    receiptNumber: asNullableString(r.receiptNumber),
    receiptStatus: asNullableString(r.receiptStatus),
    poNumber: asNullableString(r.poNumber),
    poStatus: asNullableString(r.poStatus),
    reversalReason: asNullableString(r.reversalReason),
    reversal: normalizeReversal(r.reversal),
  };
}

/**
 * Parse GET /api/v1/items/[id]/history. Fail-soft in the same spirit as
 * parseStagingWorklist: a garbage payload yields an empty page rather than
 * throwing the sheet into an error state.
 *
 * `total` falls back to the number of rows actually parsed — the honest MINIMUM
 * — so a payload without a count can never make the sheet claim there are more
 * movements than it can show. `hasMore` is only ever true when the SERVER says
 * so; it is never inferred from a page looking "full", which is how a paging
 * loop ends up asking forever.
 */
export function parseItemHistoryPage(raw: unknown): ItemHistoryPage {
  const empty: ItemHistoryPage = {
    itemId: '',
    itemName: '',
    itemSku: '',
    rows: [],
    total: 0,
    limit: ITEM_HISTORY_PAGE_SIZE,
    offset: 0,
    hasMore: false,
  };
  if (!raw || typeof raw !== 'object') return empty;
  const body = raw as Record<string, unknown>;
  const rows = Array.isArray(body.rows)
    ? body.rows.map(normalizeMovement).filter((m): m is ItemHistoryMovement => m !== null)
    : [];
  return {
    itemId: asString(body.itemId),
    itemName: asString(body.itemName),
    itemSku: asString(body.itemSku),
    rows,
    total: Math.max(asNumber(body.total, rows.length), rows.length),
    limit: Math.max(1, asNumber(body.limit, ITEM_HISTORY_PAGE_SIZE)),
    offset: Math.max(0, asNumber(body.offset, 0)),
    hasMore: body.hasMore === true,
  };
}

// ── Paging ─────────────────────────────────────────────────────────────────

/**
 * Where the NEXT page starts, measured from the window the server actually
 * answered with rather than from what the client asked for. If the server
 * clamped the limit, this still lands on the first unread row.
 */
export function nextHistoryOffset(page: ItemHistoryPage): number {
  return page.offset + page.rows.length;
}

/**
 * Appends a page to the rows already on screen, dropping ids already present.
 *
 * The de-duplication is not defensive noise. The window is newest-first, so a
 * movement written between "load page 1" and "load page 2" shifts every later
 * row down by one and the second page re-delivers the last row of the first.
 * Without this the reader sees the same receipt twice and reasonably concludes
 * stock arrived twice — a false story told by a paging artefact.
 */
export function appendHistoryMovements(
  existing: readonly ItemHistoryMovement[],
  incoming: readonly ItemHistoryMovement[],
): ItemHistoryMovement[] {
  const seen = new Set(existing.map((m) => m.id));
  const merged = [...existing];
  for (const m of incoming) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    merged.push(m);
  }
  return merged;
}

/**
 * The sheet's counter. Says "12 of 24 movements" only while some are still
 * unread; once everything is on screen it states the plain total, because
 * "24 of 24" reads as though something is still missing.
 *
 * `failed` is the read's outcome, and it is load-bearing. With no rows and no
 * total the counter used to print "0 movements" after a FAILED first page —
 * a positive claim that this item has an empty ledger, when in truth nothing
 * was read at all. That is the same conflation the list's own empty state is
 * commented against forty lines up in the sheet: an unread request is not an
 * empty ledger. When the first page failed there is no count to state, so the
 * counter states the read instead.
 *
 * A LATER page failing is different: the rows already on screen were really
 * read, so the count stays true and stands.
 */
export function historyProgressLabel(loaded: number, total: number, failed = false): string {
  const shown = Math.max(0, Math.floor(loaded));
  const all = Math.max(shown, Math.floor(total));
  if (failed && shown === 0) return 'Movements not loaded';
  const noun = all === 1 ? 'movement' : 'movements';
  return shown < all ? `${shown} of ${all} ${noun}` : `${all} ${noun}`;
}

// ── Amounts ────────────────────────────────────────────────────────────────

/**
 * How the two numbers a movement can carry are stacked in the row's right-hand
 * column: the on-hand delta ("+20") and the physical quantity a net-zero
 * transfer moved ("10 moved").
 *
 * They are NOT alternatives, and the difference matters. Most rows have exactly
 * one — a receipt has a delta, a put-away has a moved quantity — but a row may
 * carry both, and picking one with `??` would silently drop the other. The
 * owner's 2026-07-06 order pick already proved how expensive dropping a number
 * is: it is a `transfer` with a real -5 delta, and the activity feed's
 * assumption that transfers never change on hand would have hidden five units
 * leaving the building. So both are returned; the caller renders the primary
 * large and the secondary beneath it.
 */
export function historyAmountLines(f: {
  deltaLabel: string | null;
  movedLabel: string | null;
}): { primary: string | null; secondary: string | null } {
  if (f.deltaLabel && f.movedLabel) return { primary: f.deltaLabel, secondary: f.movedLabel };
  return { primary: f.deltaLabel ?? f.movedLabel, secondary: null };
}

// ── Timestamps ─────────────────────────────────────────────────────────────

/**
 * The date/time option bag, kept byte-identical to the web
 * <LocalDateTime> component (apps/web/src/components/ui/local-datetime.tsx) so
 * the two surfaces print the same instant the same way — "Jul 22, 2026,
 * 2:42 PM". Web needs a component for it because a server-rendered
 * toLocaleString() would use the deployment's timezone (UTC on Vercel); the
 * phone has no such problem and formats inline. What both share is the rule:
 * the timestamp is rendered in the VIEWER's timezone, never the server's.
 */
const HISTORY_DATETIME_OPTIONS: Intl.DateTimeFormatOptions = {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
};

/**
 * Absolute local date+time for a raw ISO timestamp, or null when the value is
 * not a date at all. Null means the caller renders NOTHING — "Invalid Date" on
 * a screen whose entire purpose is answering "on what date and time" would be
 * worse than the em dash that started this.
 */
export function formatHistoryWhen(iso: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString(undefined, HISTORY_DATETIME_OPTIONS);
}
