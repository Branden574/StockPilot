import 'server-only';

import { ServiceError, type ServiceContext } from './context';
import { fetchAllRowsByIds } from './lib/fetch-by-ids';
import { invalidateInventoryListAfterWrite } from './lib/inventory-list-cache';

/**
 * OPENING STOCK GOES THROUGH THE STOCK LEDGER (migration 0454).
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
 * minutes that are still empty, and only for a member who may adjust stock
 * (staff or above, or stock:adjust) in a warehouse they may write. A member
 * with items:create but no stock right gets their item at 0 and the sentence
 * below, as before.
 *
 * Errors are read by SQLSTATE presence, never by message text:
 *   - an error WITH a code (a Postgres SQLSTATE or a PostgREST PGRST code,
 *     including PGRST202 while the function is not deployed yet): the call's
 *     transaction wrote nothing, so the batch is at 0;
 *   - an error WITHOUT a code, or a rejected request (a lost response): the
 *     call may or may not have committed, so on-hand is re-read. The call is
 *     one transaction, so either every line shows its quantity (opened) or
 *     every line is still 0. Anything else, or a failed re-read, is reported
 *     as "could not be checked": "zero on hand" is said only when a read or a
 *     refusal showed it.
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

type RpcResult = { error: { code?: string | null } | null };

function hasSqlState(error: { code?: string | null } | null | undefined): boolean {
  return typeof error?.code === 'string' && error.code.length > 0;
}

function zeroSentence(w: OpeningWording): string {
  const one = w.pronoun === 'its';
  return `${w.subject} created, but ${w.pronoun} opening stock could not be recorded, so ${
    one ? 'it was' : 'they were'
  } saved with zero on hand. Add ${one ? 'the quantity' : 'the quantities'} with a stock adjustment.`;
}

function partialSentence(w: OpeningWording, left: number, total: number): string {
  return `${w.subject} created, but the opening stock of ${left} of ${total} could not be recorded, so those were saved with zero on hand. Add the quantities with a stock adjustment.`;
}

function uncheckedSentence(w: OpeningWording): string {
  const one = w.pronoun === 'its';
  return `${w.subject} created, but ${w.pronoun} opening stock could not be confirmed. Check ${
    one ? 'its quantity' : 'their quantities'
  } on hand before receiving, picking or counting against ${one ? 'it' : 'them'}.`;
}

/**
 * Open the stock of items this request just created. Returns the quantity
 * opened per item id (every line, on success). Always throws on a failure,
 * after invalidating the inventory list.
 */
export async function openItemStockOrThrow(
  ctx: ServiceContext,
  lines: readonly OpeningLine[],
  wording: OpeningWording,
): Promise<Map<string, number>> {
  const wanted = lines.filter((l) => l.quantity > 0);
  const opened = new Map<string, number>();
  if (wanted.length === 0) return opened;

  let outcome: 'ok' | 'zero' | 'unchecked' = 'ok';
  let failedLines = 0;
  let failure: { batch: number; code: string | null } | null = null;

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
      for (const l of batch) opened.set(l.itemId, l.quantity);
      continue;
    }

    if (res && hasSqlState(res.error)) {
      // Refused or failed inside the database: this call wrote nothing.
      outcome = 'zero';
    } else {
      // Lost response: read on-hand back to learn whether the call committed.
      const settled = await settleLostBatch(ctx, batch, opened);
      if (settled === 'ok') continue;
      outcome = settled;
    }
    failure = { batch: start / OPENING_BATCH, code: res?.error?.code ?? null };
    failedLines = wanted.length - opened.size;
    break;
  }

  // Opened or not, these rows changed (inserted, and perhaps opened): the
  // cached list must not serve them from before.
  invalidateInventoryListAfterWrite(ctx.organizationId, wording.invalidateLabel);

  if (outcome === 'ok' && opened.size === wanted.length) return opened;

  console.error(`${wording.tag} opening stock was not recorded`, {
    outcome,
    failure,
    opened: opened.size,
    notOpened: failedLines,
    itemIds: wanted.filter((l) => !opened.has(l.itemId)).map((l) => l.itemId),
  });
  if (outcome === 'unchecked') {
    throw new ServiceError('internal_error', uncheckedSentence(wording));
  }
  if (opened.size > 0) {
    throw new ServiceError('internal_error', partialSentence(wording, failedLines, wanted.length));
  }
  throw new ServiceError('internal_error', zeroSentence(wording));
}

/**
 * After a lost response: re-read the batch's on-hand. All at their quantity
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
