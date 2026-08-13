import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { withApiContext } from '@/lib/auth/api-context';
import { InventoryService } from '@/server/services/inventory';

import { POST } from './route';

// ═══════════════════════════════════════════════════════════════════════════
// THE PHONE'S WRITE-OFF BOUNDARY — where a reported outcome went to die.
//
// `removeStockFromLocation` returns the full BookCrateSyncResult and this route
// re-projects it onto the flags a client can read. `rackPreservedItemIds` was
// not in that projection, so the service faithfully reported a rack label whose
// erasure it had withheld, and the route dropped it — the native sheet could not
// have rendered it, because it never arrived.
//
// Pinned HERE and not in the mobile spec, because the mobile spec cannot see
// this: it tests `removeStockCrateWarning` against a body it constructs itself,
// so a route that never sends the flag leaves it green. Two projections, two
// boundaries, and this is the second one.
// ═══════════════════════════════════════════════════════════════════════════

vi.mock('@/lib/auth/api-context', () => ({ withApiContext: vi.fn() }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn() }));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true, resetAt: Date.now() + 60_000 })),
}));
vi.mock('@/server/loaders/inventory-list', () => ({ revalidateInventoryList: vi.fn() }));
vi.mock('@/server/services/context', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/services/context')>();
  return { ...actual, assertPermission: vi.fn() };
});

const ITEM_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const LOC_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

/** Every bucket the reconciliation can fill, all empty. Typed explicitly:
 *  bare `[]` infers `never[]`, which makes each case below unassignable. */
const EMPTY_SYNC: {
  syncedItemIds: string[];
  failedItemIds: string[];
  skippedItemIds: string[];
  staleItemIds: string[];
  unplacedItemIds: string[];
  rackPreservedItemIds: string[];
} = {
  syncedItemIds: [],
  failedItemIds: [],
  skippedItemIds: [],
  staleItemIds: [],
  unplacedItemIds: [],
  rackPreservedItemIds: [],
};

function buildCtx() {
  return {
    organizationId: 'org-1',
    userId: 'u-1',
    role: 'staff' as const,
    permissions: undefined,
    mfaRequired: false,
    mfaSatisfied: true,
    enabledModules: new Set<never>(),
    supabase: {} as never,
  };
}

function req(body: unknown) {
  return new NextRequest(`http://localhost/api/v1/items/${ITEM_ID}/remove-stock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

type SyncBuckets = typeof EMPTY_SYNC;

function respond(sync: Partial<SyncBuckets>, crateSyncUpdated = false) {
  vi.mocked(withApiContext).mockResolvedValue(buildCtx() as never);
  vi.spyOn(InventoryService.prototype, 'removeStockFromLocation').mockResolvedValue({
    item: { id: ITEM_ID },
    crateSync: { ...EMPTY_SYNC, ...sync },
    crateSyncUpdated,
  } as unknown as Awaited<ReturnType<InventoryService['removeStockFromLocation']>>);
}

async function post() {
  const res = await POST(req({ locationId: LOC_ID, quantity: 5, reason: 'Water damage' }), {
    params: Promise.resolve({ id: ITEM_ID }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('POST /api/v1/items/[id]/remove-stock — the crate-sync projection', () => {
  it('reports a PRESERVED RACK, which it used to discard', async () => {
    respond({ syncedItemIds: [ITEM_ID], rackPreservedItemIds: [ITEM_ID] });
    const { status, body } = await post();
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.crateSyncRackPreserved).toBe(true);
  });

  it('does NOT claim a preserved rack when none was withheld', async () => {
    respond({ syncedItemIds: [ITEM_ID] });
    const { body } = await post();
    expect(body.ok).toBe(true);
    expect(body).not.toHaveProperty('crateSyncRackPreserved');
  });

  it('projects EVERY bucket the service can fill, so none is invisible by construction', async () => {
    const cases = [
      ['failedItemIds', 'crateSyncFailed'],
      ['skippedItemIds', 'crateSyncSkipped'],
      ['staleItemIds', 'crateSyncStale'],
      ['unplacedItemIds', 'crateSyncUnplaced'],
      ['rackPreservedItemIds', 'crateSyncRackPreserved'],
    ] as const;
    for (const [bucket, flag] of cases) {
      const only: Partial<SyncBuckets> = {};
      only[bucket] = [ITEM_ID];
      respond(only);
      const { body } = await post();
      expect(body[flag], `${bucket} never reaches the phone as ${flag}`).toBe(true);
    }
  });

  it('still reports a label that actually moved', async () => {
    respond({ syncedItemIds: [ITEM_ID] }, true);
    const { body } = await post();
    expect(body.crateSyncUpdated).toBe(true);
  });

  it('a clean write-off carries no crate-sync keys at all', async () => {
    // The common path stays a bare success — an older build that ignores these
    // keys is unaffected, and a new one has nothing to say.
    respond({ syncedItemIds: [ITEM_ID] });
    const { body } = await post();
    expect(Object.keys(body)).toEqual(['ok']);
  });
});
