import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./audit', () => ({ audit: vi.fn(async () => {}) }));

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

import { audit } from './audit';
import { CategoriesService, updateCategorySchema } from './categories';
import { ChartersService, updateCharterSchema } from './charters';
import { LocationsService, updateLocationSchema } from './locations';
import { SuppliersService, updateSupplierSchema } from './suppliers';
import { updateWarehouseSchema, WarehousesService } from './warehouses';

/**
 * An edit form sends an emptied optional text field as '' (the update schemas
 * accept '' and refuse null), and the service stores it as NULL: cleared, never
 * an empty string (a charter code is unique per organization when present, and
 * '' would count as present). A key the patch leaves out is not written.
 */

const ID = '00000000-0000-4000-8000-000000000001';

function stubAnswering(table: string) {
  const row = { data: [{ id: ID, organization_id: 'org-test' }], error: null };
  return makeSupabaseStub({
    [`${table}.select`]: row,
    [`${table}.update`]: row,
  });
}

/** The column map the service handed to `.update(...)`. */
function written(stub: ReturnType<typeof makeSupabaseStub>, table: string) {
  const all = stub.chainArgsAll.get(`${table}.update`) ?? [];
  expect(all).toHaveLength(1);
  return all[0]![0]![0] as Record<string, unknown>;
}

const svcCtx = (client: unknown) => makeServiceContext(client) as never;

beforeEach(() => vi.clearAllMocks());

describe('SuppliersService.update', () => {
  it('stores each emptied optional field as null', async () => {
    const stub = stubAnswering('suppliers');
    const patch = updateSupplierSchema.parse({
      name: 'Harbor Paper Co',
      contactName: '',
      email: '',
      phone: '',
      website: '',
      notes: '',
    });
    expect(patch).toMatchObject({ contactName: '', email: '', phone: '', website: '', notes: '' });
    await new SuppliersService(svcCtx(stub.client)).update(ID, patch);
    expect(written(stub, 'suppliers')).toEqual({
      name: 'Harbor Paper Co',
      contact_name: null,
      email: null,
      phone: null,
      website: null,
      notes: null,
    });
  });

  it('writes only the keys the patch carries', async () => {
    const stub = stubAnswering('suppliers');
    await new SuppliersService(svcCtx(stub.client)).update(
      ID,
      updateSupplierSchema.parse({ name: 'Harbor Paper Co', phone: '555-010-0199' }),
    );
    expect(written(stub, 'suppliers')).toEqual({ name: 'Harbor Paper Co', phone: '555-010-0199' });
  });
});

describe('ChartersService.update', () => {
  it('stores each emptied optional field as null, a blank code included', async () => {
    const stub = stubAnswering('charters');
    const patch = updateCharterSchema.parse({
      name: 'North Campus',
      code: '   ',
      description: '',
      notes: '',
      contactName: '',
      contactEmail: '',
      contactPhone: '',
    });
    await new ChartersService(svcCtx(stub.client)).update(ID, patch);
    expect(written(stub, 'charters')).toEqual({
      name: 'North Campus',
      code: null,
      description: null,
      notes: null,
      contact_name: null,
      contact_email: null,
      contact_phone: null,
    });
    // The audit row carries the patch as sent: a cleared field reads "".
    expect(vi.mocked(audit)).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'charter.updated',
        after: expect.objectContaining({ code: '', notes: '', contactName: '' }),
      }),
      expect.anything(),
    );
  });

  it('writes only the keys the patch carries', async () => {
    const stub = stubAnswering('charters');
    await new ChartersService(svcCtx(stub.client)).update(
      ID,
      updateCharterSchema.parse({ name: 'North Campus', notes: 'Gate code at the desk' }),
    );
    expect(written(stub, 'charters')).toEqual({
      name: 'North Campus',
      notes: 'Gate code at the desk',
    });
  });
});

describe('WarehousesService.update', () => {
  it('stores each emptied optional field as null', async () => {
    const stub = stubAnswering('warehouses');
    const patch = updateWarehouseSchema.parse({
      name: 'North DC',
      code: 'NDC',
      contactName: '',
      contactEmail: '',
      contactPhone: '',
      notes: '',
    });
    await new WarehousesService(svcCtx(stub.client)).update(ID, patch);
    expect(written(stub, 'warehouses')).toEqual({
      name: 'North DC',
      code: 'NDC',
      contact_name: null,
      contact_email: null,
      contact_phone: null,
      notes: null,
    });
    expect(vi.mocked(audit)).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'warehouse.updated',
        after: expect.objectContaining({ contactName: '', notes: '' }),
      }),
      expect.anything(),
    );
  });

  it('writes only the keys the patch carries', async () => {
    const stub = stubAnswering('warehouses');
    await new WarehousesService(svcCtx(stub.client)).update(
      ID,
      updateWarehouseSchema.parse({ name: 'North DC', contactPhone: '555-010-0142' }),
    );
    expect(written(stub, 'warehouses')).toEqual({
      name: 'North DC',
      contact_phone: '555-010-0142',
    });
  });
});

describe('LocationsService.update', () => {
  it('stores emptied notes as null', async () => {
    const stub = stubAnswering('locations');
    const patch = updateLocationSchema.parse({ notes: '' });
    expect(patch).toEqual({ notes: '' });
    await new LocationsService(svcCtx(stub.client)).update(ID, patch);
    expect(written(stub, 'locations')).toEqual({ notes: null });
  });

  it('writes only the keys the patch carries', async () => {
    const stub = stubAnswering('locations');
    await new LocationsService(svcCtx(stub.client)).update(
      ID,
      updateLocationSchema.parse({ type: 'room' }),
    );
    expect(written(stub, 'locations')).toEqual({ type: 'room' });
  });
});

describe('CategoriesService.update', () => {
  it('stores an emptied description as null', async () => {
    const stub = stubAnswering('categories');
    const patch = updateCategorySchema.parse({ name: 'Paper', description: '' });
    await new CategoriesService(svcCtx(stub.client)).update(ID, patch);
    expect(written(stub, 'categories')).toEqual({ name: 'Paper', description: null });
  });

  it('writes only the keys the patch carries', async () => {
    const stub = stubAnswering('categories');
    await new CategoriesService(svcCtx(stub.client)).update(
      ID,
      updateCategorySchema.parse({ name: 'Paper' }),
    );
    expect(written(stub, 'categories')).toEqual({ name: 'Paper' });
  });
});
