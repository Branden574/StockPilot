import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';
import type { ServiceContext } from '@/server/services/context';

/**
 * Wave B security regressions for the AI tool surface.
 *
 * Each block names its finding and asserts the SPECIFIC property that was
 * missing, not just that the tool still works — a test that only checks the
 * happy path would have passed against the vulnerable code too.
 */

const listMock = vi.fn();
const adjustStockMock = vi.fn();
const getMock = vi.fn();
const checkRateLimitMock = vi.fn();
const safeFetchMock = vi.fn();
const embedQueryMock = vi.fn();

vi.mock('@/server/services/inventory', () => ({
  InventoryService: class {
    list(...args: unknown[]) {
      return listMock(...args);
    }
    adjustStock(...args: unknown[]) {
      return adjustStockMock(...args);
    }
    get(...args: unknown[]) {
      return getMock(...args);
    }
  },
}));
vi.mock('@/server/services/movements', () => ({
  MovementsService: class {},
  getDashboardActions: vi.fn(),
  getDashboardSummary: vi.fn(),
  getLowStockItems: vi.fn(),
}));
vi.mock('@/server/services/categories', () => ({ CategoriesService: class {} }));
vi.mock('@/server/services/suppliers', () => ({ SuppliersService: class {} }));
vi.mock('@/server/services/warehouses', () => ({ WarehousesService: class {} }));
vi.mock('@/server/services/order-requests', () => ({ OrderRequestsService: class {} }));
vi.mock('@/server/services/purchase-orders', () => ({ PurchaseOrdersService: class {} }));
vi.mock('@/server/services/bundles', () => ({ BundlesService: class {} }));
vi.mock('@/server/services/books-import', () => ({ BooksImportService: class {} }));
vi.mock('@/server/services/forecasting', () => ({
  getItemVelocity: vi.fn(),
  suggestReorderPoint: vi.fn(),
}));
vi.mock('@/lib/books/lookup', () => ({ lookupIsbn: vi.fn() }));
vi.mock('@/server/loaders/inventory-list', () => ({ revalidateInventoryList: vi.fn() }));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: (...args: unknown[]) => checkRateLimitMock(...args),
}));
// SSRF guard is stubbed at the module seam so no test performs real egress.
vi.mock('@/lib/ssrf-guard', () => ({
  safeFetch: (...args: unknown[]) => safeFetchMock(...args),
  SsrfBlockedError: class SsrfBlockedError extends Error {
    constructor(public reason: string) {
      super(`Blocked by SSRF guard: ${reason}`);
      this.name = 'SsrfBlockedError';
    }
  },
}));
vi.mock('@/lib/ai/embeddings', () => ({
  embedQuery: (...args: unknown[]) => embedQueryMock(...args),
  vectorLiteral: (v: number[]) => `[${v.join(',')}]`,
}));
// A model key must be present or identifyFromPhoto short-circuits on "not
// configured" before reaching the controls under test. The two URLs below are
// what VISION_HOST_ALLOWLIST is derived from, so they also pin WHICH hosts the
// allowlist ends up containing. No key here reaches a real provider — every
// egress and model seam in this file is stubbed.
vi.mock('@/lib/env', () => ({
  env: {
    GEMINI_API_KEY: 'test-key',
    GEMINI_MODEL: 'gemini-2.0-flash',
    ANTHROPIC_API_KEY: '',
    ANTHROPIC_MODEL: 'claude-haiku-4-5',
    NEXT_PUBLIC_SUPABASE_URL: 'https://project.supabase.test',
    NEXT_PUBLIC_APP_URL: 'https://app.stockpilot.test',
  },
}));
vi.mock('./provider', () => ({ resolveAiProvider: () => 'gemini' }));

import { TOOL_CATALOG } from './tools';

const ORG = 'org-aaaa';
const OTHER_ORG = 'org-bbbb';

beforeEach(() => {
  vi.clearAllMocks();
  checkRateLimitMock.mockResolvedValue({ allowed: true, resetAt: Date.now() + 60_000 });
});

// ═══════════════════════════════════════════════════════════════════════════
// HI-4 — listSuppliers had no organization filter.
// ═══════════════════════════════════════════════════════════════════════════

describe('HI-4: listSuppliers organization scoping', () => {
  it('filters suppliers by ctx.organizationId', async () => {
    const stub = makeSupabaseStub({
      'suppliers.select': {
        data: [{ id: 's-1', name: 'Acme', email: 'a@acme.test', phone: '555' }],
        error: null,
      },
    });
    const ctx = makeServiceContext(stub.client, {
      organizationId: ORG,
    }) as unknown as ServiceContext;

    await TOOL_CATALOG.listSuppliers!.execute({}, ctx);

    // The eq('organization_id', ORG) must be part of the query chain. Before
    // the fix the chain was select -> is -> order -> limit with no eq at all.
    const chain = stub.chains.get('suppliers.select') ?? [];
    const args = stub.chainArgs.get('suppliers.select') ?? [];
    const eqPairs = chain
      .map((method, i) => ({ method, args: args[i] }))
      .filter((c) => c.method === 'eq');
    expect(eqPairs).toEqual([{ method: 'eq', args: ['organization_id', ORG] }]);
  });

  it("does not return another organization's supplier PII", async () => {
    // Model the DB honouring the filter: the org-scoped query returns only the
    // caller's row. The assertion that matters is the one above (the filter is
    // sent); this pins the observable outcome the finding described — another
    // org's name/email/phone must not appear in the tool result.
    const stub = makeSupabaseStub({
      'suppliers.select': {
        data: [{ id: 's-1', name: 'Acme', email: 'a@acme.test', phone: '555-0100' }],
        error: null,
      },
    });
    const ctx = makeServiceContext(stub.client, {
      organizationId: ORG,
    }) as unknown as ServiceContext;

    const rows = (await TOOL_CATALOG.listSuppliers!.execute({}, ctx)) as Array<{
      name: unknown;
      email: unknown;
    }>;
    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain('Foreign Vendor');
    expect(serialized).not.toContain('leak@other.test');
    expect(rows).toHaveLength(1);
    // Supplier name + email stay fenced as data (they are free text + PII).
    expect(rows[0]!.name).toBe('<data>Acme</data>');
    expect(rows[0]!.email).toBe('<data>a@acme.test</data>');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// HI-3 — searchInventorySemantic had no organization filter.
// ═══════════════════════════════════════════════════════════════════════════

describe('HI-3: searchInventorySemantic organization scoping', () => {
  beforeEach(() => {
    embedQueryMock.mockResolvedValue([0.1, 0.2, 0.3]);
  });

  it('passes p_org_id from ctx to the RPC (never from the model)', async () => {
    const stub = makeSupabaseStub({
      'rpc:match_inventory_items_by_embedding': { data: [], error: null },
    });
    const ctx = makeServiceContext(stub.client, {
      organizationId: ORG,
    }) as unknown as ServiceContext;

    await TOOL_CATALOG.searchInventorySemantic!.execute(
      // A model that tries to supply its own org id must be ignored.
      { query: 'cleaning spills', organizationId: OTHER_ORG, p_org_id: OTHER_ORG },
      ctx,
    );

    expect(stub.rpcCalls).toHaveLength(1);
    const call = stub.rpcCalls[0]!;
    expect(call.name).toBe('match_inventory_items_by_embedding');
    expect((call.args as { p_org_id: string }).p_org_id).toBe(ORG);
  });

  it("post-filters rows that are not in the caller's org", async () => {
    // The RPC hands back a foreign row (this is what the un-migrated database
    // does, and what any future act-as path would do). The app layer must drop
    // it before the model ever sees it.
    const stub = makeSupabaseStub({
      'rpc:match_inventory_items_by_embedding': {
        data: [
          { id: 'item-mine', name: 'My Mop', sku: 'M-1', warehouse_id: 'w1', quantity_on_hand: 4, similarity: 0.91 },
          { id: 'item-foreign', name: 'Foreign Mop', sku: 'F-1', warehouse_id: 'w2', quantity_on_hand: 9, similarity: 0.99 },
        ],
        error: null,
      },
      // The confirmation query returns only the row that really is in this org.
      'inventory_items.select': { data: [{ id: 'item-mine' }], error: null },
    });
    const ctx = makeServiceContext(stub.client, {
      organizationId: ORG,
    }) as unknown as ServiceContext;

    const rows = (await TOOL_CATALOG.searchInventorySemantic!.execute(
      { query: 'mop' },
      ctx,
    )) as Array<{ id: string }>;

    expect(rows.map((r) => r.id)).toEqual(['item-mine']);
    // The foreign item's NAME must not survive anywhere in the payload — the
    // leak in the finding was item names and quantities reaching the model.
    expect(JSON.stringify(rows)).not.toContain('Foreign Mop');
    // Note the higher similarity on the foreign row: vector ranking has no
    // notion of tenancy, so the leaked row was often the TOP hit.
  });

  it('fails closed when the ownership confirmation query errors', async () => {
    const stub = makeSupabaseStub({
      'rpc:match_inventory_items_by_embedding': {
        data: [
          { id: 'item-x', name: 'Thing', sku: 'X', warehouse_id: null, quantity_on_hand: 1, similarity: 0.8 },
        ],
        error: null,
      },
      'inventory_items.select': { data: null, error: { message: 'boom' } },
    });
    const ctx = makeServiceContext(stub.client, {
      organizationId: ORG,
    }) as unknown as ServiceContext;

    const res = (await TOOL_CATALOG.searchInventorySemantic!.execute(
      { query: 'thing' },
      ctx,
    )) as { error?: string };
    // Unverified rows are NOT returned on a confirmation failure.
    expect(res.error).toBe('search_failed');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// MED-19 — adjustStock wrote a model-chosen movementType with no allowlist.
// ═══════════════════════════════════════════════════════════════════════════

describe('MED-19: adjustStock movementType allowlist', () => {
  function ctxFor() {
    const stub = makeSupabaseStub({});
    return makeServiceContext(stub.client, {
      organizationId: ORG,
      role: 'admin',
    }) as unknown as ServiceContext;
  }

  beforeEach(() => {
    adjustStockMock.mockResolvedValue(undefined);
    getMock.mockResolvedValue({ id: 'i-1', quantity_on_hand: 5 });
  });

  it.each(['adjust', 'damage', 'loss', 'correction'])(
    'accepts the allowlisted movementType %s',
    async (movementType) => {
      await TOOL_CATALOG.adjustStock!.execute(
        { itemId: 'i-1', delta: -1, reason: 'r', movementType },
        ctxFor(),
      );
      expect(adjustStockMock).toHaveBeenCalledWith(
        expect.objectContaining({ movementType }),
      );
    },
  );

  it('defaults to adjust when movementType is omitted', async () => {
    await TOOL_CATALOG.adjustStock!.execute(
      { itemId: 'i-1', delta: 1, reason: 'r' },
      ctxFor(),
    );
    expect(adjustStockMock).toHaveBeenCalledWith(
      expect.objectContaining({ movementType: 'adjust' }),
    );
  });

  it.each([
    // The two values the OLD declaration advertised — neither exists in
    // movementTypeSchema, so `as never` was writing a bogus movement_type.
    'shrinkage',
    'count',
    // Types owned by other flows: letting the model stamp these forges a
    // provenance the activity feed and every type-filtered report trust.
    'receive_po',
    'transfer',
    'return',
    'initial',
    // Outright junk.
    'DROP TABLE',
  ])('rejects the non-allowlisted movementType %s and does not write', async (movementType) => {
    await expect(
      TOOL_CATALOG.adjustStock!.execute(
        { itemId: 'i-1', delta: -1, reason: 'r', movementType },
        ctxFor(),
      ),
    ).rejects.toThrow(/movementType must be one of adjust, damage, loss, correction/);
    expect(adjustStockMock).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// MED-18 — identifyFromPhoto did model-chosen egress with no ctx, no host
// allowlist and no rate limit.
// ═══════════════════════════════════════════════════════════════════════════

describe('MED-18: identifyFromPhoto egress controls', () => {
  function ctxFor() {
    const stub = makeSupabaseStub({});
    return makeServiceContext(stub.client, {
      organizationId: ORG,
      userId: 'user-1',
    }) as unknown as ServiceContext;
  }

  it('passes a non-empty hostAllowlist to safeFetch', async () => {
    // Fail the fetch immediately — we only care about the options safeFetch
    // was called with, and this keeps the test off the model path entirely.
    safeFetchMock.mockRejectedValue(new Error('network down'));

    await expect(
      TOOL_CATALOG.identifyFromPhoto!.execute(
        { imageUrl: 'https://evil.example.com/cover.jpg' },
        ctxFor(),
      ),
    ).rejects.toThrow();

    expect(safeFetchMock).toHaveBeenCalled();
    for (const call of safeFetchMock.mock.calls) {
      const opts = call[1] as { hostAllowlist?: ReadonlyArray<string> };
      // Literal, not just "is an array": the allowlist is exactly our own
      // Supabase project host and app host, derived from env.
      expect(opts.hostAllowlist).toEqual([
        'project.supabase.test',
        'app.stockpilot.test',
      ]);
      // The attacker-supplied host must not be in the allowlist.
      expect(opts.hostAllowlist).not.toContain('evil.example.com');
    }
  });

  it('rate-limits per user and refuses when over budget', async () => {
    checkRateLimitMock.mockResolvedValue({ allowed: false, resetAt: Date.now() + 1000 });

    await expect(
      TOOL_CATALOG.identifyFromPhoto!.execute(
        { imageUrl: 'https://storage.test/cover.jpg' },
        ctxFor(),
      ),
    ).rejects.toThrow(/Rate limit reached for photo identification/);

    // Keyed on the USER, fail-closed, and it short-circuits BEFORE any egress.
    expect(checkRateLimitMock).toHaveBeenCalledWith(
      'ai-identify-photo:user-1',
      20,
      60_000,
      'closed',
    );
    expect(safeFetchMock).not.toHaveBeenCalled();
  });

  it('still rejects a non-http scheme before touching the network', async () => {
    await expect(
      TOOL_CATALOG.identifyFromPhoto!.execute(
        { imageUrl: 'file:///etc/passwd' },
        ctxFor(),
      ),
    ).rejects.toThrow(/must be an http or https URL/);
    expect(safeFetchMock).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// HI-5 (c) — the authorization boundary must not regress.
// ═══════════════════════════════════════════════════════════════════════════

describe('HI-5: write tools keep their authorization boundary', () => {
  it('flags every tool whose declaration says WRITE with write: true', () => {
    // The chat loops derive the write guard (taint refusal + audit) from this
    // flag, so a write tool that forgets it silently opts out of both.
    const missing = Object.entries(TOOL_CATALOG)
      .filter(([, tool]) => /\bWRITE\b/.test(tool.declaration.description ?? ''))
      .filter(([, tool]) => tool.write !== true)
      .map(([name]) => name);
    expect(missing).toEqual([]);
  });

  it('has the expected write-tool inventory', () => {
    // Pinned literally so ADDING a mutating tool forces a deliberate update
    // here, and REMOVING a flag by accident fails.
    const writeTools = Object.entries(TOOL_CATALOG)
      .filter(([, tool]) => tool.write === true)
      .map(([name]) => name)
      .sort();
    expect(writeTools).toEqual([
      'adjustStock',
      'applyReorderPoint',
      'approveOrder',
      'backfillEmbeddings',
      'cancelOrder',
      'createScheduleEvent',
      'denyOrder',
      'draftPos',
      'draftPosFromForecast',
      'executeBulkBookImport',
    ]);
  });

  it('refuses every write tool for a viewer (assertPermission still gates)', async () => {
    const stub = makeSupabaseStub({});
    const viewerCtx = makeServiceContext(stub.client, {
      organizationId: ORG,
      role: 'viewer',
      permissions: new Set<string>(),
    }) as unknown as ServiceContext;

    // backfillEmbeddings returns an { error } object rather than throwing (its
    // own admin gate), so it is asserted separately below.
    const throwing = [
      'adjustStock',
      'applyReorderPoint',
      'approveOrder',
      'cancelOrder',
      'createScheduleEvent',
      'denyOrder',
      'draftPos',
      'draftPosFromForecast',
      'executeBulkBookImport',
    ];
    for (const name of throwing) {
      const tool = TOOL_CATALOG[name]!;
      await expect(
        tool.execute(
          {
            itemId: 'i-1',
            delta: 1,
            reason: 'r',
            orderId: 'o-1',
            reorderPoint: 1,
            isbns: ['9780306406157'],
            warehouseId: 'w-1',
            title: 'x',
            startsAt: '2099-01-01T00:00:00-07:00',
          },
          viewerCtx,
        ),
        `${name} must refuse a viewer`,
      ).rejects.toThrow(/permission|forbidden/i);
    }

    const backfill = (await TOOL_CATALOG.backfillEmbeddings!.execute({}, viewerCtx)) as {
      error?: string;
    };
    expect(backfill.error).toBe('forbidden');
  });
});
