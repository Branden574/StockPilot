import { beforeEach, describe, expect, it, vi } from 'vitest';

import { authorizePublicApi } from '@/lib/auth/public-api';
import { createAdminClient } from '@/lib/supabase/admin';

import { GET } from './route';

// Only the auth half is stubbed. `parsePageParams` stays REAL so the range
// assertions below prove the route's own offset arithmetic, not a mock's.
vi.mock('@/lib/auth/public-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/public-api')>();
  return { ...actual, authorizePublicApi: vi.fn() };
});

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn() }));

/** Records every PostgREST builder call, then resolves like an awaited query. */
function recordingBuilder(result: { data: unknown[] | null; error: unknown }) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const builder: Record<string, unknown> = {};
  for (const method of ['from', 'select', 'eq', 'is', 'order', 'range', 'ilike']) {
    builder[method] = (...args: unknown[]) => {
      calls.push({ method, args });
      return builder;
    };
  }
  builder.then = (
    resolve: (v: typeof result) => unknown,
    reject?: (e: unknown) => unknown,
  ) => Promise.resolve(result).then(resolve, reject);
  return { builder, calls };
}

function ordersOf(calls: Array<{ method: string; args: unknown[] }>) {
  return calls.filter((c) => c.method === 'order').map((c) => c.args);
}

describe('GET /api/public/v1/items', () => {
  beforeEach(() => {
    vi.mocked(authorizePublicApi).mockResolvedValue({
      ctx: { organizationId: 'org-1' } as never,
    });
  });

  it('orders by updated_at DESC then by id ASC so paging cannot skip or duplicate rows', async () => {
    // SP-131: `updated_at` alone is NOT a stable sort key. `adjust_stock`
    // stamps `updated_at = now()` (the TRANSACTION timestamp), so every line
    // of one PO receipt lands on the identical timestamp; with no index on
    // inventory_items(updated_at) the planner uses a bounded top-N heapsort,
    // whose tie order differs per LIMIT+OFFSET bound. Page 2 and page 3 then
    // slice the same equal-timestamp group differently and an API consumer
    // silently loses rows (and sees others twice) with a 200 on every page.
    // The `id` tiebreak is what makes the total order deterministic.
    const { builder, calls } = recordingBuilder({ data: [], error: null });
    vi.mocked(createAdminClient).mockReturnValue(builder as never);

    const res = await GET(new Request('https://test.local/api/public/v1/items?limit=200&offset=200'));

    expect(res.status).toBe(200);
    expect(ordersOf(calls)).toEqual([
      ['updated_at', { ascending: false }],
      ['id', { ascending: true }],
    ]);
  });

  it('keeps tenant isolation, soft-delete filtering and the clamped window', async () => {
    const { builder, calls } = recordingBuilder({ data: [], error: null });
    vi.mocked(createAdminClient).mockReturnValue(builder as never);

    await GET(new Request('https://test.local/api/public/v1/items?limit=200&offset=200'));

    expect(calls).toContainEqual({ method: 'eq', args: ['organization_id', 'org-1'] });
    expect(calls).toContainEqual({ method: 'is', args: ['deleted_at', null] });
    expect(calls).toContainEqual({ method: 'range', args: [200, 399] });
  });

  it('still applies the tiebreak on a searched page', async () => {
    const { builder, calls } = recordingBuilder({ data: [], error: null });
    vi.mocked(createAdminClient).mockReturnValue(builder as never);

    await GET(new Request('https://test.local/api/public/v1/items?search=peg%25asus'));

    // The ilike needle keeps its metacharacter stripping (search may only narrow).
    expect(calls).toContainEqual({ method: 'ilike', args: ['name', '%pegasus%'] });
    expect(ordersOf(calls)).toEqual([
      ['updated_at', { ascending: false }],
      ['id', { ascending: true }],
    ]);
  });

  it('returns 500 without leaking the DB error', async () => {
    const { builder } = recordingBuilder({ data: null, error: { message: 'boom' } });
    vi.mocked(createAdminClient).mockReturnValue(builder as never);

    const res = await GET(new Request('https://test.local/api/public/v1/items'));
    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({ error: 'internal_error' });
  });

  it('short-circuits to the auth error response without touching the DB', async () => {
    const { NextResponse } = await import('next/server');
    vi.mocked(authorizePublicApi).mockResolvedValue({
      res: NextResponse.json({ error: 'missing_scope' }, { status: 403 }),
    });
    const spy = vi.mocked(createAdminClient);
    spy.mockClear();

    const res = await GET(new Request('https://test.local/api/public/v1/items'));
    expect(res.status).toBe(403);
    expect(spy).not.toHaveBeenCalled();
  });
});
