import 'server-only';

import { createHmac } from 'node:crypto';
import { isIP } from 'node:net';

import { env } from '@/lib/env';

/**
 * The caller's address, read in one place. x-forwarded-for is read only on
 * Vercel, where the platform sets it; elsewhere x-real-ip, else the 'unknown'
 * bucket.
 *
 * Both `clientIpFromRequest` (route handlers, which get a real `Request`)
 * and `clientIpFromHeaders` (Server Components, which only get Next's
 * `headers()` — no `Request` object exists there at all) funnel through
 * this ONE implementation so the VERCEL guard / x-real-ip fallback can't
 * drift between the two call shapes (maintenance share-link brief I4 —
 * `/m/[token]/page.tsx` used to hand-roll its own unguarded XFF parse).
 */
function pickClientIp(headers: { get(name: string): string | null }): string {
  const onVercel = process.env.VERCEL === '1';
  const xff = onVercel ? headers.get('x-forwarded-for') : null;
  return xff?.split(',')[0]?.trim() || headers.get('x-real-ip')?.trim() || 'unknown';
}

export function clientIpFromRequest(req: Request): string {
  return pickClientIp(req.headers);
}

/** `headers()`-shaped twin of `clientIpFromRequest` for Server Components,
 *  which have no `Request` to read — only the awaited `next/headers`
 *  `headers()` result (a `ReadonlyHeaders`, which satisfies this shape). */
export function clientIpFromHeaders(headers: { get(name: string): string | null }): string {
  return pickClientIp(headers);
}

/**
 * The same address for a stored record: an audit row (audit_logs.ip is inet),
 * a device row (user_login_devices.last_ip), a new-device email. The one rule
 * above, then null for anything that is not an IP literal: the limiter's
 * 'unknown' bucket, or a header value that is not an address, which the inet
 * column would refuse (22P02) and lose the row with it. An IPv6 zone id
 * ("fe80::1%eth0") passes isIP but not inet, so a '%' is refused too.
 */
export function clientIpForRecord(headers: { get(name: string): string | null }): string | null {
  return ipForRecord(pickClientIp(headers));
}

/**
 * An address already in hand, in the form a stored record takes: the value
 * when it is an IP literal inet accepts, else null. The audit writer applies
 * it to every row as the last step before the insert, whoever shaped the row.
 */
export function ipForRecord(ip: string | null | undefined): string | null {
  if (typeof ip !== 'string') return null;
  return isIP(ip) && !ip.includes('%') ? ip : null;
}

// ── Place and source, for the security-events record ────────────────────────
// The two functions below are what server/security/events.ts stores about the
// caller of a refused request: a country and city, and a keyed hash of the
// address. The address itself never leaves this file through them.

/** Where a request came from, as Vercel's edge names it; null when unknown. */
export interface ClientPlace {
  country: string | null;
  city: string | null;
}

/** The most characters a stored city may have (the table's own check). */
const CITY_MAX_CHARACTERS = 80;
/**
 * Characters a stored city never holds: control characters (C0, DEL, C1, as
 * the table's [[:cntrl:]] check refuses), the line and paragraph separators,
 * and the bidirectional controls, which could reorder the text around a city
 * on an admin's page.
 */
const CITY_REFUSED = /[\u0000-\u001F\u007F-\u009F\u2028\u2029\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/u;

function countryOf(raw: string | null): string | null {
  return raw !== null && /^[A-Z]{2}$/.test(raw) ? raw : null;
}

/** Vercel's two place headers: read by clientPlaceFromHeaders, answered by placeOnlyHeaders. */
const COUNTRY_HEADER = 'x-vercel-ip-country';
const CITY_HEADER = 'x-vercel-ip-city';

/** Vercel sends the city percent-encoded (UTF-8); anything malformed is no city. */
function cityOf(raw: string | null): string | null {
  if (raw === null) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null;
  }
  const city = decoded.trim();
  if (city.length === 0 || CITY_REFUSED.test(city)) return null;
  // Characters as the database counts them (code points, char_length).
  if ([...city].length > CITY_MAX_CHARACTERS) return null;
  return city;
}

/**
 * The caller's country (two capital letters) and city, from Vercel's
 * x-vercel-ip-country and x-vercel-ip-city. Read only on Vercel, by the same
 * trust rule as the address above: elsewhere anyone could send those headers,
 * so there is no place. A value that fails its rule is null on its own.
 */
export function clientPlaceFromHeaders(headers: { get(name: string): string | null }): ClientPlace {
  if (process.env.VERCEL !== '1') return { country: null, city: null };
  return {
    country: countryOf(headers.get(COUNTRY_HEADER)),
    city: cityOf(headers.get(CITY_HEADER)),
  };
}

/**
 * A header reader that names only a place already read, as Vercel's edge would
 * send it (part 3, sign-in alerts). The security events recorder reads the
 * place from headers; a sign-in alert's event carries the SIGN-IN's place,
 * not the place of whoever presses a button later. It answers the two place
 * headers and nothing else, so it carries no address and gives no source
 * hash, and the place reads back through clientPlaceFromHeaders' own rules
 * (only on Vercel). Kept here so the header names stay in this one file.
 */
export function placeOnlyHeaders(place: ClientPlace): { get(name: string): string | null } {
  const country = typeof place.country === 'string' ? place.country : null;
  const city = typeof place.city === 'string' ? encodeURIComponent(place.city) : null;
  return {
    get(name: string): string | null {
      const key = name.toLowerCase();
      if (key === COUNTRY_HEADER) return country;
      if (key === CITY_HEADER) return city;
      return null;
    },
  };
}

/** Names this hash's purpose and version in its day key, so the key serves nothing else. */
const SOURCE_HASH_CONTEXT = 'security-events/source/v1/';

/**
 * The eight 16-bit groups of an IPv6 address written in any of its forms:
 * zero compression (`::`, once, standing for one group or more), leading
 * zeros, either case, and a dotted IPv4 tail in place of the last two groups.
 * Null for anything else. No zone id and no brackets: the caller removes them.
 */
function ipv6Groups(text: string): number[] | null {
  let address = text;
  const lastColon = address.lastIndexOf(':');
  const tail = address.slice(lastColon + 1);
  if (tail.includes('.')) {
    if (lastColon === -1 || !/^[0-9]{1,3}(?:\.[0-9]{1,3}){3}$/.test(tail)) return null;
    const bytes = tail.split('.').map(Number);
    if (bytes.some((b) => b > 255)) return null;
    const high = ((bytes[0]! << 8) | bytes[1]!).toString(16);
    const low = ((bytes[2]! << 8) | bytes[3]!).toString(16);
    address = `${address.slice(0, lastColon + 1)}${high}:${low}`;
  }
  const halves = address.split('::');
  if (halves.length > 2) return null;
  const groupsOf = (half: string): number[] | null => {
    if (half === '') return [];
    const groups: number[] = [];
    for (const group of half.split(':')) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
      groups.push(Number.parseInt(group, 16));
    }
    return groups;
  };
  const head = groupsOf(halves[0]!);
  const rest = halves.length === 2 ? groupsOf(halves[1]!) : [];
  if (head === null || rest === null) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const compressed = 8 - head.length - rest.length;
  if (compressed < 1) return null;
  return [...head, ...new Array<number>(compressed).fill(0), ...rest];
}

/**
 * What ONE SOURCE is, for the hash below, from an address as a header gives
 * it. Null when the text is not an address.
 *
 *   - IPv4: the whole address.
 *   - IPv6: the first 64 bits, written one way (`2001:db8:1:2::/64`). One
 *     IPv6 customer usually holds a whole /64 and can send each request from
 *     a different address in it; counted per address, such a caller would
 *     never be seen twice. However the address is written (zero compression,
 *     leading zeros, capital letters, brackets with or without a port, a
 *     zone id) the same 64 bits give the same text.
 *   - An IPv4-mapped IPv6 address (::ffff:a.b.c.d) is its IPv4 address: it is
 *     the same caller, and every mapped address shares one /64.
 */
function sourceOfAddress(raw: string): string | null {
  let text = raw.trim();
  let ipv6Only = false;
  if (text.startsWith('[') || text.endsWith(']')) {
    // [address] or [address]:port, the form a URL or a proxy gives IPv6.
    const bracketed = /^\[([^[\]]*)\](?::[0-9]{1,5})?$/.exec(text);
    if (!bracketed) return null;
    text = bracketed[1]!;
    ipv6Only = true;
  }
  const zoneAt = text.indexOf('%');
  if (zoneAt !== -1) {
    // A zone id names an interface of the machine that saw the address; it
    // is no part of the address.
    if (!/^[0-9A-Za-z._-]{1,64}$/.test(text.slice(zoneAt + 1))) return null;
    text = text.slice(0, zoneAt);
    ipv6Only = true;
  }
  const version = isIP(text);
  if (version === 4) return ipv6Only ? null : text;
  if (version !== 6) return null;
  const groups = ipv6Groups(text);
  if (groups === null) return null;
  const mapped = groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff;
  if (mapped) {
    const high = groups[6]!;
    const low = groups[7]!;
    return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
  }
  return `${groups
    .slice(0, 4)
    .map((g) => g.toString(16))
    .join(':')}::/64`;
}

/**
 * A keyed hash of the caller's source (32 hex), to group events from one
 * source within one UTC day: HMAC-SHA256 of the source under the day's key,
 * where the day key is HMAC-SHA256(CRON_SECRET, SOURCE_HASH_CONTEXT +
 * 'YYYY-MM-DD'). A source is a whole IPv4 address, or the first 64 bits of
 * an IPv6 address (sourceOfAddress above). The same source on the same day
 * hashes the same; on another day, or under another secret, it does not.
 *
 * THE KEY IS DERIVED FROM A SERVER SECRET, CRON_SECRET, AND THE HASH IS
 * EXACTLY AS STRONG AS THAT SECRET. It was derived from an existing secret so
 * there is no new key to keep; a rotated CRON_SECRET only stops linking
 * across the rotation. There are few enough addresses to try every one, so
 * what keeps a stored hash from being turned back into an address is the
 * secret alone: someone who holds a hash and knows the source and day it
 * came from can test guesses of the secret against it without asking this
 * server anything. A long random secret makes that hopeless; a short or
 * guessable one would give away both the addresses behind the hashes and the
 * credential the cron routes accept. Keep CRON_SECRET long and random.
 *
 * Null when there is no CRON_SECRET, or the address (the one rule at the top
 * of this file) is not an IP address (the limiter's 'unknown' bucket, a
 * malformed header).
 */
export function clientSourceHash(
  headers: { get(name: string): string | null },
  now: Date = new Date(),
): string | null {
  const source = sourceOfAddress(pickClientIp(headers));
  if (!source || !Number.isFinite(now.getTime())) return null;
  let secret: string;
  try {
    secret = env.CRON_SECRET ?? '';
  } catch {
    return null;
  }
  if (!secret) return null;
  const day = now.toISOString().slice(0, 10);
  const dayKey = createHmac('sha256', secret).update(SOURCE_HASH_CONTEXT + day).digest();
  return createHmac('sha256', dayKey).update(source).digest('hex').slice(0, 32);
}
