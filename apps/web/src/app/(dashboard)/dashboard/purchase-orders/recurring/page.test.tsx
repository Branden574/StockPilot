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
// 4. Its destination can be one the form does not offer: a staging area (four
//    Demo Co purchase orders, production 2026-10-06) or a deleted location
//    (three of Learn4Life's). The form showed it blank and saved it anyway.
//    The page reads where that purchase order went, in the caller's
//    organization, so the form can open with no destination and say so.
// 5. The form offers what the purchase order form offers: sites linked to a
//    warehouse. The save refuses any other, as a purchase order's does.

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
const STAGING = '00000000-0000-0000-0000-0000000000d1';
const GONE_LOCATION = '00000000-0000-0000-0000-0000000000d2';
/** The source purchase order's destination, read with its location. */
const poDestination = vi.fn(async (_filters: Record<string, unknown>) => ({
  data: {
    destination_location_id: STAGING,
    destination: { name: 'Staging', deleted_at: null },
  } as {
    destination_location_id: string | null;
    destination: { name: string | null; deleted_at: string | null } | null;
  } | null,
  error: null as { message: string } | null,
}));
const locationsList = vi.fn(async (_opts: unknown) => [] as Array<Record<string, unknown>>);
/** locations read by id (what a template holds that the form does not offer). */
const locationRows = vi.fn((_ids: string[]) => ({
  data: [] as Array<Record<string, unknown>> | null,
  error: null as { message: string } | null,
}));
const listForLookups = vi.fn(async () => [] as Array<{ id: string; name: string }>);
const namesByIds = vi.fn(async (_ids: readonly string[]) => [] as Array<{ id: string; name: string; deleted_at: string | null }>);
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
      if (table === 'locations') {
        let ids: string[] = [];
        const q = {
          select: () => q,
          eq: () => q,
          in: (_column: string, values: string[]) => {
            ids = values;
            return q;
          },
          order: () => q,
          range: () => q,
          then: (resolve: (v: unknown) => unknown) => Promise.resolve(locationRows(ids)).then(resolve),
        };
        return q;
      }
      if (table === 'purchase_orders') {
        const filters: Record<string, unknown> = {};
        const q = {
          select: (columns: string) => {
            filters.select = columns;
            return q;
          },
          eq: (column: string, value: unknown) => {
            filters[column] = value;
            return q;
          },
          maybeSingle: () => poDestination(filters),
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
  SuppliersService: { forCurrentUser: vi.fn(async () => ({ listForLookups, namesByIds })) },
}));
vi.mock('@/server/services/locations', () => ({
  LocationsService: { forCurrentUser: vi.fn(async () => ({ list: locationsList })) },
}));
vi.mock('@/server/services/recurring-pos', () => ({
  RecurringPoTemplatesService: class {
    list = templatesList;
  },
}));
vi.mock('@/server/services/lib/fetch-by-ids', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/services/lib/fetch-by-ids')>()),
  reportDegradedRead: vi.fn(),
}));
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

import { PageHeader } from '@/components/patterns/page-header';
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

  it('Make recurring from a purchase order that went to a staging area: reads that destination in the caller\'s organization and names it', async () => {
    const tree = await page({ from: PO });

    expect(poDestination).toHaveBeenCalledTimes(1);
    expect(poDestination).toHaveBeenCalledWith(
      expect.objectContaining({ organization_id: 'org-1', id: PO }),
    );
    // The destination and its location, in one read (through RLS), with the
    // purchase order's supplier (small fixes slice 8: the form may not offer
    // that either).
    expect(String(poDestination.mock.calls[0]?.[0].select)).toMatch(
      /^destination_location_id, supplier_id, destination:locations!destination_location_id \(name, deleted_at\)$/,
    );
    expect(findProps(tree, RecurringTemplatesSeedLoader)?.seedDestination).toEqual({
      locationId: STAGING,
      name: 'Staging',
      deleted: false,
    });
  });

  it('Make recurring from a purchase order that went to a deleted location: says it was deleted', async () => {
    poDestination.mockResolvedValueOnce({
      data: {
        destination_location_id: GONE_LOCATION,
        destination: { name: 'Old Annex', deleted_at: '2026-06-24T00:00:00Z' },
      },
      error: null,
    });
    const tree = await page({ from: PO });

    expect(findProps(tree, RecurringTemplatesSeedLoader)?.seedDestination).toEqual({
      locationId: GONE_LOCATION,
      name: 'Old Annex',
      deleted: true,
    });
  });

  it('Make recurring from a purchase order with no destination: says it has none', async () => {
    poDestination.mockResolvedValueOnce({
      data: { destination_location_id: null, destination: null },
      error: null,
    });
    const tree = await page({ from: PO });

    expect(findProps(tree, RecurringTemplatesSeedLoader)?.seedDestination).toEqual({
      locationId: null,
      name: null,
      deleted: false,
    });
  });

  it('a failed read of that destination still renders the page: no destination named, and reported', async () => {
    poDestination.mockResolvedValueOnce({ data: null, error: { message: 'statement timeout' } });
    const tree = await page({ from: PO });

    expect(reportDegradedRead).toHaveBeenCalledWith(
      'recurring_pos.page.seed_destination',
      expect.anything(),
      expect.objectContaining({ from: true }),
    );
    const props = findProps(tree, RecurringTemplatesSeedLoader);
    expect(props?.seedDestination).toBeNull();
    // The rest of the page is unaffected.
    expect(props?.lineLabels).toHaveLength(2);
  });

  it('reads no destination without a well-formed ?from', async () => {
    const plain = await page();
    const malformed = await page({ from: 'not-a-uuid' });

    expect(poDestination).not.toHaveBeenCalled();
    expect(findProps(plain, RecurringTemplatesSeedLoader)?.seedDestination).toBeNull();
    expect(findProps(malformed, RecurringTemplatesSeedLoader)?.seedDestination).toBeNull();
  });

  it('offers the destinations the purchase order form offers: sites linked to a warehouse', async () => {
    locationsList.mockResolvedValueOnce([
      { id: 'loc-main', name: 'Main Warehouse', kind: null, type: 'warehouse', warehouse_id: 'wh-1' },
      { id: 'loc-office', name: 'District Office', kind: null, type: 'warehouse', warehouse_id: null },
    ]);
    const tree = await page();

    expect(locationsList).toHaveBeenCalledWith({ sitesOnly: true });
    expect(findProps(tree, RecurringTemplatesSeedLoader)?.locations).toEqual([
      { id: 'loc-main', name: 'Main Warehouse' },
    ]);
  });

  it('draws the shared page header with its back link, heading and description (P4.C2 redesign)', async () => {
    const header = findProps(await page(), PageHeader);
    expect(header?.title).toBe('Recurring purchase orders');
    expect(header?.subline).toBe(
      'Templates that auto-create a purchase order on a schedule — weekly, monthly, quarterly, or custom.',
    );
    const back = header?.back as React.ReactElement<{ href: string; children: React.ReactNode }>;
    expect(back.props.href).toBe('/dashboard/purchase-orders');
    expect(back.props.children).toBe('← Purchase orders');
  });
});

// 6. A template can hold a destination deleted after it was saved, or an
//    archived supplier, and the purchase order Make recurring starts from an
//    archived supplier. The form showed them blank. The page now reads what
//    they are (small fixes slice 8, items B and D) so the form can name them
//    and keep none, and the list can say a template creates nothing.
describe('Recurring POs page: what templates hold that the form does not offer', () => {
  const SITE = '00000000-0000-0000-0000-0000000000e1';
  const GONE = '00000000-0000-0000-0000-0000000000e2';
  const SUP_ACTIVE = '00000000-0000-0000-0000-0000000000f1';
  const SUP_ARCHIVED = '00000000-0000-0000-0000-0000000000f2';
  const SUP_FROM_PO = '00000000-0000-0000-0000-0000000000f3';

  beforeEach(() => {
    locationsList.mockResolvedValue([
      { id: SITE, name: 'Main Warehouse', kind: null, type: 'warehouse', warehouse_id: 'wh-1' },
    ]);
    listForLookups.mockResolvedValue([{ id: SUP_ACTIVE, name: 'TechSource Distributors' }]);
    templatesList.mockResolvedValueOnce([
      { id: 'tpl-ok', name: 'Fine', supplier_id: SUP_ACTIVE, destination_location_id: SITE, line_items: [] },
      { id: 'tpl-gone', name: 'Annex Paper', supplier_id: SUP_ARCHIVED, destination_location_id: GONE, line_items: [] },
    ] as never);
    locationRows.mockImplementation((ids: string[]) => ({
      data: [
        { id: GONE, name: 'Old Annex', kind: null, type: 'warehouse', warehouse_id: 'wh-1', deleted_at: '2026-10-05T00:00:00Z' },
      ].filter((r) => ids.includes(r.id)),
      error: null,
    }));
    namesByIds.mockImplementation(async (ids: readonly string[]) =>
      [
        { id: SUP_ARCHIVED, name: 'Acme Paper', deleted_at: '2026-10-01T00:00:00Z' },
        { id: SUP_FROM_PO, name: 'Paper Co', deleted_at: '2026-10-02T00:00:00Z' },
      ].filter((r) => ids.includes(r.id)),
    );
  });

  it('reads only what the form does not offer, and passes it named', async () => {
    const tree = await page();
    const props = findProps(tree, RecurringTemplatesSeedLoader);

    expect(locationRows).toHaveBeenCalledWith([GONE]);
    expect(namesByIds).toHaveBeenCalledWith([SUP_ARCHIVED]);
    expect(props?.unofferedDestinations).toEqual({
      [GONE]: { name: 'Old Annex', why: 'deleted', saveRefuses: 'deleted' },
    });
    expect(props?.unofferedSuppliers).toEqual({ [SUP_ARCHIVED]: { name: 'Acme Paper', why: 'archived' } });
    expect(props?.suppliers).toEqual([{ id: SUP_ACTIVE, name: 'TechSource Distributors' }]);
  });

  it('Make recurring: the purchase order\'s archived supplier is read and named too', async () => {
    poDestination.mockResolvedValueOnce({
      data: { destination_location_id: null, supplier_id: SUP_FROM_PO, destination: null } as never,
      error: null,
    });
    const tree = await page({ from: PO });

    expect(namesByIds).toHaveBeenCalledWith([SUP_ARCHIVED, SUP_FROM_PO]);
    expect(findProps(tree, RecurringTemplatesSeedLoader)?.unofferedSuppliers).toEqual({
      [SUP_ARCHIVED]: { name: 'Acme Paper', why: 'archived' },
      [SUP_FROM_PO]: { name: 'Paper Co', why: 'archived' },
    });
  });

  it('with the Suppliers module off nothing is listed: an active supplier is offered after all', async () => {
    listForLookups.mockResolvedValueOnce([]);
    namesByIds.mockImplementationOnce(async () => [
      { id: SUP_ACTIVE, name: 'TechSource Distributors', deleted_at: null },
      { id: SUP_ARCHIVED, name: 'Acme Paper', deleted_at: '2026-10-01T00:00:00Z' },
    ]);
    const props = findProps(await page(), RecurringTemplatesSeedLoader);

    expect(props?.suppliers).toEqual([{ id: SUP_ACTIVE, name: 'TechSource Distributors' }]);
    expect(props?.unofferedSuppliers).toEqual({ [SUP_ARCHIVED]: { name: 'Acme Paper', why: 'archived' } });
  });

  // The select's list can lack a destination the form does offer: a live site
  // linked to a warehouse that the list did not return (LocationsService.list
  // was one unpaged read, capped at 1000 rows of every kind). Before the fold
  // the form named it as one "you can't pick here" and the save cleared it.
  it('an offered site the list did not return is offered after all, for a template and for Make recurring', async () => {
    const FROM_PO_SITE = '00000000-0000-0000-0000-0000000000e4';
    // The list returned neither the template's site nor the purchase order's.
    locationsList.mockResolvedValueOnce([]);
    locationRows.mockImplementation((ids: string[]) => ({
      data: [
        { id: SITE, name: 'Main Warehouse', kind: null, type: 'warehouse', warehouse_id: 'wh-1', deleted_at: null },
        { id: GONE, name: 'Old Annex', kind: null, type: 'warehouse', warehouse_id: 'wh-1', deleted_at: '2026-10-05T00:00:00Z' },
        { id: FROM_PO_SITE, name: 'Yard', kind: null, type: 'warehouse', warehouse_id: 'wh-2', deleted_at: null },
      ].filter((r) => ids.includes(r.id)),
      error: null,
    }));
    poDestination.mockResolvedValueOnce({
      data: { destination_location_id: FROM_PO_SITE, destination: { name: 'Yard', deleted_at: null } },
      error: null,
    });
    const props = findProps(await page({ from: PO }), RecurringTemplatesSeedLoader);

    expect(locationRows).toHaveBeenCalledWith([SITE, GONE, FROM_PO_SITE]);
    expect(props?.locations).toEqual([
      { id: SITE, name: 'Main Warehouse' },
      { id: FROM_PO_SITE, name: 'Yard' },
    ]);
    // The deleted one is still named, and still not offered.
    expect(props?.unofferedDestinations).toEqual({
      [GONE]: { name: 'Old Annex', why: 'deleted', saveRefuses: 'deleted' },
    });
  });

  it('failed reads name nothing, are reported, and the page still renders', async () => {
    locationRows.mockImplementation(() => ({ data: null, error: { message: 'statement timeout' } }));
    namesByIds.mockRejectedValueOnce(new Error('statement timeout'));
    const props = findProps(await page(), RecurringTemplatesSeedLoader);

    expect(props?.unofferedDestinations).toEqual({ [GONE]: { name: null, why: 'unknown' } });
    expect(props?.unofferedSuppliers).toEqual({ [SUP_ARCHIVED]: { name: null, why: 'unknown' } });
    expect(reportDegradedRead).toHaveBeenCalledWith('recurring_pos.page.unoffered_destinations', expect.anything(), { ids: 1 });
    expect(reportDegradedRead).toHaveBeenCalledWith('recurring_pos.page.unoffered_suppliers', expect.anything(), { ids: 1 });
  });
});
