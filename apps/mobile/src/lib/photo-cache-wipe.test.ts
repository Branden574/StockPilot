import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Signing out, or an account eviction, forgets the photos the leaving account
 * saw: expo-image's memory and disk caches (which keep a photo under its
 * storage path for up to a week) and the in-memory item-photo links. Before,
 * a sign-out cleared the SQLite cache only.
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
