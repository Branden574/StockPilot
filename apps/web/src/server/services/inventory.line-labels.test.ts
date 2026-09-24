import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeServiceContext, makeSupabaseStub, servedLikePostgrest } from '@/test/supabase-mock';

vi.mock('@/lib/auth/warehouse', () => ({
  getWarehouseAccess: vi.fn(async () => ({ hasAllAccess: true, readableIds: [] })),
}));

import { getWarehouseAccess } from '@/lib/auth/warehouse';

import { InventoryService } from './inventory';

/**
 * lineLabelsByIds labels lines that already point at an item (an edit-mode
 * draft PO, a saved recurring template). list() hides deleted items and
 * rentals, so such lines rendered blank while the PO save refused a deleted
 * item's line by name. This read filters nothing out for what became of the
 * item and says what it is instead, while keeping list()'s scoping.
 */

const row = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  organization_id: 'org-test',
  warehouse_id: 'wh-a',
  sku: `SKU-${id}`,
  name: `Item ${id}`,
  barcode: null,
  item_type: 'product',
  unit_cost: 1,
  group_id: null,
  variant_size: null,
  category_id: null,
  status: 'active',
  deleted_at: null,
  is_rental: false,
  is_bundle: false,
  ...over,
});

const ROWS = [
  row('plain'),
  row('gone', { deleted_at: '2026-09-01T00:00:00Z' }),
  row('rent', { is_rental: true }),
  row('kit', { is_bundle: true, sku: '__BUNDLE__0a000000' }),
  row('archived', { status: 'archived' }),
  row('other-wh', { warehouse_id: 'wh-b' }),
  row('book', { item_type: 'book' }),
  row('foreign', { organization_id: 'org-other' }),
];

beforeEach(() => {
  vi.mocked(getWarehouseAccess).mockResolvedValue({ hasAllAccess: true, readableIds: [] } as never);
});

describe('InventoryService.lineLabelsByIds', () => {
  it('returns deleted, rental, kit and archived rows with what they are; never another org\'s', async () => {
    const stub = makeSupabaseStub({ 'inventory_items.select': servedLikePostgrest(ROWS) });
    const svc = new InventoryService(makeServiceContext(stub.client) as never);

    const rows = await svc.lineLabelsByIds(['plain', 'gone', 'rent', 'kit', 'archived', 'foreign']);

    expect(rows.map((r) => [r.id, r.deleted_at != null, r.is_rental, r.is_bundle, r.status])).toEqual([
      ['archived', false, false, false, 'archived'],
      ['gone', true, false, false, 'active'],
      ['kit', false, false, true, 'active'],
      ['plain', false, false, false, 'active'],
      ['rent', false, true, false, 'active'],
    ]);
  });

  it('keeps list()\'s item-type default (product) and honours an item-type set', async () => {
    const stub = makeSupabaseStub({ 'inventory_items.select': servedLikePostgrest(ROWS) });
    const svc = new InventoryService(makeServiceContext(stub.client) as never);

    expect((await svc.lineLabelsByIds(['plain', 'book'])).map((r) => r.id)).toEqual(['plain']);
    expect(
      (await svc.lineLabelsByIds(['plain', 'book'], { itemTypes: ['product', 'book'] })).map((r) => r.id),
    ).toEqual(['book', 'plain']);
  });

  it('a warehouse-scoped caller sees only their warehouses', async () => {
    vi.mocked(getWarehouseAccess).mockResolvedValue({ hasAllAccess: false, readableIds: ['wh-a'] } as never);
    const stub = makeSupabaseStub({ 'inventory_items.select': servedLikePostgrest(ROWS) });
    const svc = new InventoryService(makeServiceContext(stub.client, { role: 'staff' }) as never);

    expect((await svc.lineLabelsByIds(['plain', 'other-wh'])).map((r) => r.id)).toEqual(['plain']);
  });

  it('no ids, no read', async () => {
    const stub = makeSupabaseStub({ 'inventory_items.select': servedLikePostgrest(ROWS) });
    const svc = new InventoryService(makeServiceContext(stub.client) as never);

    expect(await svc.lineLabelsByIds([])).toEqual([]);
    expect(stub.fromCalls).not.toContain('inventory_items');
  });
});
