import 'server-only';

import { ServiceError, type ServiceContext } from './context';
import { fetchAllRowsByIds } from './lib/fetch-by-ids';
import { invalidateInventoryListAfterWrite } from './lib/inventory-list-cache';

/**
 * OPENING STOCK GOES THROUGH THE STOCK LEDGER.
 *
 * Every create path (InventoryService.create, bulkCreate,
 * bulkCreateSizedVariants and BooksImportService) inserts its items with
 * nothing on hand, then calls this with the quantities the person asked for.
 * open_item_stock (SECURITY DEFINER) writes, for each line and in one
 * transaction per call: the first holding (where tg_seed_initial_level always
 * put it: the item's site primary, else Unplaced), on-hand, and one 'initial'
 * movement attributed to the caller. So the ledger invariant
 * SUM(stock_movements.quantity_change) = quantity_on_hand holds from the
 * first moment an item has stock, and a failed opening leaves the item at 0
 * with no holding and no movement: nothing has to be undone.
 *
 * The function accepts only the caller's own items created in the last 15
 * minutes that are still empty, and only for a member who holds stock:adjust
 * (as adjust_stock asks), in a warehouse they may write. A member with
 * items:create but without stock:adjust gets their item at 0 and the
 * sentence below.
 *
 * The answer names each line it opened (opened_item_id). Only those lines
 * count as opened; a line missing from an answer without an error is settled
 * by reading on-hand back, as a lost response is.
 *
 * Errors are read by SQLSTATE presence, never by message text:
 *   - an error WITH a code (a Postgres SQLSTATE or a PostgREST PGRST code,
 *     including PGRST202 while the function is not deployed yet): the call's
 *     transaction wrote nothing, so the batch is at 0;
 *   - an error WITHOUT a code, or a rejected request (a lost response): the
 *     call may or may not have committed, so on-hand is re-read. The call is
 *     one transaction, so either every line shows its quantity (opened) or
 *     every line is still 0. Anything else, or a failed re-read, is reported
 *     as "could not be confirmed": "zero on hand" is said only when a read or
 *     a refusal showed it.
 *
 * The failure is a ServiceError 'conflict', whose sentence the person reads as
 * written (an internal_error would show a generic "try again", and a second
 * press saves a second item). The sentence says the item WAS saved, with zero
 * on hand, and where to set its quantity (Adjust stock on the item). When the
 * refusal is 42501 with hint stock:adjust, the person cannot use Adjust stock,
 * so the sentence says someone who can adjust stock must set the quantity.
 * details: { reason: 'opening_stock_not_recorded', cause ('not_recorded',
 * 'no_stock_permission' or 'not_confirmed'), outcome, itemIds (the first 100
 * not opened), notOpened, total }, so a screen can take the person to the
 * record.
 *
 * unmatchedIds: rows the caller inserted but could not match to a requested
 * quantity (a SKU it did not send). They are never opened and count as not
 * opened, so the person is told rather than left with a silent 0.
 */

/** One line: an item this call just inserted at 0, and the quantity asked for. */
export interface OpeningLine {
  itemId: string;
  quantity: number;
}

export interface OpeningWording {
  /** Log prefix, such as '[create]'. */
  tag: string;
  /** 'This item was', 'These variants were', 'These items were', 'These books were'. */
  subject: string;
  pronoun: 'its' | 'their';
  /** Cache-invalidation label for this write. */
  invalidateLabel: string;
}

/** Lines per open_item_stock call: the function's own cap. */
export const OPENING_BATCH = 1000;

/** The not-opened ids carried in the refusal's details, at most. */
const DETAIL_IDS = 100;

export const OPENING_NOT_RECORDED = 'opening_stock_not_recorded';

type RpcError = { code?: string | null; hint?: string | null };
type RpcResult = { data?: unknown; error: RpcError | null };

export type OpeningCause = 'not_recorded' | 'no_stock_permission' | 'not_confirmed';

function isStockPermissionRefusal(error: RpcError | null | undefined): boolean {
  return error?.code === '42501' && error?.hint === 'stock:adjust';
}

/** The item ids an answer without an error names as opened. */
function answeredIds(data: unknown): Set<string> {
  const ids = new Set<string>();
  if (!Array.isArray(data)) return ids;
  for (const row of data) {
    const id = (row as { opened_item_id?: unknown } | null)?.opened_item_id;
    if (typeof id === 'string') ids.add(id);
  }
  return ids;
}

function hasSqlState(error: { code?: string | null } | null | undefined): boolean {
  return typeof error?.code === 'string' && error.code.length > 0;
}

function zeroSentence(w: OpeningWording): string {
  return w.pronoun === 'its'
    ? `${w.subject} saved with zero on hand: its opening quantity could not be recorded. Open the item and use Adjust stock to set its quantity.`
    : `${w.subject} saved with zero on hand: their opening quantities could not be recorded. Open each one and use Adjust stock to set its quantity.`;
}

function partialSentence(w: OpeningWording, left: number, total: number): string {
  return `${w.subject} saved, but ${left} of ${total} have zero on hand: their opening quantities could not be recorded. Open each of those and use Adjust stock to set its quantity.`;
}

function noPermissionZeroSentence(w: OpeningWording): string {
  return w.pronoun === 'its'
    ? `${w.subject} saved with zero on hand: you do not have permission to add stock. Someone who can adjust stock must set its quantity.`
    : `${w.subject} saved with zero on hand: you do not have permission to add stock. Someone who can adjust stock must set their quantities.`;
}

function noPermissionPartialSentence(w: OpeningWording, left: number, total: number): string {
  return `${w.subject} saved, but ${left} of ${total} have zero on hand: you do not have permission to add stock. Someone who can adjust stock must set their quantities.`;
}

function uncheckedSentence(w: OpeningWording): string {
  return w.pronoun === 'its'
    ? `${w.subject} saved, but its opening quantity could not be confirmed. Open the item and check its quantity on hand before receiving, picking or counting against it.`
    : `${w.subject} saved, but their opening quantities could not be confirmed. Open each one and check its quantity on hand before receiving, picking or counting against it.`;
}

/**
 * Open the stock of items this request just created. Returns the quantity
 * opened per item id (every line, on success: each named in an answer or
 * confirmed by a read-back). Always throws on a failure,
 * after invalidating the inventory list.
 */
export async function openItemStockOrThrow(
  ctx: ServiceContext,
  lines: readonly OpeningLine[],
  wording: OpeningWording,
  unmatchedIds: readonly string[] = [],
): Promise<Map<string, number>> {
  const wanted = lines.filter((l) => l.quantity > 0);
  const opened = new Map<string, number>();
  if (wanted.length === 0 && unmatchedIds.length === 0) return opened;

  let outcome: 'ok' | 'zero' | 'unchecked' = 'ok';
  let noPermission = false;
  let failure: { batch: number; code: string | null; unanswered?: number } | null = null;

  for (let start = 0; start < wanted.length; start += OPENING_BATCH) {
    const batch = wanted.slice(start, start + OPENING_BATCH);
    let res: RpcResult | null = null;
    try {
      res = (await ctx.supabase.rpc('open_item_stock', {
        p_org_id: ctx.organizationId,
        p_lines: batch.map((l) => ({ itemId: l.itemId, quantity: l.quantity })),
      })) as RpcResult;
    } catch {
      res = null;
    }

    if (res && !res.error) {
      // Opened: only the lines the answer names. Any other line is read back.
      const answered = answeredIds(res.data);
      const missing: OpeningLine[] = [];
      for (const l of batch) {
        if (answered.has(l.itemId)) opened.set(l.itemId, l.quantity);
        else missing.push(l);
      }
      if (missing.length === 0) continue;
      const settled = await settleLostBatch(ctx, missing, opened);
      if (settled === 'ok') continue;
      outcome = settled;
      failure = { batch: start / OPENING_BATCH, code: null, unanswered: missing.length };
      break;
    }

    if (res && hasSqlState(res.error)) {
      // Refused or failed inside the database: this call wrote nothing.
      outcome = 'zero';
      noPermission = isStockPermissionRefusal(res.error);
    } else {
      // Lost response: read on-hand back to learn whether the call committed.
      const settled = await settleLostBatch(ctx, batch, opened);
      if (settled === 'ok') continue;
      outcome = settled;
    }
    failure = { batch: start / OPENING_BATCH, code: res?.error?.code ?? null };
    break;
  }

  // Opened or not, these rows changed (inserted, and perhaps opened): the
  // cached list must not serve them from before.
  invalidateInventoryListAfterWrite(ctx.organizationId, wording.invalidateLabel);

  if (outcome === 'ok' && opened.size === wanted.length && unmatchedIds.length === 0) return opened;

  const notOpenedIds = [
    ...wanted.filter((l) => !opened.has(l.itemId)).map((l) => l.itemId),
    ...unmatchedIds,
  ];
  const total = wanted.length + unmatchedIds.length;
  const kind: 'zero' | 'partial' | 'unchecked' =
    outcome === 'unchecked' ? 'unchecked' : opened.size > 0 ? 'partial' : 'zero';
  const cause: OpeningCause =
    kind === 'unchecked' ? 'not_confirmed' : noPermission ? 'no_stock_permission' : 'not_recorded';
  // The report: ids and counts only, never error text.
  console.error(`${wording.tag} opening stock was not recorded`, {
    outcome: kind,
    cause,
    failure,
    opened: opened.size,
    notOpened: notOpenedIds.length,
    unmatched: unmatchedIds.length,
    itemIds: notOpenedIds,
  });
  const sentence =
    kind === 'unchecked'
      ? uncheckedSentence(wording)
      : kind === 'partial'
        ? noPermission
          ? noPermissionPartialSentence(wording, notOpenedIds.length, total)
          : partialSentence(wording, notOpenedIds.length, total)
        : noPermission
          ? noPermissionZeroSentence(wording)
          : zeroSentence(wording);
  throw new ServiceError('conflict', sentence, {
    reason: OPENING_NOT_RECORDED,
    cause,
    outcome: kind,
    itemIds: notOpenedIds.slice(0, DETAIL_IDS),
    notOpened: notOpenedIds.length,
    total,
  });
}

/**
 * The rows an insert handed back do not account for what was sent (fewer
 * rows, or a stocked SKU with no row): nothing is opened, and the person is
 * told the quantities could not be confirmed, with the ids that came back.
 * Invalidates the list and returns the error for the caller to throw.
 */
export function openingUnconfirmedError(
  ctx: ServiceContext,
  wording: OpeningWording,
  returnedIds: readonly string[],
  counts: { sent: number; returned: number },
): ServiceError {
  invalidateInventoryListAfterWrite(ctx.organizationId, wording.invalidateLabel);
  console.error(`${wording.tag} opening stock was not recorded`, {
    outcome: 'unchecked',
    cause: 'not_confirmed',
    sent: counts.sent,
    returned: counts.returned,
    itemIds: returnedIds,
  });
  return new ServiceError('conflict', uncheckedSentence(wording), {
    reason: OPENING_NOT_RECORDED,
    cause: 'not_confirmed' satisfies OpeningCause,
    outcome: 'unchecked',
    itemIds: returnedIds.slice(0, DETAIL_IDS),
    notOpened: returnedIds.length,
    total: counts.sent,
  });
}

/**
 * After a lost response, or for lines an answer did not name: re-read the batch's on-hand. All at their quantity
 * means the call committed (marked opened); all at 0 means it did not ('zero',
 * and every later batch was never sent). Anything else, or a failed read, is
 * 'unchecked'.
 */
async function settleLostBatch(
  ctx: ServiceContext,
  lines: readonly OpeningLine[],
  opened: Map<string, number>,
): Promise<'ok' | 'zero' | 'unchecked'> {
  let rows: Array<{ id: string; quantity_on_hand: number | string | null }>;
  try {
    rows = await fetchAllRowsByIds<{ id: string; quantity_on_hand: number | string | null }>(
      lines.map((l) => l.itemId),
      (batch) => (from, to) =>
        ctx.supabase
          .from('inventory_items')
          .select('id, quantity_on_hand')
          .eq('organization_id', ctx.organizationId)
          .in('id', batch)
          .order('id')
          .range(from, to),
    );
  } catch {
    return 'unchecked';
  }
  const onHand = new Map(rows.map((r) => [r.id, Number(r.quantity_on_hand ?? NaN)]));
  const allOpened = lines.every((l) => onHand.get(l.itemId) === l.quantity);
  if (allOpened) {
    for (const l of lines) opened.set(l.itemId, l.quantity);
    return 'ok';
  }
  const allZero = lines.every((l) => onHand.get(l.itemId) === 0);
  return allZero ? 'zero' : 'unchecked';
}
