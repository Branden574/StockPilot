import 'server-only';

import { lookup } from 'node:dns/promises';
import net from 'node:net';

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
 * Use:
 *   await assertSafeFetchUrl(rawUrl);
 *   const res = await fetch(rawUrl);
 *
 * The check resolves DNS and validates EVERY returned address — DNS
 * rebinding (a hostname that returns a public IP at validate time
 * and a private IP at fetch time) is partially mitigated by callers
 * who pass `lookup` to fetch's underlying agent. For this codebase
 * the threat model is reconnaissance + exfiltration, not full DNS
 * rebinding, so a single resolution check is acceptable.
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
  if (net.isIPv4(hostname) && isV4Private(hostname)) {
    throw new SsrfBlockedError(`private IPv4 literal: ${hostname}`);
  }
  if (net.isIPv6(hostname) && isV6Private(hostname)) {
    throw new SsrfBlockedError(`private IPv6 literal: ${hostname}`);
  }

  // Resolve DNS and reject if any returned address is private.
  if (!net.isIP(hostname)) {
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
  }

  return url;
}
