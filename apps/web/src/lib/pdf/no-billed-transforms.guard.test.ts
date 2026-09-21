import { execFileSync } from 'node:child_process';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * GUARD: PDFs must not ask Supabase to resize or re-encode photos.
 *
 * Supabase bills every distinct photo it transforms in a month (100 included,
 * then $5 per 1,000; the 2026-09 invoice showed 427). Every PDF route already
 * pipes its image URLs through `prefetchImagesAsDataUris`, which converts WebP
 * to JPEG locally with sharp, so the transform bought nothing: the stored
 * thumbnail is already ~200 px. `primaryImagesForServerDecoding` returns that
 * thumbnail as a plain object URL and only transforms a photo that has no
 * thumbnail at all.
 */
const WEB = path.resolve(__dirname, '..', '..', '..');

function grep(pattern: string): string[] {
  try {
    return execFileSync('grep', ['-rlE', pattern, 'src/app'], { cwd: WEB, encoding: 'utf8' })
      .split('\n')
      .filter(Boolean);
  } catch {
    return []; // grep exits 1 when nothing matches
  }
}

describe('PDF routes and billed image transforms', () => {
  it('no route calls the transform-first resolver', () => {
    expect(
      grep('primaryImagesForPdfRendering\\('),
      'Use primaryImagesForServerDecoding + prefetchImagesAsDataUris: the stored thumbnail, converted locally.',
    ).toEqual([]);
  });

  it('every PDF route that resolves item photos converts them locally', () => {
    const resolving = grep('primaryImagesForServerDecoding\\(').filter((f) => f.includes('pdf'));
    expect(resolving.length).toBeGreaterThanOrEqual(5); // the scan must not be empty
    const converting = new Set(grep('prefetchImagesAsDataUris\\('));
    for (const file of resolving) {
      expect(converting.has(file), `${file} resolves photos but does not convert them locally`).toBe(true);
    }
  });
});
