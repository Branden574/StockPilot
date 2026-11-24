import { PROBE_RULES, type ProbeKind } from './probe-paths';

/**
 * Measurement for the scanner-path route (app/api/security/probe/[kind]):
 * on Vercel, can the handler see the ORIGINAL path a scanner asked for, and
 * through which channel? One log line per request answers that with booleans
 * and small counts only. It records nothing new and changes no answer.
 *
 * NEVER in the line: a path, a query string, a header value, an address or any
 * other text a client chose. Header and query NAMES appear only from the fixed
 * lists below, so a client cannot put its own text into the line. A final
 * guard drops the line if any client-sent value could be found in it.
 *
 * Remove after the measurement: set PROBE_MEASURE_ENABLED to false, then delete
 * this file and its call in the route.
 */
export const PROBE_MEASURE_ENABLED = true;

export const PROBE_MEASURE_TAG = 'security.probe.measure';

/**
 * Request headers that might carry the path as it was asked for, before the
 * rewrite. Next sets x-matched-path (and x-invoke-path / x-invoke-query on its
 * own router hop); Vercel's edge may add its own original-path header; the rest
 * are the usual proxy spellings. `referer` is deliberately not here: it is the
 * address of another page and is client-chosen.
 */
export const PATH_HEADERS = [
  'x-matched-path',
  'x-invoke-path',
  'x-vercel-original-path',
  'x-forwarded-uri',
  'x-original-url',
  'x-original-uri',
  'x-rewrite-url',
  'x-nextjs-rewritten-path',
] as const;

/**
 * The header NAMES that may be listed, a fixed set of routing names. Never a
 * name that can carry a person or a credential (see FORBIDDEN_NAME_PART).
 */
export const LISTED_HEADER_NAMES = [
  ...PATH_HEADERS,
  'x-invoke-query',
  'x-nextjs-rewritten-query',
  'x-now-route-matches',
  'x-middleware-rewrite',
  'x-vercel-id',
  'x-vercel-deployment-url',
  'x-forwarded-proto',
  'x-forwarded-host',
  'x-forwarded-port',
] as const;

/** A header name containing any of these is never listed, whatever the list says. */
export const FORBIDDEN_NAME_PART = ['token', 'key', 'secret', 'auth', 'cookie', 'session', 'ip'];

/** The names of the rewrites' own named parameters (lib/security/probe-paths.ts). */
export const REWRITE_PARAM_NAMES = ['dirs', 'file', 'rest', 'wp', 'tool', 'target', 'seg'] as const;

/** The longest header value or path looked at; a longer one is treated as no match. */
const MAX_VALUE_LENGTH = 2048;

// --- A matcher that mirrors the rewrite sources -------------------------------

/**
 * Turns one rewrite source (path-to-regexp 6 syntax as probe-paths.ts uses it:
 * `/:name(pattern)*`, `/:name*`, `/:name(pattern)`, and literal text) into a
 * case-insensitive regular expression with an optional trailing slash, like
 * Next's own. probe-paths... see probe-measure.test.ts: it checks this against
 * Next's two matchers for every kind.
 */
export function sourceToRegExp(source: string): RegExp {
  let out = '';
  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === '/' && source[i + 1] === ':') {
      // A parameter with its "/" prefix.
      i += 2;
      let name = '';
      while (i < source.length && /[A-Za-z0-9_]/.test(source[i]!)) name += source[i++];
      let pattern = '[^/#?]+?';
      if (source[i] === '(') {
        let depth = 0;
        let inClass = false;
        const start = i + 1;
        for (; i < source.length; i++) {
          const c = source[i]!;
          if (c === '\\') {
            i++;
            continue;
          }
          if (inClass) {
            if (c === ']') inClass = false;
            continue;
          }
          if (c === '[') inClass = true;
          else if (c === '(') depth++;
          else if (c === ')' && --depth === 0) break;
        }
        pattern = source.slice(start, i);
        i++;
      }
      const mod = source[i] === '*' || source[i] === '?' || source[i] === '+' ? source[i++] : '';
      if (mod === '*') out += `(?:/(?:${pattern}))*`;
      else if (mod === '+') out += `(?:/(?:${pattern}))+`;
      else if (mod === '?') out += `(?:/(?:${pattern}))?`;
      else out += `/(?:${pattern})`;
    } else {
      out += ch.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
      i++;
    }
  }
  return new RegExp(`^${out}/?$`, 'i');
}

const KIND_MATCHERS: ReadonlyMap<ProbeKind, readonly RegExp[]> = (() => {
  const map = new Map<ProbeKind, RegExp[]>();
  for (const rule of PROBE_RULES) {
    const list = map.get(rule.kind) ?? [];
    list.push(sourceToRegExp(rule.source));
    map.set(rule.kind, list);
  }
  return map;
})();

/** True when `pathname` is accepted by one of this kind's own rewrite sources. */
export function pathMatchesKind(pathname: string, kind: ProbeKind): boolean {
  if (pathname.length === 0 || pathname.length > MAX_VALUE_LENGTH) return false;
  return (KIND_MATCHERS.get(kind) ?? []).some((re) => re.test(pathname));
}

/** A header value read as a path: a full address is cut to its path; query and fragment are dropped. */
function valueAsPath(value: string): string {
  let v = value.trim();
  const scheme = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i.exec(v);
  if (scheme) v = v.slice(scheme[0].length);
  return v.split(/[?#]/, 1)[0] ?? '';
}

// --- The measurement ----------------------------------------------------------

export type ProbeChannel = { present: boolean; matchesKind: boolean };

export type ProbeMeasurement = {
  /** req.url's pathname (the nextUrl pathname is the same string). */
  url: ProbeChannel;
  /** The rewrite's named parameters arriving as query parameters. */
  query: { present: boolean; paramCount: number; paramNames: string[] };
  headers: Record<(typeof PATH_HEADERS)[number], ProbeChannel>;
  headerCount: number;
  headerNames: string[];
};

function isListable(name: string): boolean {
  return !FORBIDDEN_NAME_PART.some((part) => name.includes(part));
}

/** Booleans, small integers and fixed-list names only. Throws if a header accessor throws. */
export function measureProbeChannels(req: Request, kind: ProbeKind): ProbeMeasurement {
  const url = new URL(req.url);
  const queryNames = REWRITE_PARAM_NAMES.filter((n) => url.searchParams.has(n));
  const headers = {} as ProbeMeasurement['headers'];
  for (const name of PATH_HEADERS) {
    const value = req.headers.get(name);
    headers[name] = {
      present: value !== null,
      matchesKind: value !== null && pathMatchesKind(valueAsPath(value), kind),
    };
  }
  const present = new Set<string>();
  let headerCount = 0;
  for (const name of req.headers.keys()) {
    headerCount++;
    present.add(name.toLowerCase());
  }
  return {
    url: { present: url.pathname.length > 0, matchesKind: pathMatchesKind(url.pathname, kind) },
    query: {
      present: queryNames.length > 0,
      paramCount: queryNames.length,
      paramNames: [...queryNames].sort(),
    },
    headers,
    headerCount: Math.min(headerCount, 999),
    headerNames: LISTED_HEADER_NAMES.filter((n) => isListable(n) && present.has(n)).sort(),
  };
}

/**
 * The guard: true when none of the request's own text is in the line (its
 * path, its query string, any query or header value of 3 characters or more).
 */
export function lineIsClean(line: string, req: Request): boolean {
  const seen: string[] = [];
  try {
    const url = new URL(req.url);
    seen.push(url.pathname, url.search);
    for (const value of url.searchParams.values()) seen.push(value);
  } catch {
    return false;
  }
  for (const value of req.headers.values()) seen.push(value);
  // The line's own booleans are not client text: a header whose whole value is
  // "true" or "false" must not silence the measurement.
  return !seen.some(
    (text) => text.length >= 3 && text !== 'true' && text !== 'false' && line.includes(text),
  );
}

/**
 * Writes the one log line. Never throws and never changes the answer: any
 * failure, including a throwing header accessor, writes nothing.
 */
export function logProbeMeasurement(req: Request, kind: ProbeKind): void {
  if (!PROBE_MEASURE_ENABLED) return;
  try {
    const line = JSON.stringify({
      tag: PROBE_MEASURE_TAG,
      kind,
      ...measureProbeChannels(req, kind),
    });
    if (lineIsClean(line, req)) console.info(line);
  } catch {
    // Measurement only: nothing here may change or fail a probe answer.
  }
}
