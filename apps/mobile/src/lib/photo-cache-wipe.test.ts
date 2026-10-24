import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Signing out, an account eviction, or a pull for another account forgets the
 * photos the leaving account saw: expo-image's memory and disk caches (which
 * keep a photo under its storage path for up to a week) and the in-memory
 * item-photo links. Before, a sign-out cleared the SQLite cache only. Which
 * wipes keep the photos, and the record of whose they are, is executed end to
 * end in cache-owner.sqlite.test.ts.
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
  it('clears the memory and the disk photo caches', async () => {
    const { clearPhotoCaches } = await import('./photo-cache-wipe');
    await clearPhotoCaches(vi.fn());
    expect(image.clearMemoryCache).toHaveBeenCalledTimes(1);
    expect(image.clearDiskCache).toHaveBeenCalledTimes(1);
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
    await expect(clearPhotoCaches(warn)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith('[auth] could not clear the photo memory cache', null);
    expect(warn).toHaveBeenCalledWith(
      '[auth] could not clear the photo disk cache',
      expect.any(Error),
    );
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
    await wipeWithPhotoCaches(async () => {
      order.push('sqlite');
    });
    expect(order).toEqual(['photos', 'sqlite']);
    expect(image.clearMemoryCache).toHaveBeenCalledTimes(1);
  });

  // Mutation caught: `await clearPhotoCaches(); await wipe();` without the
  // finally. clearPhotoCaches reports a cache it could not clear rather than
  // throwing, but a throw must still never skip the SQLite wipe.
  it('a photo wipe that throws still runs the SQLite wipe', async () => {
    const { wipeWithPhotoCaches } = await import('./photo-cache-wipe');
    image.clearMemoryCache.mockImplementationOnce(() => {
      throw new Error('native module missing');
    });
    const wipe = vi.fn(async () => {});
    await expect(wipeWithPhotoCaches(wipe)).rejects.toThrow('native module missing');
    expect(wipe).toHaveBeenCalledTimes(1);
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
