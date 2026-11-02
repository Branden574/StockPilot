import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeServiceContext, makeSupabaseStub, servedLikePostgrest } from '@/test/supabase-mock';

vi.mock('@/lib/email/rentals', () => ({
  sendRentalCheckoutEmail: vi.fn(async () => undefined),
  sendRentalReturnedEmail: vi.fn(async () => undefined),
}));
vi.mock('./lib/defer', () => ({ defer: vi.fn() }));

import { audit } from './audit';
import { defer } from './lib/defer';
import { RentalsService } from './rentals';

/**
 * S39: a rental started for a warehouse of organization B from a checkout
 * page left open after the person switched to organization A. create_rental
 * decides on the WAREHOUSE's own organization (B's module, B's
 * rentals:create, write on the warehouse), so the rental was made in B while
 * its audit row (with the borrower's name, the line count and the dates)
 * landed in A. The warehouse is now read in A first; a miss refuses before
 * the function.
 */

const WAREHOUSE_ID = '00000000-0000-4000-8000-0000000000b1';

const input = {
  warehouseId: WAREHOUSE_ID,
  borrowerName: 'Borrower Example',
  borrowerUserId: null,
  expectedReturnAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
  notes: null,
  lines: [{ itemId: '00000000-0000-4000-8000-000000000001', quantity: 1, notes: null }],
};

function stubFor() {
  return makeSupabaseStub({
    'warehouses.select': servedLikePostgrest([{ id: WAREHOUSE_ID, organization_id: 'org-B' }]),
    'organization_members.select': { data: null, error: null },
    'rpc:create_rental': { data: 'rental-b-1', error: null },
  });
}

function svc(stub: ReturnType<typeof makeSupabaseStub>, org: string) {
  return new RentalsService(
    makeServiceContext(stub.client, { organizationId: org, role: 'manager' }),
  );
}

beforeEach(() => vi.clearAllMocks());

describe('create: a warehouse of another organization is not found', () => {
  it('starting a rental in a warehouse that is not in A runs nothing and records nothing', async () => {
    const stub = stubFor();

    await expect(svc(stub, 'org-A').create(input)).rejects.toMatchObject({
      code: 'not_found',
      message: 'Warehouse not found.',
    });

    expect(stub.chainArgsAll.get('warehouses.select')?.[0]).toEqual(
      expect.arrayContaining([
        ['organization_id', 'org-A'],
        ['id', WAREHOUSE_ID],
      ]),
    );
    expect(stub.rpcCalls).toHaveLength(0);
    expect(audit).not.toHaveBeenCalled();
    expect(defer).not.toHaveBeenCalled();
  });

  it('refuses the same way when a member borrower is named', async () => {
    const stub = stubFor();

    await expect(
      svc(stub, 'org-A').create({ ...input, borrowerUserId: 'u-borrower' }),
    ).rejects.toMatchObject({
      code: 'not_found',
      message: 'Warehouse not found.',
    });

    expect(stub.rpcCalls).toHaveLength(0);
    expect(audit).not.toHaveBeenCalled();
  });

  it('still checks the return date first, before any read', async () => {
    const stub = stubFor();

    await expect(
      svc(stub, 'org-A').create({ ...input, expectedReturnAt: '2000-01-01T00:00:00.000Z' }),
    ).rejects.toMatchObject({ code: 'validation_error' });

    expect(stub.fromCalls).toHaveLength(0);
  });

  it('working in B, the rental is made once and recorded in B', async () => {
    const stub = stubFor();

    await expect(svc(stub, 'org-B').create(input)).resolves.toEqual({ id: 'rental-b-1' });

    expect(stub.rpcCalls.map((c) => c.name)).toEqual(['create_rental']);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'rental.created', entityId: 'rental-b-1' }),
      expect.objectContaining({ organizationId: 'org-B' }),
    );
  });
});
