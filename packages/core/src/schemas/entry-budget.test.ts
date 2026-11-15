import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { z } from 'zod';

import {
  ENTRY_BUDGET_MESSAGE,
  exceedsEntryBudget,
  REQUEST_ENTRY_BUDGET,
  withEntryBudget,
} from './entry-budget';
import { postReceiptSchema } from './receipts';

/**
 * Security invariant: a request holds at most REQUEST_ENTRY_BUDGET list
 * entries in total, counted at every depth before any schema runs, so a list
 * inside a list cannot multiply its bounds.
 */

const PO = '0d4b8a52-6f1e-4c3a-9b7d-2e5f8a1c3d4e';
const WH = '7a9c1e3f-5b2d-4e6a-8c0f-1d3b5e7a9c2f';
const LINE = '3c5e7a9b-1d2f-4a6c-8e0b-2f4a6c8e0b1d';
const RECEIPT_RETRY_ID = '5b7d9f1a-3c5e-4b7d-9f1a-3c5e7a9b1d2f';

describe('exceedsEntryBudget', () => {
  it('is 200,000 entries', () => {
    expect(REQUEST_ENTRY_BUDGET).toBe(200_000);
  });

  it('passes a request at the budget and refuses one entry more', () => {
    expect(exceedsEntryBudget({ lines: new Array(200_000).fill(0) })).toBe(false);
    expect(exceedsEntryBudget({ lines: new Array(200_001).fill(0) })).toBe(true);
  });

  it('counts every element of every list, inside objects and inside other lists', () => {
    // 3 (a) + 2 (a[2]) + 2 (c) + 1 (c[0]) + 2 (c[1]) = 10 entries.
    const shape = { a: [1, 2, [3, 4]], b: { c: [[5], [6, 7]] }, d: 'x' };
    expect(exceedsEntryBudget(shape, 10)).toBe(false);
    expect(exceedsEntryBudget(shape, 9)).toBe(true);
  });

  it('adds up lists spread over many small ones (lines times serials)', () => {
    const lines = Array.from({ length: 100 }, () => ({ serials: new Array(100).fill('s') }));
    // 100 lines + 100 x 100 serials.
    expect(exceedsEntryBudget({ lines }, 10_100)).toBe(false);
    expect(exceedsEntryBudget({ lines }, 10_099)).toBe(true);
  });

  it('counts a list before visiting any of its elements', () => {
    const trap = new Array(11).fill(0);
    Object.defineProperty(trap, 0, {
      get() {
        throw new Error('element visited');
      },
    });
    expect(exceedsEntryBudget({ lines: trap }, 10)).toBe(true);
  });

  it('walks a deeply nested body without recursion, within and past the budget', () => {
    // Built the way JSON.parse decodes a body: one list per level.
    const within = JSON.parse(`${'['.repeat(100_000)}${']'.repeat(100_000)}`) as unknown;
    expect(() => exceedsEntryBudget(within)).not.toThrow();
    expect(exceedsEntryBudget(within)).toBe(false);
    const past = JSON.parse(`${'['.repeat(500_000)}${']'.repeat(500_000)}`) as unknown;
    expect(exceedsEntryBudget(past)).toBe(true);
    // A list at the bottom of 100,000 nested objects still counts.
    const nest = (inner: string) =>
      JSON.parse(`${'{"a":'.repeat(100_000)}${inner}${'}'.repeat(100_000)}`) as unknown;
    expect(exceedsEntryBudget(nest('[1,2]'))).toBe(false);
    expect(exceedsEntryBudget(nest(`[${'0,'.repeat(REQUEST_ENTRY_BUDGET)}0]`))).toBe(true);
  });

  it('stops on a shape that refers back to itself', () => {
    const list: unknown[] = [];
    list.push(list);
    expect(exceedsEntryBudget(list, 1_000)).toBe(true);
    const object: Record<string, unknown> = {};
    object.self = object;
    expect(exceedsEntryBudget(object, 1_000)).toBe(true);
  });

  it('passes values with no lists', () => {
    for (const v of [null, undefined, 0, 'x', true, { a: { b: 'c' } }]) {
      expect(exceedsEntryBudget(v)).toBe(false);
    }
  });
});

describe('withEntryBudget', () => {
  let objectParse: ReturnType<typeof vi.spyOn>;
  let arrayParse: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    objectParse = vi.spyOn(z.ZodObject.prototype, '_parse');
    arrayParse = vi.spyOn(z.ZodArray.prototype, '_parse');
  });
  afterEach(() => {
    objectParse.mockRestore();
    arrayParse.mockRestore();
  });

  const schema = withEntryBudget(
    z.object({ lines: z.array(z.array(z.number()).max(10)).max(10) }),
    20,
  );

  it('parses input within the budget exactly as the schema does', () => {
    expect(schema.parse({ lines: [[1, 2], [3]] })).toEqual({ lines: [[1, 2], [3]] });
    expect(objectParse).toHaveBeenCalled();
  });

  it('refuses input over the budget with one plain issue, before the schema parses anything', () => {
    const result = schema.safeParse({
      lines: Array.from({ length: 5 }, () => new Array(5).fill('x')),
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues).toEqual([
      expect.objectContaining({ code: 'custom', message: ENTRY_BUDGET_MESSAGE }),
    ]);
    expect(objectParse).not.toHaveBeenCalled();
    expect(arrayParse).not.toHaveBeenCalled();
  });

  it('keeps the schema types', () => {
    expectTypeOf<z.input<typeof schema>>().toEqualTypeOf<{ lines: number[][] }>();
    expectTypeOf<z.output<typeof schema>>().toEqualTypeOf<{ lines: number[][] }>();
  });
});

describe('postReceiptSchema sits behind the budget', () => {
  /** A receipt of `lines` lines with `serials` serial numbers on each. */
  function receipt(lines: number, serials: number) {
    return {
      purchaseOrderId: PO,
      warehouseId: WH,
      idempotencyKey: RECEIPT_RETRY_ID,
      lines: Array.from({ length: lines }, (_, i) => ({
        poLineId: LINE,
        qtyReceived: serials,
        qtyAccepted: serials,
        serials: Array.from({ length: serials }, (__, j) => `SN-${i}-${j}`),
      })),
    };
  }

  it('takes a receipt of exactly the budget', () => {
    // 20 lines + 20 x 9,999 serials = 200,000 entries.
    expect(postReceiptSchema.safeParse(receipt(20, 9_999)).success).toBe(true);
  });

  it('refuses lines times serials past the budget with the plain message, unparsed', () => {
    const arrayParse = vi.spyOn(z.ZodArray.prototype, '_parse');
    const result = postReceiptSchema.safeParse(receipt(21, 9_999));
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((i) => i.message)).toEqual([ENTRY_BUDGET_MESSAGE]);
    expect(arrayParse).not.toHaveBeenCalled();
    arrayParse.mockRestore();
  });
});
