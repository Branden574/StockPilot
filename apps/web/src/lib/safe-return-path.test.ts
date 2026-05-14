import { describe, expect, it } from 'vitest';

import { safeReturnPath } from './safe-return-path';

describe('safeReturnPath', () => {
  it('returns the path verbatim for a same-origin dashboard URL', () => {
    expect(safeReturnPath('/dashboard/inventory?q=foo')).toBe(
      '/dashboard/inventory?q=foo',
    );
  });

  it('returns the path for a URL with multiple params', () => {
    expect(
      safeReturnPath('/dashboard/inventory?q=lanyards&sort=name_asc&cat=swag'),
    ).toBe('/dashboard/inventory?q=lanyards&sort=name_asc&cat=swag');
  });

  it('accepts /dashboard/books too', () => {
    expect(safeReturnPath('/dashboard/books?q=harry')).toBe(
      '/dashboard/books?q=harry',
    );
  });

  it('returns null for null / undefined / empty', () => {
    expect(safeReturnPath(null)).toBeNull();
    expect(safeReturnPath(undefined)).toBeNull();
    expect(safeReturnPath('')).toBeNull();
    expect(safeReturnPath('   ')).toBeNull();
  });

  it('rejects cross-origin URLs', () => {
    expect(safeReturnPath('https://evil.com')).toBeNull();
    expect(safeReturnPath('http://evil.com/dashboard/inventory')).toBeNull();
  });

  it('rejects protocol-relative URLs', () => {
    expect(safeReturnPath('//evil.com')).toBeNull();
    expect(safeReturnPath('//evil.com/dashboard/inventory')).toBeNull();
  });

  it('rejects javascript: / data: / file: schemes', () => {
    expect(safeReturnPath('javascript:alert(1)')).toBeNull();
    expect(safeReturnPath('JAVASCRIPT:alert(1)')).toBeNull();
    expect(safeReturnPath('data:text/html,<script>x</script>')).toBeNull();
    expect(safeReturnPath('file:///etc/passwd')).toBeNull();
  });

  it('rejects paths outside /dashboard/', () => {
    expect(safeReturnPath('/admin/secrets')).toBeNull();
    expect(safeReturnPath('/api/auth/logout')).toBeNull();
    expect(safeReturnPath('/')).toBeNull();
  });

  it('rejects URL-encoded protocol-relative escapes', () => {
    expect(safeReturnPath('%2F%2Fevil.com')).toBeNull();
  });

  it('rejects overlong values', () => {
    const long = '/dashboard/inventory?q=' + 'x'.repeat(2100);
    expect(safeReturnPath(long)).toBeNull();
  });

  it('trims surrounding whitespace before validating', () => {
    expect(safeReturnPath('  /dashboard/inventory?q=foo  ')).toBe(
      '/dashboard/inventory?q=foo',
    );
  });
});
