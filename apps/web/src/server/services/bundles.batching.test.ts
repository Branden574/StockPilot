import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The bundle list batches its last-distributed read: the list has no ceiling,
 * and one `.in()` past ~215 uuids fails (414 locally, "fetch failed" in
 * production after ~7 s of retries).
 */

const reportError = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('@/lib/error-reporter', () => ({ reportError }));
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

import {
  inFilters,
  makeServiceContext,
  makeSupabaseStub,
  type MockCall,
} from '@/test/supabase-mock';

import { BundlesService } from './bundles';
import { ServiceError } from './context';

const uuid = (i: number, p = '0') => `${p.repeat(8)}-0000-4000-8000-${String(i).padStart(12, '0')}`;
const ids = (n: number, p?: string) => Array.from({ length: n }, (_, i) => uuid(i, p));

function inList(call: MockCall, column: string): string[] | null {
  const hit = inFilters(call).find(([c]) => c === column);
  return hit ? (hit[1] as string[]) : null;
}

beforeEach(() => {
  reportError.mockClear();
});

describe('BundlesService batched reads', () => {
  it('list() reads the last distribution of 250 bundles in batches and keeps the newest', async () => {
    const bundles = ids(250, 'b').map((id) => ({
      id,
      name: id,
      sku: null,
      is_active: true,
      preassembly_enabled: false,
      archived_at: null,
      components: [],
      phantom: null,
    }));
    const lists: string[][] = [];
    const stub = makeSupabaseStub({
      'bundles.select': { data: bundles, error: null },
      'bundle_distributions.select': (call) => {
        const list = inList(call, 'bundle_id') ?? [];
        lists.push(list);
        // Newest first, as the query orders it.
        return {
          data: list.flatMap((bundle_id) => [
            { bundle_id, distributed_at: '2026-09-20T00:00:00Z' },
            { bundle_id, distributed_at: '2026-01-01T00:00:00Z' },
          ]),
          error: null,
        };
      },
    });
    const out = await new BundlesService(makeServiceContext(stub.client)).list();
    expect(lists.map((l) => l.length)).toEqual([100, 100, 50]);
    expect(out.at(-1)?.lastDistributedAt).toBe('2026-09-20T00:00:00Z');
  });

  it('list() throws when a distribution batch fails', async () => {
    let n = 0;
    const stub = makeSupabaseStub({
      'bundles.select': { data: ids(250, 'b').map((id) => ({ id, name: id })), error: null },
      'bundle_distributions.select': () => {
        n += 1;
        return n === 3 ? { data: null, error: { message: 'boom' } } : { data: [], error: null };
      },
    });
    await expect(new BundlesService(makeServiceContext(stub.client)).list()).rejects.toBeInstanceOf(
      ServiceError,
    );
  });
});
