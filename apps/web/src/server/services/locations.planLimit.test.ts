import { beforeEach, describe, expect, it } from 'vitest';

import { PLACEMENT_KINDS, PLACEMENT_TYPES, SYSTEM_KINDS } from '@/lib/locations/groups';
import { makeSupabaseStub, type SupabaseStub } from '@/test/supabase-mock';

import { ServiceError, type ServiceContext } from './context';
import { LocationsService } from './locations';

// ---------------------------------------------------------------------------
// The locations plan entitlement governs SITES only (what pickers offer and
// the Locations page "Sites" tab shows). Field regression 2026-07-07: a demo
// org with 2 sites was blocked from creating a rack because assertPlanLimit
// counted ALL location rows (2 sites + 3 shelves + 2 auto-created system
// buckets = 7 > Pro's 5). These tests pin both halves of the fix:
//   1. create() consults the limit ONLY when the new row classifies as a site
//      (racks/crates/areas and shelf/bin types skip it entirely — they can
//      neither consume the limit nor be blocked by an org at its site cap);
//   2. assertPlanLimit's count applies the sites-only SQL mirror of
//      isSiteLocation(), built from the same groups.ts constants.
// ---------------------------------------------------------------------------

const ORG_ID = 'org-test';
const WAREHOUSE_ID = 'dddddddd-dddd-dddd-dddd-dddddddddddd';

const PRO_ORG_ROW = {
  plan: 'pro', // Pro caps locations at 5
  access_tier: null,
  billing_arrangement: null,
  stripe_subscription_id: null,
  trial_ends_at: null,
  trial_tier: null,
};

function makeService(opts: { siteCount: number }): { svc: LocationsService; stub: SupabaseStub } {
  const stub = makeSupabaseStub({
    'organizations.select': { data: PRO_ORG_ROW, error: null },
    'locations.select': { data: null, error: null, count: opts.siteCount },
    'locations.insert': { data: { id: 'loc-new' }, error: null },
  });
  const ctx = {
    supabase: stub.client,
    organizationId: ORG_ID,
    userId: 'user-test',
    role: 'admin',
    mfaRequired: false,
    mfaSatisfied: true,
    enabledModules: new Set(),
  } as unknown as ServiceContext;
  return { svc: new LocationsService(ctx), stub };
}

describe('LocationsService.create — plan limit is sites-only', () => {
  let svc: LocationsService;
  let stub: SupabaseStub;

  describe('placement rows skip the entitlement entirely', () => {
    beforeEach(() => {
      // Count would be OVER the Pro cap if it were consulted.
      ({ svc, stub } = makeService({ siteCount: 99 }));
    });

    it('creates a rack (kind) without ever querying the plan or the count', async () => {
      const row = await svc.create({
        name: 'Rack Z9',
        kind: 'rack',
        warehouseId: WAREHOUSE_ID,
        rackNumber: 'Z9',
      });
      expect(row).toEqual({ id: 'loc-new' });
      expect(stub.fromCalls).not.toContain('organizations');
      expect(stub.chains.get('locations.select')).toBeUndefined();
    });

    it('creates a shelf (type) without consulting the limit', async () => {
      const row = await svc.create({ name: 'Aisle C — Shelf 3', type: 'shelf' });
      expect(row).toEqual({ id: 'loc-new' });
      expect(stub.fromCalls).not.toContain('organizations');
    });
  });

  describe('site rows still consume the entitlement', () => {
    it('rejects a new site when the org is at its site cap — and never inserts', async () => {
      ({ svc, stub } = makeService({ siteCount: 5 }));
      const err = await svc
        .create({ name: 'Overflow Depot', type: 'warehouse' })
        .then(() => null)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ServiceError);
      expect((err as ServiceError).code).toBe('plan_limit_exceeded');
      expect(stub.chains.get('locations.insert')).toBeUndefined();
    });

    it('creates a site under the cap, counting with the sites-only filters', async () => {
      ({ svc, stub } = makeService({ siteCount: 2 }));
      const row = await svc.create({ name: 'Overflow Depot', type: 'warehouse' });
      expect(row).toEqual({ id: 'loc-new' });

      // The count query must mirror isSiteLocation(): two OR groups (ANDed by
      // PostgREST) that keep NULLs and exclude system/placement kinds + types.
      const chain = stub.chains.get('locations.select') ?? [];
      const args = stub.chainArgs.get('locations.select') ?? [];
      const orFilters = chain
        .map((method, i) => (method === 'or' ? (args[i]?.[0] as string) : null))
        .filter((f): f is string => f !== null);
      expect(orFilters).toEqual([
        `kind.is.null,kind.not.in.(${[...SYSTEM_KINDS, ...PLACEMENT_KINDS].join(',')})`,
        `type.is.null,type.not.in.(${PLACEMENT_TYPES.join(',')})`,
      ]);
    });
  });
});
