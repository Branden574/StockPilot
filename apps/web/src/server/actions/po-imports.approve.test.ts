import { beforeEach, describe, expect, it, vi } from 'vitest';

// unstable_cache/revalidateTag: the actions under test import the
// inventory-list loader (cache invalidation helper), whose module graph
// builds unstable_cache wrappers at import time.
vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
  unstable_cache: vi.fn((fn: unknown) => fn),
}));

const { mockApprove } = vi.hoisted(() => ({
  mockApprove: vi.fn(async (_input: Record<string, unknown>) => ({ poId: 'new-po' })),
}));

vi.mock('@/server/services/po-imports', () => ({
  PoImportsService: { forCurrentUser: vi.fn(async () => ({ approve: mockApprove })) },
}));
vi.mock('@/server/services/inventory', () => ({
  InventoryService: { forCurrentUser: vi.fn() },
}));
vi.mock('@/server/services/vendor-item-mappings', () => ({
  VendorItemMappingsService: { forCurrentUser: vi.fn() },
}));
vi.mock('@/lib/auth/session', () => ({
  requireOrgContext: vi.fn(async () => ({ organizationId: 'org-test', userId: 'user-test' })),
}));
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }));

import { approvePoImportAction } from './po-imports';

const PO_IMPORT_ID = '11111111-1111-1111-1111-111111111111';
const VENDOR_ID = '33333333-3333-3333-3333-333333333333';
const WAREHOUSE_ID = '44444444-4444-4444-4444-444444444444';
const LOCATION_ID = '66666666-6666-6666-6666-666666666666';

beforeEach(() => {
  vi.clearAllMocks();
});

// Owner directive 2026-07-08: the destination location is REQUIRED at the
// schema layer — the old optional/nullable locationId let the service fall
// back to (or auto-create) a synthetic location.
describe('approvePoImportAction — locationId is required (no auto-resolved location)', () => {
  it('rejects a missing locationId before the service is ever called', async () => {
    const result = await approvePoImportAction({
      poImportId: PO_IMPORT_ID,
      vendorId: VENDOR_ID,
      warehouseId: WAREHOUSE_ID,
      lineOverrides: [],
    } as never);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('validation_error');
      expect(result.error.message).toBe('Pick a destination location for this warehouse.');
    }
    expect(mockApprove).not.toHaveBeenCalled();
  });

  it('rejects an explicit locationId: null (the old "warehouse default" wire shape)', async () => {
    const result = await approvePoImportAction({
      poImportId: PO_IMPORT_ID,
      vendorId: VENDOR_ID,
      warehouseId: WAREHOUSE_ID,
      locationId: null,
      lineOverrides: [],
    } as never);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('validation_error');
    expect(mockApprove).not.toHaveBeenCalled();
  });

  it('rejects a non-uuid locationId', async () => {
    const result = await approvePoImportAction({
      poImportId: PO_IMPORT_ID,
      vendorId: VENDOR_ID,
      warehouseId: WAREHOUSE_ID,
      locationId: '__none',
      lineOverrides: [],
    } as never);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('validation_error');
      expect(result.error.message).toBe('Pick a destination location for this warehouse.');
    }
    expect(mockApprove).not.toHaveBeenCalled();
  });

  it('passes a valid locationId through to the service approve()', async () => {
    const result = await approvePoImportAction({
      poImportId: PO_IMPORT_ID,
      vendorId: VENDOR_ID,
      warehouseId: WAREHOUSE_ID,
      locationId: LOCATION_ID,
      lineOverrides: [],
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.poId).toBe('new-po');
    expect(mockApprove).toHaveBeenCalledTimes(1);
    expect(mockApprove.mock.calls[0]?.[0]).toMatchObject({ locationId: LOCATION_ID });
  });
});
