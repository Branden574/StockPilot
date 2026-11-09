import { describe, expect, it } from 'vitest';

import {
  diffHeaderLines,
  normaliseHeaders,
  SECURITY_HEADERS,
} from '../../tests/e2e/appearance/stage5a-headers';

/** The plan 8.5 headers rule headers-parity.spec.ts applies on the lab. */

const CSP = (nonce: string) =>
  `default-src 'self'; script-src 'self' 'nonce-${nonce}' 'unsafe-inline'`;

describe('stage 5 headers parity', () => {
  it('normalises the nonce, volatile headers, a cookie’s value and expiry, hashed static paths', () => {
    const a = normaliseHeaders({
      'content-security-policy': CSP('abc123=='),
      date: 'Mon, 09 Nov 2026 10:00:00 GMT',
      etag: '"1"',
      'x-nextjs-cache': 'HIT',
      'set-cookie':
        'sb-access=AAA; Path=/; Max-Age=3600; HttpOnly\nsp_style=classic; Path=/; Expires=Tue, 01 Jan 2030 00:00:00 GMT',
      link: '</_next/static/media/abc.woff2>; rel=preload; as="font"',
    });
    const b = normaliseHeaders({
      'content-security-policy': CSP('zzz999'),
      date: 'Mon, 09 Nov 2026 10:00:05 GMT',
      etag: '"2"',
      'x-nextjs-cache': 'MISS',
      'set-cookie':
        'sp_style=classic; Path=/; Expires=Wed, 02 Jan 2030 00:00:00 GMT\nsb-access=BBB; Path=/; Max-Age=3600; HttpOnly',
      link: '</_next/static/media/def.woff2>; rel=preload; as="font"',
    });
    expect(diffHeaderLines(a, b)).toEqual([]);
  });

  it('fails a changed security header, a lost header and a changed cookie attribute', () => {
    const before = { 'x-frame-options': 'DENY', 'cache-control': 'private, no-store', vary: 'RSC' };
    expect(
      diffHeaderLines(
        normaliseHeaders(before),
        normaliseHeaders({ ...before, 'x-frame-options': 'SAMEORIGIN' }),
      ),
    ).toEqual(['B only:      x-frame-options: DENY', 'branch only: x-frame-options: SAMEORIGIN']);
    const withoutVary = { 'x-frame-options': 'DENY', 'cache-control': 'private, no-store' };
    expect(diffHeaderLines(normaliseHeaders(before), normaliseHeaders(withoutVary))).toEqual([
      'B only:      vary: RSC',
    ]);
    expect(
      diffHeaderLines(
        normaliseHeaders({ 'set-cookie': 'sp_style=classic; Path=/; SameSite=Lax' }),
        normaliseHeaders({ 'set-cookie': 'sp_style=classic; Path=/; SameSite=None' }),
      ),
    ).toHaveLength(2);
  });

  it('keeps only the security and caching set when asked', () => {
    expect(
      normaliseHeaders(
        { 'x-powered-by': 'x', 'strict-transport-security': 'max-age=63072000' },
        SECURITY_HEADERS,
      ),
    ).toEqual(['strict-transport-security: max-age=63072000']);
  });
});
