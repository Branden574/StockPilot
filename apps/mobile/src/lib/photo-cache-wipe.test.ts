import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Signing out, an account eviction, or a pull for another account forgets the
 * photos the leaving account saw: expo-image's memory and disk caches (which
 * keep a photo under its storage path for up to a week) and the in-memory
 * item-photo links. Before, a sign-out cleared the SQLite cache only. Which
 * wipes keep the photos, and the record of whose they are, is executed end to
 * end in cache-owner.sqlite.test.ts.
 *
 * And the clear says whether it worked (B18 reviews of 43256f0da and
 * 254fb9c72): a pull that clears the photos records a clear that failed as
 * still owed, so it is tried again at the next pull instead of being recorded
 * as done (executed in cache-owner.sqlite.test.ts).
 */

const { image, createSignedUrl } = vi.hoisted(() => ({
  image: {
    clearMemoryCache: vi.fn(async () => true),
    clearDiskCache: vi.fn(async () => true),
  },
  createSignedUrl: vi.fn(),
}));

vi.mock('expo-image', () => ({ Image: image }));
vi.mock('./supabase', () => ({
  supabase: { storage: { from: () => ({ createSignedUrl, createSignedUrls: vi.fn() }) } },
}));

beforeEach(() => {
  vi.resetModules();
  image.clearMemoryCache.mockReset().mockResolvedValue(true);
  image.clearDiskCache.mockReset().mockResolvedValue(true);
  createSignedUrl.mockReset();
  let n = 0;
  createSignedUrl.mockImplementation(async () => ({
    data: { signedUrl: `https://files.example/photo?link=${++n}` },
    error: null,
  }));
});

describe('clearPhotoCaches', () => {
  // Mutation caught: a sign-out that leaves either cache in place.
  it('clears the memory and the disk photo caches, and says it did', async () => {
    const { clearPhotoCaches } = await import('./photo-cache-wipe');
    const warn = vi.fn();
    await expect(clearPhotoCaches(warn)).resolves.toBe(true);
    expect(image.clearMemoryCache).toHaveBeenCalledTimes(1);
    expect(image.clearDiskCache).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it('forgets the item-photo links this session signed, so the next account signs its own', async () => {
    const { signItemImage } = await import('./image-cache');
    const { clearPhotoCaches } = await import('./photo-cache-wipe');
    const first = await signItemImage('org/item/master.webp');
    // Held for the session: asked again, no new request.
    expect(await signItemImage('org/item/master.webp')).toBe(first);
    expect(createSignedUrl).toHaveBeenCalledTimes(1);

    await clearPhotoCaches(vi.fn());

    const after = await signItemImage('org/item/master.webp');
    expect(createSignedUrl).toHaveBeenCalledTimes(2);
    expect(after).not.toBe(first);
  });

  it('a cache that cannot be cleared is reported and never stops the sign-out', async () => {
    const { clearPhotoCaches } = await import('./photo-cache-wipe');
    image.clearDiskCache.mockRejectedValueOnce(new Error('disk busy'));
    image.clearMemoryCache.mockResolvedValueOnce(false);
    const warn = vi.fn();
    await expect(clearPhotoCaches(warn)).resolves.toBe(false);
    expect(warn).toHaveBeenCalledWith('[auth] could not clear the photo memory cache', null);
    expect(warn).toHaveBeenCalledWith(
      '[auth] could not clear the photo disk cache',
      expect.any(Error),
    );
  });

  // Mutation caught: a clear that answers true (or nothing) whatever the
  // caches did, as at 43256f0da, where the pull then recorded the account and
  // never cleared again. Each way fails the clear on its own; the other cache
  // is still cleared, and the call never throws.
  const FAILURES: Record<string, () => void> = {
    'the disk clear answers false': () => {
      image.clearDiskCache.mockResolvedValueOnce(false);
    },
    'the disk clear rejects': () => {
      image.clearDiskCache.mockRejectedValueOnce(new Error('disk busy'));
    },
    'the memory clear answers false': () => {
      image.clearMemoryCache.mockResolvedValueOnce(false);
    },
    'the memory clear rejects': () => {
      image.clearMemoryCache.mockRejectedValueOnce(new Error('memory busy'));
    },
    'the disk clear throws as it is called': () => {
      image.clearDiskCache.mockImplementationOnce(() => {
        throw new Error('native module missing');
      });
    },
    'the memory clear throws as it is called': () => {
      image.clearMemoryCache.mockImplementationOnce(() => {
        throw new Error('native module missing');
      });
    },
    'the disk clear answers something other than true': () => {
      image.clearDiskCache.mockResolvedValueOnce(undefined as unknown as boolean);
    },
  };
  it.each(Object.keys(FAILURES))('says it failed, and warns, when %s', async (failure) => {
    const { clearPhotoCaches } = await import('./photo-cache-wipe');
    FAILURES[failure]!();
    const warn = vi.fn();
    await expect(clearPhotoCaches(warn)).resolves.toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(image.clearMemoryCache).toHaveBeenCalledTimes(1);
    expect(image.clearDiskCache).toHaveBeenCalledTimes(1);
  });

  // Mutation caught: the links' forgetting left out of the answer.
  it('says it failed when the photo links could not be forgotten, and still clears both caches', async () => {
    vi.doMock('./image-cache', () => ({
      forgetSignedImageUrls: () => {
        throw new Error('links unreadable');
      },
    }));
    try {
      const { clearPhotoCaches } = await import('./photo-cache-wipe');
      const warn = vi.fn();
      await expect(clearPhotoCaches(warn)).resolves.toBe(false);
      expect(warn).toHaveBeenCalledWith(
        '[auth] could not forget the photo links',
        expect.any(Error),
      );
      expect(image.clearMemoryCache).toHaveBeenCalledTimes(1);
      expect(image.clearDiskCache).toHaveBeenCalledTimes(1);
    } finally {
      vi.doUnmock('./image-cache');
    }
  });
});

/**
 * The sign-out, the eviction and a pull for another account run their SQLite
 * wipe through wipeWithPhotoCaches. Before, the sign-out and the eviction ran
 * `await wipe(); await clearPhotoCaches();`: a SQLite wipe that threw was
 * reported and the sign-out completed, with every photo left in place.
 */
describe('wipeWithPhotoCaches', () => {
  // Mutation caught: the SQLite wipe first, as it was. The sign-out's and the
  // eviction's wipes forget whose cache it was (cache-owner.ts), so an app
  // closed before the disk clear finished left photos with no owner recorded
  // and the next account adopted them (executed in cache-owner.sqlite.test.ts).
  it('clears the photo caches before the SQLite wipe, which waits for the disk clear to finish', async () => {
    const { wipeWithPhotoCaches } = await import('./photo-cache-wipe');
    const order: string[] = [];
    image.clearDiskCache.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push('photos');
      return true;
    });
    await expect(
      wipeWithPhotoCaches(async () => {
        order.push('sqlite');
      }),
    ).resolves.toBe(true);
    expect(order).toEqual(['photos', 'sqlite']);
    expect(image.clearMemoryCache).toHaveBeenCalledTimes(1);
  });

  // Mutation caught: the wipe answering true, or nothing, after a clear that
  // failed. The reset for another account records the new account only when
  // this says the photos went (sync.ts).
  it('says whether the photos were cleared, and runs the SQLite wipe either way', async () => {
    const { wipeWithPhotoCaches } = await import('./photo-cache-wipe');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    image.clearDiskCache.mockResolvedValueOnce(false);
    const wipe = vi.fn(async () => {});
    await expect(wipeWithPhotoCaches(wipe)).resolves.toBe(false);
    expect(wipe).toHaveBeenCalledTimes(1);
  });

  // A native call that throws as it is called (a module missing from the
  // binary) is a failed clear like any other: clearPhotoCaches never throws,
  // so the pull that clears photos with no SQLite wipe is never skipped
  // (sync.ts), and the SQLite wipe here still runs.
  it('a photo wipe whose native call throws is reported as a failed clear and still runs the SQLite wipe', async () => {
    const { wipeWithPhotoCaches } = await import('./photo-cache-wipe');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    image.clearMemoryCache.mockImplementationOnce(() => {
      throw new Error('native module missing');
    });
    const wipe = vi.fn(async () => {});
    await expect(wipeWithPhotoCaches(wipe)).resolves.toBe(false);
    expect(wipe).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      '[auth] could not clear the photo memory cache',
      expect.any(Error),
    );
  });

  // Mutation caught: the photo wipe run only when the SQLite wipe succeeds.
  it('a SQLite wipe that fails still clears the photos, and its failure is passed on', async () => {
    const { signItemImage } = await import('./image-cache');
    const { wipeWithPhotoCaches } = await import('./photo-cache-wipe');
    const first = await signItemImage('org/item/master.webp');

    await expect(
      wipeWithPhotoCaches(async () => {
        throw new Error('database is locked');
      }),
    ).rejects.toThrow('database is locked');

    expect(image.clearMemoryCache).toHaveBeenCalledTimes(1);
    expect(image.clearDiskCache).toHaveBeenCalledTimes(1);
    // The links this session signed are forgotten too.
    expect(await signItemImage('org/item/master.webp')).not.toBe(first);
  });
});
