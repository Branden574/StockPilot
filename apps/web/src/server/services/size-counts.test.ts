import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_MODULE_IDS, type ModuleId } from '@stockpilot/core';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

vi.mock('@/lib/auth/warehouse', () => ({
  assertWarehouseAccess: vi.fn(),
  getWarehouseAccess: vi.fn(async () => ({
    readableIds: ['wh-a'],
    writableIds: ['wh-a'],
    hasAllAccess: true,
    primaryWarehouseId: 'wh-a',
  })),
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

import { SizeCountsService } from './size-counts';

const withIsc = new Set<ModuleId>([...DEFAULT_MODULE_IDS, 'instant_size_count']);

beforeEach(() => vi.clearAllMocks());

describe('SizeCountsService.createSession', () => {
  it('creates a session and returns it', async () => {
    const stub = makeSupabaseStub({
      'size_count_sessions.insert': {
        data: { id: 'sess-1', organization_id: 'org-test', status: 'active', mode: 'rapid_pass' },
        error: null,
      },
    });
    const svc = new SizeCountsService(makeServiceContext(stub.client, { enabledModules: withIsc }));
    const session = await svc.createSession({ styleKey: 'TEE-BLACK' });
    expect(session).toMatchObject({ id: 'sess-1', status: 'active' });
  });

  it('throws when the instant_size_count module is disabled', async () => {
    const stub = makeSupabaseStub({});
    const svc = new SizeCountsService(
      makeServiceContext(stub.client, { enabledModules: new Set<ModuleId>(['inventory']) }),
    );
    await expect(svc.createSession({})).rejects.toMatchObject({ code: 'module_disabled' });
  });
});

describe('SizeCountsService.appendEvents', () => {
  it('idempotently appends and returns the count of NEW events', async () => {
    const stub = makeSupabaseStub({
      'size_count_sessions.select': { data: { warehouse_id: null, status: 'active' }, error: null },
      // upsert maps to op=insert in the stub; ignoreDuplicates returns only new rows.
      'size_count_events.insert': { data: [{ id: 'e1' }, { id: 'e2' }], error: null },
    });
    const svc = new SizeCountsService(makeServiceContext(stub.client, { enabledModules: withIsc }));
    const res = await svc.appendEvents('sess-1', [
      { idempotencyKey: 'k1', size: 'M' },
      { idempotencyKey: 'k2', size: 'L' },
      { idempotencyKey: 'k1', size: 'M' }, // replay — deduped server-side
    ]);
    expect(res).toEqual({ inserted: 2 });
  });

  it('rejects appending to a completed session (conflict)', async () => {
    const stub = makeSupabaseStub({
      'size_count_sessions.select': { data: { warehouse_id: null, status: 'completed' }, error: null },
    });
    const svc = new SizeCountsService(makeServiceContext(stub.client, { enabledModules: withIsc }));
    await expect(
      svc.appendEvents('sess-1', [{ idempotencyKey: 'k1', size: 'M' }]),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('404s when the session does not exist in the org', async () => {
    const stub = makeSupabaseStub({
      'size_count_sessions.select': { data: null, error: null },
    });
    const svc = new SizeCountsService(makeServiceContext(stub.client, { enabledModules: withIsc }));
    await expect(
      svc.appendEvents('missing', [{ idempotencyKey: 'k1', size: 'M' }]),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('is a no-op for an empty batch', async () => {
    const stub = makeSupabaseStub({});
    const svc = new SizeCountsService(makeServiceContext(stub.client, { enabledModules: withIsc }));
    expect(await svc.appendEvents('sess-1', [])).toEqual({ inserted: 0 });
  });
});

describe('SizeCountsService.getSession', () => {
  it('returns the session + per-size tally (SUM of quantity_delta)', async () => {
    const stub = makeSupabaseStub({
      'size_count_sessions.select': {
        data: { id: 'sess-1', organization_id: 'org-test', status: 'active' },
        error: null,
      },
      'size_count_events.select': {
        data: [
          { size: 'M', quantity_delta: 1 },
          { size: 'M', quantity_delta: 1 },
          { size: 'L', quantity_delta: 1 },
          { size: 'L', quantity_delta: -1 }, // undo — nets L to 0, dropped
        ],
        error: null,
      },
    });
    const svc = new SizeCountsService(makeServiceContext(stub.client, { enabledModules: withIsc }));
    const { tally } = await svc.getSession('sess-1');
    const bySize = Object.fromEntries(tally.map((t) => [t.size, t.quantity]));
    expect(bySize).toEqual({ M: 2 }); // L netted to 0 and is filtered out
  });
});
