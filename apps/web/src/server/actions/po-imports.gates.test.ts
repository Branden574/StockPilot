import { beforeEach, describe, expect, it, vi } from 'vitest';

// The actions import the inventory-list loader (cache invalidation helper),
// whose module graph builds unstable_cache wrappers at import time.
vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
  unstable_cache: vi.fn((fn: unknown) => fn),
}));
vi.mock('@/server/loaders/inventory-list', () => ({
  revalidateInventoryListForCurrentOrg: vi.fn(async () => {}),
}));

const { mockPresignUpload, mockCreateItemsFromLines, mockFindDuplicatesForLines } =
  vi.hoisted(() => ({
    mockPresignUpload: vi.fn(async () => ({ uploadUrl: 'https://signed', storagePath: 'org/p.csv' })),
    mockCreateItemsFromLines: vi.fn(async () => ({ created: 1, mapped: 0, linked: 0, skipped: 0 })),
    mockFindDuplicatesForLines: vi.fn(async () => ({ matches: {} })),
  }));

// Route-through target: the gated service twin. If an action reverts to calling
// the DB / shared helper directly, these mocks are never invoked and the
// routing assertions fail — which is exactly the bypass the fix closes.
vi.mock('@/server/services/po-imports', () => ({
  PoImportsService: {
    forCurrentUser: vi.fn(async () => ({
      presignUpload: mockPresignUpload,
      createItemsFromLines: mockCreateItemsFromLines,
      findDuplicatesForLines: mockFindDuplicatesForLines,
    })),
  },
}));

// The REAL ServiceError so the actions' `instanceof` surfacing matches.
import { ServiceError } from '@/server/services/context';
import {
  createItemsFromPoLinesAction,
  findDuplicatesForPoLinesAction,
  presignPoUploadAction,
} from './po-imports';

const U = (n: number) => `${String(n).repeat(8)}-1111-1111-1111-111111111111`;
const PO_IMPORT_ID = U(1);
const LINE_ID = U(2);
const VENDOR_ID = U(3);
const WAREHOUSE_ID = U(4);

beforeEach(() => {
  vi.clearAllMocks();
});

// MED-3: three po-import actions used to hit the DB / shared helper directly,
// bypassing PoImportsService's module + purchase_orders:manage gate. They must
// now route through the gated twin.
describe('presignPoUploadAction — routes through the gated service twin', () => {
  const VALID = { fileName: 'po.csv', fileMimeType: 'text/csv', fileSize: 1_024 };

  it('rejects a disallowed MIME type before the service is called', async () => {
    const res = await presignPoUploadAction({ ...VALID, fileMimeType: 'image/png' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('validation_error');
    expect(mockPresignUpload).not.toHaveBeenCalled();
  });

  it('routes a valid request through PoImportsService.presignUpload', async () => {
    const res = await presignPoUploadAction(VALID);
    expect(res.ok).toBe(true);
    expect(mockPresignUpload).toHaveBeenCalledTimes(1);
    // MED-22: fileMimeType is passed THROUGH now — the service uses it to choose
    // the stored extension itself rather than parsing it out of fileName (which
    // was a path-injection sink). If a refactor stopped forwarding it, the
    // service would fall back to refusing every upload, so this is pinned.
    expect(mockPresignUpload).toHaveBeenCalledWith({
      fileName: 'po.csv',
      fileMimeType: 'text/csv',
    });
  });

  it('surfaces the service gate as a forbidden result', async () => {
    mockPresignUpload.mockRejectedValueOnce(
      new ServiceError('forbidden', 'Missing permission: purchase_orders:manage'),
    );
    const res = await presignPoUploadAction(VALID);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('forbidden');
  });
});

describe('createItemsFromPoLinesAction — routes through the gated service twin', () => {
  const VALID = {
    poImportId: PO_IMPORT_ID,
    lineIds: [LINE_ID],
    vendorId: VENDOR_ID,
    warehouseId: WAREHOUSE_ID,
  };

  it('routes valid input through PoImportsService.createItemsFromLines', async () => {
    const res = await createItemsFromPoLinesAction(VALID);
    expect(res.ok).toBe(true);
    expect(mockCreateItemsFromLines).toHaveBeenCalledTimes(1);
    expect(mockCreateItemsFromLines).toHaveBeenCalledWith(expect.objectContaining(VALID));
  });

  it('surfaces the service gate as a forbidden result', async () => {
    mockCreateItemsFromLines.mockRejectedValueOnce(
      new ServiceError('forbidden', 'Missing permission: purchase_orders:manage'),
    );
    const res = await createItemsFromPoLinesAction(VALID);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('forbidden');
  });
});

describe('findDuplicatesForPoLinesAction — routes through the gated service twin', () => {
  const VALID = { poImportId: PO_IMPORT_ID, lineIds: [LINE_ID] };

  it('routes valid input through PoImportsService.findDuplicatesForLines', async () => {
    const res = await findDuplicatesForPoLinesAction(VALID);
    expect(res.ok).toBe(true);
    expect(mockFindDuplicatesForLines).toHaveBeenCalledTimes(1);
    expect(mockFindDuplicatesForLines).toHaveBeenCalledWith(expect.objectContaining(VALID));
  });

  it('surfaces the service gate as a forbidden result', async () => {
    mockFindDuplicatesForLines.mockRejectedValueOnce(
      new ServiceError('forbidden', 'Missing permission: purchase_orders:manage'),
    );
    const res = await findDuplicatesForPoLinesAction(VALID);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('forbidden');
  });
});
