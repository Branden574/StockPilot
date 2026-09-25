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
  /**
   * location_stock_census (0371): the org-wide count and total. Defaults to
   * exactly the positive `holdings`, i.e. a caller who can read every item at
   * the location.
   */
  census?: { data: unknown; error: { message: string; code?: string } | null };
}): { svc: LocationsService; stub: SupabaseStub } {
  const row = 'row' in opts ? opts.row : { id: LOC, kind: 'rack' };
  const positive = (opts.holdings ?? []).filter((h) => h.quantity > 0);
  const stub = makeSupabaseStub({
    'locations.select': { data: row, error: null },
    'locations.update': { data: row ? { id: row.id } : null, error: null },
    'item_stock_levels.select': {
      data: opts.holdings ?? [],
      error: opts.holdingsError ?? null,
    },
    'rpc:location_stock_census': opts.census ?? {
      data: [
        {
          holding_rows: positive.length,
          total_quantity: positive.reduce((sum, h) => sum + h.quantity, 0),
        },
      ],
      error: null,
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

  // ═══ THE TOTAL IS THE ORG'S (0371) ═══
  // The caller's own read is narrowed by warehouse (a staff member with
  // locations:manage) and by item (the inventory_items!inner embed). Probe
  // C6 of the 0371 design: that read saw 0 rows where the location held 2
  // holdings / 15 units, and the location archived. The census decides now.

  it('refuses on the census even when the caller can read NONE of the stock', async () => {
    const { svc, stub } = makeService({
      holdings: [],
      census: { data: [{ holding_rows: 2, total_quantity: 15 }], error: null },
    });
    const err = await archiveError(svc);
    expect(err).toBeInstanceOf(ServiceError);
    expect((err as ServiceError).code).toBe('validation_error');
    expect((err as ServiceError).message).toBe(
      "Cannot archive: This location still holds 15 units of items you can't see. " +
        'Move or write off that stock first — archiving anyway leaves it still counted in on hand but attached to a hidden location.',
    );
    expect((err as ServiceError).details).toMatchObject({
      locationHoldsStock: true,
      units: 15,
      items: 2,
    });
    expect(stub.chains.get('locations.update')).toBeUndefined();
  });

  it('names what the caller can read and counts the rest', async () => {
    const { svc } = makeService({
      holdings: [{ quantity: 7, inventory_items: { id: 'i1', name: 'QA Chrome' } }],
      census: { data: [{ holding_rows: 2, total_quantity: 15 }], error: null },
    });
    const err = await archiveError(svc);
    expect((err as ServiceError).message).toContain(
      "still holds 15 units (7 of QA Chrome, and 8 units of items you can't see)",
    );
    expect((err as ServiceError).details).toMatchObject({ units: 15, items: 2 });
  });

  it('asks the census and the naming read TOGETHER, not one after the other', async () => {
    let release!: (v: unknown) => void;
    const held = new Promise((r) => {
      release = r;
    });
    const { svc, stub } = makeService({ holdings: [] });
    const realRpc = stub.client.rpc;
    stub.client.rpc = vi.fn(async (name: string, args: unknown) => {
      await held;
      return realRpc(name, args);
    });
    const pending = svc.archive(LOC);
    await new Promise((r) => setTimeout(r, 0));
    // The census has not answered, yet the naming read has already been made.
    expect(stub.fromCalls).toContain('item_stock_levels');
    release(undefined);
    await expect(pending).resolves.toBeUndefined();
  });

  it("maps the census's 42501 to forbidden and archives nothing", async () => {
    const { svc, stub } = makeService({
      census: { data: null, error: { message: 'forbidden', code: '42501' } },
    });
    const err = await archiveError(svc);
    expect(err).toBeInstanceOf(ServiceError);
    expect((err as ServiceError).code).toBe('forbidden');
    expect(stub.chains.get('locations.update')).toBeUndefined();
  });

  it('FAILS CLOSED when the census is missing (web deployed before the migration)', async () => {
    const { svc, stub } = makeService({
      census: {
        data: null,
        error: { message: 'Could not find the function', code: 'PGRST202' },
      },
    });
    const err = await archiveError(svc);
    expect(err).toBeInstanceOf(ServiceError);
    expect((err as ServiceError).code).toBe('internal_error');
    expect((err as ServiceError).internalDetail).toContain('Could not verify this location is empty');
    expect(stub.chains.get('locations.update')).toBeUndefined();
  });

  it('FAILS CLOSED when the census answers with no row: no answer is not "empty"', async () => {
    const { svc, stub } = makeService({ census: { data: [], error: null } });
    const err = await archiveError(svc);
    expect((err as ServiceError).code).toBe('internal_error');
    expect(stub.chains.get('locations.update')).toBeUndefined();
  });

  it('asks the census about THIS location', async () => {
    const { svc, stub } = makeService({ holdings: [] });
    await svc.archive(LOC);
    expect(stub.rpcCalls).toEqual([
      { name: 'location_stock_census', args: { p_location_id: LOC } },
    ]);
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
