import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeSupabaseStub, servedLikePostgrest } from '@/test/supabase-mock';

/**
 * Edit purchase order: what the page tells the form about a draft's
 * destination and supplier when the selects do not offer them (small fixes
 * slice 8, items A and D). The form keeps none of them and names each one
 * (po-form.unoffered.test.tsx); the page reads what they are, in the caller's
 * organization, through the caller's client.
 */

const DEST = {
  site: '11111111-0000-4000-8000-000000000001',
  staging: '11111111-0000-4000-8000-000000000002',
  gone: '11111111-0000-4000-8000-000000000003',
} as const;
const SUP = {
  active: '22222222-0000-4000-8000-000000000001',
  archived: '22222222-0000-4000-8000-000000000002',
} as const;

const draft = vi.fn(() => ({
  id: 'po-1',
  status: 'draft',
  po_number: 'PO-001',
  supplier_id: SUP.active as string | null,
  destination_location_id: DEST.site as string | null,
  charter_id: null,
  expected_at: null,
  notes: null,
}));
const listForLookups = vi.fn(async () => [{ id: SUP.active, name: 'TechSource Distributors' }]);
const namesByIds = vi.fn(async (ids: readonly string[]) =>
  [
    { id: SUP.active, name: 'TechSource Distributors', deleted_at: null },
    { id: SUP.archived, name: 'Acme Paper', deleted_at: '2026-10-01T00:00:00Z' },
  ].filter((s) => ids.includes(s.id)),
);
const locationRows = [
  { id: DEST.site, organization_id: 'org-1', name: 'Main Warehouse', kind: null, type: 'warehouse', warehouse_id: 'wh-1', deleted_at: null },
  { id: DEST.staging, organization_id: 'org-1', name: 'Staging', kind: 'staging', type: 'other', warehouse_id: 'wh-1', deleted_at: null },
  { id: DEST.gone, organization_id: 'org-1', name: 'Old Annex', kind: null, type: 'warehouse', warehouse_id: 'wh-1', deleted_at: '2026-10-01T00:00:00Z' },
];
const locationsRead = vi.fn(servedLikePostgrest(locationRows));

vi.mock('next/navigation', () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`redirect:${url}`);
  }),
  notFound: vi.fn(() => {
    throw new Error('notFound');
  }),
}));
vi.mock('@/lib/auth/session', () => ({
  requireOrgContext: vi.fn(async () => ({ organizationId: 'org-1', userId: 'u1', role: 'owner', permissions: null })),
}));
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => makeSupabaseStub({ 'locations.select': locationsRead }).client),
}));
vi.mock('@/server/services/purchase-orders', () => ({
  PurchaseOrdersService: {
    forCurrentUser: vi.fn(async () => ({ get: vi.fn(async () => ({ po: draft(), lines: [] })) })),
  },
}));
vi.mock('@/server/services/inventory', () => ({
  InventoryService: {
    forCurrentUser: vi.fn(async () => ({
      list: vi.fn(async () => ({ items: [], total: 0 })),
      listGroupVariants: vi.fn(async () => []),
    })),
  },
}));
vi.mock('@/server/services/suppliers', () => ({
  SuppliersService: { forCurrentUser: vi.fn(async () => ({ listForLookups, namesByIds })) },
}));
const listLocations = vi.fn(async (_opts: unknown): Promise<Array<Record<string, unknown>>> => [
  { id: DEST.site, name: 'Main Warehouse', kind: null, type: 'warehouse', warehouse_id: 'wh-1' },
]);
vi.mock('@/server/services/locations', () => ({
  LocationsService: {
    forCurrentUser: vi.fn(async () => ({ list: listLocations })),
  },
}));
vi.mock('@/server/services/charters', () => ({
  ChartersService: { forCurrentUser: vi.fn(async () => ({ list: vi.fn(async () => []) })) },
}));
vi.mock('@/server/services/size-run-display', () => ({ loadSizeRunGroups: vi.fn(async () => ({})) }));
const reportDegradedRead = vi.fn();
vi.mock('@/server/services/lib/fetch-by-ids', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/services/lib/fetch-by-ids')>()),
  reportDegradedRead: (...args: unknown[]) => reportDegradedRead(...args),
}));
vi.mock('@/components/po/po-form', () => ({ PoForm: vi.fn(() => null) }));

import { PoForm } from '@/components/po/po-form';

import EditPoPage from './page';

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

async function formProps() {
  const tree = await EditPoPage({ params: Promise.resolve({ id: 'po-1' }) });
  return findProps(tree, PoForm) as {
    locations: Array<{ id: string; name: string }>;
    suppliers: Array<{ id: string; name: string }>;
    initial: { locationId: string; supplierId: string };
    unoffered: unknown;
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Edit purchase order: what the page tells the form the selects do not offer', () => {
  it('an offered destination and supplier: nothing to name, and nothing read', async () => {
    const props = await formProps();
    expect(props.unoffered).toEqual({ destination: null, supplier: null });
    expect(props.initial).toMatchObject({ locationId: DEST.site, supplierId: SUP.active });
    expect(locationsRead).not.toHaveBeenCalled();
    expect(namesByIds).not.toHaveBeenCalled();
  });

  it('a staging area: read in the caller\'s organization and named as not a site', async () => {
    draft.mockReturnValueOnce({ ...draft(), destination_location_id: DEST.staging });
    const props = await formProps();
    expect(props.unoffered).toEqual({ destination: { name: 'Staging', why: 'not_a_site' }, supplier: null });
    expect(locationsRead).toHaveBeenCalledTimes(1);
    const call = locationsRead.mock.calls[0]![0];
    expect(call.args[call.methods.indexOf('eq')]).toEqual(['organization_id', 'org-1']);
  });

  it('a deleted location: named as deleted', async () => {
    draft.mockReturnValueOnce({ ...draft(), destination_location_id: DEST.gone });
    expect((await formProps()).unoffered).toEqual({
      destination: { name: 'Old Annex', why: 'deleted', saveRefuses: 'deleted' },
      supplier: null,
    });
  });

  it('an archived supplier: named as archived, and not offered', async () => {
    draft.mockReturnValueOnce({ ...draft(), supplier_id: SUP.archived });
    const props = await formProps();
    expect(props.unoffered).toEqual({ destination: null, supplier: { name: 'Acme Paper', why: 'archived' } });
    expect(props.suppliers.map((s) => s.id)).toEqual([SUP.active]);
  });

  it('with the Suppliers module off the select lists none: an active supplier is offered after all, so the draft keeps it', async () => {
    listForLookups.mockResolvedValueOnce([]);
    const props = await formProps();
    expect(props.suppliers).toEqual([{ id: SUP.active, name: 'TechSource Distributors' }]);
    expect(props.unoffered).toEqual({ destination: null, supplier: null });
  });

  // The select's list can lack a destination the form does offer: a live site
  // linked to a warehouse that the list did not return (LocationsService.list
  // was one unpaged read, capped at 1000 rows of every kind, ordered by name).
  // Before the fold, such a destination was named as one "you can't pick
  // here" and the save cleared it.
  it('an offered site the list did not return is offered after all, so the draft keeps it', async () => {
    listLocations.mockResolvedValueOnce([]);
    const props = await formProps();
    expect(props.locations).toEqual([{ id: DEST.site, name: 'Main Warehouse' }]);
    expect(props.initial).toMatchObject({ locationId: DEST.site });
    expect(props.unoffered).toEqual({ destination: null, supplier: null });
    expect(locationsRead).toHaveBeenCalledTimes(1);
  });

  it('failed reads name nothing, are reported, and never take the page down', async () => {
    draft.mockReturnValueOnce({ ...draft(), destination_location_id: DEST.gone, supplier_id: SUP.archived });
    locationsRead.mockImplementationOnce(() => ({ data: null, error: { message: 'statement timeout' } }));
    namesByIds.mockRejectedValueOnce(new Error('statement timeout'));
    const props = await formProps();
    expect(props.unoffered).toEqual({
      destination: { name: null, why: 'unknown' },
      supplier: { name: null, why: 'unknown' },
    });
    expect(reportDegradedRead).toHaveBeenCalledWith('purchase_orders.edit.unoffered_destination', expect.anything(), { ids: 1 });
    expect(reportDegradedRead).toHaveBeenCalledWith('purchase_orders.edit.unoffered_supplier', expect.anything(), { ids: 1 });
  });
});
