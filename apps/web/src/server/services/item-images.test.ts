import { beforeEach, describe, expect, it, vi } from 'vitest';

const { createAdminClientMock, createSignedUrlMock, createSignedUrlsMock, fetchObjectPrefixMock } = vi.hoisted(() => ({
  createAdminClientMock: vi.fn(),
  createSignedUrlMock: vi.fn(),
  createSignedUrlsMock: vi.fn(),
  fetchObjectPrefixMock: vi.fn(),
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

// record() sniffs the just-uploaded object via a RANGE READ of its leading
// bytes (fetchObjectPrefix) instead of a full download(). The helper is the
// seam — its own suite (lib/storage-object-prefix.test.ts) proves the
// range/streaming mechanics; here it defaults to a genuine png prefix so the
// audit-capture tests below exercise the ordinary "an image was uploaded"
// path (mirrors supabase-mock's old download() default and its rationale).
vi.mock('@/lib/storage-object-prefix', () => ({
  fetchObjectPrefix: fetchObjectPrefixMock,
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

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import ts from 'typescript';

import {
  itemReadScopeResults,
  type ScopedCaller,
  type WorldImage,
  type WorldItem,
} from '@/test/item-read-scope';
import { makeServiceContext, makeSupabaseStub, servedLikePostgrest } from '@/test/supabase-mock';

import { audit } from './audit';
import type { ServiceContext } from './context';

import { ItemImagesService } from './item-images';

/**
 * Realistic path fixtures. These were short synthetic keys ('b1/master.jpg',
 * 'org-1/items/item-pdf-ok/...') until security wave D added a structural gate
 * on the service-role signers: a stored path is now shape-checked before it is
 * handed to Storage, and real orgs and items are always UUIDs. The ids below
 * are therefore UUID-shaped and each fixture keeps a DISTINCT item id, because
 * the batch and memo assertions below depend on paths being distinct.
 * Nothing about what these tests assert changed — only the fixture realism.
 */
const ORG = '0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f';
const B1 = 'b1b1b1b1-0000-4000-8000-000000000001';
const B2 = 'b2b2b2b2-0000-4000-8000-000000000002';
const B3 = 'b3b3b3b3-0000-4000-8000-000000000003';
const B4 = 'b4b4b4b4-0000-4000-8000-000000000004';
const B5 = 'b5b5b5b5-0000-4000-8000-000000000005';
const BROWSER_NOTHUMB = 'aaaa2222-0000-4000-8000-000000000012';
const BROWSER_OK = 'aaaa3333-0000-4000-8000-000000000013';
const PDF_FB1 = 'aaaa4444-0000-4000-8000-000000000014';
const PDF_FB2 = 'aaaa5555-0000-4000-8000-000000000015';
const PDF_OK = 'aaaa6666-0000-4000-8000-000000000016';
const SERVER_OK = 'aaaa7777-0000-4000-8000-000000000017';
const SERVER_NOTHUMB = 'aaaa8888-0000-4000-8000-000000000018';


function svc(): ItemImagesService {
  return new ItemImagesService({} as ServiceContext);
}

/** A minimal but GENUINE 26-byte png (signature + IHDR + 2x3 dims), built
 *  independently of supabase-mock's fixture — the default prefix the range
 *  read resolves, so ordinary record() tests pass the sniff. */
function mockPngPrefix(): Uint8Array {
  const b = new Uint8Array(26);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  b.set([0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52], 8);
  new DataView(b.buffer).setUint32(16, 2);
  new DataView(b.buffer).setUint32(20, 3);
  return b;
}

/** Rows the service-role client sees in item_images (remove()'s shared-object
 *  read, L65b). Empty unless a test sets it. */
let adminImageRows: Array<Record<string, unknown>> = [];
let adminImageReadError: { message: string } | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  adminImageRows = [];
  adminImageReadError = null;
  const adminDb = makeSupabaseStub({
    'item_images.select': (call) =>
      adminImageReadError
        ? { data: null, error: adminImageReadError }
        : servedLikePostgrest(adminImageRows)(call),
  });
  createAdminClientMock.mockReturnValue({
    from: adminDb.client.from,
    storage: {
      from: () => ({
        createSignedUrl: createSignedUrlMock,
        createSignedUrls: createSignedUrlsMock,
      }),
    },
  });
  const png = mockPngPrefix();
  fetchObjectPrefixMock.mockResolvedValue({ prefix: png, totalSize: png.byteLength });
});

/**
 * Rank 3 (cold-start plan): signedUrls must resolve a cold page with ONE
 * batched createSignedUrls call instead of a per-path createSignedUrl
 * storm, while per-path failures still fall back to the single signer.
 * NOTE: the module keeps an in-process success memo, so every test uses
 * ITS OWN paths — reusing a path across tests would hit the memo.
 */
describe('ItemImagesService.signedUrls (batched signing)', () => {
  // L17: storage-api refuses more than 1000 paths in one createSignedUrls
  // call (a 400 for the whole call), so a page past 1000 cold paths fell back
  // to one single sign per path. The batch is now chunked at 1000.
  it('signs 2,500 cold paths in three createSignedUrls calls of at most 1000', async () => {
    createSignedUrlsMock.mockImplementation(async (paths: string[]) => ({
      data: paths.map((p) => ({ path: p, signedUrl: `https://signed/${p}`, error: null })),
      error: null,
    }));
    const paths = Array.from(
      { length: 2500 },
      (_, i) => `${ORG}/items/c0c0c0c0-0000-4000-8000-${String(i).padStart(12, '0')}/m.jpg`,
    );

    const map = await svc().signedUrls(paths);

    expect(createSignedUrlsMock).toHaveBeenCalledTimes(3);
    const sizes = createSignedUrlsMock.mock.calls.map(([p]) => (p as string[]).length);
    expect(sizes).toEqual([1000, 1000, 500]);
    expect(createSignedUrlMock).not.toHaveBeenCalled();
    expect(map.size).toBe(2500);
  });

  it('a failed chunk leaves only its own paths to the single signer', async () => {
    createSignedUrlsMock.mockImplementation(async (paths: string[]) =>
      paths.length === 1000
        ? {
            data: paths.map((p) => ({ path: p, signedUrl: `https://signed/${p}`, error: null })),
            error: null,
          }
        : { data: null, error: { message: 'boom' } },
    );
    createSignedUrlMock.mockImplementation(async (p: string) => ({
      data: { signedUrl: `https://single/${p}` },
      error: null,
    }));
    const paths = Array.from(
      { length: 1200 },
      (_, i) => `${ORG}/items/c1c1c1c1-0000-4000-8000-${String(i).padStart(12, '0')}/m.jpg`,
    );

    const map = await svc().signedUrls(paths);

    expect(createSignedUrlMock).toHaveBeenCalledTimes(200);
    expect(map.size).toBe(1200);
  });

  it('cold paths are signed with ONE batch call — the per-path signer consumes the primed batch and never issues individual storage calls', async () => {
    createSignedUrlsMock.mockResolvedValue({
      data: [
        { path: `${ORG}/${B1}/master.jpg`, signedUrl: 'https://signed/b1-master', error: null },
        { path: `${ORG}/${B1}/thumb.webp`, signedUrl: 'https://signed/b1-thumb', error: null },
      ],
      error: null,
    });

    const map = await svc().signedUrls([`${ORG}/${B1}/master.jpg`, `${ORG}/${B1}/thumb.webp`]);

    expect(createSignedUrlsMock).toHaveBeenCalledTimes(1);
    expect(createSignedUrlsMock).toHaveBeenCalledWith(
      [`${ORG}/${B1}/master.jpg`, `${ORG}/${B1}/thumb.webp`],
      expect.any(Number),
    );
    expect(createSignedUrlMock).not.toHaveBeenCalled();
    expect(map.get(`${ORG}/${B1}/master.jpg`)).toBe('https://signed/b1-master');
    expect(map.get(`${ORG}/${B1}/thumb.webp`)).toBe('https://signed/b1-thumb');
  });

  it('a path the batch failed to cover falls back to the original single createSignedUrl (per-path resilience preserved)', async () => {
    createSignedUrlsMock.mockResolvedValue({
      data: [
        { path: `${ORG}/${B2}/ok.jpg`, signedUrl: 'https://signed/b2-ok', error: null },
        { path: `${ORG}/${B2}/broken.jpg`, signedUrl: null, error: 'Object not found' },
      ],
      error: null,
    });
    createSignedUrlMock.mockResolvedValue({
      data: { signedUrl: 'https://signed/b2-single' },
      error: null,
    });

    const map = await svc().signedUrls([`${ORG}/${B2}/ok.jpg`, `${ORG}/${B2}/broken.jpg`]);

    expect(createSignedUrlsMock).toHaveBeenCalledTimes(1);
    expect(createSignedUrlMock).toHaveBeenCalledTimes(1);
    expect(createSignedUrlMock).toHaveBeenCalledWith(`${ORG}/${B2}/broken.jpg`, expect.any(Number));
    expect(map.get(`${ORG}/${B2}/ok.jpg`)).toBe('https://signed/b2-ok');
    expect(map.get(`${ORG}/${B2}/broken.jpg`)).toBe('https://signed/b2-single');
  });

  it('a whole-batch failure degrades to single signs for every path — same result, never a throw', async () => {
    createSignedUrlsMock.mockRejectedValue(new Error('storage down'));
    createSignedUrlMock.mockResolvedValue({
      data: { signedUrl: 'https://signed/b3-single' },
      error: null,
    });

    const map = await svc().signedUrls([`${ORG}/${B3}/a.jpg`]);

    expect(createSignedUrlMock).toHaveBeenCalledTimes(1);
    expect(map.get(`${ORG}/${B3}/a.jpg`)).toBe('https://signed/b3-single');
  });

  it('a path that fails to sign everywhere is simply absent from the result (public contract unchanged) and is NOT memoized — the next call retries', async () => {
    createSignedUrlsMock.mockResolvedValue({ data: [], error: null });
    createSignedUrlMock.mockResolvedValue({ data: null, error: { message: 'nope' } });

    const first = await svc().signedUrls([`${ORG}/${B4}/x.jpg`]);
    expect(first.has(`${ORG}/${B4}/x.jpg`)).toBe(false);

    // Retry succeeds — nothing negative stuck in the in-process memo
    // (recurring bug pattern #6: never cache a null).
    createSignedUrlsMock.mockResolvedValue({
      data: [{ path: `${ORG}/${B4}/x.jpg`, signedUrl: 'https://signed/b4-x', error: null }],
      error: null,
    });
    const second = await svc().signedUrls([`${ORG}/${B4}/x.jpg`]);
    expect(second.get(`${ORG}/${B4}/x.jpg`)).toBe('https://signed/b4-x');
  });

  it('in-process memo: a second resolve of already-signed paths issues ZERO storage calls and returns the SAME URLs (same-path → same-URL stability)', async () => {
    createSignedUrlsMock.mockResolvedValue({
      data: [{ path: `${ORG}/${B5}/stable.jpg`, signedUrl: 'https://signed/b5-stable', error: null }],
      error: null,
    });

    const first = await svc().signedUrls([`${ORG}/${B5}/stable.jpg`]);
    expect(first.get(`${ORG}/${B5}/stable.jpg`)).toBe('https://signed/b5-stable');

    vi.clearAllMocks();
    const second = await svc().signedUrls([`${ORG}/${B5}/stable.jpg`]);
    expect(createSignedUrlsMock).not.toHaveBeenCalled();
    expect(createSignedUrlMock).not.toHaveBeenCalled();
    expect(second.get(`${ORG}/${B5}/stable.jpg`)).toBe('https://signed/b5-stable');
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
              storage_path: `${ORG}/items/${PDF_OK}/master.jpg`,
              thumb_path: `${ORG}/items/${PDF_OK}/thumb.webp`,
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
      expect(path).toBe(`${ORG}/items/${PDF_OK}/thumb.webp`);
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
              storage_path: `${ORG}/items/${PDF_FB1}/master.jpg`,
              thumb_path: `${ORG}/items/${PDF_FB1}/thumb.webp`,
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
      expect(firstPath).toBe(`${ORG}/items/${PDF_FB1}/thumb.webp`);
      expect(firstOptions).toEqual(expect.objectContaining({ transform: expect.anything() }));
      expect(secondPath).toBe(`${ORG}/items/${PDF_FB1}/master.jpg`);
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
              storage_path: `${ORG}/items/${PDF_FB2}/master.jpg`,
              thumb_path: `${ORG}/items/${PDF_FB2}/thumb.webp`,
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
      expect(thirdCall[0]).toBe(`${ORG}/items/${PDF_FB2}/thumb.webp`);
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
              storage_path: `${ORG}/items/${BROWSER_OK}/master.jpg`,
              thumb_path: `${ORG}/items/${BROWSER_OK}/thumb.webp`,
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
      expect(call[0]).toBe(`${ORG}/items/${BROWSER_OK}/thumb.webp`);
      expect(call.length).toBe(2); // plain signer — no transform options arg
      expect(map.get('item-browser-ok')).toBe('https://signed/browser-ok-plain-thumb');
    });

    it('falls back to transform(master) only when the row has no thumb_path at all', async () => {
      const stub = makeSupabaseStub({
        'item_images.select': {
          data: [
            {
              item_id: 'item-browser-nothumb',
              storage_path: `${ORG}/items/${BROWSER_NOTHUMB}/master.jpg`,
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
      expect(path).toBe(`${ORG}/items/${BROWSER_NOTHUMB}/master.jpg`);
      expect(options).toEqual(
        expect.objectContaining({ transform: expect.objectContaining({ width: 200 }) }),
      );
      expect(map.get('item-browser-nothumb')).toBe(
        'https://signed/browser-nothumb-master-transform',
      );
    });
  });
});

/**
 * 2026-08-18: the export pipeline decodes WebP itself (sharp), so it must NOT
 * pay for the rate-limited transform endpoint on rows that have a stored
 * thumb — 30 of one export's 272 transform requests came back 429 and every
 * one was a blank cell. This chain is PLAIN(thumb) -> transform(master, only
 * when there is no thumb). primaryImagesForPdfRendering is untouched: its
 * consumers hand URLs to react-pdf and still need the PNG re-encode.
 */
describe('ItemImagesService.primaryImagesForServerDecoding — plain(thumb) -> transform(master)', () => {
  it('signs the PLAIN thumb (no transform options) and never touches the transformer for a thumb row', async () => {
    const stub = makeSupabaseStub({
      'item_images.select': {
        data: [
          {
            item_id: 'item-server-ok',
            storage_path: `${ORG}/items/${SERVER_OK}/master.jpg`,
            thumb_path: `${ORG}/items/${SERVER_OK}/thumb.webp`,
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
      data: { signedUrl: 'https://signed/server-ok-plain-thumb' },
      error: null,
    });

    const map = await service.primaryImagesForServerDecoding(['item-server-ok'], 200);

    expect(createSignedUrlMock).toHaveBeenCalledTimes(1);
    const call = createSignedUrlMock.mock.calls[0]!;
    expect(call[0]).toBe(`${ORG}/items/${SERVER_OK}/thumb.webp`);
    expect(call.length).toBe(2); // plain signer — no transform options arg
    expect(call[2]).toBeUndefined();
    expect(map.get('item-server-ok')).toBe('https://signed/server-ok-plain-thumb');
  });

  it('uses transform(master, targetWidth) ONLY when the row has no thumb_path', async () => {
    const stub = makeSupabaseStub({
      'item_images.select': {
        data: [
          {
            item_id: 'item-server-nothumb',
            storage_path: `${ORG}/items/${SERVER_NOTHUMB}/master.jpg`,
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
      data: { signedUrl: 'https://signed/server-nothumb-master-transform' },
      error: null,
    });

    const map = await service.primaryImagesForServerDecoding(['item-server-nothumb'], 320);

    expect(createSignedUrlMock).toHaveBeenCalledTimes(1);
    const [path, , options] = createSignedUrlMock.mock.calls[0]!;
    expect(path).toBe(`${ORG}/items/${SERVER_NOTHUMB}/master.jpg`);
    expect(options).toEqual(
      expect.objectContaining({ transform: expect.objectContaining({ width: 320 }) }),
    );
    expect(map.get('item-server-nothumb')).toBe('https://signed/server-nothumb-master-transform');
  });

  it('defaults targetWidth to 200 on the no-thumb leg', async () => {
    const stub = makeSupabaseStub({
      'item_images.select': {
        data: [
          {
            item_id: 'item-server-nothumb-default',
            storage_path: `${ORG}/items/${SERVER_NOTHUMB}/master2.jpg`,
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
      data: { signedUrl: 'https://signed/x' },
      error: null,
    });
    await service.primaryImagesForServerDecoding(['item-server-nothumb-default']);
    const [, , options] = createSignedUrlMock.mock.calls[0]!;
    expect(options).toEqual(
      expect.objectContaining({ transform: expect.objectContaining({ width: 200 }) }),
    );
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

// SP-135 — the client-uploaded `-thumb.webp` SIDECAR was never verified.
// record() sniffed only the master; createUploadUrl mints a SECOND signed
// upload URL for `{uuid}-thumb.webp` that the client fills with whatever it
// likes, and the row recorded that path unverified. The thumb is what every
// list/tile actually renders, served from our own storage origin behind a
// 30-day signed URL — so a renamed non-image sat there as `image/webp`.
// And remove() deleted only the master, orphaning the thumb object forever
// (there is no orphan-sweep cron). These tests pin both halves.
describe('ItemImagesService.record — thumb sidecar verification (SP-135)', () => {
  const MASTER = 'org-1/items/item-1/x.jpg';
  const THUMB = 'org-1/items/item-1/x-thumb.webp';

  /** makeSupabaseStub's `storage.from` returns a FRESH bucket object per
   *  call, so a `remove` spy taken from it can never be asserted against.
   *  Pin one bucket for the whole call. */
  function pinBucket(stub: ReturnType<typeof makeSupabaseStub>) {
    const remove = vi.fn(async () => ({ data: null, error: null }));
    const bucket = {
      remove,
      createSignedUrl: vi.fn(async () => ({
        data: { signedUrl: 'https://mock/signed' },
        error: null,
      })),
    };
    stub.client.storage.from = vi.fn(() => bucket);
    return remove;
  }

  it('rejects a thumb whose BYTES are not an image, removes BOTH objects and writes no row', async () => {
    const stub = makeSupabaseStub({
      'inventory_items.select': { data: { id: 'item-1' }, error: null },
      'item_images.insert': {
        data: { id: 'img-1', storage_path: MASTER, sort_order: 0, is_primary: true },
        error: null,
      },
    });
    const remove = pinBucket(stub);
    const png = mockPngPrefix();
    const html = new TextEncoder().encode('<html><script>alert(1)</script></html>');
    fetchObjectPrefixMock.mockImplementation(async (_bucket: unknown, path: string) =>
      path === THUMB
        ? { prefix: html, totalSize: html.byteLength }
        : { prefix: png, totalSize: png.byteLength },
    );
    const svc = new ItemImagesService(
      makeServiceContext(stub.client, { organizationId: 'org-1' }),
    );

    await expect(
      svc.record('item-1', MASTER, true, { thumbPath: THUMB }),
    ).rejects.toThrow();

    expect(remove).toHaveBeenCalledWith([MASTER, THUMB]);
    expect(stub.chains.has('item_images.insert')).toBe(false);
    expect(audit).not.toHaveBeenCalled();
  });

  it('treats a MISSING thumb object as "no thumb" — records thumb_path null and still succeeds', async () => {
    const stub = makeSupabaseStub({
      'inventory_items.select': { data: { id: 'item-1' }, error: null },
      'item_images.insert': {
        data: { id: 'img-1', storage_path: MASTER, sort_order: 0, is_primary: true },
        error: null,
      },
    });
    const remove = pinBucket(stub);
    const png = mockPngPrefix();
    fetchObjectPrefixMock.mockImplementation(async (_bucket: unknown, path: string) =>
      path === THUMB ? null : { prefix: png, totalSize: png.byteLength },
    );
    const svc = new ItemImagesService(
      makeServiceContext(stub.client, { organizationId: 'org-1' }),
    );

    await svc.record('item-1', MASTER, true, { thumbPath: THUMB });

    const insertArgs = stub.chainArgs.get('item_images.insert');
    expect(insertArgs?.[0]?.[0]).toMatchObject({
      storage_path: MASTER,
      thumb_path: null,
    });
    // A client that skipped the thumb PUT must not lose its master.
    expect(remove).not.toHaveBeenCalled();
  });

  it('accepts a thumb that really is an image', async () => {
    const stub = makeSupabaseStub({
      'inventory_items.select': { data: { id: 'item-1' }, error: null },
      'item_images.insert': {
        data: { id: 'img-1', storage_path: MASTER, sort_order: 0, is_primary: true },
        error: null,
      },
    });
    const remove = pinBucket(stub);
    const svc = new ItemImagesService(
      makeServiceContext(stub.client, { organizationId: 'org-1' }),
    );

    await svc.record('item-1', MASTER, true, { thumbPath: THUMB });

    expect(remove).not.toHaveBeenCalled();
    expect(stub.chainArgs.get('item_images.insert')?.[0]?.[0]).toMatchObject({
      thumb_path: THUMB,
    });
  });
});

describe('ItemImagesService.remove — thumb sidecar cleanup (SP-135)', () => {
  it('removes the thumb object alongside the master', async () => {
    const stub = makeSupabaseStub({
      'item_images.select': {
        data: {
          storage_path: 'org-1/items/item-1/x.jpg',
          thumb_path: 'org-1/items/item-1/x-thumb.webp',
          item_id: 'item-1',
        },
        error: null,
      },
      'item_images.delete': { data: null, error: null },
    });
    const remove = vi.fn(async () => ({ data: null, error: null }));
    stub.client.storage.from = vi.fn(() => ({ remove }));
    const svc = new ItemImagesService(
      makeServiceContext(stub.client, { organizationId: 'org-1' }),
    );

    await svc.remove('img-1');

    expect(remove).toHaveBeenCalledWith([
      'org-1/items/item-1/x.jpg',
      'org-1/items/item-1/x-thumb.webp',
    ]);
    // thumb_path must actually be SELECTed — it was not, which is why the
    // orphan was invisible to the code that was supposed to delete it.
    expect(stub.chainArgs.get('item_images.select')?.[0]?.[0]).toContain('thumb_path');
  });

  it('removes only the master when the row has no thumb', async () => {
    const stub = makeSupabaseStub({
      'item_images.select': {
        data: { storage_path: 'org-1/items/item-1/x.jpg', thumb_path: null, item_id: 'item-1' },
        error: null,
      },
      'item_images.delete': { data: null, error: null },
    });
    const remove = vi.fn(async () => ({ data: null, error: null }));
    stub.client.storage.from = vi.fn(() => ({ remove }));
    const svc = new ItemImagesService(
      makeServiceContext(stub.client, { organizationId: 'org-1' }),
    );

    await svc.remove('img-1');

    expect(remove).toHaveBeenCalledWith(['org-1/items/item-1/x.jpg']);
  });
});

// L65b: Duplicate copies an item's photo rows, not its files, so two items'
// rows can name the same objects (19 paths shared by 43 rows in production).
// remove() used to delete the objects whatever else named them, breaking the
// other item's photo. It now leaves an object another row still names; the
// row itself is still deleted (an orphaned object is harmless).
describe('ItemImagesService.remove — objects shared with a duplicated item (L65b)', () => {
  const MASTER = 'org-1/items/item-1/x.jpg';
  const THUMB = 'org-1/items/item-1/x-thumb.webp';

  function removeStub() {
    const stub = makeSupabaseStub({
      'item_images.select': {
        data: { storage_path: MASTER, thumb_path: THUMB, item_id: 'item-1' },
        error: null,
      },
      'item_images.delete': { data: null, error: null },
    });
    const remove = vi.fn(async () => ({ data: null, error: null }));
    stub.client.storage.from = vi.fn(() => ({ remove }));
    return { stub, remove };
  }

  it('keeps the master and thumb another item still names, and deletes the row', async () => {
    adminImageRows = [
      { id: 'img-1', organization_id: 'org-1', storage_path: MASTER, thumb_path: THUMB },
      { id: 'img-dup', organization_id: 'org-1', storage_path: MASTER, thumb_path: THUMB },
    ];
    const { stub, remove } = removeStub();
    const svc = new ItemImagesService(makeServiceContext(stub.client, { organizationId: 'org-1' }));

    await svc.remove('img-1');

    expect(remove).not.toHaveBeenCalled();
    expect(stub.chains.has('item_images.delete')).toBe(true);
  });

  it('removes only the object no other row names', async () => {
    adminImageRows = [
      { id: 'img-1', organization_id: 'org-1', storage_path: MASTER, thumb_path: THUMB },
      { id: 'img-dup', organization_id: 'org-1', storage_path: MASTER, thumb_path: null },
    ];
    const { stub, remove } = removeStub();
    const svc = new ItemImagesService(makeServiceContext(stub.client, { organizationId: 'org-1' }));

    await svc.remove('img-1');

    expect(remove).toHaveBeenCalledWith([THUMB]);
  });

  it('removes both objects when only this row names them, and counts only this org', async () => {
    adminImageRows = [
      { id: 'img-1', organization_id: 'org-1', storage_path: MASTER, thumb_path: THUMB },
      { id: 'img-other-org', organization_id: 'org-2', storage_path: MASTER, thumb_path: THUMB },
    ];
    const { stub, remove } = removeStub();
    const svc = new ItemImagesService(makeServiceContext(stub.client, { organizationId: 'org-1' }));

    await svc.remove('img-1');

    expect(remove).toHaveBeenCalledWith([MASTER, THUMB]);
  });

  it('removes no object when it cannot tell whether another row names it', async () => {
    adminImageReadError = { message: 'boom' };
    const { stub, remove } = removeStub();
    const svc = new ItemImagesService(makeServiceContext(stub.client, { organizationId: 'org-1' }));

    await svc.remove('img-1');

    expect(remove).not.toHaveBeenCalled();
    expect(stub.chains.has('item_images.delete')).toBe(true);
  });
});

/**
 * Security invariant (2026-09-28): ItemImagesService never signs, lists or
 * deletes the image of an item the CALLER cannot read.
 *
 * item_images_select was org-member wide until 0381, inventory_items_select
 * is scoped (warehouse, charter, viewer category). Every image read in the service used
 * to trust the image rows alone and then sign their paths with the
 * service-role client, so a scoped member's image-master request, PO page or
 * report PDF carried working URLs for items outside their scope. Every
 * item_images read now embeds `item:inventory_items!item_id!inner(id)`, which
 * PostgREST evaluates under the caller's RLS. The stub below answers the way
 * PostgREST does (test/item-read-scope.ts), so these tests fail on a read
 * that drops the embed or makes it a LEFT join.
 */
describe('ItemImagesService — item-level authorization of every image read', () => {
  const ORG_A = '0c0c0c0c-0000-4000-8000-00000000000a';
  const WH_MAIN = '0c0c0c0c-0000-4000-8000-0000000000a1';
  const WH_ANNEX = '0c0c0c0c-0000-4000-8000-0000000000a2';
  const CAT_IN = '0c0c0c0c-0000-4000-8000-0000000000c1';
  const CAT_OUT = '0c0c0c0c-0000-4000-8000-0000000000c2';
  const VIEWER: ScopedCaller = { organizationId: ORG_A, warehouseIds: [WH_MAIN], categoryIds: [CAT_IN] };
  const STAFF: ScopedCaller = { organizationId: ORG_A, warehouseIds: [WH_MAIN], categoryIds: 'all' };

  // Fresh ids per world: the module memoizes signed paths across tests.
  let seq = 0;
  function world() {
    seq += 1;
    const n = String(seq).padStart(4, '0');
    const id = (tag: string) => `${tag}-0000-4000-8000-00000000${n}`;
    const items = {
      inScope: { id: id('c1c1c1c1'), organization_id: ORG_A, warehouse_id: WH_MAIN, category_id: CAT_IN },
      otherCategory: {
        id: id('c2c2c2c2'),
        organization_id: ORG_A,
        warehouse_id: WH_MAIN,
        category_id: CAT_OUT,
        // An ISBN cover on the unreadable item must not leak through the
        // custom_fields fallback either.
        custom_fields: { thumbnail_url: 'https://covers.test/out-of-scope.jpg' },
      },
      otherWarehouse: { id: id('c3c3c3c3'), organization_id: ORG_A, warehouse_id: WH_ANNEX, category_id: CAT_IN },
    } satisfies Record<string, WorldItem>;
    const images: WorldImage[] = Object.values(items).map((item, i) => ({
      id: id(`d${i}d${i}d${i}d${i}`),
      organization_id: ORG_A,
      item_id: item.id,
      storage_path: `${ORG_A}/items/${item.id}/master.webp`,
      thumb_path: `${ORG_A}/items/${item.id}/master-thumb.webp`,
      lqip: null,
      is_primary: true,
      sort_order: 0,
    }));
    const outPaths = images
      .filter((r) => r.item_id !== items.inScope.id)
      .flatMap((r) => [r.storage_path, r.thumb_path as string]);
    return { items, images, outPaths, ids: Object.values(items).map((i) => i.id) };
  }

  function serviceFor(caller: ScopedCaller, w: ReturnType<typeof world>, extra = {}) {
    const stub = makeSupabaseStub({
      ...itemReadScopeResults(caller, { items: Object.values(w.items), images: w.images }),
      ...extra,
    });
    return {
      stub,
      service: new ItemImagesService(makeServiceContext(stub.client, { organizationId: ORG_A })),
    };
  }

  function signedPaths(): string[] {
    return [
      ...createSignedUrlsMock.mock.calls.flatMap((c) => c[0] as string[]),
      ...createSignedUrlMock.mock.calls.map((c) => c[0] as string),
    ];
  }

  beforeEach(() => {
    createSignedUrlsMock.mockImplementation(async (paths: string[]) => ({
      data: paths.map((p) => ({ path: p, signedUrl: `https://signed.test/${p}`, error: null })),
      error: null,
    }));
    createSignedUrlMock.mockImplementation(async (p: string) => ({
      data: { signedUrl: `https://signed.test/${p}` },
      error: null,
    }));
  });

  const methods = [
    ['primaryImagesForItems', (s: ItemImagesService, ids: string[]) => s.primaryImagesForItems(ids)],
    ['primaryImagesWithThumbsForItems', (s: ItemImagesService, ids: string[]) => s.primaryImagesWithThumbsForItems(ids)],
    ['primaryImagesForPdfRendering', (s: ItemImagesService, ids: string[]) => s.primaryImagesForPdfRendering(ids)],
    ['primaryImagesForServerDecoding', (s: ItemImagesService, ids: string[]) => s.primaryImagesForServerDecoding(ids)],
    ['primaryImagesForBrowserDisplay', (s: ItemImagesService, ids: string[]) => s.primaryImagesForBrowserDisplay(ids)],
    ['primaryMasterUrlsForItems', (s: ItemImagesService, ids: string[]) => s.primaryMasterUrlsForItems(ids)],
  ] as const;

  for (const [name, call] of methods) {
    it(`${name}: a category-scoped viewer gets only the in-scope item, and nothing out of scope is signed`, async () => {
      const w = world();
      const { service } = serviceFor(VIEWER, w);

      const result = await call(service, w.ids);

      expect([...result.keys()]).toEqual([w.items.inScope.id]);
      const signed = signedPaths();
      expect(signed.length).toBeGreaterThan(0);
      for (const p of w.outPaths) expect(signed).not.toContain(p);
      expect(signed.every((p) => p.includes(w.items.inScope.id))).toBe(true);
    });

    it(`${name}: a warehouse-scoped staff member gets their warehouse's items, never another warehouse's`, async () => {
      const w = world();
      const { service } = serviceFor(STAFF, w);

      const result = await call(service, w.ids);

      expect([...result.keys()].sort()).toEqual([w.items.inScope.id, w.items.otherCategory.id].sort());
      expect(signedPaths().some((p) => p.includes(w.items.otherWarehouse.id))).toBe(false);
    });
  }

  it('list(): a scoped caller gets no image rows for an item they cannot read', async () => {
    const w = world();
    const { service } = serviceFor(VIEWER, w);

    expect(await service.list(w.items.otherCategory.id)).toEqual([]);
    expect(await service.list(w.items.otherWarehouse.id)).toEqual([]);
    expect((await service.list(w.items.inScope.id)).map((r) => r.storage_path)).toEqual([
      `${ORG_A}/items/${w.items.inScope.id}/master.webp`,
    ]);
  });

  it('remove(): the image of an item the caller cannot read is "not found", and nothing is deleted', async () => {
    const w = world();
    const { stub, service } = serviceFor(STAFF, w);
    const remove = vi.fn(async () => ({ data: null, error: null }));
    stub.client.storage.from = vi.fn(() => ({ remove }));
    const outImage = w.images.find((r) => r.item_id === w.items.otherWarehouse.id)!;

    await expect(service.remove(outImage.id)).rejects.toThrow('not_found');
    expect(remove).not.toHaveBeenCalled();
    expect(stub.chainsAll.get('item_images.delete')).toBeUndefined();
  });

  it('remove(): an in-scope image is still removed (master and thumb)', async () => {
    const w = world();
    const { stub, service } = serviceFor(STAFF, w, {
      'item_images.delete': { data: null, error: null },
    });
    const remove = vi.fn(async () => ({ data: null, error: null }));
    stub.client.storage.from = vi.fn(() => ({ remove }));
    const inImage = w.images.find((r) => r.item_id === w.items.inScope.id)!;

    await service.remove(inImage.id);

    expect(remove).toHaveBeenCalledWith([inImage.storage_path, inImage.thumb_path]);
  });
});

/**
 * NO item_images READ WITHOUT THE ITEM EMBED, checked two ways.
 *
 * The item embed (`item:inventory_items!item_id!inner(id)`) is the whole of the
 * item-level authorization above: item_images_select was org-member wide
 * until 0381, so a read without it handed a scoped caller the image rows, and
 * then signed URLs, of items they cannot read (the embed stays as the
 * service's own check now that the policy agrees). The first version of this guard was a regular
 * expression over `.from('item_images')` in single quotes followed directly by
 * `.select('...')`: a read written with double quotes, a template string, a
 * table-name constant, a select list in a variable, or a builder split across
 * statements was not seen at all, and the count it checked did not see it
 * either. These replace it:
 *
 *   1. BEHAVIOUR: every method of the service (whatever it is called, new ones
 *      included) is run against a stub that records each PostgREST request as
 *      it is really issued, and every item_images read must carry the embed.
 *   2. SOURCE, through the TypeScript AST (quotes, comments and line breaks do
 *      not matter): every item_images read must be one chain,
 *      `.from(<literal>)...select(<literal with the embed>)`, and anything the
 *      check cannot read (a computed table name, the table named outside
 *      `.from()`, a select list that is not a literal, a builder whose select
 *      is elsewhere) fails as unprovable, not as fine. This catches a read the
 *      behaviour check does not reach (one behind an early return).
 */
const ITEM_EMBED = 'item:inventory_items!item_id!inner(id)';
/** A chain with one of these is a write; its `.select()` only reads back its own row. */
const WRITE_METHODS = new Set(['insert', 'update', 'upsert', 'delete']);

function literalText(node: ts.Node | undefined): string | null {
  return node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    ? node.text
    : null;
}

/** Each item_images read in `source` that does not provably carry the embed, as "line N: why". */
function itemImagesReadProblems(source: string): { problems: string[]; embeddedReads: number } {
  const sf = ts.createSourceFile('source.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const problems: string[] = [];
  let embeddedReads = 0;
  const line = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const isFromCall = (n: ts.Node | undefined): n is ts.CallExpression =>
    !!n &&
    ts.isCallExpression(n) &&
    ts.isPropertyAccessExpression(n.expression) &&
    n.expression.name.text === 'from';

  const visit = (node: ts.Node): void => {
    // The table named anywhere but inline in .from(): a constant, an alias, a
    // map of table names. Its read cannot be followed, so it is refused.
    if (literalText(node) === 'item_images' && !(isFromCall(node.parent) && node.parent.arguments[0] === node)) {
      problems.push(`line ${line(node)}: 'item_images' named outside .from(); name the table inline`);
    }
    if (ts.isTemplateExpression(node) && node.getText(sf).includes('item_images')) {
      problems.push(`line ${line(node)}: 'item_images' in a template with substitutions`);
    }
    if (isFromCall(node)) {
      const table = literalText(node.arguments[0]);
      if (table === null) {
        problems.push(`line ${line(node)}: .from() with a computed table name`);
      } else if (table === 'item_images') {
        // Up the builder chain: .from(...).select(...).eq(...).order(...)...
        const chain: Array<{ name: string; call: ts.CallExpression }> = [];
        let cur: ts.Node = node;
        while (
          ts.isPropertyAccessExpression(cur.parent) &&
          cur.parent.expression === cur &&
          ts.isCallExpression(cur.parent.parent) &&
          cur.parent.parent.expression === cur.parent
        ) {
          chain.push({ name: cur.parent.name.text, call: cur.parent.parent });
          cur = cur.parent.parent;
        }
        if (!chain.some((m) => WRITE_METHODS.has(m.name))) {
          const select = chain.find((m) => m.name === 'select');
          const cols = select ? literalText(select.call.arguments[0]) : null;
          if (!select) {
            problems.push(`line ${line(node)}: an item_images read whose .select() is not in the same chain`);
          } else if (cols === null) {
            problems.push(`line ${line(select.call)}: an item_images .select() whose column list is not a literal`);
          } else if (!cols.includes(ITEM_EMBED)) {
            problems.push(`line ${line(select.call)}: an item_images read without ${ITEM_EMBED}`);
          } else {
            embeddedReads += 1;
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { problems, embeddedReads };
}

describe('ItemImagesService — no item_images read without the item embed', () => {
  it('BEHAVIOUR: every item_images read any method issues carries the inner item embed', async () => {
    createSignedUrlsMock.mockImplementation(async (paths: string[]) => ({
      data: paths.map((p) => ({ path: p, signedUrl: `https://signed.test/${p}`, error: null })),
      error: null,
    }));
    createSignedUrlMock.mockImplementation(async (p: string) => ({
      data: { signedUrl: `https://signed.test/${p}` },
      error: null,
    }));
    const ids = [B1, B2];
    // The shapes the service's methods take today: (itemIds), (itemId or
    // imageId), the shared resolver's (method, itemIds, resolveRow), and
    // record's (itemId, path, isFirst). A method that rejects one shape (a
    // TypeError, a validation error) is simply tried with the next.
    const argShapes: unknown[][] = [
      [ids],
      [B1],
      ['guard', ids, async () => null],
      [B1, `${ORG}/items/${B1}/guard.png`, true],
    ];
    const methods = Object.getOwnPropertyNames(ItemImagesService.prototype).filter(
      (name) => name !== 'constructor',
    );
    const selectsByMethod = new Map<string, string[]>();
    for (const name of methods) {
      for (const args of argShapes) {
        const image = { id: B1, item_id: B1, storage_path: `${ORG}/items/${B1}/m.png`, thumb_path: null, is_primary: true, sort_order: 0 };
        const stub = makeSupabaseStub({
          'item_images.select': { data: [image], error: null },
          'inventory_items.select': { data: [{ id: B1, custom_fields: null }], error: null },
        });
        const service = new ItemImagesService(makeServiceContext(stub.client, { organizationId: ORG }));
        try {
          await (service as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[name]!(...args);
        } catch {
          // Only the requests matter here.
        }
        // Every chain on item_images that is a read: its first method is
        // .select() (a write's read-back is recorded under its write).
        const selects = (stub.chainArgsAll.get('item_images.select') ?? []).map((a) =>
          String(a[0]?.[0]),
        );
        selectsByMethod.set(name, [...(selectsByMethod.get(name) ?? []), ...selects]);
      }
    }

    const all = [...selectsByMethod.entries()].flatMap(([name, list]) =>
      list.map((select) => ({ name, select })),
    );
    for (const { name, select } of all) {
      expect(select, `${name}() read item_images without the embed`).toContain(ITEM_EMBED);
    }
    // Not vacuous: every read the service has today was reached.
    const reached = [...selectsByMethod.entries()].filter(([, l]) => l.length > 0).map(([n]) => n);
    expect(reached).toEqual(
      expect.arrayContaining([
        'list',
        'primaryImagesForItems',
        'primaryImagesWithThumbsForItems',
        'resolvePrimaryImageUrls',
        'primaryImagesForPdfRendering',
        'primaryImagesForServerDecoding',
        'primaryImagesForBrowserDisplay',
        'primaryMasterUrlsForItems',
        'remove',
      ]),
    );
  });

  it('SOURCE: every item_images read in item-images.ts is one chain whose literal select carries the embed', () => {
    const { problems, embeddedReads } = itemImagesReadProblems(
      readFileSync(join(__dirname, 'item-images.ts'), 'utf8'),
    );
    expect(problems).toEqual([]);
    // Six reads today: list, primaryImagesForItems,
    // primaryImagesWithThumbsForItems, resolvePrimaryImageUrls,
    // primaryMasterUrlsForItems, remove.
    expect(embeddedReads).toBe(6);
  });

  it('SOURCE: the check refuses every other way of writing a read, and passes the embedded ones', () => {
    const refused: Record<string, string> = {
      'double quotes': `x.from("item_images").select("item_id, storage_path").eq('a', 1);`,
      'a template string': 'x.from(`item_images`).select(`item_id, storage_path`);',
      'a comment between from and select': `x.from('item_images') // why\n  // more\n  .select('item_id');`,
      'a table-name constant': `const T = 'item_images';\nx.from(T).select('id, ${ITEM_EMBED}');`,
      'a computed table name': 'x.from(`item_${kind}`).select(`id`);',
      'a select list in a variable': `const COLS = 'id, ${ITEM_EMBED}';\nx.from('item_images').select(COLS);`,
      'a select list built by a template': `x.from('item_images').select(\`id, \${extra}\`);`,
      'select() with no list': `x.from('item_images').select().eq('id', 1);`,
      'a builder split across statements': `const q = x.from('item_images');\nawait q.select('id, ${ITEM_EMBED}');`,
      'a cast inside the chain': `(x.from('item_images') as any).select('id, ${ITEM_EMBED}');`,
      'a LEFT embed (no !inner)': `x.from('item_images').select('id, item:inventory_items!item_id(id)');`,
    };
    for (const [how, code] of Object.entries(refused)) {
      expect(itemImagesReadProblems(code).problems, how).not.toEqual([]);
    }

    const accepted: Record<string, string> = {
      'single quotes': `x.from('item_images').select('id, ${ITEM_EMBED}').eq('a', 1);`,
      'double quotes': `x.from("item_images")\n  // comment\n  .select("id, ${ITEM_EMBED}");`,
      'a template string': 'x.from(`item_images`).select(`id, ' + ITEM_EMBED + '`);',
      'a write with a read-back': `x.from('item_images').insert({ a: 1 }).select('id').single();`,
      'a delete': `x.from('item_images').delete().eq('id', 1);`,
      'another table, and the storage bucket': `x.from('inventory_items').select('id'); s.storage.from('item-images').remove([p]);`,
      'the table named in a log tag': `report({ tag: 'item_images.sign_failed' });`,
    };
    for (const [how, code] of Object.entries(accepted)) {
      expect(itemImagesReadProblems(code).problems, how).toEqual([]);
    }
  });
});
