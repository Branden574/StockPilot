import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ServiceContext } from '@/server/services/context';

// We mock the heavy services so the tool tests stay focused on the
// tool's own logic (fuzzy retry, sort acceptance, response shape).
// Each mock returns a vi.fn() that the test can program per case.

const listMock = vi.fn();

vi.mock('@/server/services/inventory', () => ({
  InventoryService: class {
    list(...args: unknown[]) {
      return listMock(...args);
    }
  },
}));

// Tools.ts imports a handful of other services; stub them as empty
// classes since we don't exercise them here.
vi.mock('@/server/services/movements', () => ({
  MovementsService: class {},
  getDashboardActions: vi.fn(),
  getDashboardSummary: vi.fn(),
  getLowStockItems: vi.fn(),
}));
vi.mock('@/server/services/categories', () => ({
  CategoriesService: class {},
}));
vi.mock('@/server/services/suppliers', () => ({
  SuppliersService: class {},
}));
vi.mock('@/server/services/warehouses', () => ({
  WarehousesService: class {},
}));
vi.mock('@/server/services/order-requests', () => ({
  OrderRequestsService: class {},
}));
vi.mock('@/server/services/purchase-orders', () => ({
  PurchaseOrdersService: class {},
}));
vi.mock('@/server/services/bundles', () => ({
  BundlesService: class {},
}));
vi.mock('@/server/services/books-import', () => ({
  BooksImportService: class {},
}));
vi.mock('@/server/services/forecasting', () => ({
  getItemVelocity: vi.fn(),
  suggestReorderPoint: vi.fn(),
}));
vi.mock('@/lib/books/lookup', () => ({
  lookupIsbn: vi.fn(),
}));

import { TOOL_CATALOG } from './tools';

const fakeCtx = {
  organizationId: 'org-x',
  userId: 'user-x',
  role: 'admin',
  supabase: {} as ServiceContext['supabase'],
} as ServiceContext;

beforeEach(() => {
  listMock.mockReset();
});

describe('searchInventory tool', () => {
  it('accepts cost_asc sort and surfaces it in sortedBy', async () => {
    listMock.mockResolvedValue({ total: 3, items: [{ id: 'a', name: 'cheap thing', unit_cost: 1 }] });
    const tool = TOOL_CATALOG.searchInventory!;
    const res = (await tool.execute({ query: '', sort: 'cost_asc' }, fakeCtx)) as {
      sortedBy: string;
    };
    expect(res.sortedBy).toBe('cost_asc');
    // Sort should be forwarded to the service.
    expect(listMock).toHaveBeenCalledWith(expect.objectContaining({ sort: 'cost_asc' }));
  });

  it('accepts cost_desc sort and surfaces it', async () => {
    listMock.mockResolvedValue({ total: 1, items: [] });
    const tool = TOOL_CATALOG.searchInventory!;
    const res = (await tool.execute({ query: '', sort: 'cost_desc' }, fakeCtx)) as {
      sortedBy: string;
    };
    expect(res.sortedBy).toBe('cost_desc');
  });

  it('falls back to updated_desc on unknown sort string', async () => {
    listMock.mockResolvedValue({ total: 0, items: [] });
    const tool = TOOL_CATALOG.searchInventory!;
    const res = (await tool.execute({ query: '', sort: 'price_low' }, fakeCtx)) as {
      sortedBy: string;
    };
    expect(res.sortedBy).toBe('updated_desc');
  });

  it('retries single-word plural with singular variant', async () => {
    // First call (literal "Chromebooks") returns 0; retry with
    // "Chromebook" returns 181. The tool should surface the matched
    // variant and the items.
    listMock
      .mockResolvedValueOnce({ total: 0, items: [] })
      .mockResolvedValueOnce({
        total: 181,
        items: [{ id: 'item-1', name: 'Lenovo 300e Yoga Chromebook' }],
      });
    const tool = TOOL_CATALOG.searchInventory!;
    const res = (await tool.execute({ query: 'Chromebooks' }, fakeCtx)) as {
      total: number;
      matchedVariant: string | null;
      queryVariantsTried: string[];
      noMatchExplanation: string | null;
    };
    expect(res.total).toBe(181);
    expect(res.matchedVariant).toBe('Chromebook');
    expect(res.queryVariantsTried).toContain('Chromebooks');
    expect(res.queryVariantsTried).toContain('Chromebook');
    expect(res.noMatchExplanation).toBeNull();
  });

  it('retries multi-word with joined + singular-of-joined variants', async () => {
    listMock
      // Literal: "chrome books"
      .mockResolvedValueOnce({ total: 0, items: [] })
      // Joined: "chromebooks"
      .mockResolvedValueOnce({ total: 0, items: [] })
      // Singular of joined: "chromebook" — hit!
      .mockResolvedValueOnce({
        total: 181,
        items: [{ id: 'item-1', name: 'Chromebook' }],
      });
    const tool = TOOL_CATALOG.searchInventory!;
    const res = (await tool.execute({ query: 'chrome books' }, fakeCtx)) as {
      total: number;
      matchedVariant: string | null;
      queryVariantsTried: string[];
    };
    expect(res.total).toBe(181);
    expect(res.matchedVariant).toBe('chromebook');
  });

  it('returns noMatchExplanation when ALL variants return zero', async () => {
    listMock.mockResolvedValue({ total: 0, items: [] });
    const tool = TOOL_CATALOG.searchInventory!;
    const res = (await tool.execute({ query: 'thingamajigs' }, fakeCtx)) as {
      total: number;
      noMatchExplanation: string | null;
      queryVariantsTried: string[];
    };
    expect(res.total).toBe(0);
    expect(res.noMatchExplanation).toBeTruthy();
    expect(res.noMatchExplanation).toMatch(/tried.*spellings/i);
    // Should have tried at least two variants (literal + singular).
    expect(res.queryVariantsTried.length).toBeGreaterThanOrEqual(2);
  });

  it('does NOT set noMatchExplanation when literal hit on first try', async () => {
    listMock.mockResolvedValue({
      total: 5,
      items: [{ id: 'a', name: 'Widget' }],
    });
    const tool = TOOL_CATALOG.searchInventory!;
    const res = (await tool.execute({ query: 'widget' }, fakeCtx)) as {
      total: number;
      matchedVariant: string | null;
      noMatchExplanation: string | null;
      queryVariantsTried: string[];
    };
    expect(res.total).toBe(5);
    expect(res.matchedVariant).toBe('widget');
    expect(res.noMatchExplanation).toBeNull();
    expect(res.queryVariantsTried).toEqual(['widget']);
  });

  it("includes expected items (expected:'any') and annotates them so the answer never implies shelf stock (mig 0277)", async () => {
    listMock.mockResolvedValue({
      total: 2,
      items: [
        {
          id: 'phantom-1',
          name: 'PD 8/7 Sticker',
          quantity_on_hand: 0,
          awaiting_first_receipt: true,
        },
        { id: 'real-1', name: 'Dell XPS', quantity_on_hand: 4, awaiting_first_receipt: false },
      ],
    });
    const tool = TOOL_CATALOG.searchInventory!;
    const res = (await tool.execute({ query: 'sticker' }, fakeCtx)) as {
      items: Array<{ id: string; name: string; expected?: boolean; expectedNote?: string }>;
    };
    // The service call must opt OUT of the default flagged-row exclusion.
    expect(listMock).toHaveBeenCalledWith(expect.objectContaining({ expected: 'any' }));
    const phantom = res.items.find((i) => i.id === 'phantom-1')!;
    const real = res.items.find((i) => i.id === 'real-1')!;
    // Annotation sits OUTSIDE the <data> wrapper (not spoofable by names).
    expect(phantom.name).toBe('<data>PD 8/7 Sticker</data> (expected — not yet received)');
    expect(phantom.expected).toBe(true);
    expect(phantom.expectedNote).toMatch(/not received any stock/i);
    expect(real.name).toBe('<data>Dell XPS</data>');
    expect(real.expected).toBeUndefined();
  });

  it('drops generic words like "items" when retrying', async () => {
    // "chrome items" — joined would be "chromeitems" (won't match
    // anything sensible), generic-word-stripped is "chrome". That
    // variant should be attempted.
    let attempts: Array<string | undefined> = [];
    listMock.mockImplementation(async (filters: { q?: string }) => {
      attempts.push(filters.q);
      if (filters.q === 'chrome') {
        return { total: 3, items: [{ id: 'a', name: 'Chrome bottle' }] };
      }
      return { total: 0, items: [] };
    });
    const tool = TOOL_CATALOG.searchInventory!;
    const res = (await tool.execute({ query: 'chrome items' }, fakeCtx)) as {
      total: number;
      matchedVariant: string | null;
    };
    expect(res.total).toBe(3);
    expect(attempts).toContain('chrome');
    expect(res.matchedVariant).toBe('chrome');
  });
});
