import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The recurring-PO page's picker and the labels of saved template lines.
//
// 1. The picker must not offer a kit's pre-assembled stock: a template
//    holding one is refused on save, and kits are never ordered (0366).
// 2. A saved line can point at an item the picker does not list (deleted
//    since, a kit, archived). The save refuses a deleted item or a kit BY
//    NAME, so the line must say what it is; the page resolves those ids.

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
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { plan: 'pro' }, error: null }) }) }),
    }),
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
vi.mock('@/components/po/recurring-templates-seed-loader', () => ({
  RecurringTemplatesSeedLoader: vi.fn(() => null),
}));

import { RecurringTemplatesSeedLoader } from '@/components/po/recurring-templates-seed-loader';

import RecurringPosPage from './page';

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
    await RecurringPosPage();
    expect(inventoryList).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 1000, expected: 'any', excludeBundles: true }),
    );
  });

  it('labels saved lines the picker does not list: deleted items and kits say what they are', async () => {
    const tree = await RecurringPosPage();

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
    const tree = await RecurringPosPage();
    expect(findProps(tree, RecurringTemplatesSeedLoader)?.lineLabels).toEqual([]);
  });
});
