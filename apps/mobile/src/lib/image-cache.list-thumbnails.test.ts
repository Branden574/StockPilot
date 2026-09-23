import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The Items and Books lists must use the STORED thumbnail, not an on-demand
 * resize of the master. Supabase bills every distinct photo it transforms in a
 * month (100 included, then $5 per 1,000): with the old code, browsing the
 * catalog once billed nearly every photo in it, and each row needed its own
 * signing request. Measured on the 2026-09 invoice: 427 transformed photos.
 */

const createSignedUrl = vi.fn();
const createSignedUrls = vi.fn();
vi.mock('./supabase', () => ({
  supabase: { storage: { from: () => ({ createSignedUrl, createSignedUrls }) } },
}));

async function freshModule() {
  vi.resetModules();
  return import('./image-cache');
}

beforeEach(() => {
  createSignedUrl.mockReset();
  createSignedUrls.mockReset();
  createSignedUrls.mockImplementation(async (paths: string[]) => ({
    data: paths.map((path) => ({ path, signedUrl: `https://x/plain/${path}?token=t` })),
  }));
  createSignedUrl.mockImplementation(async (path: string, _ttl: number, opts?: { transform?: unknown }) => ({
    data: { signedUrl: `https://x/${opts?.transform ? 'render' : 'plain'}/${path}?token=t` },
  }));
});

describe('signListThumbnails', () => {
  it('signs stored thumbnails in ONE batched request and asks for no transform', async () => {
    const { signListThumbnails } = await freshModule();
    const out = await signListThumbnails([
      { storage_path: 'o/items/a/1.webp', thumb_path: 'o/items/a/1-thumb.webp' },
      { storage_path: 'o/items/b/2.jpg', thumb_path: 'o/items/b/2-thumb.webp' },
      { storage_path: 'o/items/c/3.jpg', thumb_path: 'o/items/c/3-thumb.webp' },
    ]);
    expect(createSignedUrls).toHaveBeenCalledTimes(1);
    expect(createSignedUrls.mock.calls[0]![0]).toEqual([
      'o/items/a/1-thumb.webp',
      'o/items/b/2-thumb.webp',
      'o/items/c/3-thumb.webp',
    ]);
    expect(createSignedUrl).not.toHaveBeenCalled(); // no per-photo request, no transform
    // Keyed by the MASTER path, which is what the list rows look up.
    expect(out.get('o/items/a/1.webp')).toBe('https://x/plain/o/items/a/1-thumb.webp?token=t');
    expect(out.get('o/items/c/3.jpg')).toBe('https://x/plain/o/items/c/3-thumb.webp?token=t');
  });

  it('transforms ONLY the photos that have no stored thumbnail', async () => {
    const { signListThumbnails, THUMB_TRANSFORM } = await freshModule();
    const out = await signListThumbnails([
      { storage_path: 'o/items/a/1.webp', thumb_path: 'o/items/a/1-thumb.webp' },
      { storage_path: 'o/items/m/mobile.jpg', thumb_path: null },
      { storage_path: 'o/items/n/legacy.jpg' },
    ]);
    expect(createSignedUrls).toHaveBeenCalledTimes(1);
    expect(createSignedUrl).toHaveBeenCalledTimes(2);
    for (const call of createSignedUrl.mock.calls) {
      expect(call[2]).toEqual({ transform: THUMB_TRANSFORM });
    }
    expect(createSignedUrl.mock.calls.map((c) => c[0]).sort()).toEqual([
      'o/items/m/mobile.jpg',
      'o/items/n/legacy.jpg',
    ]);
    expect(out.get('o/items/m/mobile.jpg')).toContain('/render/');
    expect(out.get('o/items/a/1.webp')).toContain('/plain/');
  });

  it('a thumbnail that fails to sign falls back to the transform: the row still gets a picture', async () => {
    createSignedUrls.mockImplementation(async (paths: string[]) => ({
      data: paths.map((path) => ({ path, signedUrl: path.includes('/b/') ? '' : `https://x/plain/${path}?token=t` })),
    }));
    const { signListThumbnails } = await freshModule();
    const out = await signListThumbnails([
      { storage_path: 'o/items/a/1.webp', thumb_path: 'o/items/a/1-thumb.webp' },
      { storage_path: 'o/items/b/2.jpg', thumb_path: 'o/items/b/2-thumb.webp' },
    ]);
    expect(createSignedUrl).toHaveBeenCalledTimes(1);
    expect(createSignedUrl.mock.calls[0]![0]).toBe('o/items/b/2.jpg');
    expect(out.get('o/items/b/2.jpg')).toContain('/render/');
    expect(out.get('o/items/a/1.webp')).toContain('/plain/');
  });

  it('asks the network for nothing when there are no photos, and nothing twice for the same thumbnail', async () => {
    const { signListThumbnails } = await freshModule();
    expect((await signListThumbnails([])).size).toBe(0);
    expect(createSignedUrls).not.toHaveBeenCalled();
    const photos = [{ storage_path: 'o/items/a/1.webp', thumb_path: 'o/items/a/1-thumb.webp' }];
    await signListThumbnails(photos);
    await signListThumbnails(photos);
    expect(createSignedUrls).toHaveBeenCalledTimes(1); // second call served from the in-memory cache
  });
});

describe('the list screens', () => {
  it('select thumb_path and use signListThumbnails, not the transform preset', async () => {
    const { readFileSync } = await import('node:fs');
    const path = await import('node:path');
    // The photo read lives in the shared reader (batched, fails loudly); the
    // screens call it and sign through signListThumbnails.
    const reader = readFileSync(path.resolve(__dirname, 'id-reads.ts'), 'utf8');
    expect(reader, 'readPrimaryPhotos must read the stored thumbnail path').toMatch(
      /\.select\('item_id, storage_path, thumb_path, is_primary, sort_order'\)/,
    );
    for (const screen of ['inventory.tsx', 'books.tsx']) {
      const source = readFileSync(path.resolve(__dirname, '..', '..', 'app', '(drawer)', '(tabs)', screen), 'utf8');
      expect(source, `${screen} must read photos through the shared reader`).toMatch(/readPrimaryPhotos\(/);
      expect(source).toMatch(/signListThumbnails/);
      expect(source, `${screen} must not ask for the on-demand transform itself`).not.toMatch(/THUMB_TRANSFORM/);
    }
  });
});
