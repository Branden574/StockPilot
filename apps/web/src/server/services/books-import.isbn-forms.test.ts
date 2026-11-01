import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The assistant's bulk ISBN import (BooksImportService, the AI tool's
 * preview and execute) is the second books import, beside Books > Bulk ISBN
 * import (InventoryService.bulkCreate). It compared ISBN strings exactly, so a
 * book stocked under its ISBN-13 came in again when the list gave its ISBN-10,
 * and a list that carried both forms of one book created it twice (B26). It
 * now matches a book by either form, as the dashboard import does.
 */

vi.mock('@/lib/auth/warehouse', () => ({
  getWarehouseAccess: vi.fn(async () => ({
    readableIds: ['wh-a'],
    writableIds: ['wh-a'],
    hasAllAccess: true,
    primaryWarehouseId: 'wh-a',
  })),
  assertWarehouseAccess: vi.fn(),
  forcedWarehouseId: vi.fn(async () => null),
  ForbiddenError: class ForbiddenError extends Error {},
}));
vi.mock('@/lib/books/lookup', async () => {
  const actual = await vi.importActual<typeof import('@/lib/books/lookup')>('@/lib/books/lookup');
  return {
    ...actual,
    lookupIsbn: vi.fn(async (isbn: string) => ({
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
    })),
  };
});

import { makeServiceContext, makeSupabaseStub, servedLikePostgrest } from '@/test/supabase-mock';

import { BooksImportService } from './books-import';

// One book, both forms of its ISBN (a checksum-valid pair), and another book.
const ISBN10 = '0306406152';
const ISBN13 = '9780306406157';
const OTHER13 = '9780140449136';

type Stored = {
  id: string;
  organization_id: string;
  name: string;
  barcode: string;
  quantity_on_hand: number;
  deleted_at: string | null;
};

function harness(stored: Stored[], opts: { pairReadFails?: boolean } = {}) {
  const stub = makeSupabaseStub({
    'inventory_items.select': servedLikePostgrest(stored),
    'organizations.select': { data: { plan: 'enterprise' }, error: null },
    'warehouse_charters.select': opts.pairReadFails
      ? { data: null, error: { message: 'upstream timeout' } }
      : { data: { charter_id: 'charter-north' }, error: null },
    'inventory_items.insert': { data: [], error: null },
  });
  const svc = new BooksImportService(
    makeServiceContext(stub.client, { organizationId: 'org-1' }) as never,
  );
  const inserts = () =>
    [...stub.chainsAll.entries()].flatMap(([table, chains]) =>
      chains.filter((c) => c.includes('insert')).map(() => table),
    );
  return { svc, inserts };
}

const book = (barcode: string, over: Partial<Stored> = {}): Stored => ({
  id: `stored-${barcode}`,
  organization_id: 'org-1',
  name: `Stocked ${barcode}`,
  barcode,
  quantity_on_hand: 3,
  deleted_at: null,
  ...over,
});

beforeEach(() => vi.clearAllMocks());

describe("the assistant's bulk ISBN import matches a book by either form of its ISBN", () => {
  it('an ISBN-10 is already there when the book is stocked under its ISBN-13', async () => {
    const { svc } = harness([book(ISBN13)]);
    const { rows } = await svc.preview([ISBN10]);
    expect(rows[0]).toMatchObject({
      status: 'duplicate_in_db',
      existing: { id: `stored-${ISBN13}` },
    });
  });

  it('an ISBN-13 is already there when the book is stocked under its ISBN-10', async () => {
    const { svc } = harness([book(ISBN10)]);
    const { rows } = await svc.preview([ISBN13]);
    expect(rows[0]).toMatchObject({ status: 'duplicate_in_db' });
  });

  it("never matches another organization's book, or one in Recovery", async () => {
    const { svc } = harness([
      book(ISBN13, { organization_id: 'org-2' }),
      book(ISBN10, { deleted_at: '2026-10-01T00:00:00Z' }),
    ]);
    const { rows } = await svc.preview([ISBN13]);
    expect(rows[0]).toMatchObject({ status: 'ready' });
  });

  it('a list that carries both forms of one book takes the first and calls the second a repeat', async () => {
    const { svc } = harness([]);
    const { rows } = await svc.preview([ISBN10, OTHER13, ISBN13]);
    expect(rows.map((r) => r.status)).toEqual(['ready', 'ready', 'duplicate_in_list']);
  });
});

describe("the assistant's bulk ISBN import: the warehouse and charter pairing", () => {
  it('refuses honestly, with nothing written, when the pairing cannot be read', async () => {
    const { svc, inserts } = harness([], { pairReadFails: true });
    const err = (await svc
      .execute([OTHER13], { warehouseId: 'wh-a', charterId: 'charter-north' })
      .catch((e: unknown) => e)) as { code: string; message: string };

    expect(err.code).toBe('internal_error');
    expect(err.message).not.toMatch(/not serviced/i);
    expect(inserts()).toEqual([]);
  });
});
