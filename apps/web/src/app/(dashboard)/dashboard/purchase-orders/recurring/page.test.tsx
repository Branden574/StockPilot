import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The recurring-PO page's picker and the labels of saved template lines.
//
// 1. The picker must not offer a kit's pre-assembled stock: a template
//    holding one is refused on save, and kits are never ordered (0366).
// 2. A saved line can point at an item the picker does not list (deleted
//    since, a kit, archived). The save refuses a deleted item or a kit BY
//    NAME, so the line must say what it is; the page resolves those ids.
// 3. "Make recurring" (?from=<poId>) fills the form in the browser from that
//    purchase order. Its lines can point at items the picker does not list:
//    a rental (the picker never lists rentals, while a purchase order may
//    hold them; production 2026-10-06, PO-DEMO-002's two rental lines read
//    "Item not available"), an archived item. The page resolves that
//    purchase order's items too.

const inventoryList = vi.fn(async (_filters: unknown) => ({
  items: [{ id: 'item-listed', name: 'Pencils', sku: 'PEN-1', unit_cost: 1 }],
  total: 1,
  valueOnHand: 0,
}));
const lineLabelsByIds = vi.fn(async (_ids: string[], _opts: unknown) => [
  {
    id: '00000000-0000-0000-0000-0000000000a2',
    sku: 'BP-1',
    name: 'Blue pens',
    deleted_at: '2026-09-01T00:00:00Z',
    is_bundle: false,
  },
  {
    id: '00000000-0000-0000-0000-0000000000a1',
    sku: '__BUNDLE__0a000000',
    name: 'Reading Kit',
    deleted_at: null,
    is_bundle: true,
  },
]);
const RENTAL = '00000000-0000-0000-0000-0000000000b1';
const PO = '00000000-0000-0000-0000-0000000000c1';
const poLines = vi.fn(async (_filters: Record<string, unknown>) => ({
  data: [
    { id: 'l1', item_id: 'item-listed' },
    { id: 'l2', item_id: RENTAL },
    { id: 'l3', item_id: '00000000-0000-0000-0000-0000000000a2' },
  ] as Array<{ id: string; item_id: string }> | null,
  error: null as { message: string } | null,
}));
const templatesList = vi.fn(async () => [
  {
    id: 'tpl-1',
    name: 'Weekly Supplies',
    line_items: [
      { itemId: 'item-listed', quantityOrdered: 1, unitCost: 1 },
      { itemId: '00000000-0000-0000-0000-0000000000a2', quantityOrdered: 1, unitCost: 1 },
      { itemId: '00000000-0000-0000-0000-0000000000a1', quantityOrdered: 1, unitCost: 1 },
      { itemId: 'not-a-uuid', quantityOrdered: 1, unitCost: 1 },
    ],
  },
]);

vi.mock('@/lib/modules/module-gate', () => ({
  checkModuleAccess: vi.fn(async () => ({ enabled: true, canManage: true })),
}));
vi.mock('@/lib/auth/session', () => ({
  requireOrgContext: vi.fn(async () => ({ organizationId: 'org-1', userId: 'u1', role: 'owner' })),
}));
vi.mock('next/navigation', () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`redirect:${url}`);
  }),
}));
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({
    from: (table: string) => {
      if (table === 'purchase_order_items') {
        const filters: Record<string, unknown> = {};
        const q = {
          select: () => q,
          eq: (column: string, value: unknown) => {
            filters[column] = value;
            return q;
          },
          order: () => q,
          range: () => q,
          then: (
            resolve: (v: unknown) => unknown,
            reject: (e: unknown) => unknown,
          ) => poLines(filters).then(resolve, reject),
        };
        return q;
      }
      return {
        select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { plan: 'pro' }, error: null }) }) }),
      };
    },
  })),
}));
vi.mock('@/server/services/context', () => ({ withContext: vi.fn(async () => ({})) }));
vi.mock('@/server/services/inventory', () => ({
  InventoryService: { forCurrentUser: vi.fn(async () => ({ list: inventoryList, lineLabelsByIds })) },
}));
vi.mock('@/server/services/suppliers', () => ({
  SuppliersService: { forCurrentUser: vi.fn(async () => ({ listForLookups: vi.fn(async () => []) })) },
}));
vi.mock('@/server/services/locations', () => ({
  LocationsService: { forCurrentUser: vi.fn(async () => ({ list: vi.fn(async () => []) })) },
}));
vi.mock('@/server/services/recurring-pos', () => ({
  RecurringPoTemplatesService: class {
    list = templatesList;
  },
}));
vi.mock('@/server/services/lib/fetch-by-ids', () => ({ reportDegradedRead: vi.fn() }));
vi.mock('@/server/services/lib/paginate', () => ({
  fetchAllRows: vi.fn(async (build: (from: number, to: number) => PromiseLike<{ data: unknown[] | null; error: unknown }>) => {
    const res = await build(0, 999);
    if (res.error) throw new Error('read failed');
    return res.data ?? [];
  }),
}));
vi.mock('@/components/po/recurring-templates-seed-loader', () => ({
  RecurringTemplatesSeedLoader: vi.fn(() => null),
}));

import { RecurringTemplatesSeedLoader } from '@/components/po/recurring-templates-seed-loader';
import { reportDegradedRead } from '@/server/services/lib/fetch-by-ids';

import RecurringPosPage from './page';

const page = (search: Record<string, string> = {}) =>
  RecurringPosPage({ searchParams: Promise.resolve(search) });

function findProps(node: unknown, type: unknown): Record<string, unknown> | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findProps(child, type);
      if (hit) return hit;
    }
    return null;
  }
  if (!React.isValidElement(node)) return null;
  if (node.type === type) return node.props as Record<string, unknown>;
  return findProps((node.props as { children?: unknown }).children, type);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Recurring POs page', () => {
  it('the template picker does not offer a kit (excludeBundles)', async () => {
    await page();
    expect(inventoryList).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 1000, expected: 'any', excludeBundles: true }),
    );
  });

  it('labels saved lines the picker does not list: deleted items and kits say what they are', async () => {
    const tree = await page();

    // Only the unlisted, well-formed ids are resolved.
    expect(lineLabelsByIds).toHaveBeenCalledWith(
      ['00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000a1'],
      { itemType: 'all' },
    );
    const props = findProps(tree, RecurringTemplatesSeedLoader);
    expect(props?.lineLabels).toEqual([
      { id: '00000000-0000-0000-0000-0000000000a2', name: 'Blue pens', sku: 'BP-1', deleted: true, kitStock: false },
      { id: '00000000-0000-0000-0000-0000000000a1', name: 'Reading Kit', sku: '__BUNDLE__0a000000', deleted: false, kitStock: true },
    ]);
  });

  it('a failed label read still renders the page, without labels', async () => {
    lineLabelsByIds.mockRejectedValueOnce(new Error('statement timeout'));
    const tree = await page();
    expect(findProps(tree, RecurringTemplatesSeedLoader)?.lineLabels).toEqual([]);
  });

  it('Make recurring: resolves the source purchase order\'s items the picker does not list, a rental among them', async () => {
    lineLabelsByIds.mockResolvedValueOnce([
      {
        id: '00000000-0000-0000-0000-0000000000a2',
        sku: 'BP-1',
        name: 'Blue pens',
        deleted_at: '2026-09-01T00:00:00Z',
        is_bundle: false,
      },
      {
        id: '00000000-0000-0000-0000-0000000000a1',
        sku: '__BUNDLE__0a000000',
        name: 'Reading Kit',
        deleted_at: null,
        is_bundle: true,
      },
      { id: RENTAL, sku: 'DEMO-001', name: 'MacBook Pro 14"', deleted_at: null, is_bundle: false },
    ]);
    const tree = await page({ from: PO });

    // That purchase order's lines, read in the caller's organization.
    expect(poLines).toHaveBeenCalledWith({ organization_id: 'org-1', purchase_order_id: PO });
    // The templates' unlisted ids and the purchase order's, each once, never
    // a listed item.
    expect(lineLabelsByIds).toHaveBeenCalledWith(
      ['00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000a1', RENTAL],
      { itemType: 'all' },
    );
    const props = findProps(tree, RecurringTemplatesSeedLoader);
    expect(props?.lineLabels).toContainEqual({
      id: RENTAL,
      name: 'MacBook Pro 14"',
      sku: 'DEMO-001',
      deleted: false,
      kitStock: false,
    });
  });

  it('reads no purchase order lines without a well-formed ?from', async () => {
    await page();
    await page({ from: 'not-a-uuid' });
    expect(poLines).not.toHaveBeenCalled();
  });

  it('a failed read of the purchase order lines still renders the page, with the templates\' labels', async () => {
    poLines.mockResolvedValueOnce({ data: null, error: { message: 'statement timeout' } });
    const tree = await page({ from: PO });
    expect(reportDegradedRead).toHaveBeenCalledWith(
      'recurring_pos.page.seed_line_labels',
      expect.anything(),
      expect.objectContaining({ from: true }),
    );
    expect(lineLabelsByIds).toHaveBeenCalledWith(
      ['00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000a1'],
      { itemType: 'all' },
    );
    expect(findProps(tree, RecurringTemplatesSeedLoader)?.lineLabels).toHaveLength(2);
  });
});
