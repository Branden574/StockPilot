import 'server-only';

import { lookup } from 'node:dns/promises';
import net from 'node:net';

import { Agent, fetch as undiciFetch } from 'undici';

/**
 * Server-side guard against SSRF (Server-Side Request Forgery) when
 * fetching a URL whose hostname comes from user input. Rejects:
 *
 *   • non-http(s) schemes (file://, gopher://, ftp://, …)
 *   • host parts that resolve to private (RFC-1918), link-local,
 *     loopback, or cloud-metadata IP ranges
 *   • IPv6 equivalents (loopback ::1, ULA fc00::/7, link-local fe80::/10,
 *     IPv4-mapped IPv6 like ::ffff:10.0.0.1, ::ffff:169.254.169.254)
 *   • the AWS / GCP / Alibaba metadata service IPs explicitly
 *
 * Use one of:
 *
 *   await assertSafeFetchUrl(rawUrl);
 *   const res = await fetch(rawUrl);  // legacy path — TOCTOU window
 *
 * — OR, for the hardened path that closes the resolve/fetch race:
 *
 *   const res = await safeFetch(rawUrl, { ... });
 *
 * `safeFetch` resolves the URL's host ONCE through the SSRF guard,
 * pins the resulting IP, and dispatches the HTTP request against that
 * IP with the original Host header intact. This closes the DNS-rebinding
 * TOCTOU gap where a hostname returns a public IP at validate time and
 * a private IP at fetch time. SNI / TLS verification still use the
 * original hostname.
 */

const PRIVATE_V4_CIDRS: Array<[number, number]> = [
  // [network, mask-bits]
  [ipv4ToInt('10.0.0.0'), 8],
  [ipv4ToInt('172.16.0.0'), 12],
  [ipv4ToInt('192.168.0.0'), 16],
  [ipv4ToInt('127.0.0.0'), 8],
  [ipv4ToInt('169.254.0.0'), 16], // link-local + AWS/Alibaba metadata
  [ipv4ToInt('100.64.0.0'), 10], // CGNAT — used by some cloud meshes
  [ipv4ToInt('0.0.0.0'), 8],
  [ipv4ToInt('224.0.0.0'), 4], // multicast
];

const BLOCK_V4_EXACT = new Set<string>([
  '169.254.169.254', // AWS / Alibaba IMDS
  '100.100.100.200', // Alibaba metadata
  '169.254.170.2', // ECS task metadata
]);

function ipv4ToInt(ip: string): number {
  return ip
    .split('.')
    .reduce((acc, oct) => (acc << 8) + Number(oct), 0) >>> 0;
}

function isV4Private(addr: string): boolean {
  if (BLOCK_V4_EXACT.has(addr)) return true;
  const ip = ipv4ToInt(addr);
  for (const [network, bits] of PRIVATE_V4_CIDRS) {
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    if ((ip & mask) === (network & mask)) return true;
  }
  return false;
}

function isV6Private(addr: string): boolean {
  const lower = addr.toLowerCase();
  if (lower === '::1' || lower === '::') return true;
  // Link-local fe80::/10
  if (lower.startsWith('fe80:') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) return true;
  // ULA fc00::/7
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true;
  // IPv4-mapped: ::ffff:a.b.c.d — extract and check the v4 part.
  const mapped = lower.match(/^::ffff:([0-9a-f.:]+)$/);
  if (mapped) {
    const v4 = mapped[1] ?? '';
    if (net.isIPv4(v4)) return isV4Private(v4);
    // IPv4-mapped expressed in colon-hex form — reject conservatively.
    return true;
  }
  return false;
}

export interface SsrfGuardOptions {
  /** When set, the URL's hostname must be in this list (lowercased). */
  hostAllowlist?: ReadonlyArray<string>;
}

export class SsrfBlockedError extends Error {
  constructor(public reason: string) {
    super(`Blocked by SSRF guard: ${reason}`);
    this.name = 'SsrfBlockedError';
  }
}

export async function assertSafeFetchUrl(
  raw: string,
  opts: SsrfGuardOptions = {},
): Promise<URL> {
  const { url } = await resolveSafeUrl(raw, opts);
  return url;
}

/**
 * Like {@link assertSafeFetchUrl}, but also returns the resolved IP —
 * used internally by {@link safeFetch} to pin the connection to the
 * exact address we just validated.
 */
async function resolveSafeUrl(
  raw: string,
  opts: SsrfGuardOptions = {},
): Promise<{ url: URL; address: string; family: 4 | 6 }> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SsrfBlockedError('not a valid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SsrfBlockedError(`disallowed scheme ${url.protocol}`);
  }
  const hostname = url.hostname.toLowerCase();

  if (opts.hostAllowlist && opts.hostAllowlist.length > 0) {
    const ok = opts.hostAllowlist.some(
      (allowed) => hostname === allowed || hostname.endsWith(`.${allowed}`),
    );
    if (!ok) throw new SsrfBlockedError(`host not on allowlist: ${hostname}`);
  }

  // If the URL was given as an IP literal, validate directly.
  if (net.isIPv4(hostname)) {
    if (isV4Private(hostname)) {
      throw new SsrfBlockedError(`private IPv4 literal: ${hostname}`);
    }
    return { url, address: hostname, family: 4 };
  }
  if (net.isIPv6(hostname)) {
    if (isV6Private(hostname)) {
      throw new SsrfBlockedError(`private IPv6 literal: ${hostname}`);
    }
    return { url, address: hostname, family: 6 };
  }

  // Resolve DNS and reject if any returned address is private.
  let addrs: Array<{ address: string; family: number }>;
  try {
    addrs = await lookup(hostname, { all: true });
  } catch (e) {
    throw new SsrfBlockedError(
      `DNS resolution failed for ${hostname}: ${e instanceof Error ? e.message : 'unknown'}`,
    );
  }
  for (const a of addrs) {
    if (a.family === 4 && isV4Private(a.address)) {
      throw new SsrfBlockedError(`${hostname} resolves to private IPv4 ${a.address}`);
    }
    if (a.family === 6 && isV6Private(a.address)) {
      throw new SsrfBlockedError(`${hostname} resolves to private IPv6 ${a.address}`);
    }
  }
  // Pick the first address — pinning ANY one of the validated set is
  // safe (they all passed the private-range check).
  const first = addrs[0];
  if (!first) {
    throw new SsrfBlockedError(`DNS returned no addresses for ${hostname}`);
  }
  return {
    url,
    address: first.address,
    family: first.family === 6 ? 6 : 4,
  };
}

/** Max redirect hops `safeFetch` will follow, each re-validated. */
const MAX_SAFE_REDIRECTS = 5;

/** Does an HTTP status carry a `Location` we should follow? */
function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

/** One pinned-IP request hop (no automatic redirect following). */
async function fetchPinned(
  url: URL,
  address: string,
  init: Parameters<typeof undiciFetch>[1],
): Promise<Response> {
  // undici's connect.lookup uses the callback signature from node:dns
  // (NOT the promise version). We always return the pre-validated IP
  // regardless of hostname, so a rebinder can't slip a different
  // address into the connect.
  const agent = new Agent({
    connect: {
      lookup: (
        _hostname: string,
        _options: unknown,
        cb: (err: NodeJS.ErrnoException | null, address: string, family: number) => void,
      ) => {
        const family = net.isIPv4(address) ? 4 : 6;
        cb(null, address, family);
      },
    },
  });
  try {
    // `redirect: 'manual'` is CRITICAL: undici's default is 'follow', and a
    // followed redirect is NOT re-validated by the SSRF guard. Worse, for an
    // IP-LITERAL Location (e.g. `http://169.254.169.254/`) undici bypasses the
    // pinned `lookup` entirely and connects straight to that literal — so the
    // IP-pin does nothing for redirects. We must intercept every hop ourselves
    // and re-run it through resolveSafeUrl. (See ssrf-guard.test.ts.)
    const res = await undiciFetch(url, { ...init, redirect: 'manual', dispatcher: agent });
    return res as unknown as Response;
  } finally {
    void agent.close().catch(() => {});
  }
}

/**
 * SSRF-hardened fetch. Resolves and validates the URL through the SSRF
 * guard, then pins the connection to the exact IP we resolved so a
 * DNS rebinder can't slip a private IP in between the check and the
 * connect(). The original hostname is preserved for the Host header
 * and for TLS SNI / cert validation.
 *
 * Redirects are followed MANUALLY (up to {@link MAX_SAFE_REDIRECTS} hops) and
 * each `Location` is re-validated through the SSRF guard before the next hop —
 * undici's built-in redirect follow skips that re-check and lets a redirect to
 * a private / metadata IP punch straight through the guard.
 *
 * Implementation: per-request undici `Agent` with a `lookup` override
 * that always returns the validated address. The Agent is closed in a
 * `finally` so we don't leak sockets.
 */
export async function safeFetch(
  raw: string,
  init?: Parameters<typeof undiciFetch>[1] & {
    /** Optional SSRF allowlist of hostnames. */
    hostAllowlist?: ReadonlyArray<string>;
  },
): Promise<Response> {
  const { hostAllowlist, ...rest } = init ?? {};

  // If the caller explicitly opted out of following (or chose error/manual),
  // honour it: validate the first URL, pin, and return whatever comes back.
  const wantsFollow = rest.redirect === undefined || rest.redirect === 'follow';

  let { url, address } = await resolveSafeUrl(raw, { hostAllowlist });
  let body = rest.body;

  for (let hop = 0; ; hop++) {
    const res = await fetchPinned(url, address, { ...rest, body });
    if (!wantsFollow || !isRedirectStatus(res.status)) return res;

    const location = res.headers.get('location');
    if (!location) return res; // redirect with no target — hand it back as-is.
    if (hop >= MAX_SAFE_REDIRECTS) {
      throw new SsrfBlockedError(`too many redirects (>${MAX_SAFE_REDIRECTS})`);
    }

    // Resolve the next hop relative to the current URL, then re-validate it
    // through the FULL SSRF guard (private-IP + allowlist) before connecting.
    let next: string;
    try {
      next = new URL(location, url).toString();
    } catch {
      throw new SsrfBlockedError('redirect Location is not a valid URL');
    }
    ({ url, address } = await resolveSafeUrl(next, { hostAllowlist }));

    // Per fetch semantics, 303 (and 301/302 for non-GET/HEAD historically)
    // turn the follow-up into a bodyless GET. Drop the body so we don't replay
    // a POST payload to a redirected host.
    if (res.status === 303) {
      body = undefined;
      rest.method = 'GET';
    }
  }
}
