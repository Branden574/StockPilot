// @vitest-environment node
// Node, not a DOM: a browser-like Request drops the header names a page may
// not set (Origin, Sec-Fetch-*), and the server receives them as sent.
import { describe, expect, it } from 'vitest';

import {
  bearerTokenFrom,
  fetchSiteIsElsewhere,
  isCrossSiteBrowserRequest,
  isWriteMethod,
  refusesCrossSiteCookieWrite,
} from './cross-site-request';

/**
 * Security invariant (docket S14, INV-E5): the one rule for a
 * cookie-authenticated write that a browser sent from another origin.
 *
 * A request is refused when it carries no Bearer token, its method is a write
 * (anything but GET, HEAD and OPTIONS), and the browser says it came from
 * elsewhere: Sec-Fetch-Site present and not `same-origin`, or Origin present
 * and not naming a host this request was addressed to (`null` and unreadable
 * values name none). A request with neither header is not judged.
 */

const APP = 'https://app.test';

function req(
  headers: Record<string, string> = {},
  { method = 'POST', url = `${APP}/api/v1/things` }: { method?: string; url?: string } = {},
) {
  return new Request(url, { method, headers });
}

describe('the browser says where the write came from', () => {
  it('same-origin (Sec-Fetch-Site and a matching Origin): allowed', () => {
    expect(
      refusesCrossSiteCookieWrite(req({ 'sec-fetch-site': 'same-origin', origin: APP })),
    ).toBe(false);
  });

  it('same-site: a page on a sibling subdomain is refused', () => {
    expect(
      refusesCrossSiteCookieWrite(
        req({ 'sec-fetch-site': 'same-site', origin: 'https://evil.app.test' }),
      ),
    ).toBe(true);
    // The same page in a browser that sends no Sec-Fetch-Site: its Origin.
    expect(refusesCrossSiteCookieWrite(req({ origin: 'https://evil.app.test' }))).toBe(true);
  });

  it('cross-site: refused, by either header alone', () => {
    expect(
      refusesCrossSiteCookieWrite(
        req({ 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' }),
      ),
    ).toBe(true);
    expect(refusesCrossSiteCookieWrite(req({ 'sec-fetch-site': 'cross-site' }))).toBe(true);
    expect(refusesCrossSiteCookieWrite(req({ origin: 'https://evil.example' }))).toBe(true);
  });

  it('none (a request no page made): refused', () => {
    expect(refusesCrossSiteCookieWrite(req({ 'sec-fetch-site': 'none' }))).toBe(true);
  });

  it('Sec-Fetch-Site same-origin but an Origin naming another host: refused', () => {
    expect(
      refusesCrossSiteCookieWrite(
        req({ 'sec-fetch-site': 'same-origin', origin: 'https://evil.example' }),
      ),
    ).toBe(true);
  });

  it('an unknown or empty Sec-Fetch-Site value: refused (only same-origin passes)', () => {
    expect(refusesCrossSiteCookieWrite(req({ 'sec-fetch-site': 'Same-Origin' }))).toBe(true);
    expect(refusesCrossSiteCookieWrite(req({ 'sec-fetch-site': '' }))).toBe(true);
  });
});

describe('missing headers', () => {
  it('neither header: not judged (not a request a page drove)', () => {
    expect(refusesCrossSiteCookieWrite(req())).toBe(false);
    expect(isCrossSiteBrowserRequest(req())).toBe(false);
  });

  it('only Sec-Fetch-Site same-origin: allowed', () => {
    expect(refusesCrossSiteCookieWrite(req({ 'sec-fetch-site': 'same-origin' }))).toBe(false);
  });

  it('only a matching Origin (a browser without Sec-Fetch-Site): allowed', () => {
    expect(refusesCrossSiteCookieWrite(req({ origin: APP }))).toBe(false);
  });
});

describe('an Origin that names no host', () => {
  it('Origin "null" (sandboxed frame, data: URL, cross-origin redirect): refused', () => {
    expect(refusesCrossSiteCookieWrite(req({ origin: 'null' }))).toBe(true);
    // Even beside a same-origin Sec-Fetch-Site: a form on a no-referrer page
    // sends this, and no form in the app posts to a route under this rule.
    expect(
      refusesCrossSiteCookieWrite(req({ 'sec-fetch-site': 'same-origin', origin: 'null' })),
    ).toBe(true);
  });

  it.each([
    ['not a URL', 'not a url'],
    ['an unclosed IPv6 literal', 'http://[::1'],
    ['a scheme with no host', 'file://'],
    ['an empty value', ''],
    ['two origins in one header', `${APP}, https://evil.example`],
  ])('a malformed Origin (%s): refused', (_name, origin) => {
    expect(refusesCrossSiteCookieWrite(req({ origin }))).toBe(true);
  });
});

describe('the host the Origin is compared with', () => {
  it('the port is part of the host; a default port is not', () => {
    expect(refusesCrossSiteCookieWrite(req({ origin: 'https://app.test:8443' }))).toBe(true);
    expect(refusesCrossSiteCookieWrite(req({ origin: 'https://app.test:443' }))).toBe(false);
  });

  it('host names compare without case', () => {
    expect(refusesCrossSiteCookieWrite(req({ origin: 'https://APP.test' }))).toBe(false);
  });

  it('next dev / next start: the URL says localhost, the browser used 127.0.0.1 (its Host header decides)', () => {
    const local = { url: 'http://localhost:3570/api/v1/things' };
    expect(
      refusesCrossSiteCookieWrite(
        req({ host: '127.0.0.1:3570', origin: 'http://127.0.0.1:3570', 'sec-fetch-site': 'same-origin' }, local),
      ),
    ).toBe(false);
    // The same server, posted to from a page on another port: refused.
    expect(
      refusesCrossSiteCookieWrite(req({ host: '127.0.0.1:3570', origin: 'http://127.0.0.1:3999' }, local)),
    ).toBe(true);
  });

  it('a proxy that names the public host in X-Forwarded-Host (first value)', () => {
    const internal = { url: 'http://internal.local/api/v1/things' };
    expect(
      refusesCrossSiteCookieWrite(
        req({ host: 'internal.local', 'x-forwarded-host': 'app.test, proxy.local', origin: APP }, internal),
      ),
    ).toBe(false);
    expect(
      refusesCrossSiteCookieWrite(
        req({ host: 'internal.local', 'x-forwarded-host': 'proxy.local, app.test', origin: APP }, internal),
      ),
    ).toBe(true);
  });

  it('a Host header that is not a host names none', () => {
    const internal = { url: 'http://internal.local/api/v1/things' };
    for (const host of ['app.test/x', 'user@app.test', 'app.test x', ' ']) {
      expect(refusesCrossSiteCookieWrite(req({ host, origin: APP }, internal)), host).toBe(true);
    }
  });
});

describe('a Bearer caller is not judged; nothing else is exempt', () => {
  it('Bearer (the phone) with any Origin and any Sec-Fetch-Site: allowed', () => {
    for (const scheme of ['Bearer', 'bearer', 'BEARER']) {
      expect(
        refusesCrossSiteCookieWrite(
          req({
            authorization: `${scheme} t0k3n`,
            origin: 'https://evil.example',
            'sec-fetch-site': 'cross-site',
          }),
        ),
        scheme,
      ).toBe(false);
    }
  });

  it('a non-Bearer Authorization header (Basic, which a browser can attach on its own) is judged', () => {
    expect(
      refusesCrossSiteCookieWrite(
        req({ authorization: 'Basic dXNlcjpwYXNz', origin: 'https://evil.example' }),
      ),
    ).toBe(true);
    // "Bearer" with no token is not a bearer either: withApiContext reads the cookie.
    expect(
      refusesCrossSiteCookieWrite(req({ authorization: 'Bearer ', origin: 'https://evil.example' })),
    ).toBe(true);
  });

  it('bearerTokenFrom reads exactly what withApiContext authenticates with', () => {
    expect(bearerTokenFrom(req({ authorization: 'Bearer abc' }))).toBe('abc');
    expect(bearerTokenFrom(req({ authorization: 'bearer   abc' }))).toBe('abc');
    expect(bearerTokenFrom(req({ authorization: 'Basic abc' }))).toBeNull();
    expect(bearerTokenFrom(req({ authorization: 'Bearer' }))).toBeNull();
    expect(bearerTokenFrom(req())).toBeNull();
    expect(bearerTokenFrom(undefined)).toBeNull();
  });
});

describe('every method', () => {
  const crossSite = { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' };

  it.each(['GET', 'HEAD', 'OPTIONS'])('%s is not a write: never judged', (method) => {
    expect(refusesCrossSiteCookieWrite(req(crossSite, { method }))).toBe(false);
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('%s cross-site: refused', (method) => {
    expect(refusesCrossSiteCookieWrite(req(crossSite, { method }))).toBe(true);
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('%s same-origin: allowed', (method) => {
    expect(
      refusesCrossSiteCookieWrite(req({ origin: APP, 'sec-fetch-site': 'same-origin' }, { method })),
    ).toBe(false);
  });

  it('a method in another case is the same method (fetch does not normalise "patch")', () => {
    // Request-shaped, because undici warns on constructing a lowercase "patch".
    const lowercase = { method: 'patch', url: `${APP}/api/v1/things`, headers: new Headers(crossSite) };
    expect(refusesCrossSiteCookieWrite(lowercase as Request)).toBe(true);
    expect(isWriteMethod('get')).toBe(false);
    expect(isWriteMethod('Options')).toBe(false);
  });

  it('any other method is a write', () => {
    for (const method of ['PROPFIND', 'MKCOL', 'PURGE', 'REPORT']) {
      expect(isWriteMethod(method), method).toBe(true);
    }
  });
});

describe('fetchSiteIsElsewhere: the Sec-Fetch-Site half on its own', () => {
  it('only a present value other than same-origin', () => {
    expect(fetchSiteIsElsewhere(req())).toBe(false);
    expect(fetchSiteIsElsewhere(req({ 'sec-fetch-site': 'same-origin' }))).toBe(false);
    expect(fetchSiteIsElsewhere(req({ 'sec-fetch-site': 'same-origin', origin: 'null' }))).toBe(false);
    for (const site of ['same-site', 'cross-site', 'none']) {
      expect(fetchSiteIsElsewhere(req({ 'sec-fetch-site': site })), site).toBe(true);
    }
  });
});
