/**
 * THE LINK OF A TAPPED PUSH, PARSED (Phase 3, iPhone push tap).
 *
 * Every notification row is pushed with `data: { link, type }` (migration
 * 0313's dispatch). The link is a WEB path ('/dashboard/orders/<uuid>'), the
 * returns DUAL link ('/dashboard/returns/<rma>?order=/dashboard/orders/<id>'),
 * or, for two backorder types, an absolute https link on the app's own host.
 * This turns it into the native route the notification coordinator opens
 * (notification-intent.ts, notification-intent-host.tsx), or says why it
 * cannot. It is a classifier over the ONE shared table (web-path-rewrite.ts),
 * not a second table.
 *
 * Accepted: a relative path ('/' but not '//'); 'stockpilot://' only in the
 * web-path form 'stockpilot:///dashboard/...'; https only on exactly
 * stockpilotusa.com or www.stockpilotusa.com, with no userinfo and no port.
 * The authority is read with a regex, not `new URL`, so node and Hermes agree.
 * The fragment is dropped. The path must be /dashboard with plain segments: no
 * '%', no dots, no empty segments.
 *
 * ROUTED ON THE PATH. The table's rules are unanchored and the first match
 * wins, so a whole link handed to it can be routed by its QUERY: the
 * inventory page with `?next=/dashboard/orders/<id>` opens that order. The
 * path decides the route; the query is kept only when the table, given it,
 * still answers the same route (the maintenance and Book Order Totals hints,
 * which the table sanitises itself). So the dual link opens the RMA, never the
 * order in its query, and an order link never carries ?focus into /order/<id>.
 *
 * A web page with no native twin (the table's catch-all, '/') is
 * 'unsupported': the tap shows the fallback notice, never a silent Home. A
 * 36-character id in the native route must be a real uuid AND a whole segment
 * of the web path, which catches the unanchored rules cutting a longer segment
 * down to 36 characters.
 */
import { rewriteWebPath, UUID_ONLY } from './web-path-rewrite';

export type NotificationLinkKind = 'none' | 'relative' | 'scheme' | 'https' | 'other';

export type NotificationLinkRejection =
  | 'no-link'
  | 'not-a-string'
  | 'too-long'
  | 'bad-scheme'
  | 'foreign-host'
  | 'malformed'
  | 'not-dashboard'
  | 'unsupported'
  | 'bad-id';

/** The link shapes a producer writes. */
export type FirstPartyKind = 'relative' | 'scheme' | 'https';

export type NotificationTarget =
  | {
      ok: true;
      linkKind: FirstPartyKind;
      /** The native route to push, e.g. '/order/<uuid>'. */
      native: string;
      /** The native route's first segment: 'order', 'returns', 'po', ... */
      routeKind: string;
      /** The route's uuid, when it names one record. */
      resourceId: string | null;
    }
  | { ok: false; linkKind: NotificationLinkKind; reason: NotificationLinkRejection };

/** Longest link a push may carry. */
export const NOTIFICATION_LINK_MAX_LENGTH = 2048;

/** The only hosts an https link may name. */
export const FIRST_PARTY_HOSTS: readonly string[] = ['stockpilotusa.com', 'www.stockpilotusa.com'];

const DASHBOARD_PREFIX = /^\/dashboard(?:\/|$)/;
const DASHBOARD_PATH = /^\/dashboard(?:\/[A-Za-z0-9_-]+)*$/;
const ANY_SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const HTTPS_LINK = /^https:\/\/([^/?#]*)(.*)$/i;
const SCHEME_PREFIX = 'stockpilot://';

function refuse(
  linkKind: NotificationLinkKind,
  reason: NotificationLinkRejection,
): NotificationTarget {
  return { ok: false, linkKind, reason };
}

function kindOf(link: string): NotificationLinkKind {
  if (link.startsWith('/')) return 'relative';
  if (/^stockpilot:/i.test(link)) return 'scheme';
  if (/^https:/i.test(link)) return 'https';
  return 'other';
}

/** Whitespace, a control character or a backslash anywhere. */
function hasUnsafeCharacter(link: string): boolean {
  for (let i = 0; i < link.length; i += 1) {
    const code = link.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f || code === 0x5c) return true;
  }
  return /\s/.test(link);
}

/** The route part of a native path (before any query). */
function routeOf(native: string): string {
  const q = native.indexOf('?');
  return q < 0 ? native : native.slice(0, q);
}

/**
 * The path, query and fragment of the link, from its first '/', or a
 * rejection. Each kind is held to its own first-party shape here.
 */
function locatorOf(
  link: string,
  linkKind: NotificationLinkKind,
): { locator: string; kind: FirstPartyKind } | { reason: NotificationLinkRejection } {
  if (linkKind === 'relative') return { locator: link, kind: 'relative' };
  if (linkKind === 'scheme') {
    if (link.slice(0, SCHEME_PREFIX.length).toLowerCase() !== SCHEME_PREFIX) {
      return { reason: 'malformed' };
    }
    const rest = link.slice(SCHEME_PREFIX.length);
    // stockpilot://order/<id>: a native-form link, which no producer writes.
    if (!rest.startsWith('/')) return { reason: 'unsupported' };
    return { locator: rest, kind: 'scheme' };
  }
  if (linkKind === 'https') {
    const m = HTTPS_LINK.exec(link);
    if (!m) return { reason: 'malformed' };
    const authority = m[1] ?? '';
    const rest = m[2] ?? '';
    if (authority.includes('@')) return { reason: 'malformed' };
    if (!FIRST_PARTY_HOSTS.includes(authority.toLowerCase())) return { reason: 'foreign-host' };
    if (!rest.startsWith('/')) return { reason: 'not-dashboard' };
    return { locator: rest, kind: 'https' };
  }
  return { reason: ANY_SCHEME.test(link) ? 'bad-scheme' : 'malformed' };
}

/**
 * The native destination of a push's `data.link`. Never throws; anything it
 * cannot place is a rejection with a reason (for the fallback notice and the
 * sanitised diagnostics, never shown as Home).
 */
export function parseNotificationLink(raw: unknown): NotificationTarget {
  if (raw === null || raw === undefined || raw === '') return refuse('none', 'no-link');
  if (typeof raw !== 'string') return refuse('none', 'not-a-string');
  const linkKind = kindOf(raw);
  if (raw.length > NOTIFICATION_LINK_MAX_LENGTH) return refuse(linkKind, 'too-long');
  if (hasUnsafeCharacter(raw)) return refuse(linkKind, 'malformed');

  const located = locatorOf(raw, linkKind);
  if ('reason' in located) return refuse(linkKind, located.reason);
  const { locator, kind } = located;
  if (locator.startsWith('//')) return refuse(linkKind, 'malformed');

  const hash = locator.indexOf('#');
  const withoutFragment = hash < 0 ? locator : locator.slice(0, hash);
  const q = withoutFragment.indexOf('?');
  const path = q < 0 ? withoutFragment : withoutFragment.slice(0, q);
  const query = q < 0 ? '' : withoutFragment.slice(q + 1);
  if (!DASHBOARD_PREFIX.test(path)) return refuse(linkKind, 'not-dashboard');
  if (!DASHBOARD_PATH.test(path)) return refuse(linkKind, 'malformed');

  // Route on the path; keep the query only when it leaves the route alone.
  const byPath = rewriteWebPath(path);
  const full = query ? rewriteWebPath(`${path}?${query}`) : byPath;
  const native = routeOf(full) === routeOf(byPath) ? full : byPath;
  const route = routeOf(native);
  if (route === '/' || !route.startsWith('/') || DASHBOARD_PREFIX.test(route)) {
    return refuse(linkKind, 'unsupported');
  }

  const webSegments = path.split('/');
  let resourceId: string | null = null;
  for (const segment of route.split('/')) {
    if (segment.length !== 36) continue;
    if (!UUID_ONLY.test(segment) || !webSegments.includes(segment)) {
      return refuse(linkKind, 'bad-id');
    }
    resourceId = resourceId ?? segment;
  }
  return { ok: true, linkKind: kind, native, routeKind: route.split('/')[1] ?? '', resourceId };
}
