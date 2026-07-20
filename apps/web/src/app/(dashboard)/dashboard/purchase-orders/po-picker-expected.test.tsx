import { beforeEach, describe, expect, it, vi } from 'vitest';

// The PO create/edit item pickers must request expected:'any' (mig 0277):
// the default InventoryService.list() exclusion would hide items still
// awaiting their first receipt, and a buyer re-ordering an expected SKU
// would be invited to create a DUPLICATE item instead of reusing the row.
// These tests invoke the server components with mocked services and assert
// the exact list() filter each page sends.

const inventoryList = vi.fn(async () => ({ items: [], total: 0, valueOnHand: 0 }));
const suppliersList = vi.fn(async () => []);
const locationsList = vi.fn(async () => []);
const chartersList = vi.fn(async () => []);
const poGet = vi.fn(async () => ({
  po: { status: 'draft', supplier_id: null, charter_id: null, expected_at: null, po_number: 'PO-1' },
  lines: [],
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
vi.mock('@/components/po/po-form', () => ({ PoForm: () => null }));
vi.mock('@/server/services/inventory', () => ({
  InventoryService: { forCurrentUser: vi.fn(async () => ({ list: inventoryList })) },
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
// The edit page imports ServiceError only; mock the module so the real
// context.ts (next/headers, supabase server client) never loads in vitest.
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

import NewPoPage from './new/page';
import EditPoPage from './[id]/edit/page';

beforeEach(() => {
  vi.clearAllMocks();
  inventoryList.mockResolvedValue({ items: [], total: 0, valueOnHand: 0 });
  poGet.mockResolvedValue({
    po: { status: 'draft', supplier_id: null, charter_id: null, expected_at: null, po_number: 'PO-1' },
    lines: [],
  });
});

describe('PO item pickers request expected:\'any\' (mig 0277)', () => {
  it('new-PO page: list() is called with expected:\'any\' so expected items are offerable', async () => {
    await NewPoPage();
    expect(inventoryList).toHaveBeenCalledWith(
      expect.objectContaining({ expected: 'any' }),
    );
  });

  it('edit-PO page: list() is called with expected:\'any\' so existing draft lines keep resolving', async () => {
    await EditPoPage({ params: Promise.resolve({ id: 'po-1' }) });
    expect(inventoryList).toHaveBeenCalledWith(
      expect.objectContaining({ expected: 'any' }),
    );
  });
});
