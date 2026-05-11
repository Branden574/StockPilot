import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

// Mock the warehouse helpers — books-import calls them directly. The default
// mock gives full access; individual tests override per-call.
vi.mock('@/lib/auth/warehouse', () => ({
  getWarehouseAccess: vi.fn(async () => ({
    readableIds: ['wh-a'],
    writableIds: ['wh-a'],
    hasAllAccess: true,
    primaryWarehouseId: 'wh-a',
  })),
  assertWarehouseAccess: vi.fn(),
  forcedWarehouseId: vi.fn(async () => null),
  ForbiddenError: class ForbiddenError extends Error {
    readonly code = 'forbidden' as const;
  },
}));

// Stub requireOrgContext so any incidental call doesn't blow up trying to read
// Next.js headers in the test environment.
vi.mock('@/lib/auth/session', () => ({
  requireOrgContext: vi.fn(async () => ({
    userId: 'user-test',
    organizationId: 'org-test',
    role: 'admin',
  })),
}));

// Mock the upstream book-lookup pipeline so tests don't hit the network.
// Each test seeds the metadata it wants returned per-ISBN; default is a
// minimal title-only response.
vi.mock('@/lib/books/lookup', async () => {
  const actual = await vi.importActual<typeof import('@/lib/books/lookup')>(
    '@/lib/books/lookup',
  );
  return {
    ...actual,
    lookupIsbn: vi.fn(async (isbn: string) => ({
      isbn,
      title: `Book ${isbn}`,
      authors: ['Author A'],
      publisher: null,
      publishedDate: null,
      description: null,
      pageCount: null,
      thumbnailUrl: null,
      grade: null,
      source: 'google-books' as const,
    })),
  };
});

import { lookupIsbn } from '@/lib/books/lookup';

import { BooksImportService } from './books-import';
import { ServiceError } from './context';

const WAREHOUSE_ID = 'wh-a';

// Two real-looking ISBN-13 values; the import service normalizes via
// normalizeIsbn which only checks length 10 or 13 of digits.
const ISBN_A = '9780140449136';
const ISBN_B = '9780393310733';

beforeEach(() => {
  vi.clearAllMocks();
});

/**
 * Build a supabase stub that handles every read/write a successful execute()
 * walk needs:
 *  - preview: inventory_items.select (existence check for already-imported ISBNs)
 *  - hoisted plan-limit: organizations.select (plan), inventory_items.select (count)
 *  - hoisted charter check (only when charterId !== null) — caller seeds
 *  - batch write: inventory_items.insert
 *  - batch stock movements: stock_movements.insert
 *  - cover rehost: item_images.insert (only when thumbnailUrl present)
 */
function execStub(opts: {
  existingByIsbn?: Array<{ id: string; name: string; barcode: string; quantity_on_hand: number }>;
  plan?: string;
  currentItemCount?: number;
  insertedItems?: Array<{ id: string; barcode: string }>;
  insertError?: { message: string; code?: string } | null;
} = {}) {
  return makeSupabaseStub({
    // Preview: rows that already exist by barcode.
    'inventory_items.select': {
      data: opts.existingByIsbn ?? [],
      error: null,
      count: opts.currentItemCount ?? 0,
    },
    'organizations.select': {
      data: { plan: opts.plan ?? 'pro' },
      error: null,
    },
    'inventory_items.insert': opts.insertError
      ? { data: null, error: opts.insertError }
      : { data: opts.insertedItems ?? [], error: null },
    'stock_movements.insert': { data: null, error: null },
    'item_images.insert': { data: null, error: null },
  });
}

describe('BooksImportService.execute', () => {
  it('happy path: hoists plan/charter checks ONCE, batches inventory_items + stock_movements inserts', async () => {
    const stub = execStub({
      plan: 'pro',
      currentItemCount: 5,
      insertedItems: [
        { id: 'item-1', barcode: ISBN_A },
        { id: 'item-2', barcode: ISBN_B },
      ],
    });

    const svc = new BooksImportService(makeServiceContext(stub.client));
    const result = await svc.execute([ISBN_A, ISBN_B], {
      warehouseId: WAREHOUSE_ID,
      defaultQuantity: 3,
    });

    expect(result.created).toBe(2);
    expect(result.skipped).toBe(0);
    expect(result.failed).toEqual([]);

    // Exactly ONE inventory_items.insert and ONE stock_movements.insert.
    const itemInsertArgs = stub.chainArgs.get('inventory_items.insert') ?? [];
    expect(itemInsertArgs.length).toBeGreaterThan(0);
    const payload = itemInsertArgs[0]![0] as Array<Record<string, unknown>>;
    expect(Array.isArray(payload)).toBe(true);
    expect(payload).toHaveLength(2);
    expect(payload[0]!.barcode).toBe(ISBN_A);
    expect(payload[1]!.barcode).toBe(ISBN_B);

    const movementInsertArgs = stub.chainArgs.get('stock_movements.insert') ?? [];
    expect(movementInsertArgs.length).toBe(1);
    const movements = movementInsertArgs[0]![0] as Array<Record<string, unknown>>;
    expect(movements).toHaveLength(2);
    expect(movements[0]!.movement_type).toBe('initial');
    expect(movements[0]!.quantity_change).toBe(3);

    // organizations.select hit ONCE (hoisted plan-limit), not per-row.
    const orgFromCalls = stub.fromCalls.filter((t) => t === 'organizations').length;
    expect(orgFromCalls).toBe(1);
  });

  it('skips stock_movements insert entirely when defaultQuantity is 0', async () => {
    const stub = execStub({
      insertedItems: [{ id: 'item-1', barcode: ISBN_A }],
    });

    const svc = new BooksImportService(makeServiceContext(stub.client));
    const result = await svc.execute([ISBN_A], {
      warehouseId: WAREHOUSE_ID,
      defaultQuantity: 0,
    });

    expect(result.created).toBe(1);
    // No stock_movements work at all when defaultQty is 0 — none of the
    // books moved, so no initial movement to record.
    const movementCalls = stub.fromCalls.filter((t) => t === 'stock_movements').length;
    expect(movementCalls).toBe(0);
  });

  it('throws plan_limit_exceeded BEFORE the insert when batch would overflow plan limit', async () => {
    // 'free' plan limits items to 100; seed currentItemCount at 99 so
    // adding 2 books trips the gate (99 + 2 > 100).
    const stub = execStub({
      plan: 'free',
      currentItemCount: 99,
      insertedItems: [], // would never run
    });

    const svc = new BooksImportService(makeServiceContext(stub.client));

    let caught: unknown = null;
    try {
      await svc.execute([ISBN_A, ISBN_B], {
        warehouseId: WAREHOUSE_ID,
        defaultQuantity: 1,
      });
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(ServiceError);
    expect((caught as ServiceError).code).toBe('plan_limit_exceeded');

    // Crucially: no inventory_items.insert happened. The whole batch is
    // rejected upfront — no partial state.
    const itemInserts = stub.fromCalls.filter((t) => t === 'inventory_items').length;
    // .select for the preview existence check + .select for the count is
    // expected; .insert is NOT expected.
    const insertChain = stub.chains.get('inventory_items.insert');
    expect(insertChain).toBeUndefined();
    expect(itemInserts).toBeGreaterThan(0);
  });

  it('failure contract: 23505 on the batch insert rejects ALL rows with a conflict ServiceError', async () => {
    const stub = execStub({
      insertError: { message: 'duplicate key value violates unique constraint', code: '23505' },
    });

    const svc = new BooksImportService(makeServiceContext(stub.client));

    let caught: unknown = null;
    try {
      await svc.execute([ISBN_A, ISBN_B], {
        warehouseId: WAREHOUSE_ID,
        defaultQuantity: 1,
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ServiceError);
    expect((caught as ServiceError).code).toBe('conflict');
    // No stock_movements insert when the inventory_items insert failed —
    // we never reached that phase.
    const movementCalls = stub.fromCalls.filter((t) => t === 'stock_movements').length;
    expect(movementCalls).toBe(0);
  });

  it('routes ISBNs already in the org to result.skipped without touching the insert path', async () => {
    const stub = execStub({
      existingByIsbn: [
        { id: 'existing-1', name: 'Already Imported', barcode: ISBN_A, quantity_on_hand: 7 },
      ],
      insertedItems: [{ id: 'item-new', barcode: ISBN_B }],
    });

    const svc = new BooksImportService(makeServiceContext(stub.client));
    const result = await svc.execute([ISBN_A, ISBN_B], {
      warehouseId: WAREHOUSE_ID,
      defaultQuantity: 1,
    });

    expect(result.skipped).toBe(1);
    expect(result.created).toBe(1);

    const itemInsertArgs = stub.chainArgs.get('inventory_items.insert') ?? [];
    const payload = itemInsertArgs[0]![0] as Array<Record<string, unknown>>;
    // Only the NEW ISBN reaches the batch insert — the duplicate is
    // filtered out before any DB write.
    expect(payload).toHaveLength(1);
    expect(payload[0]!.barcode).toBe(ISBN_B);
  });

  it('records lookup_failed rows in result.failed[] without short-circuiting the rest of the batch', async () => {
    // Force lookup to fail for one ISBN, succeed for the other.
    vi.mocked(lookupIsbn).mockImplementation(async (isbn: string) => {
      if (isbn === ISBN_A) return null;
      return {
        isbn,
        title: `Book ${isbn}`,
        authors: [],
        publisher: null,
        publishedDate: null,
        description: null,
        pageCount: null,
        thumbnailUrl: null,
        grade: null,
        source: 'google-books' as const,
      };
    });

    const stub = execStub({
      insertedItems: [{ id: 'item-1', barcode: ISBN_B }],
    });
    const svc = new BooksImportService(makeServiceContext(stub.client));
    const result = await svc.execute([ISBN_A, ISBN_B], {
      warehouseId: WAREHOUSE_ID,
      defaultQuantity: 1,
    });

    expect(result.created).toBe(1);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]!.isbn).toBe(ISBN_A);

    const itemInsertArgs = stub.chainArgs.get('inventory_items.insert') ?? [];
    const payload = itemInsertArgs[0]![0] as Array<Record<string, unknown>>;
    expect(payload).toHaveLength(1);
    expect(payload[0]!.barcode).toBe(ISBN_B);
  });
});
