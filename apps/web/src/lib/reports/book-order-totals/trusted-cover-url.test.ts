// SSRF: which cover URLs the Book Order Totals report shows or fetches. Only
// this project's signed item-images URLs and https URLs on the book-cover
// allowlist (or its subdomains) pass; anything else is a placeholder.
import { describe, expect, it } from 'vitest';

import { isAllowedCoverHost } from '@/lib/books/cover-hosts';

import { isTrustedCoverUrl } from './trusted-cover-url';

const SUPABASE = 'https://proj.supabase.co';

describe('isTrustedCoverUrl', () => {
  it('trusts a signed item-images URL on the project origin', () => {
    expect(
      isTrustedCoverUrl(
        `${SUPABASE}/storage/v1/object/sign/item-images/o/i/cover.webp?token=t`,
        SUPABASE,
      ),
    ).toBe(true);
  });
  it('refuses other buckets, public paths and other projects', () => {
    expect(
      isTrustedCoverUrl(`${SUPABASE}/storage/v1/object/sign/avatars/o/a.png?token=t`, SUPABASE),
    ).toBe(false);
    expect(
      isTrustedCoverUrl(`${SUPABASE}/storage/v1/object/public/item-images/o/i/c.webp`, SUPABASE),
    ).toBe(false);
    expect(isTrustedCoverUrl(`${SUPABASE}/rest/v1/inventory_items`, SUPABASE)).toBe(false);
    expect(
      isTrustedCoverUrl('https://other.supabase.co/storage/v1/object/sign/item-images/x', SUPABASE),
    ).toBe(false);
  });
  it('trusts https cover hosts and their subdomains, nothing else', () => {
    expect(isTrustedCoverUrl('https://covers.openlibrary.org/b/id/1-L.jpg', SUPABASE)).toBe(true);
    expect(isTrustedCoverUrl('https://ia800000.us.archive.org/x.jpg', SUPABASE)).toBe(true);
    expect(isTrustedCoverUrl('http://covers.openlibrary.org/b/id/1-L.jpg', SUPABASE)).toBe(false);
    expect(isTrustedCoverUrl('https://covers.openlibrary.org.evil.example/x.jpg', SUPABASE)).toBe(
      false,
    );
    expect(isTrustedCoverUrl('https://evilarchive.org/x.jpg', SUPABASE)).toBe(false);
    expect(isTrustedCoverUrl('https://user:pw@covers.openlibrary.org/x.jpg', SUPABASE)).toBe(false);
    expect(isTrustedCoverUrl('http://169.254.169.254/latest/meta-data', SUPABASE)).toBe(false);
    expect(isTrustedCoverUrl('javascript:alert(1)', SUPABASE)).toBe(false);
    expect(isTrustedCoverUrl('', SUPABASE)).toBe(false);
    expect(isTrustedCoverUrl(null, SUPABASE)).toBe(false);
  });
  it("the host rule is the SSRF guard's suffix rule", () => {
    expect(isAllowedCoverHost('ARCHIVE.ORG')).toBe(true);
    expect(isAllowedCoverHost('x.books.google.com')).toBe(true);
    expect(isAllowedCoverHost('google.com')).toBe(false);
  });
});
