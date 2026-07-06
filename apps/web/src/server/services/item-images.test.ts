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
