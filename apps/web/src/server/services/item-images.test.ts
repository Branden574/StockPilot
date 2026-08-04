import { beforeEach, describe, expect, it, vi } from 'vitest';

const { createAdminClientMock, createSignedUrlMock, createSignedUrlsMock } = vi.hoisted(() => ({
  createAdminClientMock: vi.fn(),
  createSignedUrlMock: vi.fn(),
  createSignedUrlsMock: vi.fn(),
}));

// Pass-through so the wrapped per-path signer runs on every call (i.e.
// every path behaves like a Data Cache MISS — the worst case the batch
// layer exists for).
vi.mock('next/cache', () => ({
  unstable_cache: vi.fn((fn: unknown) => fn),
}));

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: createAdminClientMock,
}));

vi.mock('./context', () => ({
  withContext: vi.fn(),
  assertPermission: vi.fn(),
  ServiceError: class ServiceError extends Error {},
}));

// record()/remove() used to have ZERO audit capture (Movement/Activity P2
// Task 1e) — mock the writer so the new tests below can assert entityId +
// the changed_keys/image_added shape without a real audit_logs write.
vi.mock('./audit', () => ({ audit: vi.fn(async () => undefined) }));

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

import { audit } from './audit';
import type { ServiceContext } from './context';

import { ItemImagesService } from './item-images';

function svc(): ItemImagesService {
  return new ItemImagesService({} as ServiceContext);
}

beforeEach(() => {
  vi.clearAllMocks();
  createAdminClientMock.mockReturnValue({
    storage: {
      from: () => ({
        createSignedUrl: createSignedUrlMock,
        createSignedUrls: createSignedUrlsMock,
      }),
    },
  });
});

/**
 * Rank 3 (cold-start plan): signedUrls must resolve a cold page with ONE
 * batched createSignedUrls call instead of a per-path createSignedUrl
 * storm, while per-path failures still fall back to the single signer.
 * NOTE: the module keeps an in-process success memo, so every test uses
 * ITS OWN paths — reusing a path across tests would hit the memo.
 */
describe('ItemImagesService.signedUrls (batched signing)', () => {
  it('cold paths are signed with ONE batch call — the per-path signer consumes the primed batch and never issues individual storage calls', async () => {
    createSignedUrlsMock.mockResolvedValue({
      data: [
        { path: 'b1/master.jpg', signedUrl: 'https://signed/b1-master', error: null },
        { path: 'b1/thumb.webp', signedUrl: 'https://signed/b1-thumb', error: null },
      ],
      error: null,
    });

    const map = await svc().signedUrls(['b1/master.jpg', 'b1/thumb.webp']);

    expect(createSignedUrlsMock).toHaveBeenCalledTimes(1);
    expect(createSignedUrlsMock).toHaveBeenCalledWith(
      ['b1/master.jpg', 'b1/thumb.webp'],
      expect.any(Number),
    );
    expect(createSignedUrlMock).not.toHaveBeenCalled();
    expect(map.get('b1/master.jpg')).toBe('https://signed/b1-master');
    expect(map.get('b1/thumb.webp')).toBe('https://signed/b1-thumb');
  });

  it('a path the batch failed to cover falls back to the original single createSignedUrl (per-path resilience preserved)', async () => {
    createSignedUrlsMock.mockResolvedValue({
      data: [
        { path: 'b2/ok.jpg', signedUrl: 'https://signed/b2-ok', error: null },
        { path: 'b2/broken.jpg', signedUrl: null, error: 'Object not found' },
      ],
      error: null,
    });
    createSignedUrlMock.mockResolvedValue({
      data: { signedUrl: 'https://signed/b2-single' },
      error: null,
    });

    const map = await svc().signedUrls(['b2/ok.jpg', 'b2/broken.jpg']);

    expect(createSignedUrlsMock).toHaveBeenCalledTimes(1);
    expect(createSignedUrlMock).toHaveBeenCalledTimes(1);
    expect(createSignedUrlMock).toHaveBeenCalledWith('b2/broken.jpg', expect.any(Number));
    expect(map.get('b2/ok.jpg')).toBe('https://signed/b2-ok');
    expect(map.get('b2/broken.jpg')).toBe('https://signed/b2-single');
  });

  it('a whole-batch failure degrades to single signs for every path — same result, never a throw', async () => {
    createSignedUrlsMock.mockRejectedValue(new Error('storage down'));
    createSignedUrlMock.mockResolvedValue({
      data: { signedUrl: 'https://signed/b3-single' },
      error: null,
    });

    const map = await svc().signedUrls(['b3/a.jpg']);

    expect(createSignedUrlMock).toHaveBeenCalledTimes(1);
    expect(map.get('b3/a.jpg')).toBe('https://signed/b3-single');
  });

  it('a path that fails to sign everywhere is simply absent from the result (public contract unchanged) and is NOT memoized — the next call retries', async () => {
    createSignedUrlsMock.mockResolvedValue({ data: [], error: null });
    createSignedUrlMock.mockResolvedValue({ data: null, error: { message: 'nope' } });

    const first = await svc().signedUrls(['b4/x.jpg']);
    expect(first.has('b4/x.jpg')).toBe(false);

    // Retry succeeds — nothing negative stuck in the in-process memo
    // (recurring bug pattern #6: never cache a null).
    createSignedUrlsMock.mockResolvedValue({
      data: [{ path: 'b4/x.jpg', signedUrl: 'https://signed/b4-x', error: null }],
      error: null,
    });
    const second = await svc().signedUrls(['b4/x.jpg']);
    expect(second.get('b4/x.jpg')).toBe('https://signed/b4-x');
  });

  it('in-process memo: a second resolve of already-signed paths issues ZERO storage calls and returns the SAME URLs (same-path → same-URL stability)', async () => {
    createSignedUrlsMock.mockResolvedValue({
      data: [{ path: 'b5/stable.jpg', signedUrl: 'https://signed/b5-stable', error: null }],
      error: null,
    });

    const first = await svc().signedUrls(['b5/stable.jpg']);
    expect(first.get('b5/stable.jpg')).toBe('https://signed/b5-stable');

    vi.clearAllMocks();
    const second = await svc().signedUrls(['b5/stable.jpg']);
    expect(createSignedUrlsMock).not.toHaveBeenCalled();
    expect(createSignedUrlMock).not.toHaveBeenCalled();
    expect(second.get('b5/stable.jpg')).toBe('https://signed/b5-stable');
  });

  it('returns an empty map for an empty path list without touching storage', async () => {
    const map = await svc().signedUrls([]);
    expect(map.size).toBe(0);
    expect(createSignedUrlsMock).not.toHaveBeenCalled();
  });
});

/**
 * Fix wave (2026-08-04, review of the transform-re-encode fix): pins the
 * resolver-chain CONTRAST between the two public entry points that share
 * `resolvePrimaryImageUrls` — PDF/Excel rendering must sign transform(thumb)
 * first (falling back to transform(master), then plain(thumb) last) because
 * @react-pdf/renderer and the Excel embedder can't decode WebP, while browser
 * display must sign plain(thumb) first (the ORIGINAL pre-fix chain) because
 * browsers decode WebP natively and a transform round-trip there is pure
 * waste. Swapping either chain's order is exactly the regression this guards.
 *
 * Cache note: `next/cache`'s `unstable_cache` is mocked to a pass-through
 * identity function at the top of this file, so `signItemImageTransformed`/
 * `signItemImageMaster` run as plain un-cached functions here — every call
 * reaches `createSignedUrlMock` for real, nothing is served from Next's Data
 * Cache. Separately, `primaryImagesForPdfRendering`/`primaryImagesForBrowserDisplay`
 * call the per-path signers directly rather than through `signedUrls()`, so
 * they never touch the in-process success memo or the batch-sign map either
 * (those are `signedUrls()`-only plumbing — see that describe block above).
 * Net effect: no cross-test cache state to defeat call recording here. Unique
 * per-test item/path names are still used anyway, matching this file's
 * existing convention, so a future change that DOES route these methods
 * through `signedUrls()` fails loudly here instead of silently passing on
 * stale memoized URLs.
 */
describe('ItemImagesService — PDF vs browser signing-chain contrast', () => {
  describe('primaryImagesForPdfRendering — transform(thumb) → transform(master) → plain(thumb)', () => {
    it('signs transform(thumb) first and stops there on success', async () => {
      const stub = makeSupabaseStub({
        'item_images.select': {
          data: [
            {
              item_id: 'item-pdf-ok',
              storage_path: 'org-1/items/item-pdf-ok/master.jpg',
              thumb_path: 'org-1/items/item-pdf-ok/thumb.webp',
              is_primary: true,
              sort_order: 0,
            },
          ],
          error: null,
        },
      });
      const service = new ItemImagesService(
        makeServiceContext(stub.client, { organizationId: 'org-1' }),
      );
      createSignedUrlMock.mockResolvedValueOnce({
        data: { signedUrl: 'https://signed/pdf-ok-thumb-transform' },
        error: null,
      });

      const map = await service.primaryImagesForPdfRendering(['item-pdf-ok'], 200);

      expect(createSignedUrlMock).toHaveBeenCalledTimes(1);
      const [path, , options] = createSignedUrlMock.mock.calls[0]!;
      expect(path).toBe('org-1/items/item-pdf-ok/thumb.webp');
      expect(options).toEqual(
        expect.objectContaining({ transform: expect.objectContaining({ width: 200 }) }),
      );
      expect(map.get('item-pdf-ok')).toBe('https://signed/pdf-ok-thumb-transform');
    });

    it('falls back to transform(master) when transform(thumb) errors', async () => {
      const stub = makeSupabaseStub({
        'item_images.select': {
          data: [
            {
              item_id: 'item-pdf-fallback1',
              storage_path: 'org-1/items/item-pdf-fallback1/master.jpg',
              thumb_path: 'org-1/items/item-pdf-fallback1/thumb.webp',
              is_primary: true,
              sort_order: 0,
            },
          ],
          error: null,
        },
      });
      const service = new ItemImagesService(
        makeServiceContext(stub.client, { organizationId: 'org-1' }),
      );
      createSignedUrlMock
        .mockResolvedValueOnce({ data: null, error: { message: 'transform(thumb) failed' } })
        .mockResolvedValueOnce({
          data: { signedUrl: 'https://signed/pdf-fallback1-master-transform' },
          error: null,
        });

      const map = await service.primaryImagesForPdfRendering(['item-pdf-fallback1'], 200);

      expect(createSignedUrlMock).toHaveBeenCalledTimes(2);
      const [firstPath, , firstOptions] = createSignedUrlMock.mock.calls[0]!;
      const [secondPath, , secondOptions] = createSignedUrlMock.mock.calls[1]!;
      expect(firstPath).toBe('org-1/items/item-pdf-fallback1/thumb.webp');
      expect(firstOptions).toEqual(expect.objectContaining({ transform: expect.anything() }));
      expect(secondPath).toBe('org-1/items/item-pdf-fallback1/master.jpg');
      expect(secondOptions).toEqual(expect.objectContaining({ transform: expect.anything() }));
      expect(map.get('item-pdf-fallback1')).toBe(
        'https://signed/pdf-fallback1-master-transform',
      );
    });

    it('falls back to plain(thumb) LAST, only once both transform signs fail', async () => {
      const stub = makeSupabaseStub({
        'item_images.select': {
          data: [
            {
              item_id: 'item-pdf-fallback2',
              storage_path: 'org-1/items/item-pdf-fallback2/master.jpg',
              thumb_path: 'org-1/items/item-pdf-fallback2/thumb.webp',
              is_primary: true,
              sort_order: 0,
            },
          ],
          error: null,
        },
      });
      const service = new ItemImagesService(
        makeServiceContext(stub.client, { organizationId: 'org-1' }),
      );
      createSignedUrlMock
        .mockResolvedValueOnce({ data: null, error: { message: 'transform(thumb) failed' } })
        .mockResolvedValueOnce({ data: null, error: { message: 'transform(master) failed' } })
        .mockResolvedValueOnce({
          data: { signedUrl: 'https://signed/pdf-fallback2-plain-thumb' },
          error: null,
        });

      const map = await service.primaryImagesForPdfRendering(['item-pdf-fallback2'], 200);

      expect(createSignedUrlMock).toHaveBeenCalledTimes(3);
      const thirdCall = createSignedUrlMock.mock.calls[2]!;
      expect(thirdCall[0]).toBe('org-1/items/item-pdf-fallback2/thumb.webp');
      // The plain signer calls createSignedUrl(path, ttl) — NO third
      // options argument — which is exactly what distinguishes "plain" from
      // "transform" in this mock, since both routes share one signing fn.
      expect(thirdCall.length).toBe(2);
      expect(map.get('item-pdf-fallback2')).toBe(
        'https://signed/pdf-fallback2-plain-thumb',
      );
    });
  });

  describe('primaryImagesForBrowserDisplay — plain(thumb) → transform(master), the ORIGINAL pre-fix chain', () => {
    it('signs plain(thumb) first, with no transform options, and never touches transform', async () => {
      const stub = makeSupabaseStub({
        'item_images.select': {
          data: [
            {
              item_id: 'item-browser-ok',
              storage_path: 'org-1/items/item-browser-ok/master.jpg',
              thumb_path: 'org-1/items/item-browser-ok/thumb.webp',
              is_primary: true,
              sort_order: 0,
            },
          ],
          error: null,
        },
      });
      const service = new ItemImagesService(
        makeServiceContext(stub.client, { organizationId: 'org-1' }),
      );
      createSignedUrlMock.mockResolvedValueOnce({
        data: { signedUrl: 'https://signed/browser-ok-plain-thumb' },
        error: null,
      });

      const map = await service.primaryImagesForBrowserDisplay(['item-browser-ok'], 200);

      expect(createSignedUrlMock).toHaveBeenCalledTimes(1);
      const call = createSignedUrlMock.mock.calls[0]!;
      expect(call[0]).toBe('org-1/items/item-browser-ok/thumb.webp');
      expect(call.length).toBe(2); // plain signer — no transform options arg
      expect(map.get('item-browser-ok')).toBe('https://signed/browser-ok-plain-thumb');
    });

    it('falls back to transform(master) only when the row has no thumb_path at all', async () => {
      const stub = makeSupabaseStub({
        'item_images.select': {
          data: [
            {
              item_id: 'item-browser-nothumb',
              storage_path: 'org-1/items/item-browser-nothumb/master.jpg',
              thumb_path: null,
              is_primary: true,
              sort_order: 0,
            },
          ],
          error: null,
        },
      });
      const service = new ItemImagesService(
        makeServiceContext(stub.client, { organizationId: 'org-1' }),
      );
      createSignedUrlMock.mockResolvedValueOnce({
        data: { signedUrl: 'https://signed/browser-nothumb-master-transform' },
        error: null,
      });

      const map = await service.primaryImagesForBrowserDisplay(['item-browser-nothumb'], 200);

      expect(createSignedUrlMock).toHaveBeenCalledTimes(1);
      const [path, , options] = createSignedUrlMock.mock.calls[0]!;
      expect(path).toBe('org-1/items/item-browser-nothumb/master.jpg');
      expect(options).toEqual(
        expect.objectContaining({ transform: expect.objectContaining({ width: 200 }) }),
      );
      expect(map.get('item-browser-nothumb')).toBe(
        'https://signed/browser-nothumb-master-transform',
      );
    });
  });
});

// Movement/Activity P2 Task 1e: record()/remove() had ZERO audit capture —
// a photo add/remove never showed up anywhere in the item's history. Both
// now emit 'inventory.item.updated' (no new AuditEvent — this phase is
// migration-free) with entityId=itemId so it surfaces in the item's
// Activity feed.
describe('ItemImagesService.record — audit capture', () => {
  it('emits inventory.item.updated with entityId=itemId and image_added:true', async () => {
    const stub = makeSupabaseStub({
      'inventory_items.select': { data: { id: 'item-1' }, error: null },
      'item_images.insert': {
        data: { id: 'img-1', storage_path: 'org-1/items/item-1/x.jpg', sort_order: 0, is_primary: true },
        error: null,
      },
    });
    const svc = new ItemImagesService(makeServiceContext(stub.client, { organizationId: 'org-1' }));

    await svc.record('item-1', 'org-1/items/item-1/x.jpg', true);

    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'inventory.item.updated',
        entityType: 'inventory_item',
        entityId: 'item-1',
        extra: { changed_keys: ['images'], image_added: true },
      }),
      expect.anything(),
    );
  });

  it('does NOT audit when the insert fails', async () => {
    const stub = makeSupabaseStub({
      'inventory_items.select': { data: { id: 'item-1' }, error: null },
      'item_images.insert': { data: null, error: { message: 'boom' } },
    });
    const svc = new ItemImagesService(makeServiceContext(stub.client, { organizationId: 'org-1' }));

    await expect(
      svc.record('item-1', 'org-1/items/item-1/x.jpg', true),
    ).rejects.toThrow();
    expect(audit).not.toHaveBeenCalled();
  });
});

describe('ItemImagesService.remove — audit capture', () => {
  it('emits inventory.item.updated with entityId=itemId (resolved from the deleted row) and image_added:false', async () => {
    const stub = makeSupabaseStub({
      'item_images.select': { data: { storage_path: 'org-1/items/item-1/x.jpg', item_id: 'item-1' }, error: null },
      'item_images.delete': { data: null, error: null },
    });
    const svc = new ItemImagesService(makeServiceContext(stub.client, { organizationId: 'org-1' }));

    await svc.remove('img-1');

    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'inventory.item.updated',
        entityType: 'inventory_item',
        entityId: 'item-1',
        extra: { changed_keys: ['images'], image_added: false },
      }),
      expect.anything(),
    );
  });
});
