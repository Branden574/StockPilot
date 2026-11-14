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

vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => {}) }));

import { lookupIsbn } from '@/lib/books/lookup';
import { reportError } from '@/lib/error-reporter';

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
 *  - opening stock: rpc open_item_stock
 *  - cover rehost: item_images.insert (only when thumbnailUrl present)
 */
function execStub(opts: {
  existingByIsbn?: Array<{ id: string; name: string; barcode: string; quantity_on_hand: number }>;
  plan?: string;
  currentItemCount?: number;
  insertedItems?: Array<{ id: string; barcode: string }>;
  insertError?: { message: string; code?: string } | null;
  /** Fail the opening (open_item_stock refuses: nothing written). */
  openingError?: { message: string; code?: string; hint?: string } | null;
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
    'rpc:open_item_stock': opts.openingError
      ? { data: null, error: opts.openingError }
      : { data: [], error: null },
    'item_images.insert': { data: null, error: null },
  });
}

describe('BooksImportService.execute', () => {
  it('happy path: hoists plan/charter checks ONCE, inserts the books at 0 in one batch and opens them in one call', async () => {
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

    // Exactly ONE inventory_items.insert, every book at 0, and ONE opening.
    const itemInsertArgs = stub.chainArgs.get('inventory_items.insert') ?? [];
    expect(itemInsertArgs.length).toBeGreaterThan(0);
    const payload = itemInsertArgs[0]![0] as Array<Record<string, unknown>>;
    expect(Array.isArray(payload)).toBe(true);
    expect(payload).toHaveLength(2);
    expect(payload[0]!.barcode).toBe(ISBN_A);
    expect(payload[1]!.barcode).toBe(ISBN_B);
    expect(payload.map((r) => r.quantity_on_hand)).toEqual([0, 0]);

    const openings = stub.rpcCalls.filter((c) => c.name === 'open_item_stock');
    expect(openings).toHaveLength(1);
    expect(openings[0]!.args).toEqual({
      p_org_id: 'org-test',
      p_lines: [
        { itemId: 'item-1', quantity: 3 },
        { itemId: 'item-2', quantity: 3 },
      ],
    });
    expect(stub.fromCalls).not.toContain('stock_movements');

    // organizations.select hit ONCE (hoisted plan-limit), not per-row.
    const orgFromCalls = stub.fromCalls.filter((t) => t === 'organizations').length;
    expect(orgFromCalls).toBe(1);
  });

  it('opens nothing when defaultQuantity is 0', async () => {
    const stub = execStub({
      insertedItems: [{ id: 'item-1', barcode: ISBN_A }],
    });

    const svc = new BooksImportService(makeServiceContext(stub.client));
    const result = await svc.execute([ISBN_A], {
      warehouseId: WAREHOUSE_ID,
      defaultQuantity: 0,
    });

    expect(result.created).toBe(1);
    // No opening at all when defaultQty is 0: none of the books has stock.
    expect(stub.rpcCalls.filter((c) => c.name === 'open_item_stock')).toEqual([]);
    expect(stub.fromCalls).not.toContain('stock_movements');
  });

  it('throws plan_limit_exceeded BEFORE the insert when batch would overflow plan limit', async () => {
    // 'free' plan limits items to 10000; seed currentItemCount at 9999
    // so adding 2 books trips the gate (9999 + 2 > 10000).
    const stub = execStub({
      plan: 'free',
      currentItemCount: 9999,
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
    // No opening when the inventory_items insert failed: we never reached
    // that phase.
    expect(stub.rpcCalls.filter((c) => c.name === 'open_item_stock')).toEqual([]);
  });

  // ── Opening stock through the ledger ──────────────────────────────
  // A refused opening leaves every book at 0 with nothing written (the call is
  // one transaction), and the import fails loudly instead of reporting books
  // created with stock no movement explains.
  it('a refused opening throws the zero-on-hand sentence and writes nothing else', async () => {
    const stub = execStub({
      insertedItems: [
        { id: 'item-1', barcode: ISBN_A },
        { id: 'item-2', barcode: ISBN_B },
      ],
      // A viewer granted items:create may insert books but not add stock.
      openingError: { message: 'forbidden', code: '42501', hint: 'stock:adjust' },
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

    // Fails LOUDLY — never "created 2 books, one failed ISBN".
    expect(caught).toBeInstanceOf(ServiceError);
    // A 'conflict': the person reads the sentence itself, never the generic
    // "try again" an internal_error shows.
    expect((caught as ServiceError).code).toBe('conflict');
    expect((caught as ServiceError).message).toBe(
      'These books were saved with zero on hand: their opening quantities could not be recorded. Open each one and use Adjust stock to set its quantity.',
    );
    // Nothing of the ledger is written directly.
    expect(stub.fromCalls).not.toContain('stock_movements');
    expect(stub.fromCalls).not.toContain('item_stock_levels');
    expect(stub.chains.has('inventory_items.update')).toBe(false);
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

// S31: a failed lookup's own text (a book source's quota words, a network
// error) and the Postgres text of a duplicate went into the rows and the
// conflict the assistant's import tools answer. They are reported now, and
// the person reads the app's sentences.
describe("BooksImportService: a failure's own text stays in the report (S31)", () => {
  it('each failed lookup says the fixed sentence, and the preview sends ONE report', async () => {
    const first = new Error('Google Books 429: quota exceeded for this project');
    vi.mocked(lookupIsbn).mockImplementation(async (isbn: string) => {
      throw isbn === ISBN_A ? first : new TypeError('fetch failed');
    });
    const stub = execStub();
    const svc = new BooksImportService(makeServiceContext(stub.client));

    const { rows } = await svc.preview([ISBN_A, ISBN_B]);

    expect(rows.map((r) => [r.status, r.error])).toEqual([
      ['lookup_failed', 'Could not look this ISBN up. Try again later.'],
      ['lookup_failed', 'Could not look this ISBN up. Try again later.'],
    ]);
    expect(JSON.stringify(rows)).not.toMatch(/quota|fetch failed/);
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(vi.mocked(reportError).mock.calls[0]![1]).toEqual({
      tag: 'books_import.lookup',
      organizationId: 'org-test',
      level: 'warning',
      extra: { failed: 2 },
    });
  });

  it('a book with no metadata keeps its own words and is not reported', async () => {
    vi.mocked(lookupIsbn).mockImplementation(async () => null);
    const svc = new BooksImportService(makeServiceContext(execStub().client));
    const { rows } = await svc.preview([ISBN_A]);
    expect(rows[0]!.error).toBe('No metadata found across sources.');
    expect(reportError).not.toHaveBeenCalled();
  });

  it('a duplicate on the batch insert: the conflict carries no Postgres text, details are the batch size only', async () => {
    const pgText = 'duplicate key value violates unique constraint "inventory_items_org_barcode_key"';
    const stub = execStub({ insertError: { message: pgText, code: '23505' } });
    const svc = new BooksImportService(makeServiceContext(stub.client));

    let caught: ServiceError | null = null;
    try {
      await svc.execute([ISBN_A, ISBN_B], { warehouseId: WAREHOUSE_ID, defaultQuantity: 1 });
    } catch (e) {
      caught = e as ServiceError;
    }
    expect(caught).toBeInstanceOf(ServiceError);
    expect(caught!.code).toBe('conflict');
    expect(caught!.message).toBe(
      'Import rejected: at least one book conflicts with an existing item (duplicate SKU or barcode). No books were imported.',
    );
    expect(caught!.details).toEqual({ batchSize: 2 });
    expect(JSON.stringify({ m: caught!.message, d: caught!.details })).not.toContain('inventory_items');
    expect(reportError).toHaveBeenCalledTimes(1);
    const [reported, context] = vi.mocked(reportError).mock.calls[0]!;
    expect((reported as Error).message).toBe(pgText);
    expect(context).toEqual({
      tag: 'books_import.conflict',
      organizationId: 'org-test',
      level: 'warning',
      extra: { batchSize: 2 },
    });
  });
});
