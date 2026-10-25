// @vitest-environment node
// Node, not a DOM: a browser-like Request drops the header names a page may
// not set (Origin, Sec-Fetch-*), and the server receives them as sent.
import { describe, expect, it } from 'vitest';

import {
  bearerTokenFrom,
  fetchSiteIsElsewhere,
  isCrossSiteBrowserRequest,
  isSameOriginBrowserRequest,
  isWriteMethod,
  refusesCrossSiteCookieWrite,
  sentFromAnotherOrigin,
} from './cross-site-request';

/**
 * Security invariant (docket S14, INV-E5): the one rule for a
 * cookie-authenticated write that a browser did not send from this origin.
 *
 * A request is refused when it carries no Bearer token, its method is a write
 * (anything but GET, HEAD and OPTIONS), and the browser does not say it came
 * from a page on this origin: Sec-Fetch-Site present and not `same-origin`,
 * Origin present and not naming a host this request was addressed to (`null`
 * and unreadable values name none), or NEITHER header present (fail closed:
 * every browser the app supports sends Origin on a write).
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
    expect(refusesCrossSiteCookieWrite(req({ 'sec-fetch-site': 'same-origin', origin: APP }))).toBe(
      false,
    );
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

describe('missing headers (fail closed)', () => {
  // Every browser the app supports (Chrome, Edge and Firefox 111+, Safari
  // 16.4+) sends Origin on any request whose method is not GET or HEAD (the
  // Fetch standard, "append a request Origin header"), so a write with neither
  // header did not come from one of its pages: a client, a proxy or an
  // extension stripped both, and it is refused like a cross-site one.
  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])(
    'a cookie %s with neither header: refused',
    (method) => {
      expect(refusesCrossSiteCookieWrite(req({}, { method }))).toBe(true);
    },
  );

  it('a Bearer write with neither header (the phone): allowed', () => {
    expect(refusesCrossSiteCookieWrite(req({ authorization: 'Bearer t0k3n' }))).toBe(false);
  });

  it.each(['GET', 'HEAD', 'OPTIONS'])(
    'a %s with neither header: allowed (not a write)',
    (method) => {
      expect(refusesCrossSiteCookieWrite(req({}, { method }))).toBe(false);
    },
  );

  it("a same-origin fetch POST (Origin and Sec-Fetch-Site same-origin, the web app's own): allowed", () => {
    expect(refusesCrossSiteCookieWrite(req({ origin: APP, 'sec-fetch-site': 'same-origin' }))).toBe(
      false,
    );
  });

  it('only Sec-Fetch-Site same-origin (a browser or extension that dropped Origin): allowed', () => {
    expect(refusesCrossSiteCookieWrite(req({ 'sec-fetch-site': 'same-origin' }))).toBe(false);
  });

  it('only a matching Origin (plain http to a LAN address, where no browser sends Sec-Fetch-Site): allowed', () => {
    expect(refusesCrossSiteCookieWrite(req({ origin: APP }))).toBe(false);
    const lan = { url: 'http://192.168.1.20:3570/api/v1/things' };
    expect(
      refusesCrossSiteCookieWrite(
        req({ host: '192.168.1.20:3570', origin: 'http://192.168.1.20:3570' }, lan),
      ),
    ).toBe(false);
  });

  it('the two halves: a header saying elsewhere, and a page of this origin proven', () => {
    // Neither header: nothing says elsewhere, and nothing proves this origin.
    expect(isCrossSiteBrowserRequest(req())).toBe(false);
    expect(isSameOriginBrowserRequest(req())).toBe(false);
    expect(isSameOriginBrowserRequest(req({ 'sec-fetch-site': 'same-origin' }))).toBe(true);
    expect(isSameOriginBrowserRequest(req({ origin: APP }))).toBe(true);
    expect(isSameOriginBrowserRequest(req({ origin: APP, 'sec-fetch-site': 'same-site' }))).toBe(
      false,
    );
    expect(
      isSameOriginBrowserRequest(req({ origin: 'null', 'sec-fetch-site': 'same-origin' })),
    ).toBe(false);
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
        req(
          {
            host: '127.0.0.1:3570',
            origin: 'http://127.0.0.1:3570',
            'sec-fetch-site': 'same-origin',
          },
          local,
        ),
      ),
    ).toBe(false);
    // The same server, posted to from a page on another port: refused.
    expect(
      refusesCrossSiteCookieWrite(
        req({ host: '127.0.0.1:3570', origin: 'http://127.0.0.1:3999' }, local),
      ),
    ).toBe(true);
  });

  it('a proxy that names the public host in X-Forwarded-Host (first value)', () => {
    const internal = { url: 'http://internal.local/api/v1/things' };
    expect(
      refusesCrossSiteCookieWrite(
        req(
          { host: 'internal.local', 'x-forwarded-host': 'app.test, proxy.local', origin: APP },
          internal,
        ),
      ),
    ).toBe(false);
    expect(
      refusesCrossSiteCookieWrite(
        req(
          { host: 'internal.local', 'x-forwarded-host': 'proxy.local, app.test', origin: APP },
          internal,
        ),
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
      refusesCrossSiteCookieWrite(
        req({ authorization: 'Bearer ', origin: 'https://evil.example' }),
      ),
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
      refusesCrossSiteCookieWrite(
        req({ origin: APP, 'sec-fetch-site': 'same-origin' }, { method }),
      ),
    ).toBe(false);
  });

  it('a method in another case is the same method (fetch does not normalise "patch")', () => {
    // Request-shaped, because undici warns on constructing a lowercase "patch".
    const lowercase = {
      method: 'patch',
      url: `${APP}/api/v1/things`,
      headers: new Headers(crossSite),
    };
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
    expect(fetchSiteIsElsewhere(req({ 'sec-fetch-site': 'same-origin', origin: 'null' }))).toBe(
      false,
    );
    for (const site of ['same-site', 'cross-site', 'none']) {
      expect(fetchSiteIsElsewhere(req({ 'sec-fetch-site': site })), site).toBe(true);
    }
  });
});

// A GET is never judged by the write rule, so a GET that spends something of
// the person's (their session on /auth/session-ended, their export budget)
// asks this instead: did a page on another origin make the browser send it?
// `none` is the person's own act (a typed address, a bookmark, a link opened
// from another app), which no page can produce, so it is not another origin.
describe('sentFromAnotherOrigin: a page on another origin made this request', () => {
  it.each(['cross-site', 'same-site'])('Sec-Fetch-Site %s: yes, whatever the method', (site) => {
    for (const method of ['GET', 'HEAD', 'POST']) {
      expect(sentFromAnotherOrigin(req({ 'sec-fetch-site': site }, { method })), method).toBe(true);
    }
  });

  it('a top-level navigation, an image and a fetch from another origin are all another origin', () => {
    for (const [mode, dest] of [
      ['navigate', 'document'],
      ['no-cors', 'image'],
      ['no-cors', 'script'],
      ['navigate', 'iframe'],
      ['cors', 'empty'],
    ]) {
      const r = req(
        { 'sec-fetch-site': 'same-site', 'sec-fetch-mode': mode!, 'sec-fetch-dest': dest! },
        { method: 'GET' },
      );
      expect(sentFromAnotherOrigin(r), `${mode} ${dest}`).toBe(true);
    }
  });

  it("same-origin (the app's own page) and none (the person's own act): no", () => {
    expect(sentFromAnotherOrigin(req({ 'sec-fetch-site': 'same-origin' }, { method: 'GET' }))).toBe(
      false,
    );
    expect(sentFromAnotherOrigin(req({ 'sec-fetch-site': 'none' }, { method: 'GET' }))).toBe(false);
  });

  it('no Sec-Fetch-Site (a browser without Fetch Metadata, the phone, a server-side fetch): no', () => {
    expect(sentFromAnotherOrigin(req({}, { method: 'GET' }))).toBe(false);
    // Origin alone does not decide it: a GET navigation carries none, and the
    // write rule above is what judges Origin.
    expect(sentFromAnotherOrigin(req({ origin: 'https://evil.example' }, { method: 'GET' }))).toBe(
      false,
    );
  });

  it('an unknown or empty value: yes (only same-origin and none are this origin or the person)', () => {
    for (const site of ['', 'cross-origin', 'Same-Origin']) {
      expect(sentFromAnotherOrigin(req({ 'sec-fetch-site': site }, { method: 'GET' })), site).toBe(
        true,
      );
    }
  });
});
