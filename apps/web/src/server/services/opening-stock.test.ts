import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The shared opening of new items' stock (InventoryService create /
 * bulkCreate / bulkCreateSizedVariants and BooksImportService), through the
 * stock ledger's open_item_stock (migration 0454).
 *
 * One RPC per batch of up to 1,000 lines, in the active organization. An
 * error is read by its SQLSTATE (or PostgREST code), never its message: with a
 * code the call wrote nothing, so the items are at 0 and the sentence says so;
 * without one (a lost response) on-hand is re-read, and the answer follows
 * what the read shows: opened, still 0, or could not be checked.
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

async function open(client: unknown, lines: Line[], w: OpeningWording = BOOKS) {
  return openItemStockOrThrow(makeServiceContext(client) as never, lines, w);
}

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

  it('a refusal (a SQLSTATE) says the item was saved with zero on hand, and never re-reads', async () => {
    const { stub, reads } = stubWith({
      answer: () => ({ data: null, error: { message: 'forbidden', code: '42501', hint: 'stock:adjust' } }),
    });
    const err = (await open(stub.client, [{ itemId: uuid(1), quantity: 5 }], ITEM).catch(
      (e: unknown) => e,
    )) as ServiceError;

    expect(err.code).toBe('internal_error');
    expect(err.internalDetail).toBe(
      'This item was created, but its opening stock could not be recorded, so it was saved with zero on hand. Add the quantity with a stock adjustment.',
    );
    expect(reads).toEqual([]);
    expect(invalidate).toHaveBeenCalledWith('org-test', 'item.open_stock');
  });

  it('a function not deployed yet (PGRST202) is a refusal too: nothing was written', async () => {
    const { stub } = stubWith({
      answer: () => ({ data: null, error: { message: 'Could not find the function', code: 'PGRST202' } }),
    });
    const err = (await open(stub.client, [{ itemId: uuid(1), quantity: 5 }]).catch(
      (e: unknown) => e,
    )) as ServiceError;
    expect(err.internalDetail).toMatch(/they were saved with zero on hand\. Add the quantities/);
  });

  it('decides by the code, never the message: a refusal worded like success is still a refusal', async () => {
    const { stub } = stubWith({
      answer: () => ({ data: null, error: { message: 'ok', code: '22023' } }),
    });
    await expect(open(stub.client, [{ itemId: uuid(1), quantity: 5 }])).rejects.toMatchObject({
      code: 'internal_error',
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
    expect(err.internalDetail).toMatch(/so they were saved with zero on hand/);
  });

  it('a lost response whose re-read fails never claims zero on hand', async () => {
    const { stub } = stubWith({ answer: () => 'throw', failRead: true });
    const err = (await open(stub.client, [{ itemId: uuid(1), quantity: 5 }], ITEM).catch(
      (e: unknown) => e,
    )) as ServiceError;
    expect(err.code).toBe('internal_error');
    expect(err.internalDetail).toBe(
      'This item was created, but its opening stock could not be confirmed. Check its quantity on hand before receiving, picking or counting against it.',
    );
    expect(err.internalDetail).not.toMatch(/zero on hand/);
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
    expect(err.internalDetail).toMatch(/could not be confirmed/);
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
    expect(err.internalDetail).toBe(
      'These books were created, but the opening stock of 1500 of 2500 could not be recorded, so those were saved with zero on hand. Add the quantities with a stock adjustment.',
    );
    expect(invalidate).toHaveBeenCalledTimes(1);
  });
});
