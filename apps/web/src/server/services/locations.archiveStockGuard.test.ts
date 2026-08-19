import { describe, expect, it, vi } from 'vitest';

import { makeSupabaseStub, type SupabaseStub } from '@/test/supabase-mock';

vi.mock('./audit', () => ({ audit: vi.fn() }));

import { ServiceError, type ServiceContext } from './context';
import { LocationsService } from './locations';

// ---------------------------------------------------------------------------
// ARCHIVING A LOCATION THAT STILL HOLDS STOCK — rack 100-A, 2026-08-19
//
// InventoryService.archive has refused to archive an ITEM holding stock since
// the 2026-07-23 wave. archive() on a LOCATION had no such guard: it refused
// Staging/Unplaced and nothing else, so a rack with units on it soft-deleted
// cleanly.
//
// That is the more dangerous of the two. Archiving an item at least hides the
// item along with its stock; archiving a location leaves every
// `item_stock_levels` row pointing at it completely untouched, so the units go
// on counting toward on-hand, valuation and reconciliation while the place they
// name vanishes from every list. Nothing anywhere then shows where they are.
//
// And it sits directly in the path of the incident that motivated it. Rack
// 100-A was created at DC4 as a test, has 22 real units on it today, and the
// obvious reaction to "this rack should not exist" is to delete it. Without
// this guard, doing so converts a visible problem into an invisible one — and
// the units are unreachable afterwards, because every picker, transfer source
// and report filters deleted locations out.
//
// The override exists for a genuine decommission, and it has to be asked for.
// ---------------------------------------------------------------------------

const LOC = 'loc-rack-100a';

function makeService(opts: {
  row?: { id: string; kind: string | null } | null;
  holdings?: Array<{ quantity: number; inventory_items: { id: string; name: string } }>;
  holdingsError?: { message: string } | null;
}): { svc: LocationsService; stub: SupabaseStub } {
  const row = 'row' in opts ? opts.row : { id: LOC, kind: 'rack' };
  const stub = makeSupabaseStub({
    'locations.select': { data: row, error: null },
    'locations.update': { data: row ? { id: row.id } : null, error: null },
    'item_stock_levels.select': {
      data: opts.holdings ?? [],
      error: opts.holdingsError ?? null,
    },
  });
  const ctx = {
    supabase: stub.client,
    organizationId: 'org-test',
    userId: 'user-test',
    role: 'admin',
    mfaRequired: false,
    mfaSatisfied: true,
    enabledModules: new Set(),
  } as unknown as ServiceContext;
  return { svc: new LocationsService(ctx), stub };
}

async function archiveError(svc: LocationsService, opts?: { acknowledgeStock?: boolean }) {
  return svc
    .archive(LOC, opts)
    .then(() => null)
    .catch((e: unknown) => e);
}

describe('LocationsService.archive — the stock guard', () => {
  it('refuses a rack that still holds stock, and names what is on it', async () => {
    const { svc, stub } = makeService({
      holdings: [
        { quantity: 12, inventory_items: { id: 'i1', name: 'Science Dimensions Earth & Space' } },
        { quantity: 10, inventory_items: { id: 'i2', name: 'Science Dimensions Earth & Space' } },
      ],
    });

    const err = await archiveError(svc);

    expect(err).toBeInstanceOf(ServiceError);
    expect((err as ServiceError).code).toBe('validation_error');
    const msg = (err as ServiceError).message;
    expect(msg).toContain('22 units');
    expect(msg).toContain('2 items');
    // Never the item wording: archiving a location writes nothing off.
    expect(msg).not.toMatch(/write it off/i);
    // THE FLAG IS THE CONTRACT the dialog switches on — pinned here because
    // matching this refusal by substring is recurring-bug #28: a reword makes
    // the override silently unreachable with every test still passing.
    expect((err as ServiceError).details).toMatchObject({
      locationHoldsStock: true,
      units: 22,
      items: 2,
    });
    // THE SOFT-DELETE NEVER RAN. A guard that refuses after the update is not
    // a guard, and the whole hazard is the row disappearing.
    expect(stub.chains.get('locations.update')).toBeUndefined();
  });

  it('archives a rack that holds nothing', async () => {
    const { svc, stub } = makeService({ holdings: [] });
    await expect(svc.archive(LOC)).resolves.toBeUndefined();
    expect(stub.chains.get('locations.update')).toBeDefined();
  });

  it('ignores zero-quantity rows — an emptied rack keeps its holding rows forever', async () => {
    // 100-A itself carries four of these: items whose stock was written off but
    // whose (item, location) row survives at 0. They are not stock and must not
    // block a decommission, or no rack could ever be archived after use.
    const { svc, stub } = makeService({
      holdings: [{ quantity: 0, inventory_items: { id: 'i1', name: 'Maus I' } }],
    });
    await expect(svc.archive(LOC)).resolves.toBeUndefined();
    expect(stub.chains.get('locations.update')).toBeDefined();
  });

  it('archives anyway when the caller explicitly acknowledges the stock', async () => {
    const { svc, stub } = makeService({
      holdings: [{ quantity: 12, inventory_items: { id: 'i1', name: 'A book' } }],
    });
    await expect(svc.archive(LOC, { acknowledgeStock: true })).resolves.toBeUndefined();
    expect(stub.chains.get('locations.update')).toBeDefined();
  });

  it('FAILS CLOSED when the holdings read errors — never archives on an unknown', async () => {
    // Same posture as assertBulkArchivableOrThrow. If we cannot prove the
    // location is empty we must not delete it; the alternative is orphaning
    // stock on a transient PostgREST failure.
    const { svc, stub } = makeService({ holdingsError: { message: 'boom' } });
    const err = await archiveError(svc);
    expect(err).toBeInstanceOf(ServiceError);
    expect((err as ServiceError).code).toBe('internal_error');
    expect(stub.chains.get('locations.update')).toBeUndefined();
  });

  it('still refuses Staging/Unplaced before it ever looks at stock', async () => {
    // The system guard is the outer one and must not be reachable-around by an
    // acknowledgement — those buckets are never archivable at any price.
    const { svc, stub } = makeService({
      row: { id: LOC, kind: 'staging' },
      holdings: [{ quantity: 5, inventory_items: { id: 'i1', name: 'A book' } }],
    });
    const err = await archiveError(svc, { acknowledgeStock: true });
    expect(err).toBeInstanceOf(ServiceError);
    expect((err as ServiceError).message).toContain('managed automatically');
    expect(stub.chains.get('locations.update')).toBeUndefined();
  });
});
