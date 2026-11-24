import {
  isSampleMethod,
  scrubRequestSample,
  scrubRequestTarget,
  type SampleMethod,
} from '@stockpilot/core';

import { probeRuleFor, ruleParamNames } from './probe-match';
import type { ProbeKind, ProbeRule } from './probe-paths';

/**
 * What a scanner asked for, read from a probe request (security tools part 5,
 * stage 3): the scrubbed path, the scrubbed query string as the client sent
 * it, and the method. Never a header value, a body, a cookie or an address.
 * The country is added by the recorder (server/security/event-samples.ts),
 * from the same headers and by the same rule as the security event's.
 *
 * Three locks before anything is kept:
 *   1. THE RE-MATCH (review M2). The path is req.url's pathname: on Vercel
 *      the path the client asked for (measured in production, 3a), never a
 *      query value or a header. The rule Next applies to it must be of the
 *      kind the route was called with; otherwise (the route called directly,
 *      a platform that hands over something else) there is no sample.
 *   2. NEVER SAMPLED (review M1). Nothing under a path that can carry a
 *      capability token or key, whatever rule took it: a link checker or
 *      scanner handed a real link appends scanner names to it
 *      (`/r/<token>/.env`). See NEVER_SAMPLE_PATHS.
 *   3. THE SCRUB (@stockpilot/core request-scrub.ts) of the path and query.
 */

/**
 * The paths under which nothing is sampled: each one can carry a capability
 * token or key in its path or its query, read from the app's route tree
 * (probe-sample.test.ts walks src/app and fails on a route with a token-like
 * part that is under none of them, and pins this list as it is). A path is under an entry when its
 * segments begin with the entry's (case aside, after repeated slashes and
 * dot segments are resolved, at any step of resolving them, decoded or not).
 */
export const NEVER_SAMPLE_PATHS = [
  // Links that carry a token in the path.
  '/r', // public order link, r/[token]; r/confirm and r/track take theirs in the query
  '/m', // maintenance share link, m/[token] and m/[token]/photo/[n]
  '/i', // invite shortcut, i/[token]
  '/invite', // invite, invite/[token]
  '/orders/sign', // signature link, orders/sign/[token]
  '/returns/request', // return request link, returns/request/[token]
  // Links that carry a token or an address in the query.
  '/unsubscribe', // ?m= (member link), ?e= and ?t= (address and its token)
  '/sign-in-alert', // ?a=, ?i= and ?t= (the alert and its tag)
  '/auth', // auth/callback ?code=, auth/confirm ?token_hash= and ?r=
  '/reset', // password reset, reset/complete (the brief's; the link's token goes to /auth)
  '/api/integrations', // the accounting connections' sign-in callbacks: ?code= and ?state=
  // Interfaces called with a key.
  '/api/v1', // the phone app and API keys; orders/submissions/[key]
  '/api/public', // the public API: an organization's key (a header today), never sampled
  '/ingest', // the analytics proxy: the project key rides in its query
] as const;

const NEVER_SAMPLE_SEGMENTS: readonly (readonly string[])[] = NEVER_SAMPLE_PATHS.map((p) =>
  p.split('/').filter(Boolean),
);

/** Undoes escapes up to three times, as the scrubber reads a path; null when one is malformed. */
function decoded(path: string): string | null {
  let out = path;
  for (let i = 0; i < 3; i++) {
    let next: string;
    try {
      next = decodeURIComponent(out);
    } catch {
      return i === 0 ? null : out;
    }
    if (next === out) break;
    out = next;
  }
  return out;
}

/**
 * True when walking `segments` (resolving `.` and `..` as a server does) is
 * ever under a NEVER_SAMPLE_PATHS entry: after every step, not only at the
 * end, so `/x/../r/<token>/../../.env` is under `/r` too.
 */
function everUnder(segments: readonly string[]): boolean {
  const stack: string[] = [];
  const under = () =>
    NEVER_SAMPLE_SEGMENTS.some(
      (entry) => entry.length <= stack.length && entry.every((seg, i) => stack[i] === seg),
    );
  for (const raw of segments) {
    // A matrix part (`/r;x=1/`) is not part of the name.
    const segment = raw.split(';', 1)[0]!.toLowerCase();
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      stack.pop();
      continue;
    }
    stack.push(segment);
    if (under()) return true;
  }
  return false;
}

/**
 * Whether anything of a request to `pathname` may be sampled at all (review
 * M1). False under every NEVER_SAMPLE_PATHS entry, read case aside, with
 * repeated slashes and dot segments resolved, both as sent and with each
 * segment decoded (where an encoded slash or a backslash separates too), and
 * for a path that is not a string or is empty.
 */
export function mayBeSampled(pathname: string): boolean {
  if (typeof pathname !== 'string' || pathname.length === 0) return false;
  const sent = pathname.split('/');
  if (everUnder(sent)) return false;
  // Each segment decoded on its own, so one malformed escape cannot hide
  // the name of another segment.
  const plain = sent.flatMap((segment) => (decoded(segment) ?? segment).split(/[/\\]/));
  return !everUnder(plain);
}

/** The query names Next adds for itself (next/dist/lib/constants: NEXT_QUERY_PARAM_PREFIX, NEXT_INTERCEPTION_MARKER_PREFIX). */
export const NEXT_INTERNAL_QUERY_PREFIXES = ['nxtP', 'nxtI'] as const;

/** A query key as a server reads it (`+` is a space); the text itself when it cannot be decoded. */
function keyName(rawKey: string): string {
  try {
    return decodeURIComponent(rawKey.replace(/\+/g, ' '));
  } catch {
    return rawKey;
  }
}

/**
 * The query string as the client sent it, from req.url's (review M2, 3a):
 * after a rewrite the rule's own parameters (dirs, file, rest, ...: read from
 * the rule's source by ruleParamNames, never typed out) arrive mixed into the
 * query, and Next may add its own `nxtP`/`nxtI` names. Every part whose key is
 * one of those is dropped; the rest is kept as it was sent, in order. A
 * client's own parameter of one of those names is lost with them (said on
 * the page). `search` is URL.search: '' or starting with `?`. Returns the
 * query without its `?`, '' for none.
 */
export function originalQueryOf(search: string, rule: ProbeRule): string {
  const query = search.startsWith('?') ? search.slice(1) : search;
  if (query === '') return '';
  const added = new Set(ruleParamNames(rule.source));
  return query
    .split('&')
    .filter((part) => {
      const name = keyName(part.split('=', 1)[0]!);
      return !added.has(name) && !NEXT_INTERNAL_QUERY_PREFIXES.some((p) => name.startsWith(p));
    })
    .join('&');
}

/** One sample, before the recorder adds the country. */
export interface ProbeSampleInput {
  reason: ProbeKind;
  method: SampleMethod;
  /** isStorableTarget: the scrubbed path, or '(unreadable)'. */
  target: string;
  /** isStorableSample: the scrubbed query string, or null for none. */
  sample: string | null;
}

/**
 * The sample of a probe request for `kind`, or null when none may be kept:
 * the address cannot be read, the method is not one of the seven, the rule
 * Next applies to the path is not of `kind` (or there is none), or the path
 * is under NEVER_SAMPLE_PATHS. Reads the request's address and method only.
 * Never throws.
 */
export function probeSampleOf(
  request: { readonly url: string; readonly method: string },
  kind: ProbeKind,
): ProbeSampleInput | null {
  try {
    const method = request.method;
    if (!isSampleMethod(method)) return null;
    const url = new URL(request.url);
    const pathname = url.pathname;
    const rule = probeRuleFor(pathname);
    if (rule === null || rule.kind !== kind) return null;
    if (!mayBeSampled(pathname)) return null;
    return {
      reason: kind,
      method,
      target: scrubRequestTarget(pathname),
      sample: scrubRequestSample(originalQueryOf(url.search, rule)),
    };
  } catch {
    return null;
  }
}
