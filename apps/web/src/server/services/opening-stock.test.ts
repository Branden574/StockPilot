import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The shared opening of new items' stock (InventoryService create /
 * bulkCreate / bulkCreateSizedVariants and BooksImportService), through the
 * stock ledger's open_item_stock.
 *
 * One RPC per batch of up to 1,000 lines, in the active organization. An
 * error is read by its SQLSTATE (or PostgREST code), never its message: with a
 * code the call wrote nothing, so the items are at 0 and the sentence says so;
 * without one (a lost response) on-hand is re-read, and the answer follows
 * what the read shows: opened, still 0, or could not be checked.
 *
 * The person READS the sentence: it is a 'conflict' (shown as written), never
 * an internal_error (which shows a generic "try again" and invites a second
 * press, a second item). It says the item was saved, with zero on hand, and
 * where to set its quantity. An inserted row whose quantity could not be
 * matched (unmatchedIds) counts as not opened.
 */

const invalidate = vi.fn();
vi.mock('./lib/inventory-list-cache', () => ({
  invalidateInventoryListAfterWrite: (...a: unknown[]) => invalidate(...a),
}));
vi.spyOn(console, 'error').mockImplementation(() => {});

import { inFilters, makeServiceContext, makeSupabaseStub, type MockCall } from '@/test/supabase-mock';

import type { ServiceError } from './context';
import { OPENING_BATCH, openItemStockOrThrow, type OpeningWording } from './opening-stock';

const uuid = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;

const ITEM: OpeningWording = {
  tag: '[test]',
  subject: 'This item was',
  pronoun: 'its',
  invalidateLabel: 'item.open_stock',
};
const BOOKS: OpeningWording = {
  tag: '[test]',
  subject: 'These books were',
  pronoun: 'their',
  invalidateLabel: 'books.open_stock',
};

type Line = { itemId: string; quantity: number };

function linesOf(call: MockCall): Line[] {
  return ((call.args[0]?.[0] as { p_lines?: Line[] })?.p_lines ?? []) as Line[];
}

/** open_item_stock answering per call; on-hand served from `onHand`. */
function stubWith(opts: {
  answer?: (n: number, lines: Line[]) => { data: unknown; error: unknown } | 'throw';
  onHand?: Record<string, number>;
  failRead?: boolean;
}) {
  let n = 0;
  const calls: Array<{ org: unknown; lines: Line[] }> = [];
  const reads: string[][] = [];
  const stub = makeSupabaseStub({
    'rpc:open_item_stock': (call: MockCall) => {
      n += 1;
      const lines = linesOf(call);
      calls.push({ org: (call.args[0]?.[0] as { p_org_id?: string })?.p_org_id, lines });
      const a = opts.answer?.(n, lines) ?? { data: lines.map((l) => ({ opened_item_id: l.itemId })), error: null };
      if (a === 'throw') throw new TypeError('fetch failed');
      return a as never;
    },
    'inventory_items.select': (call: MockCall) => {
      const ids = (inFilters(call).find(([c]) => c === 'id')?.[1] ?? []) as string[];
      reads.push(ids);
      if (opts.failRead) return { data: null, error: { message: 'read boom' } };
      return {
        data: ids
          .filter((id) => opts.onHand && id in opts.onHand)
          .map((id) => ({ id, quantity_on_hand: opts.onHand![id] })),
        error: null,
      };
    },
  });
  return { stub, calls, reads };
}

async function open(client: unknown, lines: Line[], w: OpeningWording = BOOKS, unmatched: string[] = []) {
  return openItemStockOrThrow(makeServiceContext(client) as never, lines, w, unmatched);
}

const GENERIC = 'An internal error occurred. Please try again.';

beforeEach(() => vi.clearAllMocks());

describe('openItemStockOrThrow', () => {
  it('sends one call per 1,000 lines in the active organization, and returns every opened quantity', async () => {
    const lines = Array.from({ length: 2_500 }, (_, i) => ({ itemId: uuid(i), quantity: (i % 7) + 1 }));
    const { stub, calls } = stubWith({});

    const opened = await open(stub.client, lines);

    expect(OPENING_BATCH).toBe(1000);
    expect(calls.map((c) => c.lines.length)).toEqual([1000, 1000, 500]);
    expect(calls.every((c) => c.org === 'org-test')).toBe(true);
    expect(calls.flatMap((c) => c.lines)).toEqual(lines);
    expect(opened.size).toBe(2_500);
    expect(opened.get(uuid(3))).toBe(4);
    expect(invalidate).toHaveBeenCalledWith('org-test', 'books.open_stock');
  });

  it('skips lines at 0 and makes no call when nothing has stock', async () => {
    const { stub, calls } = stubWith({});
    const opened = await open(stub.client, [
      { itemId: uuid(1), quantity: 0 },
      { itemId: uuid(2), quantity: 0 },
    ]);
    expect(calls).toEqual([]);
    expect(opened.size).toBe(0);
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('a refusal (a SQLSTATE) tells the person the item was saved with zero on hand and where to set it, and never re-reads', async () => {
    const { stub, reads } = stubWith({
      answer: () => ({ data: null, error: { message: 'forbidden', code: '42501', hint: 'warehouse_write' } }),
    });
    const err = (await open(stub.client, [{ itemId: uuid(1), quantity: 5 }], ITEM).catch(
      (e: unknown) => e,
    )) as ServiceError;

    expect(err.code).toBe('conflict');
    expect(err.message).toBe(
      'This item was saved with zero on hand: its opening quantity could not be recorded. Open the item and use Adjust stock to set its quantity.',
    );
    expect(err.message).not.toBe(GENERIC);
    expect(err.details).toEqual({
      reason: 'opening_stock_not_recorded',
      cause: 'not_recorded',
      outcome: 'zero',
      itemIds: [uuid(1)],
      notOpened: 1,
      total: 1,
    });
    expect(reads).toEqual([]);
    expect(invalidate).toHaveBeenCalledWith('org-test', 'item.open_stock');
  });

  // The person may not add stock (42501, hint stock:adjust): they are never
  // sent to Adjust stock, which they cannot use.
  it('a stock:adjust refusal says the item was saved with zero on hand and someone who can adjust stock must set it', async () => {
    const { stub } = stubWith({
      answer: () => ({ data: null, error: { message: 'forbidden', code: '42501', hint: 'stock:adjust' } }),
    });
    const one = (await open(stub.client, [{ itemId: uuid(1), quantity: 5 }], ITEM).catch(
      (e: unknown) => e,
    )) as ServiceError;
    expect(one.code).toBe('conflict');
    expect(one.message).toBe(
      'This item was saved with zero on hand: you do not have permission to add stock. Someone who can adjust stock must set its quantity.',
    );
    expect(one.message).not.toMatch(/use Adjust stock/);
    expect(one.details).toMatchObject({ reason: 'opening_stock_not_recorded', cause: 'no_stock_permission', outcome: 'zero' });

    const many = (await open(stub.client, [
      { itemId: uuid(1), quantity: 5 },
      { itemId: uuid(2), quantity: 1 },
    ]).catch((e: unknown) => e)) as ServiceError;
    expect(many.message).toBe(
      'These books were saved with zero on hand: you do not have permission to add stock. Someone who can adjust stock must set their quantities.',
    );
  });

  it('a stock:adjust refusal of a later batch names how many were left at 0', async () => {
    const lines = Array.from({ length: 1_500 }, (_, i) => ({ itemId: uuid(i), quantity: 1 }));
    const { stub } = stubWith({
      answer: (n, ls) =>
        n === 2
          ? { data: null, error: { message: 'forbidden', code: '42501', hint: 'stock:adjust' } }
          : { data: ls.map((l) => ({ opened_item_id: l.itemId })), error: null },
    });
    const err = (await open(stub.client, lines).catch((e: unknown) => e)) as ServiceError;
    expect(err.message).toBe(
      'These books were saved, but 500 of 1500 have zero on hand: you do not have permission to add stock. Someone who can adjust stock must set their quantities.',
    );
    expect(err.details).toMatchObject({ cause: 'no_stock_permission', outcome: 'partial' });
  });

  // Only the ids the function answered are opened; a line missing from the
  // answer is settled by reading on-hand back.
  it('an answer with no error and no rows is read back, and never counted as opened', async () => {
    const { stub, reads } = stubWith({
      answer: () => ({ data: [], error: null }),
      onHand: { [uuid(1)]: 0 },
    });
    const err = (await open(stub.client, [{ itemId: uuid(1), quantity: 5 }], ITEM).catch(
      (e: unknown) => e,
    )) as ServiceError;
    expect(reads).toEqual([[uuid(1)]]);
    expect(err.message).toBe(
      'This item was saved with zero on hand: its opening quantity could not be recorded. Open the item and use Adjust stock to set its quantity.',
    );
  });

  it('an answer missing one id: that line is read back, and the person is told about it alone', async () => {
    const { stub, reads } = stubWith({
      answer: (_n, ls) => ({ data: ls.slice(1).map((l) => ({ opened_item_id: l.itemId })), error: null }),
      onHand: { [uuid(1)]: 0 },
    });
    const err = (await open(stub.client, [
      { itemId: uuid(1), quantity: 5 },
      { itemId: uuid(2), quantity: 3 },
    ]).catch((e: unknown) => e)) as ServiceError;
    expect(reads).toEqual([[uuid(1)]]);
    expect(err.message).toBe(
      'These books were saved, but 1 of 2 have zero on hand: their opening quantities could not be recorded. Open each of those and use Adjust stock to set its quantity.',
    );
    expect((err.details as { itemIds: string[] }).itemIds).toEqual([uuid(1)]);
  });

  it('an answer missing one id whose read-back shows its quantity counts it as opened', async () => {
    const { stub } = stubWith({
      answer: (_n, ls) => ({ data: ls.slice(1).map((l) => ({ opened_item_id: l.itemId })), error: null }),
      onHand: { [uuid(1)]: 5 },
    });
    const opened = await open(stub.client, [
      { itemId: uuid(1), quantity: 5 },
      { itemId: uuid(2), quantity: 3 },
    ]);
    expect([...opened.entries()].sort()).toEqual([
      [uuid(1), 5],
      [uuid(2), 3],
    ]);
  });

  it('a normal answer opens every line it names, with no read-back', async () => {
    const { stub, reads } = stubWith({});
    const opened = await open(stub.client, [{ itemId: uuid(4), quantity: 2 }], ITEM);
    expect(opened.get(uuid(4))).toBe(2);
    expect(reads).toEqual([]);
  });

  it('a function not deployed yet (PGRST202) is a refusal too: nothing was written', async () => {
    const { stub } = stubWith({
      answer: () => ({ data: null, error: { message: 'Could not find the function', code: 'PGRST202' } }),
    });
    const err = (await open(stub.client, [{ itemId: uuid(1), quantity: 5 }]).catch(
      (e: unknown) => e,
    )) as ServiceError;
    expect(err.message).toBe(
      'These books were saved with zero on hand: their opening quantities could not be recorded. Open each one and use Adjust stock to set its quantity.',
    );
  });

  it('decides by the code, never the message: a refusal worded like success is still a refusal', async () => {
    const { stub } = stubWith({
      answer: () => ({ data: null, error: { message: 'ok', code: '22023' } }),
    });
    await expect(open(stub.client, [{ itemId: uuid(1), quantity: 5 }])).rejects.toMatchObject({
      code: 'conflict',
      message: expect.stringMatching(/saved with zero on hand/),
    });
  });

  it('a lost response whose re-read shows every quantity counts as opened', async () => {
    const { stub, reads } = stubWith({
      answer: () => 'throw',
      onHand: { [uuid(1)]: 5, [uuid(2)]: 2.5 },
    });
    const opened = await open(stub.client, [
      { itemId: uuid(1), quantity: 5 },
      { itemId: uuid(2), quantity: 2.5 },
    ]);
    expect(reads.flat().sort()).toEqual([uuid(1), uuid(2)]);
    expect([...opened.entries()]).toEqual([
      [uuid(1), 5],
      [uuid(2), 2.5],
    ]);
  });

  it('a lost response (no code) whose re-read shows every item at 0 says zero on hand', async () => {
    const { stub } = stubWith({
      answer: () => ({ data: null, error: { message: 'Bad gateway', code: '' } }),
      onHand: { [uuid(1)]: 0, [uuid(2)]: 0 },
    });
    const err = (await open(stub.client, [
      { itemId: uuid(1), quantity: 5 },
      { itemId: uuid(2), quantity: 2 },
    ]).catch((e: unknown) => e)) as ServiceError;
    expect(err.message).toMatch(/^These books were saved with zero on hand/);
    expect((err.details as { outcome: string }).outcome).toBe('zero');
  });

  it('a lost response whose re-read fails never claims zero on hand', async () => {
    const { stub } = stubWith({ answer: () => 'throw', failRead: true });
    const err = (await open(stub.client, [{ itemId: uuid(1), quantity: 5 }], ITEM).catch(
      (e: unknown) => e,
    )) as ServiceError;
    expect(err.code).toBe('conflict');
    expect(err.message).toBe(
      'This item was saved, but its opening quantity could not be confirmed. Open the item and check its quantity on hand before receiving, picking or counting against it.',
    );
    expect(err.message).not.toMatch(/zero on hand/);
    expect((err.details as { outcome: string }).outcome).toBe('unchecked');
  });

  it('a lost response whose re-read shows neither all opened nor all 0 is "could not be confirmed"', async () => {
    const { stub } = stubWith({
      answer: () => 'throw',
      onHand: { [uuid(1)]: 5, [uuid(2)]: 0 },
    });
    const err = (await open(stub.client, [
      { itemId: uuid(1), quantity: 5 },
      { itemId: uuid(2), quantity: 2 },
    ]).catch((e: unknown) => e)) as ServiceError;
    expect(err.message).toBe(
      'These books were saved, but their opening quantities could not be confirmed. Open each one and check its quantity on hand before receiving, picking or counting against it.',
    );
  });

  it('a later batch refused after earlier ones opened names how many were left at 0, and sends no more', async () => {
    const lines = Array.from({ length: 2_500 }, (_, i) => ({ itemId: uuid(i), quantity: 1 }));
    const { stub, calls } = stubWith({
      answer: (n, ls) =>
        n === 2
          ? { data: null, error: { message: 'refused', code: '42501' } }
          : { data: ls.map((l) => ({ opened_item_id: l.itemId })), error: null },
    });
    const err = (await open(stub.client, lines).catch((e: unknown) => e)) as ServiceError;
    expect(calls).toHaveLength(2);
    expect(err.code).toBe('conflict');
    expect(err.message).toBe(
      'These books were saved, but 1500 of 2500 have zero on hand: their opening quantities could not be recorded. Open each of those and use Adjust stock to set its quantity.',
    );
    const d = err.details as { outcome: string; itemIds: string[]; notOpened: number; total: number };
    expect([d.outcome, d.notOpened, d.total, d.itemIds.length, d.itemIds[0]]).toEqual([
      'partial',
      1500,
      2500,
      100,
      uuid(1000),
    ]);
    expect(invalidate).toHaveBeenCalledTimes(1);
  });

  it('an inserted row whose quantity could not be matched counts as not opened, and the person is told', async () => {
    const { stub, calls } = stubWith({});
    const err = (await open(
      stub.client,
      [
        { itemId: uuid(1), quantity: 2 },
        { itemId: uuid(2), quantity: 3 },
      ],
      BOOKS,
      [uuid(9)],
    ).catch((e: unknown) => e)) as ServiceError;
    expect(calls).toHaveLength(1);
    expect(err.code).toBe('conflict');
    expect(err.message).toBe(
      'These books were saved, but 1 of 3 have zero on hand: their opening quantities could not be recorded. Open each of those and use Adjust stock to set its quantity.',
    );
    expect((err.details as { itemIds: string[] }).itemIds).toEqual([uuid(9)]);
    expect(invalidate).toHaveBeenCalledTimes(1);
  });

  it('with only unmatched rows nothing is sent, and the person is told they are at zero', async () => {
    const { stub, calls } = stubWith({});
    const err = (await open(stub.client, [], ITEM, [uuid(7)]).catch((e: unknown) => e)) as ServiceError;
    expect(calls).toEqual([]);
    expect(err.message).toBe(
      'This item was saved with zero on hand: its opening quantity could not be recorded. Open the item and use Adjust stock to set its quantity.',
    );
    expect(invalidate).toHaveBeenCalledTimes(1);
  });
});
