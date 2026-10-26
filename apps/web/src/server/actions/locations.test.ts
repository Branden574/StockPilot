import { afterEach, describe, expect, it, vi } from 'vitest';

import { makeSupabaseStub, type SupabaseStub } from '@/test/supabase-mock';

// The actions re-render the Locations page and expire the Items list; neither
// is under test here.
vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
  unstable_cache: vi.fn((fn: unknown) => fn),
}));
vi.mock('@/server/loaders/inventory-list', () => ({
  revalidateInventoryListForCurrentOrg: vi.fn(async () => true),
}));
vi.mock('@/server/services/audit', () => ({ audit: vi.fn() }));

import { ServiceError, type ServiceContext } from '@/server/services/context';
import { LocationsService } from '@/server/services/locations';

import { archiveLocationAction, restoreLocationAction } from './locations';

/**
 * The Locations page's Archive dialog offers "Archive anyway" only when the
 * refusal says, in its details, that the location still holds stock
 * (locations-manager.tsx reads `error.details.locationHoldsStock`). The
 * service has always put that flag on its ServiceError; the action's
 * toResult kept the code and the message and dropped the details, so the
 * page only ever got a toast and the override could never be reached. These
 * run the real LocationsService (over a stubbed database), so the flag is
 * the one the guard really throws.
 */

const LOC = 'loc-rack-100a';

function serviceOver(stub: SupabaseStub): LocationsService {
  return new LocationsService({
    supabase: stub.client,
    organizationId: 'org-test',
    userId: 'user-test',
    role: 'admin',
    mfaRequired: false,
    mfaSatisfied: true,
    enabledModules: new Set(),
  } as unknown as ServiceContext);
}

/** A rack holding 12 units of one item, as the archive guard reads it. */
function rackWithStock(): SupabaseStub {
  return makeSupabaseStub({
    'locations.select': { data: { id: LOC, kind: 'rack' }, error: null },
    'locations.update': { data: { id: LOC }, error: null },
    'item_stock_levels.select': {
      data: [{ quantity: 12, inventory_items: { id: 'item-1', name: 'Earth and Space' } }],
      error: null,
    },
    'rpc:location_stock_census': {
      data: [{ holding_rows: 1, total_quantity: 12 }],
      error: null,
    },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('archiveLocationAction', () => {
  it('returns the stock refusal WITH its details, so the dialog can offer Archive anyway', async () => {
    const stub = rackWithStock();
    vi.spyOn(LocationsService, 'forCurrentUser').mockResolvedValue(serviceOver(stub));

    const res = await archiveLocationAction(LOC);

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('validation_error');
    expect(res.error.message).toContain('12 units');
    expect(res.error.details).toMatchObject({ locationHoldsStock: true, units: 12, items: 1 });
    // Refused before the soft-delete.
    expect(stub.chains.get('locations.update')).toBeUndefined();
  });

  it('archives on the second press, when the operator acknowledged the stock', async () => {
    const stub = rackWithStock();
    vi.spyOn(LocationsService, 'forCurrentUser').mockResolvedValue(serviceOver(stub));

    const res = await archiveLocationAction(LOC, { acknowledgeStock: true });

    expect(res).toEqual({ ok: true, data: undefined });
    expect(stub.chains.get('locations.update')).toBeDefined();
  });

  it('never forwards the details of an internal error (raw database text stays on the server)', async () => {
    vi.spyOn(LocationsService, 'forCurrentUser').mockResolvedValue({
      archive: vi.fn(async () => {
        throw new ServiceError('internal_error', 'relation "locations" violates policy', {
          constraint: 'locations_org_fk',
        });
      }),
    } as unknown as LocationsService);

    const res = await archiveLocationAction(LOC);

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('internal_error');
    expect(res.error.details).toBeUndefined();
    expect(res.error.message).not.toContain('locations');
  });
});

describe('a location action that hits an unexpected exception', () => {
  it('answers with a generic message, never the exception text', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(LocationsService, 'forCurrentUser').mockResolvedValue({
      restore: vi.fn(async () => {
        throw new Error('duplicate key value violates unique constraint "locations_pkey"');
      }),
    } as unknown as LocationsService);

    const res = await restoreLocationAction(LOC);

    expect(res).toEqual({
      ok: false,
      error: { code: 'internal_error', message: 'Something went wrong. Please try again.' },
    });
    // Still logged on the server for diagnosis.
    expect(consoleError).toHaveBeenCalled();
  });
});
