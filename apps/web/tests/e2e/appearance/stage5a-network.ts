import { isAppearanceSaveBody } from './switch-requests';

/**
 * Network parity of plan 8.5: "per route, the set of data requests (method,
 * path, body shape) is equal between classic and glass, apart from scene
 * images and the appearance save". Pure, for network-parity.spec.ts; the
 * unit test is src/test/stage5a-network.test.ts.
 *
 * A request becomes one key, `METHOD where body-shape`:
 *  - where: the path for this app's own origin, `<host>/path` for another
 *    host (the lab's Supabase), and the query with Next's `_rsc` cache key
 *    dropped, the rest sorted, and any full ISO time in a value written
 *    `<time>` (a "since" filter carries the moment the page asked);
 *  - a server action adds its id (`action <id>`), an RSC request `rsc`;
 *  - the body shape: JSON as its structure (keys sorted, each value's type,
 *    an array as the shape of its items), a form as its field names, other
 *    text as `text`.
 * Left out (never data): the build's static files, the scene photos
 * (/liquid-glass/...), fonts and icons, analytics and error reporting
 * (PostHog, Sentry and its /monitoring tunnel), data: and blob: URLs, the
 * Design cookie route (POST /api/appearance/style) and the account save
 * (setMyAppearanceAction's body, switch-requests.ts). A router prefetch is
 * kept apart: glass may prefetch only a link Classic's page also holds.
 */

export interface NetRequest {
  method: string;
  url: string;
  /** Lower-case names, as Playwright gives them. */
  headers: Record<string, string>;
  postData: string | null;
}

export type Verdict =
  | { kind: 'ignore'; why: string }
  | { kind: 'prefetch'; path: string }
  | { kind: 'data'; key: string };

const ISO_TIME = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?/gu;

/** The structure of a JSON value: what classic and glass must send alike. */
export function jsonShape(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) {
    const items = [...new Set(value.map(jsonShape))].sort();
    return `[${items.join('|')}]`;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${jsonShape(v)}`);
    return `{${entries.join(',')}}`;
  }
  return typeof value;
}

/** A request body's shape (see the header). */
export function bodyShape(body: string | null, contentType: string | undefined): string {
  if (body === null || body === '') return '-';
  try {
    return jsonShape(JSON.parse(body));
  } catch {
    /* not JSON */
  }
  if (contentType?.includes('application/x-www-form-urlencoded')) {
    return `form(${[...new Set([...new URLSearchParams(body).keys()])].sort().join(',')})`;
  }
  if (contentType?.includes('multipart/form-data')) {
    const names = [...body.matchAll(/name="([^"]+)"/gu)].map((m) => m[1]!);
    return `multipart(${[...new Set(names)].sort().join(',')})`;
  }
  return 'text';
}

function where(url: URL, appOrigin: string): string {
  const params = [...url.searchParams.entries()]
    .filter(([key]) => key !== '_rsc')
    .map(([key, value]) => `${key}=${value.replace(ISO_TIME, '<time>')}`)
    .sort();
  const query = params.length ? `?${params.join('&')}` : '';
  const host = url.origin === appOrigin ? '' : url.host;
  return `${host}${url.pathname}${query}`;
}

/** What one request is, for the parity comparison. */
export function classifyRequest(request: NetRequest, appOrigin: string): Verdict {
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return { kind: 'ignore', why: 'not a URL' };
  }
  if (url.protocol === 'data:' || url.protocol === 'blob:')
    return { kind: 'ignore', why: 'inline' };
  if (/posthog|sentry/iu.test(url.hostname)) return { kind: 'ignore', why: 'analytics' };
  const method = request.method.toUpperCase();
  const own = url.origin === appOrigin;
  if (own) {
    const path = url.pathname;
    if (path === '/monitoring' || path.startsWith('/monitoring/') || path.startsWith('/ingest'))
      return { kind: 'ignore', why: 'analytics' };
    if (path.startsWith('/_next/static/')) return { kind: 'ignore', why: 'static' };
    if (path.startsWith('/liquid-glass/')) return { kind: 'ignore', why: 'scene image' };
    if (/^\/(icon|apple-icon|favicon|manifest)\b/u.test(path) || /\.(woff2?|ttf|otf)$/u.test(path))
      return { kind: 'ignore', why: 'icon or font' };
    if (method === 'POST' && path === '/api/appearance/style')
      return { kind: 'ignore', why: 'the Design cookie route' };
    const action = request.headers['next-action'];
    if (method === 'POST' && action && isAppearanceSaveBody(request.postData))
      return { kind: 'ignore', why: 'the appearance save' };
    if (request.headers['next-router-prefetch']) return { kind: 'prefetch', path };
    const tag = action ? ` action ${action}` : request.headers.rsc ? ' rsc' : '';
    return {
      kind: 'data',
      key: `${method} ${where(url, appOrigin)}${tag} ${bodyShape(
        request.postData,
        request.headers['content-type'],
      )}`,
    };
  }
  return {
    kind: 'data',
    key: `${method} ${where(url, appOrigin)} ${bodyShape(request.postData, request.headers['content-type'])}`,
  };
}

export interface ParityResult {
  onlyClassic: string[];
  onlyGlass: string[];
  /** Glass prefetches of a path no Classic link named. */
  strayPrefetches: string[];
}

/**
 * Compares the data requests of one route's load in Classic and in Liquid
 * Glass, as sets (a request repeated by a retry is the same request).
 * `classicLinkPaths` are the paths of the links Classic's page held.
 */
export function compareLoads(
  classic: readonly NetRequest[],
  glass: readonly NetRequest[],
  appOrigin: string,
  classicLinkPaths: Iterable<string>,
): ParityResult {
  const keys = (list: readonly NetRequest[]) => {
    const data = new Set<string>();
    const prefetch = new Set<string>();
    for (const request of list) {
      const verdict = classifyRequest(request, appOrigin);
      if (verdict.kind === 'data') data.add(verdict.key);
      if (verdict.kind === 'prefetch') prefetch.add(verdict.path);
    }
    return { data, prefetch };
  };
  const a = keys(classic);
  const b = keys(glass);
  const links = new Set(classicLinkPaths);
  return {
    onlyClassic: [...a.data].filter((k) => !b.data.has(k)).sort(),
    onlyGlass: [...b.data].filter((k) => !a.data.has(k)).sort(),
    strayPrefetches: [...b.prefetch].filter((p) => !links.has(p) && !a.prefetch.has(p)).sort(),
  };
}
