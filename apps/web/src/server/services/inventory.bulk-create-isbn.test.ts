import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The bulk ISBN import (Books > Bulk ISBN import, InventoryService.bulkCreate)
 * skips a book the organization already has. It used to compare the barcode
 * string exactly, so the same book came in again whenever the list gave the
 * other form of its ISBN (0306406152 for a book stocked as 9780306406157), and
 * one import that carried both forms, or the same ISBN twice, created two
 * records of one book. A book's ISBN is now matched in both forms (the core
 * isbnSearchKeys rule the search and the Book Order Totals report use), against
 * the records already there and against the rows earlier in the same import.
 * A product's barcode is still matched exactly.
 */

const { auditMany } = vi.hoisted(() => ({
  auditMany: vi.fn(async (payloads: readonly unknown[]) => ({ written: payloads.length, lost: 0 })),
}));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => {}) }));
vi.mock('./lib/inventory-list-cache', () => ({ invalidateInventoryListAfterWrite: vi.fn() }));
vi.mock('./audit', () => ({ audit: vi.fn(async () => undefined), auditMany }));
vi.mock('./integration-events', () => ({ dispatchEvent: vi.fn(async () => undefined) }));
vi.mock('@/lib/auth/warehouse', () => ({
  getWarehouseAccess: vi.fn(async () => ({
    readableIds: ['wh-1'],
    writableIds: ['wh-1'],
    hasAllAccess: true,
    primaryWarehouseId: 'wh-1',
  })),
  assertWarehouseAccess: vi.fn(),
  forcedWarehouseId: vi.fn(async () => null),
  ForbiddenError: class ForbiddenError extends Error {},
}));

import {
  callArgs,
  makeServiceContext,
  makeSupabaseStub,
  servedLikePostgrest,
} from '@/test/supabase-mock';

import { InventoryService } from './inventory';

// One book, both forms of its ISBN (a checksum-valid pair).
const ISBN10 = '0306406152';
const ISBN13 = '9780306406157';
// Another book, unrelated.
const OTHER13 = '9780140449136';

type Stored = { id: string; organization_id: string; barcode: string; deleted_at: string | null };

function harness(stored: Stored[]) {
  const inserted: Array<Record<string, unknown>> = [];
  const stub = makeSupabaseStub({
    'organizations.select': { data: { plan: 'enterprise' }, error: null },
    'inventory_items.select': servedLikePostgrest(stored),
    'inventory_items.insert': (call) => {
      const rows = (callArgs(call, 'insert')?.[0] ?? []) as Array<Record<string, unknown>>;
      inserted.push(...rows);
      return {
        data: rows.map((_, i) => ({
          id: `new-${inserted.length - rows.length + i}`,
          quantity_on_hand: 0,
        })),
        error: null,
      };
    },
  });
  const svc = new InventoryService(
    makeServiceContext(stub.client, { organizationId: 'org-1' }) as never,
  );
  return { svc, inserted };
}

function book(barcode: string, name = `Book ${barcode}`) {
  return {
    name,
    barcode,
    itemType: 'book' as const,
    quantityOnHand: 0,
    unitCost: 0,
    retailPrice: 0,
  };
}

const row = (barcode: string, over: Partial<Stored> = {}): Stored => ({
  id: `stored-${barcode}`,
  organization_id: 'org-1',
  barcode,
  deleted_at: null,
  ...over,
});

beforeEach(() => vi.clearAllMocks());

describe('bulk ISBN import: a book already in the organization is matched by its ISBN', () => {
  it('skips an ISBN-10 when the book is stocked under its ISBN-13', async () => {
    const { svc, inserted } = harness([row(ISBN13)]);
    const res = await svc.bulkCreate({ warehouseId: 'wh-1', items: [book(ISBN10)] });
    expect(res).toMatchObject({ created: 0, skipped: 1 });
    expect(inserted).toHaveLength(0);
  });

  it('skips an ISBN-13 when the book is stocked under its ISBN-10', async () => {
    const { svc, inserted } = harness([row(ISBN10)]);
    const res = await svc.bulkCreate({ warehouseId: 'wh-1', items: [book(ISBN13)] });
    expect(res).toMatchObject({ created: 0, skipped: 1 });
    expect(inserted).toHaveLength(0);
  });

  it('finds the stored digits from a hyphenated ISBN', async () => {
    const { svc, inserted } = harness([row(ISBN10)]);
    const res = await svc.bulkCreate({
      warehouseId: 'wh-1',
      items: [book('978-0-306-40615-7')],
    });
    expect(res).toMatchObject({ created: 0, skipped: 1 });
    expect(inserted).toHaveLength(0);
  });

  it("never matches another organization's record", async () => {
    const { svc, inserted } = harness([row(ISBN13, { organization_id: 'org-2' })]);
    const res = await svc.bulkCreate({ warehouseId: 'wh-1', items: [book(ISBN10)] });
    expect(res).toMatchObject({ created: 1, skipped: 0 });
    expect(inserted.map((r) => r.barcode)).toEqual([ISBN10]);
  });
});

describe('bulk ISBN import: one import never creates two records of one book', () => {
  it('creates one record when the import carries both forms of one ISBN', async () => {
    const { svc, inserted } = harness([]);
    const res = await svc.bulkCreate({
      warehouseId: 'wh-1',
      items: [book(ISBN10), book(OTHER13), book(ISBN13)],
    });
    expect(res).toMatchObject({ created: 2, skipped: 1 });
    // The first row of the book wins; the unrelated book is untouched.
    expect(inserted.map((r) => r.barcode)).toEqual([ISBN10, OTHER13]);
  });

  it('creates one record when the import carries the same ISBN twice', async () => {
    const { svc, inserted } = harness([]);
    const res = await svc.bulkCreate({
      warehouseId: 'wh-1',
      items: [book(ISBN13, 'First copy'), book(ISBN13, 'Second copy')],
    });
    expect(res).toMatchObject({ created: 1, skipped: 1 });
    expect(inserted.map((r) => r.name)).toEqual(['First copy']);
  });
});

describe('bulk create: a product barcode is matched exactly, as before', () => {
  it('does not treat a product barcode as an ISBN of another form', async () => {
    const { svc, inserted } = harness([row(ISBN13)]);
    const res = await svc.bulkCreate({
      warehouseId: 'wh-1',
      items: [{ ...book(ISBN10), itemType: 'product' as const }],
    });
    expect(res).toMatchObject({ created: 1, skipped: 0 });
    expect(inserted.map((r) => r.barcode)).toEqual([ISBN10]);
  });

  it('still skips a product whose exact barcode is already there', async () => {
    const { svc, inserted } = harness([row('012345678905')]);
    const res = await svc.bulkCreate({
      warehouseId: 'wh-1',
      items: [{ ...book('012345678905'), itemType: 'product' as const }],
    });
    expect(res).toMatchObject({ created: 0, skipped: 1 });
    expect(inserted).toHaveLength(0);
  });
});
