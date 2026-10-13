import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The Settings > AI backfill: an admin runs the oldest items without an
 * embedding through embedItemsBatch, and the panel shows the counts. The
 * batch also returns its first failure's message and why it stopped (for the
 * hourly sweep's summary line); that message can carry the database's own
 * words (table, column, policy names), which never go back to a browser. The
 * action answers the three counts it always did.
 */

const h = vi.hoisted(() => ({ embedItemsBatch: vi.fn() }));

vi.mock('@/lib/ai/embeddings', () => ({ embedItemsBatch: h.embedItemsBatch }));
vi.mock('@/server/services/context', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/services/context')>();
  return {
    ...actual,
    withContext: vi.fn(async () => ({
      organizationId: 'org-1',
      userId: 'user-1',
      role: 'admin',
      mfaRequired: false,
      mfaSatisfied: true,
    })),
  };
});

import { backfillItemEmbeddingsAction } from './embeddings';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('backfillItemEmbeddingsAction', () => {
  it("answers the counts only, never the batch's first error text", async () => {
    h.embedItemsBatch.mockResolvedValueOnce({
      embedded: 2,
      failed: 1,
      changed: 0,
      remaining: 4,
      firstError: 'write failed: permission denied for table inventory_items',
      stopped: null,
      geminiFailuresInARow: 0,
    });

    const r = await backfillItemEmbeddingsAction({ limit: 3 });

    // Every item tried, as before: no stop option, per-item lines kept.
    expect(h.embedItemsBatch).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 'org-1' }),
      { limit: 3 },
    );
    expect(r).toEqual({ ok: true, data: { embedded: 2, failed: 1, remaining: 4 } });
  });
});
