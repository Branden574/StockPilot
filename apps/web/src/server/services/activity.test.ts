import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

vi.mock('@/lib/auth/warehouse', () => ({
  getWarehouseAccess: vi.fn(async () => ({
    readableIds: ['wh-a'],
    writableIds: ['wh-a'],
    hasAllAccess: true,
    primaryWarehouseId: 'wh-a',
  })),
  assertWarehouseAccess: vi.fn(),
  forcedWarehouseId: vi.fn(async () => null),
  ForbiddenError: class ForbiddenError extends Error {
    readonly code = 'forbidden' as const;
  },
}));

vi.mock('@/lib/auth/session', () => ({
  requireOrgContext: vi.fn(async () => ({
    userId: 'user-test',
    organizationId: 'org-test',
    role: 'admin',
  })),
}));

import { ActivityService } from './activity';

beforeEach(() => {
  vi.clearAllMocks();
});

// ActivityService.forItem uses the constructor (private), so we use a
// little helper to instantiate it from a ctx — bypassing the private
// constructor via the JS-accessible class shape.
function makeService(client: unknown): ActivityService {
  // The constructor is `private` at the type level only; we still reach it
  // via `new` here because TypeScript private is structural at runtime.
   
  return new (ActivityService as any)(makeServiceContext(client));
}

describe('ActivityService.forItem', () => {
  it('merges movement + audit events and sorts by createdAt desc', async () => {
    const stub = makeSupabaseStub({
      'stock_movements.select': {
        data: [
          {
            id: 'm-old',
            movement_type: 'adjust',
            quantity_change: 1,
            new_quantity: 5,
            reason: 'restock',
            notes: null,
            created_at: '2025-01-01T00:00:00.000Z',
            user_id: 'u1',
          },
          {
            id: 'm-new',
            movement_type: 'transfer',
            quantity_change: -2,
            new_quantity: 3,
            reason: null,
            notes: 'moved to A',
            created_at: '2025-03-01T00:00:00.000Z',
            user_id: null,
          },
        ],
        error: null,
      },
      'audit_logs.select': {
        data: [
          {
            id: 'a1',
            event: 'item.updated',
            metadata: { reason: 'rename' },
            created_at: '2025-02-01T00:00:00.000Z',
            user_id: 'u1',
          },
        ],
        error: null,
      },
      'user_profiles.select': {
        data: [{ id: 'u1', full_name: 'Alice', email: 'a@x.com' }],
        error: null,
      },
    });
    const svc = makeService(stub.client);

    const events = await svc.forItem('item-1');
    expect(events).toHaveLength(3);
    expect(events.map((e) => e.id)).toEqual(['m:m-new', 'a:a1', 'm:m-old']);
  });

  it('falls back to "System" when movement has null user_id', async () => {
    const stub = makeSupabaseStub({
      'stock_movements.select': {
        data: [
          {
            id: 'm1',
            movement_type: 'initial',
            quantity_change: 10,
            new_quantity: 10,
            reason: null,
            notes: null,
            created_at: '2025-01-01T00:00:00.000Z',
            user_id: null,
          },
        ],
        error: null,
      },
      'audit_logs.select': { data: [], error: null },
    });
    const svc = makeService(stub.client);

    const events = await svc.forItem('item-1');
    expect(events).toHaveLength(1);
    expect(events[0]!.actor).toBe('System');
    expect(events[0]!.actorEmail).toBeNull();
  });

  it('looks up user_profiles via in() with the merged set of user_ids', async () => {
    const stub = makeSupabaseStub({
      'stock_movements.select': {
        data: [
          {
            id: 'm1',
            movement_type: 'adjust',
            quantity_change: 1,
            new_quantity: 1,
            reason: null,
            notes: null,
            created_at: '2025-01-01T00:00:00.000Z',
            user_id: 'u1',
          },
        ],
        error: null,
      },
      'audit_logs.select': {
        data: [
          {
            id: 'a1',
            event: 'item.updated',
            metadata: {},
            created_at: '2025-01-02T00:00:00.000Z',
            user_id: 'u2',
          },
        ],
        error: null,
      },
      'user_profiles.select': {
        data: [
          { id: 'u1', full_name: 'Alice', email: 'a@x.com' },
          { id: 'u2', full_name: null, email: 'b@x.com' },
        ],
        error: null,
      },
    });
    const svc = makeService(stub.client);

    await svc.forItem('item-1');

    const chain = stub.chains.get('user_profiles.select') ?? [];
    const args = stub.chainArgs.get('user_profiles.select') ?? [];
    const inIdx = chain.indexOf('in');
    expect(inIdx).toBeGreaterThan(-1);
    expect(args[inIdx]![0]).toBe('id');
    // Order is not guaranteed (Set iteration), so compare as sorted lists.
    expect([...(args[inIdx]![1] as string[])].sort()).toEqual(['u1', 'u2']);
  });

  it('skips the user_profiles lookup entirely when no user_ids are present', async () => {
    const stub = makeSupabaseStub({
      'stock_movements.select': { data: [], error: null },
      'audit_logs.select': { data: [], error: null },
    });
    const svc = makeService(stub.client);

    await svc.forItem('item-1');
    expect(stub.fromCalls).not.toContain('user_profiles');
  });

  it('uses email when full_name is null', async () => {
    const stub = makeSupabaseStub({
      'stock_movements.select': {
        data: [
          {
            id: 'm1',
            movement_type: 'adjust',
            quantity_change: 1,
            new_quantity: 1,
            reason: null,
            notes: null,
            created_at: '2025-01-01T00:00:00.000Z',
            user_id: 'u1',
          },
        ],
        error: null,
      },
      'audit_logs.select': { data: [], error: null },
      'user_profiles.select': {
        data: [{ id: 'u1', full_name: null, email: 'who@x.com' }],
        error: null,
      },
    });
    const svc = makeService(stub.client);

    const events = await svc.forItem('item-1');
    expect(events[0]!.actor).toBe('who@x.com');
    expect(events[0]!.actorEmail).toBe('who@x.com');
  });

  it('"Unknown" when user_id has no matching profile row', async () => {
    const stub = makeSupabaseStub({
      'stock_movements.select': {
        data: [
          {
            id: 'm1',
            movement_type: 'adjust',
            quantity_change: 1,
            new_quantity: 1,
            reason: null,
            notes: null,
            created_at: '2025-01-01T00:00:00.000Z',
            user_id: 'ghost',
          },
        ],
        error: null,
      },
      'audit_logs.select': { data: [], error: null },
      'user_profiles.select': { data: [], error: null },
    });
    const svc = makeService(stub.client);

    const events = await svc.forItem('item-1');
    expect(events[0]!.actor).toBe('Unknown');
    expect(events[0]!.actorEmail).toBeNull();
  });

  it('caps total events at the requested limit', async () => {
    const stub = makeSupabaseStub({
      'stock_movements.select': {
        data: Array.from({ length: 20 }, (_, i) => ({
          id: `m${i}`,
          movement_type: 'adjust',
          quantity_change: 1,
          new_quantity: 1,
          reason: null,
          notes: null,
          // Newer first so they win the sort.
          created_at: new Date(2025, 0, 1, 0, i).toISOString(),
          user_id: null,
        })),
        error: null,
      },
      'audit_logs.select': {
        data: Array.from({ length: 20 }, (_, i) => ({
          id: `a${i}`,
          event: 'item.updated',
          metadata: {},
          created_at: new Date(2024, 0, 1, 0, i).toISOString(),
          user_id: null,
        })),
        error: null,
      },
    });
    const svc = makeService(stub.client);

    const events = await svc.forItem('item-1', 6);
    expect(events).toHaveLength(6);
  });

  it('passes ceil(limit / 1.5) as the per-source limit', async () => {
    const stub = makeSupabaseStub({
      'stock_movements.select': { data: [], error: null },
      'audit_logs.select': { data: [], error: null },
    });
    const svc = makeService(stub.client);

    // limit=30 ⇒ halfLimit = ceil(30 / 1.5) = 20
    await svc.forItem('item-1', 30);

    const movChain = stub.chains.get('stock_movements.select') ?? [];
    const movArgs = stub.chainArgs.get('stock_movements.select') ?? [];
    const movLimitIdx = movChain.indexOf('limit');
    expect(movArgs[movLimitIdx]![0]).toBe(20);

    const auditChain = stub.chains.get('audit_logs.select') ?? [];
    const auditArgs = stub.chainArgs.get('audit_logs.select') ?? [];
    const auditLimitIdx = auditChain.indexOf('limit');
    expect(auditArgs[auditLimitIdx]![0]).toBe(20);
  });

  it('uses metadata.reason as audit summary when present', async () => {
    const stub = makeSupabaseStub({
      'stock_movements.select': { data: [], error: null },
      'audit_logs.select': {
        data: [
          {
            id: 'a1',
            event: 'item.archived',
            metadata: { reason: 'EOL product' },
            created_at: '2025-01-01T00:00:00.000Z',
            user_id: null,
          },
        ],
        error: null,
      },
    });
    const svc = makeService(stub.client);

    const events = await svc.forItem('item-1');
    expect(events[0]!.kind).toBe('audit');
    expect(events[0]!.summary).toBe('EOL product');
    expect(events[0]!.delta).toBeNull();
    expect(events[0]!.quantityAfter).toBeNull();
  });
});
