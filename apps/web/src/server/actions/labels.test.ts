import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * loadLabelItemsAction: the POST side of the Print labels handoff.
 *
 * It must answer the bulk bar's largest selection (up to LABELS_MAX_ITEMS ids,
 * which never fit in a URL), and it must be exactly as careful as the page:
 * the rows come from InventoryService.byIds on the caller's OWN context (RLS,
 * org filter, live items only), and the MFA gate the dashboard layout applies
 * to the page applies here too, because a Server Action does not run through
 * that layout.
 */

const h = vi.hoisted(() => ({
  withContext: vi.fn(),
  byIds: vi.fn(),
  ctxSeen: [] as unknown[],
}));

vi.mock('@/server/services/context', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/services/context')>();
  return { ...actual, withContext: h.withContext };
});
vi.mock('@/server/services/inventory', () => ({
  InventoryService: vi.fn(function (this: { byIds: unknown }, ctx: unknown) {
    h.ctxSeen.push(ctx);
    this.byIds = h.byIds;
  }),
}));

import { LABELS_MAX_ITEMS } from '@/lib/inventory/labels-selection';
import { ServiceError } from '@/server/services/context';

import { loadLabelItemsAction } from './labels';

const uuid = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
const ids = (n: number) => Array.from({ length: n }, (_, i) => uuid(i));
const row = (id: string) => ({ id, name: `Item ${id}`, sku: `SKU-${id}`, barcode: null });

const ctx = { organizationId: 'org-1', userId: 'u-1', mfaRequired: false, mfaSatisfied: true };

beforeEach(() => {
  vi.clearAllMocks();
  h.ctxSeen.length = 0;
  h.withContext.mockResolvedValue(ctx);
});

describe('loadLabelItemsAction', () => {
  it('answers the largest selection (500 ids) through the caller’s own byIds read, in selection order', async () => {
    const wanted = ids(LABELS_MAX_ITEMS);
    // byIds answers in its own order and leaves out what the caller may not
    // read (every 50th item here).
    const readable = wanted.filter((_, i) => i % 50 !== 49);
    h.byIds.mockResolvedValue([...readable].reverse().map(row));

    const res = await loadLabelItemsAction({ ids: wanted });

    expect(h.byIds).toHaveBeenCalledTimes(1);
    expect(h.byIds).toHaveBeenCalledWith(wanted);
    expect(h.ctxSeen).toEqual([ctx]);
    expect(res).toEqual({ ok: true, data: readable.map(row) });
  });

  it('refuses more than LABELS_MAX_ITEMS before reading anything', async () => {
    const res = await loadLabelItemsAction({ ids: ids(LABELS_MAX_ITEMS + 1) });
    expect(res).toMatchObject({ ok: false, error: { code: 'validation_error' } });
    expect(h.withContext).not.toHaveBeenCalled();
    expect(h.byIds).not.toHaveBeenCalled();
  });

  it('refuses a malformed id and an empty list', async () => {
    expect(await loadLabelItemsAction({ ids: [uuid(1), 'x'] })).toMatchObject({
      ok: false,
      error: { code: 'validation_error' },
    });
    expect(await loadLabelItemsAction({ ids: [] })).toMatchObject({
      ok: false,
      error: { code: 'validation_error' },
    });
    expect(h.byIds).not.toHaveBeenCalled();
  });

  it('refuses a session that has not passed the MFA it owes, before reading anything', async () => {
    h.withContext.mockResolvedValue({
      ...ctx,
      mfaRequired: true,
      mfaSatisfied: false,
      mfaEnrolled: true,
    });
    const res = await loadLabelItemsAction({ ids: ids(3) });
    expect(res).toMatchObject({
      ok: false,
      error: { code: 'forbidden', details: { reason: 'aal2_required' } },
    });
    expect(h.byIds).not.toHaveBeenCalled();
  });

  it('a failed read is a generic internal error, never the raw database text', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    h.byIds.mockRejectedValue(new ServiceError('internal_error', 'relation "x" timed out'));
    const res = await loadLabelItemsAction({ ids: ids(3) });
    expect(res).toMatchObject({ ok: false, error: { code: 'internal_error' } });
    expect(JSON.stringify(res)).not.toContain('relation');
  });
});
