// The words for a SKU already taken where a record is going (migration 0234:
// one SKU per organization, charter and rack label). The owner changed
// charters to force records to group because the old words told him to:
// "change the SKU, the charter, or the rack/location" (2026-10-05). The words
// now say what collided, in plain words, and never advise changing the charter
// or the rack to get around the rule. When the caller can read the record that
// holds the SKU (one RLS-scoped lookup), they name it and carry its id.
import { describe, expect, it, vi } from 'vitest';

vi.mock('./context', () => ({
  withContext: vi.fn(),
  ServiceError: class extends Error {
    constructor(
      public code: string,
      message: string,
      public details?: Record<string, unknown>,
    ) {
      super(message);
    }
  },
  assertPermission: vi.fn(),
  assertPlanLimit: vi.fn(),
  assertModuleEnabled: vi.fn(),
}));
vi.mock('@/lib/auth/warehouse', () => ({
  getWarehouseAccess: vi.fn(async () => ({ hasAllAccess: true, readableIds: [] })),
  forcedWarehouseId: vi.fn(async () => null),
  assertWarehouseAccess: vi.fn(async () => undefined),
  ForbiddenError: class extends Error {},
}));
vi.mock('./audit', () => ({ audit: vi.fn(async () => undefined) }));
vi.mock('./lib/inventory-list-cache', () => ({ invalidateInventoryListAfterWrite: vi.fn() }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn() }));

import { createAdminClient } from '@/lib/supabase/admin';

import { InventoryService, skuTakenMessage } from './inventory';

const CHARTER_ADVICE =
  /(change|switch|pick|choose|use) (the |a |another |a different )?(sku, (the )?)?charter|different charter|another charter|charter, or|different rack|another rack|rack\/location/i;

describe('skuTakenMessage', () => {
  it('names the SKU and the record that holds it, and offers only a different SKU or opening that record', () => {
    const named = skuTakenMessage('SP-IIHH8-AZCSKHS', 'Black Mouse Pad');
    expect(named).toContain('SP-IIHH8-AZCSKHS');
    expect(named).toContain('Black Mouse Pad');
    expect(named).not.toMatch(CHARTER_ADVICE);
    const unnamed = skuTakenMessage('SP-IIHH8-AZCSKHS', null);
    expect(unnamed).toContain('SP-IIHH8-AZCSKHS');
    expect(unnamed).not.toMatch(CHARTER_ADVICE);
  });
});

type Filter = [string, string, unknown];

function harness(opts: {
  conflict: { id: string; name: string } | null;
  siblingFails?: boolean;
  targetFails?: boolean;
}) {
  const TARGET = {
    id: 'row-a',
    organization_id: 'org-1',
    sku: 'SP-OLD',
    name: 'Mouse pad',
    warehouse_id: null,
    bin_location: '22-C',
    charter_id: null,
    custom_fields: {},
    status: 'active',
    item_type: 'product',
    tracking_type: 'none',
    quantity_on_hand: 4,
    category_id: null,
    group_id: null,
  };
  const lookups: Filter[][] = [];
  const emptyChain = () => {
    const p: Record<string, unknown> = {};
    for (const m of ['select', 'update', 'eq', 'neq', 'is', 'in', 'order', 'limit']) p[m] = () => p;
    p.single = async () => ({ data: null, error: null });
    p.maybeSingle = async () => ({ data: null, error: null });
    (p as { then: unknown }).then = (res: (v: unknown) => unknown) =>
      res({ data: [], error: null });
    return p;
  };
  const supabase = {
    from: (table: string) => {
      if (table !== 'inventory_items') return emptyChain();
      let isUpdate = false;
      let isLookup = false;
      const filters: Filter[] = [];
      const p: Record<string, unknown> = {};
      p.select = (cols: string) => {
        if (!isUpdate && /^id, name$/.test(cols.trim())) isLookup = true;
        return p;
      };
      p.update = () => ((isUpdate = true), p);
      for (const op of ['eq', 'neq', 'is', 'in'])
        p[op] = (c: string, v: unknown) => (filters.push([op, c, v]), p);
      p.order = () => p;
      p.limit = () => p;
      const resolve = () => {
        if (isLookup) {
          lookups.push(filters);
          return { data: opts.conflict ? [opts.conflict] : [], error: null };
        }
        if (isUpdate) {
          return opts.targetFails
            ? {
                data: null,
                error: { code: '23505', message: 'duplicate key value violates unique constraint' },
              }
            : { data: { ...TARGET, sku: 'SP-NEW' }, error: null };
        }
        return { data: TARGET, error: null };
      };
      p.single = async () => resolve();
      p.maybeSingle = async () => resolve();
      (p as { then: unknown }).then = (res: (v: unknown) => unknown) => res(resolve());
      return p;
    },
  };
  const admin = {
    from: () => {
      const p: Record<string, unknown> = {};
      for (const m of ['update', 'eq', 'neq', 'is', 'select']) p[m] = () => p;
      (p as { then: unknown }).then = (res: (v: unknown) => unknown) =>
        res(
          opts.siblingFails
            ? { data: null, error: { code: '23505', message: 'dup' } }
            : { data: null, error: null },
        );
      return p;
    },
  };
  vi.mocked(createAdminClient).mockReturnValue(admin as never);
  const ctx = {
    organizationId: 'org-1',
    userId: 'u-1',
    role: 'admin',
    supabase,
    enabledModules: new Set<string>(),
  } as never;
  return { svc: new InventoryService(ctx), lookups };
}

describe('InventoryService.update: a SKU already taken at this charter and rack', () => {
  it('names the record the caller can read, carries its id, and never advises a charter change', async () => {
    const { svc, lookups } = harness({
      conflict: { id: 'row-z', name: 'Black Mouse Pad' },
      targetFails: true,
    });
    const err = (await svc.update('row-a', { sku: 'SP-NEW' }).catch((e: unknown) => e)) as {
      code: string;
      message: string;
      details?: Record<string, unknown>;
    };
    expect(err.code).toBe('conflict');
    expect(err.message).toContain('SP-NEW');
    expect(err.message).toContain('Black Mouse Pad');
    expect(err.message).not.toMatch(CHARTER_ADVICE);
    expect(err.details).toMatchObject({
      reason: 'sku_taken',
      sku: 'SP-NEW',
      conflictItemId: 'row-z',
    });
    // One lookup, under the caller's own client, for exactly the slot 0234 guards.
    expect(lookups).toEqual([
      [
        ['eq', 'organization_id', 'org-1'],
        ['eq', 'sku', 'SP-NEW'],
        ['is', 'deleted_at', null],
        ['is', 'charter_id', null],
        ['eq', 'bin_location', '22-C'],
        ['neq', 'id', 'row-a'],
      ],
    ]);
  });

  it('says only what it may when the record is hidden from the caller', async () => {
    const { svc } = harness({ conflict: null, targetFails: true });
    const err = (await svc.update('row-a', { sku: 'SP-NEW' }).catch((e: unknown) => e)) as {
      message: string;
      details?: Record<string, unknown>;
    };
    expect(err.message).toContain('SP-NEW');
    expect(err.message).not.toMatch(CHARTER_ADVICE);
    expect(err.details).not.toHaveProperty('conflictItemId');
  });

  it('a sibling that cannot follow a re-key is told honestly: this record moved, the others kept the old SKU', async () => {
    const { svc } = harness({ conflict: null, siblingFails: true });
    const err = (await svc.update('row-a', { sku: 'SP-NEW' }).catch((e: unknown) => e)) as {
      code: string;
      message: string;
    };
    expect(err.code).toBe('conflict');
    expect(err.message).toMatch(/SP-NEW/);
    expect(err.message).toMatch(/SP-OLD/);
    expect(err.message).not.toMatch(CHARTER_ADVICE);
  });
});
