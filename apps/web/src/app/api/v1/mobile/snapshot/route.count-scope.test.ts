import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { withApiContext } from '@/lib/auth/api-context';
import { getWarehouseAccess } from '@/lib/auth/warehouse';

import { GET } from './route';

/**
 * The open cycle counts the phone's sync sends follow the one count read rule
 * (lib/auth/count-read-scope.ts), the rule the web count list and count page
 * apply (server/services/cycle-counts.read-scope.test.ts):
 *
 *   - managers and above, and members with every warehouse: every open count;
 *   - anyone else: the open counts of the warehouses they can read, and an
 *     open count with no warehouse only when it is assigned to them;
 *   - a member with no readable warehouse: none, and the read is not sent.
 *
 * Who may read counts at all (module and permission) is
 * route.read-gates.test.ts.
 */

vi.mock('@/lib/auth/api-context', () => ({ withApiContext: vi.fn() }));
vi.mock('@/lib/auth/warehouse', () => ({ getWarehouseAccess: vi.fn() }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn() }));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true, resetAt: Date.now() + 60_000 })),
}));

interface Query {
  table: string;
  calls: Array<{ method: string; args: unknown[] }>;
  sent: boolean;
}

const queries: Query[] = [];

function makeClient() {
  return {
    from(table: string) {
      const q: Query = { table, calls: [], sent: false };
      queries.push(q);
      const proxy: Record<string, unknown> = new Proxy(
        {},
        {
          get(_t, prop: string) {
            if (prop === 'then') {
              return (resolve: (v: unknown) => unknown) => {
                q.sent = true;
                return Promise.resolve(resolve({ data: [], error: null }));
              };
            }
            return (...args: unknown[]) => {
              q.calls.push({ method: prop, args });
              return proxy;
            };
          },
        },
      );
      return proxy as never;
    },
  };
}

const ME = 'u-1';

async function pull(role: 'owner' | 'admin' | 'manager' | 'staff' | 'viewer') {
  vi.mocked(withApiContext).mockResolvedValue({
    organizationId: 'org-1',
    userId: ME,
    role,
    permissions: new Set(['items:read', 'cycle_counts:read']),
    enabledModules: new Set(['inventory', 'cycle_counts']),
    supabase: makeClient(),
  } as never);
  const res = await GET(new NextRequest('http://localhost/api/v1/mobile/snapshot'));
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

function limitedTo(readable: string[], writable: string[] = readable) {
  vi.mocked(getWarehouseAccess).mockResolvedValue({
    readableIds: readable,
    writableIds: writable,
    hasAllAccess: false,
    primaryWarehouseId: readable[0] ?? null,
  } as never);
}

/** The count reads that were sent, and the `or` filters each one carried. */
const countReads = () => queries.filter((q) => q.table === 'cycle_counts' && q.sent);
const orFilters = (q: Query) => q.calls.filter((c) => c.method === 'or').map((c) => c.args[0]);

beforeEach(() => {
  queries.length = 0;
  vi.clearAllMocks();
  limitedTo(['wh1', 'wh2']);
});

describe('open cycle counts for a member limited to some warehouses', () => {
  it('a staff member: the counts of their warehouses, and a count with no warehouse only when it is assigned to them', async () => {
    await pull('staff');
    const reads = countReads();
    expect(reads).toHaveLength(1);
    expect(orFilters(reads[0]!)).toEqual([
      `warehouse_id.in.(wh1,wh2),and(warehouse_id.is.null,assigned_to.eq.${ME})`,
    ]);
  });

  it('a read-only member: the same filter, from the warehouses they can read', async () => {
    limitedTo(['wh1'], []);
    await pull('viewer');
    const reads = countReads();
    expect(reads).toHaveLength(1);
    expect(orFilters(reads[0]!)).toEqual([
      `warehouse_id.in.(wh1),and(warehouse_id.is.null,assigned_to.eq.${ME})`,
    ]);
  });

  it('the read is still the open counts of the active organization, newest first, at most 50', async () => {
    await pull('staff');
    const calls = countReads()[0]!.calls;
    expect(calls).toContainEqual({ method: 'eq', args: ['organization_id', 'org-1'] });
    expect(calls).toContainEqual({ method: 'eq', args: ['status', 'in_progress'] });
    expect(calls).toContainEqual({ method: 'limit', args: [50] });
  });

  it('a member with no readable warehouse: no counts, and the read is not sent', async () => {
    limitedTo([]);
    const body = await pull('staff');
    expect(body.openCycleCounts).toEqual([]);
    expect(countReads()).toEqual([]);
  });
});

describe('open cycle counts for members who see every warehouse', () => {
  it.each(['owner', 'admin', 'manager'] as const)('%s: every open count, no filter', async (role) => {
    await pull(role);
    const reads = countReads();
    expect(reads).toHaveLength(1);
    expect(orFilters(reads[0]!)).toEqual([]);
    expect(getWarehouseAccess).not.toHaveBeenCalled();
  });

  it('a staff member with every warehouse: every open count, no filter', async () => {
    vi.mocked(getWarehouseAccess).mockResolvedValue({
      readableIds: ['wh1'],
      writableIds: ['wh1'],
      hasAllAccess: true,
      primaryWarehouseId: 'wh1',
    } as never);
    await pull('staff');
    const reads = countReads();
    expect(reads).toHaveLength(1);
    expect(orFilters(reads[0]!)).toEqual([]);
  });
});
