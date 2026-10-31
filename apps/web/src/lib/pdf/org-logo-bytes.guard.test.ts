import { execFileSync } from 'node:child_process';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * GUARD (SSRF): every branded PDF gets the organization's logo as bytes.
 *
 * organizations.logo_url is set by an org owner or admin, and the database does
 * not hold it to the logo bucket the settings action checks, so a direct update
 * can store any string. react-pdf's <Image src> fetches a URL itself (following
 * redirects) and reads any other string as a file on the server. BrandedHeader
 * and the Book Order Totals header therefore draw nothing but a data: URI
 * (branding.test.tsx, book-order-totals.test.tsx), and every route that reads
 * logo_url for a PDF resolves it through the guarded image fetch first:
 * prefetchPdfLogo, or in Book Order Totals prefetchImagesAsDataUris, which it
 * has used since #291 and which also converts a WebP or AVIF logo to JPEG.
 * A route that skipped this would print no logo; this guard names it.
 */
const WEB = path.resolve(__dirname, '..', '..', '..');

function grep(flags: string, pattern: string): string[] {
  try {
    return execFileSync('grep', [flags, pattern, 'src/app'], { cwd: WEB, encoding: 'utf8' })
      .split('\n')
      .filter(Boolean);
  } catch {
    return []; // grep exits 1 when nothing matches
  }
}

describe('PDF routes and the organization logo', () => {
  it('every route that reads logo_url for a PDF resolves it to bytes first', () => {
    const pdfRoutes = new Set(
      grep('-rlF', "from '@react-pdf/renderer'").filter((f) => !/\.test\.tsx?$/.test(f)),
    );
    const readingLogo = grep('-rlF', 'logo_url').filter((f) => pdfRoutes.has(f));
    // The seven branded PDFs; the scan must not come back empty.
    expect(readingLogo.length).toBeGreaterThanOrEqual(7);
    const resolving = new Set([
      ...grep('-rlF', 'prefetchPdfLogo('),
      ...grep('-rlF', "prefetchImagesAsDataUris([['logo',"),
    ]);
    const missing = readingLogo.filter((file) => !resolving.has(file));
    expect(missing, 'these routes read logo_url but do not fetch it as bytes').toEqual([]);
  });
});
