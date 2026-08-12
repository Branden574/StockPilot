import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// THE REGRESSION, at the layer that caused it.
//
// Both PO pages called `inventorySvc.list({ limit: 1000, expected: 'any' })`
// with no item type. InventoryService.list defaults to
// `.eq('item_type','product')`, so an org holding Product A and Book B handed
// the form ONLY Product A — the book was not merely hard to find, it never
// reached the client at all, and the picker then offered to "Create" a
// duplicate of it.
//
// These tests invoke the server components with mocked services and read the
// props the page actually hands <PoForm>, so they fail on the old
// no-item-type read and pass on the fixed one.

const inventoryList = vi.fn(async () => ({ items: [], total: 0, valueOnHand: 0 }));
const listGroupVariants = vi.fn(async () => []);
const suppliersList = vi.fn(async () => []);
const locationsList = vi.fn(async () => []);
const chartersList = vi.fn(async () => []);
const poGet = vi.fn(async () => ({
  po: { status: 'draft', supplier_id: null, charter_id: null, expected_at: null, po_number: 'PO-1' },
  lines: [] as Array<Record<string, unknown>>,
}));

vi.mock('@/lib/auth/session', () => ({
  requireOrgContext: vi.fn(async () => ({
    organizationId: 'org-1',
    userId: 'u1',
    role: 'owner',
  })),
}));
vi.mock('next/navigation', () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`redirect:${url}`);
  }),
  notFound: vi.fn(() => {
    throw new Error('notFound');
  }),
}));
vi.mock('@/components/po/po-form', () => ({ PoForm: vi.fn(() => null) }));
vi.mock('@/server/services/inventory', () => ({
  InventoryService: {
    forCurrentUser: vi.fn(async () => ({ list: inventoryList, listGroupVariants })),
  },
}));
vi.mock('@/server/services/size-run-display', () => ({
  loadSizeRunGroups: vi.fn(async () => ({})),
}));
vi.mock('@/server/services/suppliers', () => ({
  SuppliersService: { forCurrentUser: vi.fn(async () => ({ list: suppliersList })) },
}));
vi.mock('@/server/services/locations', () => ({
  LocationsService: { forCurrentUser: vi.fn(async () => ({ list: locationsList })) },
}));
vi.mock('@/server/services/charters', () => ({
  ChartersService: { forCurrentUser: vi.fn(async () => ({ list: chartersList })) },
}));
vi.mock('@/server/services/purchase-orders', () => ({
  PurchaseOrdersService: { forCurrentUser: vi.fn(async () => ({ get: poGet })) },
}));
vi.mock('@/server/services/context', () => ({
  ServiceError: class ServiceError extends Error {
    constructor(
      public code: string,
      message: string,
    ) {
      super(message);
    }
  },
}));

import { PoForm } from '@/components/po/po-form';

import EditPoPage from './[id]/edit/page';
import NewPoPage from './new/page';

/** Depth-first search of a returned RSC element tree for a component's props. */
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

interface FormItem {
  id: string;
  name: string;
  sku: string;
  unit_cost: number;
  itemType?: string | null;
  barcode?: string | null;
}

function formItems(tree: unknown): FormItem[] {
  const props = findProps(tree, PoForm);
  expect(props).not.toBeNull();
  return (props as { items: FormItem[] }).items;
}

// The org from the bug report: one product, one book.
const PRODUCT_A = {
  id: 'p-a',
  name: 'Product A',
  sku: 'SKU-A',
  unit_cost: 4,
  item_type: 'product',
  barcode: '0123456789012',
  group_id: null,
  variant_size: null,
};
const BOOK_B = {
  id: 'b-b',
  name: "Charlotte's Web",
  sku: 'BK-B',
  unit_cost: 6.5,
  item_type: 'book',
  // For a book, barcode IS the ISBN.
  barcode: '9780142407332',
  group_id: null,
  variant_size: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  inventoryList.mockResolvedValue({
    items: [PRODUCT_A, BOOK_B],
    total: 2,
    valueOnHand: 0,
  } as never);
  poGet.mockResolvedValue({
    po: { status: 'draft', supplier_id: null, charter_id: null, expected_at: null, po_number: 'PO-1' },
    lines: [],
  });
});

describe('PO pages read BOTH product and book (PURCHASE_ORDER_ITEM_TYPES)', () => {
  it("new-PO page: list() is called with itemTypes ['product','book']", async () => {
    await NewPoPage();
    expect(inventoryList).toHaveBeenCalledWith({
      limit: 1000,
      expected: 'any',
      itemTypes: ['product', 'book'],
    });
  });

  it("edit-PO page: list() is called with itemTypes ['product','book']", async () => {
    await EditPoPage({ params: Promise.resolve({ id: 'po-1' }) });
    expect(inventoryList).toHaveBeenCalledWith({
      limit: 1000,
      expected: 'any',
      itemTypes: ['product', 'book'],
    });
  });

  it('new-PO page: the book reaches the form alongside the product', async () => {
    const items = formItems(await NewPoPage());
    expect(items.map((i) => i.id)).toEqual(['p-a', 'b-b']);
    expect(items.find((i) => i.id === 'b-b')).toEqual({
      id: 'b-b',
      name: "Charlotte's Web",
      sku: 'BK-B',
      unit_cost: 6.5,
      groupId: null,
      variantSize: null,
      itemType: 'book',
      barcode: '9780142407332',
    });
  });

  it('edit-PO page: the book reaches the form alongside the product', async () => {
    const items = formItems(await EditPoPage({ params: Promise.resolve({ id: 'po-1' }) }));
    expect(items.map((i) => i.id)).toEqual(['p-a', 'b-b']);
    expect(items.find((i) => i.id === 'b-b')?.itemType).toBe('book');
    expect(items.find((i) => i.id === 'b-b')?.barcode).toBe('9780142407332');
  });

  it('edit-PO page: an existing BOOK line resolves to that book', async () => {
    poGet.mockResolvedValueOnce({
      po: {
        status: 'draft',
        supplier_id: null,
        charter_id: null,
        expected_at: null,
        po_number: 'PO-1',
      },
      lines: [{ item_id: 'b-b', quantity_ordered: 4, unit_cost: 6.5 }],
    });
    const tree = await EditPoPage({ params: Promise.resolve({ id: 'po-1' }) });
    const props = findProps(tree, PoForm) as {
      initial: { lines: Array<{ itemId?: string; quantityOrdered: number; unitCost: number }> };
      items: FormItem[];
    };
    expect(props.initial.lines).toEqual([
      { itemId: 'b-b', quantityOrdered: 4, unitCost: 6.5 },
    ]);
    // The line's item is present in the catalog handed to the picker, so it
    // renders with a label instead of looking unselected.
    expect(props.items.some((i) => i.id === 'b-b')).toBe(true);
  });
});
