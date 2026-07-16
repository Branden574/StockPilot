import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeSupabaseStub } from '@/test/supabase-mock';

const stubHolder: { stub: ReturnType<typeof makeSupabaseStub> | null } = { stub: null };

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => stubHolder.stub!.client),
}));

// Mutable auth state so per-test unauthenticated/org overrides work
// (mirrors custom-fields.test.ts / dashboard-settings.test.ts).
const contextState: { throwUnauth: boolean; organizationId: string } = {
  throwUnauth: false,
  organizationId: 'org-1',
};

vi.mock('@/server/services/context', async () => {
  const actual = await vi.importActual<typeof import('@/server/services/context')>(
    '@/server/services/context',
  );
  return {
    ...actual,
    withContext: vi.fn(async () => {
      if (contextState.throwUnauth) {
        throw new actual.ServiceError('unauthenticated', 'Not signed in.');
      }
      return {
        organizationId: contextState.organizationId,
        userId: 'user-1',
        role: 'admin',
        supabase: stubHolder.stub!.client,
        mfaRequired: false,
        mfaSatisfied: true,
        enabledModules: new Set(),
      };
    }),
  };
});

import { loadOlderItemActivityAction } from './activity';

const ITEM_ID = '11111111-1111-1111-1111-111111111111';
const BEFORE = '2025-06-01T00:00:00.000Z';

function movementRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'm1',
    movement_type: 'adjust',
    quantity_change: 1,
    previous_quantity: 9,
    new_quantity: 10,
    moved_quantity: null,
    from_location_id: null,
    to_location_id: null,
    reason: null,
    reference_type: null,
    reference_id: null,
    notes: null,
    created_at: '2025-01-01T00:00:00.000Z',
    user_id: null,
    ...overrides,
  };
}

describe('loadOlderItemActivityAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    contextState.throwUnauth = false;
    contextState.organizationId = 'org-1';
    stubHolder.stub = null;
  });

  it('rejects a non-uuid itemId as validation_error, no query issued', async () => {
    const stub = makeSupabaseStub();
    stubHolder.stub = stub;

    const result = await loadOlderItemActivityAction({ itemId: 'not-a-uuid', before: BEFORE });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('validation_error');
    expect(stub.fromCalls).toEqual([]);
  });

  it('rejects a non-ISO `before` value as validation_error, no query issued', async () => {
    const stub = makeSupabaseStub();
    stubHolder.stub = stub;

    const result = await loadOlderItemActivityAction({ itemId: ITEM_ID, before: 'not-a-date' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('validation_error');
    expect(stub.fromCalls).toEqual([]);
  });

  it('returns an `unauthenticated` error (never throws) when there is no session', async () => {
    contextState.throwUnauth = true;
    stubHolder.stub = makeSupabaseStub();

    const result = await loadOlderItemActivityAction({ itemId: ITEM_ID, before: BEFORE });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('unauthenticated');
  });

  it("scopes every underlying query to the CALLER's organization — never a value derived from the request (no cross-org leak)", async () => {
    contextState.organizationId = 'org-caller';
    const stub = makeSupabaseStub({
      'stock_movements.select': { data: [], error: null },
      'audit_logs.select': { data: [], error: null },
    });
    stubHolder.stub = stub;

    const result = await loadOlderItemActivityAction({ itemId: ITEM_ID, before: BEFORE });
    expect(result.ok).toBe(true);

    const movChain = stub.chains.get('stock_movements.select') ?? [];
    const movArgs = stub.chainArgs.get('stock_movements.select') ?? [];
    const movOrgIdx = movChain.indexOf('eq');
    expect(movArgs[movOrgIdx]).toEqual(['organization_id', 'org-caller']);

    const auditChain = stub.chains.get('audit_logs.select') ?? [];
    const auditArgs = stub.chainArgs.get('audit_logs.select') ?? [];
    const auditOrgIdx = auditChain.indexOf('eq');
    expect(auditArgs[auditOrgIdx]).toEqual(['organization_id', 'org-caller']);
  });

  it('threads `before` through to ActivityService.forItem as a `.lt(created_at, before)` bound on BOTH queries', async () => {
    const stub = makeSupabaseStub({
      'stock_movements.select': { data: [], error: null },
      'audit_logs.select': { data: [], error: null },
    });
    stubHolder.stub = stub;

    await loadOlderItemActivityAction({ itemId: ITEM_ID, before: BEFORE });

    const movChain = stub.chains.get('stock_movements.select') ?? [];
    const movArgs = stub.chainArgs.get('stock_movements.select') ?? [];
    const movLtIdx = movChain.indexOf('lt');
    expect(movLtIdx).toBeGreaterThan(-1);
    expect(movArgs[movLtIdx]).toEqual(['created_at', BEFORE]);

    const auditChain = stub.chains.get('audit_logs.select') ?? [];
    const auditArgs = stub.chainArgs.get('audit_logs.select') ?? [];
    const auditLtIdx = auditChain.indexOf('lt');
    expect(auditLtIdx).toBeGreaterThan(-1);
    expect(auditArgs[auditLtIdx]).toEqual(['created_at', BEFORE]);
  });

  it('returns exhausted=true when the page comes up short of BOTH per-kind caps (50 movements / 25 audits)', async () => {
    const stub = makeSupabaseStub({
      'stock_movements.select': { data: [movementRow()], error: null },
      'audit_logs.select': { data: [], error: null },
    });
    stubHolder.stub = stub;

    const result = await loadOlderItemActivityAction({ itemId: ITEM_ID, before: BEFORE });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.exhausted).toBe(true);
  });

  it('returns exhausted=false when movements alone still fill the full page cap (50), even with zero audits', async () => {
    const stub = makeSupabaseStub({
      'stock_movements.select': {
        data: Array.from({ length: 50 }, (_, i) =>
          movementRow({ id: `m${i}`, created_at: new Date(2025, 0, 1, 0, i).toISOString() }),
        ),
        error: null,
      },
      'audit_logs.select': { data: [], error: null },
    });
    stubHolder.stub = stub;

    const result = await loadOlderItemActivityAction({ itemId: ITEM_ID, before: BEFORE });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.exhausted).toBe(false);
  });

  it('resolves locationNames for ONLY the location ids referenced by this page', async () => {
    const stub = makeSupabaseStub({
      'stock_movements.select': {
        data: [
          movementRow({
            id: 'm-tx',
            movement_type: 'transfer',
            from_location_id: 'loc-a',
            to_location_id: 'loc-b',
          }),
        ],
        error: null,
      },
      'audit_logs.select': { data: [], error: null },
      'locations.select': {
        data: [
          { id: 'loc-a', name: 'Rack A1' },
          { id: 'loc-b', name: 'Rack B2' },
          { id: 'loc-c', name: 'Unreferenced Rack' },
        ],
        error: null,
      },
    });
    stubHolder.stub = stub;

    const result = await loadOlderItemActivityAction({ itemId: ITEM_ID, before: BEFORE });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.locationNames).toEqual({ 'loc-a': 'Rack A1', 'loc-b': 'Rack B2' });
      expect(result.data.events).toHaveLength(1);
      expect(result.data.events[0]!.id).toBe('m:m-tx');
    }
  });

  it('skips the locations query entirely when no returned event references a location', async () => {
    const stub = makeSupabaseStub({
      'stock_movements.select': { data: [movementRow()], error: null },
      'audit_logs.select': { data: [], error: null },
    });
    stubHolder.stub = stub;

    const result = await loadOlderItemActivityAction({ itemId: ITEM_ID, before: BEFORE });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.locationNames).toEqual({});
    expect(stub.fromCalls).not.toContain('locations');
  });
});
