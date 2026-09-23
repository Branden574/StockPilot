import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * PO imports keep every id list under the URL limits.
 *
 * - The search puts matching supplier AND PO ids in ONE `or=` parameter next
 *   to the ilike terms and list()'s long select. Capping each list at 100 on
 *   its own still built an ~8.4 KB URL (over the local gateway's limit), so
 *   the two lists share one character budget and the result says when it had
 *   to drop matches. Measured on REAL postgrest-js URLs below.
 * - approve()'s stamp and cancel()'s cleanup batch their writes and reads;
 *   whatever committed is audited and invalidated, and an unread keep-check
 *   still archives nothing.
 */

const { mockAudit, mockAuditMany, reportError, invalidate } = vi.hoisted(() => ({
  mockAudit: vi.fn(async () => {}),
  mockAuditMany: vi.fn(async (rows: readonly unknown[]) => ({ written: rows.length, lost: 0 })),
  reportError: vi.fn(async () => undefined),
  invalidate: vi.fn(),
}));
vi.mock('./audit', () => ({ audit: mockAudit, auditMany: mockAuditMany }));
vi.mock('@/lib/po-parser', () => ({ parsePoFile: vi.fn() }));
vi.mock('@/lib/po-scan/extract', () => ({ extractPoFromMedia: vi.fn(), SCAN_MODEL_NAME: 'mock' }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn() }));
vi.mock('@/lib/error-reporter', () => ({ reportError }));
vi.mock('./lib/inventory-list-cache', () => ({ invalidateInventoryListAfterWrite: invalidate }));

import { createClient } from '@supabase/supabase-js';

import { DEFAULT_MODULE_IDS, type ModuleId } from '@stockpilot/core';

import {
  inFilters,
  makeServiceContext,
  makeSupabaseStub,
  type MockCall,
} from '@/test/supabase-mock';

import { PoImportsService, takeInTurns } from './po-imports';

const uuid = (i: number, p = '0') => `${p.repeat(8)}-0000-4000-8000-${String(i).padStart(12, '0')}`;
const WH_UUID = 'aaaaaaaa-0000-4000-8000-000000000001';
const MODULES = new Set<ModuleId>([...DEFAULT_MODULE_IDS, 'po_imports' as ModuleId]);

function inList(call: MockCall, column: string): string[] {
  return (inFilters(call).find(([c]) => c === column)?.[1] ?? []) as string[];
}
const tags = () =>
  reportError.mock.calls.map((c) => (c as unknown as [Error, { tag: string }])[1].tag);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('search filter URL length (real postgrest-js URLs)', () => {
  /** A real supabase-js client whose fetch answers from memory and records
   *  every PostgREST URL, so the lengths below are the ones production sends. */
  function realClient(opts: { suppliers: number; pos: number; failSuppliers?: boolean }) {
    const urls: string[] = [];
    const fetchImpl = async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input instanceof Request ? input.url : input);
      urls.push(url);
      const path = new URL(url).pathname;
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json', 'content-range': '0-0/0' },
        });
      if (path.endsWith('/suppliers')) {
        if (opts.failSuppliers) return json({ message: 'boom', code: 'XX000' }, 500);
        return json(Array.from({ length: opts.suppliers }, (_, i) => ({ id: uuid(i, 's') })));
      }
      if (path.endsWith('/purchase_orders')) {
        return json(Array.from({ length: opts.pos }, (_, i) => ({ id: uuid(i, 'p') })));
      }
      return json([]);
    };
    const client = createClient('https://proj.supabase.co', 'anon-key', {
      global: { fetch: fetchImpl },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const svc = new PoImportsService(
      makeServiceContext(client, { enabledModules: MODULES }) as never,
    );
    const importUrls = () =>
      urls
        .filter((u) => new URL(u).pathname.endsWith('/po_imports'))
        .map((u) => {
          const x = new URL(u);
          return { length: x.pathname.length + x.search.length, search: x.search };
        });
    return { svc, importUrls };
  }

  it('keeps list() and count() under 6,000 characters with 101 supplier and 101 PO matches, and says it capped', async () => {
    const { svc, importUrls } = realClient({ suppliers: 101, pos: 101 });
    await svc.list({ q: 'acme', limit: 25, statuses: ['parsed', 'needs_review'] });
    await svc.count({ q: 'acme', statuses: ['parsed', 'needs_review'] });
    const built = importUrls();
    expect(built).toHaveLength(2);
    for (const u of built) {
      expect(u.length).toBeLessThan(6_000);
      expect(u.search).toContain('vendor_id.in.');
      expect(u.search).toContain('approved_po_id.in.');
    }
    expect(await svc.searchCapped('acme')).toBe(true);
  });

  it('stays under 6,000 characters for a 120-character non-ASCII search term', async () => {
    const { svc, importUrls } = realClient({ suppliers: 101, pos: 101 });
    const term = 'é'.repeat(120);
    await svc.list({ q: term, limit: 25 });
    expect(importUrls()[0]?.length).toBeLessThan(6_000);
  });

  it('includes every match and does not cap when they fit', async () => {
    const { svc, importUrls } = realClient({ suppliers: 20, pos: 20 });
    await svc.list({ q: 'acme' });
    const search = decodeURIComponent(importUrls()[0]?.search ?? '');
    expect(search).toContain(uuid(19, 's'));
    expect(search).toContain(uuid(19, 'p'));
    expect(await svc.searchCapped('acme')).toBe(false);
  });

  it('throws when a lookup fails instead of silently searching without it', async () => {
    const { svc } = realClient({ suppliers: 1, pos: 1, failSuppliers: true });
    await expect(svc.list({ q: 'acme' })).rejects.toMatchObject({ code: 'internal_error' });
  });

  it('takeInTurns splits the budget fairly and gives unused share to the other list', () => {
    const a = Array.from({ length: 101 }, (_, i) => uuid(i, 'a'));
    const b = Array.from({ length: 5 }, (_, i) => uuid(i, 'b'));
    const { taken, capped } = takeInTurns([a, b], 39 * 60);
    expect(taken[1]).toHaveLength(5);
    expect(taken[0]).toHaveLength(55);
    expect(capped).toBe(true);
  });
});

describe('approve() stamps 150 import-created items in batches', () => {
  function approveStub(update: (call: MockCall, n: number) => { data: unknown; error: unknown }) {
    let lineReads = 0;
    let updates = 0;
    const created = Array.from({ length: 150 }, (_, i) => ({ item_id: uuid(i, 'c') }));
    const stub = makeSupabaseStub({
      'po_imports.select': {
        data: { id: 'imp-1', organization_id: 'org-test', status: 'parsed', warehouse_id: WH_UUID },
        error: null,
      },
      'po_import_lines.select': () => {
        lineReads += 1;
        return lineReads === 1
          ? {
              data: [
                {
                  id: 'line-1',
                  line_number: 1,
                  line_type: 'inventory',
                  item_id: 'item-A',
                  qty_ordered_original: 2,
                  unit_cost: 5,
                  line_total: 10,
                },
              ],
              error: null,
            }
          : { data: created, error: null };
      },
      'rpc:next_po_number': { data: 'PO-100', error: null },
      'locations.select': { data: { id: 'loc-chosen' }, error: null },
      'purchase_orders.insert': { data: { id: 'new-po' }, error: null },
      'purchase_order_items.insert': { data: null, error: null },
      'inventory_items.update': (call) => {
        updates += 1;
        return update(call, updates) as never;
      },
      'po_imports.update': { data: { id: 'imp-1' }, error: null },
    });
    return stub;
  }
  const approveInput = {
    poImportId: 'imp-1',
    vendorId: 'vendor-1',
    warehouseId: WH_UUID,
    locationId: 'loc-chosen',
    lineOverrides: [],
  } as never;

  it('stamps every created item, at most 100 per write', async () => {
    const lists: string[][] = [];
    const stub = approveStub((call) => {
      lists.push(inList(call, 'id'));
      return { data: null, error: null };
    });
    const res = await new PoImportsService(makeServiceContext(stub.client) as never).approve(
      approveInput,
    );
    expect(res.poId).toBe('new-po');
    expect(lists.map((l) => l.length)).toEqual([100, 50]);
  });

  it('reports a failed stamp batch with the unstamped count and still approves', async () => {
    const stub = approveStub((_call, n) =>
      n === 2 ? { data: null, error: { message: 'boom' } } : { data: null, error: null },
    );
    const res = await new PoImportsService(makeServiceContext(stub.client) as never).approve(
      approveInput,
    );
    expect(res.poId).toBe('new-po');
    const call = reportError.mock.calls.find(
      (c) =>
        (c as unknown as [Error, { tag: string }])[1].tag ===
        'po_import.approve.stamp_created_items',
    ) as unknown as [Error, { extra: Record<string, unknown> }];
    expect(call[1].extra).toMatchObject({ stamped: 100, unstamped: 50 });
  });
});

describe('cancel() cleans up 250 import-created items in batches', () => {
  const created = Array.from({ length: 250 }, (_, i) => uuid(i, 'c'));
  const onLivePo = uuid(245, 'c');

  function cancelStub(
    opts: {
      keepFail?: number;
      updateFail?: number;
    } = {},
  ) {
    let keepReads = 0;
    let updates = 0;
    const lists = { cand: [] as string[][], keep: [] as string[][], update: [] as string[][] };
    const stub = makeSupabaseStub({
      'po_imports.update': { data: { id: 'imp-1' }, error: null },
      'po_import_lines.select': { data: created.map((item_id) => ({ item_id })), error: null },
      'inventory_items.select': (call) => {
        const list = inList(call, 'id');
        lists.cand.push(list);
        return { data: list.map((id) => ({ id, name: 'x' })), error: null };
      },
      'purchase_order_items.select': (call) => {
        keepReads += 1;
        const list = inList(call, 'item_id');
        lists.keep.push(list);
        if (keepReads === opts.keepFail) return { data: null, error: { message: 'timeout' } };
        return {
          data: list
            .filter((id) => id === onLivePo)
            .map((item_id) => ({ item_id, po: { status: 'ordered' } })),
          error: null,
        };
      },
      'inventory_items.update': (call) => {
        updates += 1;
        const list = inList(call, 'id');
        lists.update.push(list);
        if (updates === opts.updateFail) return { data: null, error: { message: 'boom' } };
        return { data: list.map((id) => ({ id, name: 'x' })), error: null };
      },
    });
    return { stub, lists };
  }
  // The archive rows go through ONE batched write (auditMany), never one
  // audit() call per item.
  const archived = () => {
    expect(
      mockAudit.mock.calls.some(
        (c) => (c as unknown as [{ event?: string }])[0]?.event === 'inventory.item.archived',
      ),
    ).toBe(false);
    expect(mockAuditMany).toHaveBeenCalledTimes(1);
    return (mockAuditMany.mock.calls[0]![0] as Array<{ event?: string }>).filter(
      (a) => a.event === 'inventory.item.archived',
    );
  };

  it('reads candidates and the keep-check and archives in batches, keeping an item on a live PO from the last batch', async () => {
    const { stub, lists } = cancelStub();
    await new PoImportsService(makeServiceContext(stub.client) as never).cancel('imp-1');
    expect(lists.cand.map((l) => l.length)).toEqual([100, 100, 50]);
    expect(lists.keep.map((l) => l.length)).toEqual([100, 100, 50]);
    expect(lists.update.map((l) => l.length)).toEqual([100, 100, 49]);
    expect(lists.update.flat()).not.toContain(onLivePo);
    expect(archived()).toHaveLength(249);
  });

  it('archives NOTHING when a keep-check batch fails', async () => {
    const { stub } = cancelStub({ keepFail: 3 });
    await new PoImportsService(makeServiceContext(stub.client) as never).cancel('imp-1');
    expect(stub.chainsAll.get('inventory_items.update')).toBeUndefined();
    expect(tags()).toContain('po_import.cancel.archive_created_items.keep_check');
  });

  it('audits and invalidates the archived part when a later archive batch fails', async () => {
    const { stub } = cancelStub({ updateFail: 2 });
    await new PoImportsService(makeServiceContext(stub.client) as never).cancel('imp-1');
    expect(archived()).toHaveLength(100);
    expect(invalidate).toHaveBeenCalledWith('org-test', 'po_import.cancel');
    expect(tags()).toContain('po_import.cancel.archive_created_items.archive');
  });
});

describe('resolveLineResults with 250 mapped lines', () => {
  it("reads the mapped items' categories in batches of at most 100", async () => {
    const lines = Array.from({ length: 250 }, (_, i) => ({
      id: uuid(i, 'l'),
      po_import_id: 'imp-1',
      line_number: i + 1,
      line_type: 'inventory',
      description: `Line ${i}`,
      item_id: uuid(i, 'i'),
      suggested_item_id: null,
    }));
    const lists: string[][] = [];
    const stub = makeSupabaseStub({
      'po_imports.select': {
        data: { id: 'imp-1', organization_id: 'org-test', status: 'parsed', warehouse_id: WH_UUID },
        error: null,
      },
      'po_import_lines.select': { data: lines, error: null },
      'inventory_items.select': (call) => {
        const list = inList(call, 'id');
        lists.push(list);
        return { data: list.map((id) => ({ id, category_id: null })), error: null };
      },
    });
    const svc = new PoImportsService(
      makeServiceContext(stub.client, { enabledModules: MODULES }) as never,
    );
    const out = await svc.resolveLineResults('imp-1');
    expect(lists.map((l) => l.length)).toEqual([100, 100, 50]);
    expect(Object.keys(out).length).toBeGreaterThan(0);
  });

  it('throws when a category batch fails', async () => {
    const lines = Array.from({ length: 250 }, (_, i) => ({
      id: uuid(i, 'l'),
      po_import_id: 'imp-1',
      line_number: i + 1,
      line_type: 'inventory',
      item_id: uuid(i, 'i'),
      suggested_item_id: null,
    }));
    let n = 0;
    const stub = makeSupabaseStub({
      'po_imports.select': {
        data: { id: 'imp-1', organization_id: 'org-test', status: 'parsed', warehouse_id: WH_UUID },
        error: null,
      },
      'po_import_lines.select': { data: lines, error: null },
      'inventory_items.select': () => {
        n += 1;
        return n === 2 ? { data: null, error: { message: 'boom' } } : { data: [], error: null };
      },
    });
    const svc = new PoImportsService(
      makeServiceContext(stub.client, { enabledModules: MODULES }) as never,
    );
    await expect(svc.resolveLineResults('imp-1')).rejects.toMatchObject({ code: 'internal_error' });
  });
});

describe('approve() with an ownership charter and 150 linked lines', () => {
  it('reads the linked items in batches of at most 100', async () => {
    const lines = Array.from({ length: 150 }, (_, i) => ({
      id: uuid(i, 'l'),
      line_number: i + 1,
      line_type: 'inventory',
      item_id: uuid(i, 'i'),
      qty_ordered_original: 1,
      unit_cost: 1,
      line_total: 1,
    }));
    let lineReads = 0;
    const lists: string[][] = [];
    const stub = makeSupabaseStub({
      'po_imports.select': {
        data: { id: 'imp-1', organization_id: 'org-test', status: 'parsed', warehouse_id: WH_UUID },
        error: null,
      },
      'po_import_lines.select': () => {
        lineReads += 1;
        return lineReads === 1 ? { data: lines, error: null } : { data: [], error: null };
      },
      // Every linked item already sits under the chosen (Generic) charter, so
      // no sibling is needed; this test is about the read.
      'inventory_items.select': (call) => {
        const list = inList(call, 'id');
        lists.push(list);
        return {
          data: list.map((id) => ({ id, sku: `S-${id}`, name: 'x', charter_id: null })),
          error: null,
        };
      },
      'rpc:next_po_number': { data: 'PO-100', error: null },
      'locations.select': { data: { id: 'loc-chosen' }, error: null },
      'purchase_orders.insert': { data: { id: 'new-po' }, error: null },
      'purchase_order_items.insert': { data: null, error: null },
      'po_imports.update': { data: { id: 'imp-1' }, error: null },
    });
    const res = await new PoImportsService(makeServiceContext(stub.client) as never).approve({
      poImportId: 'imp-1',
      vendorId: 'vendor-1',
      warehouseId: WH_UUID,
      locationId: 'loc-chosen',
      itemCharterId: null,
      lineOverrides: [],
    } as never);
    expect(res.poId).toBe('new-po');
    expect(lists.map((l) => l.length)).toEqual([100, 50]);
  });
});
