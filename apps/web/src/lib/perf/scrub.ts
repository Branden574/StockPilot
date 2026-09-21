/**
 * PostHog `before_send` hook for performance events.
 *
 * `rum.ts` builds every `perf_*` event from an allowlist, so what WE put on
 * the event is already safe. This file is about what POSTHOG puts on it: the
 * SDK decorates every event, ours included, with `$current_url`, `$pathname`,
 * `$referrer`, the session's entry URL, the page title and a `$set_once` bag
 * of first-touch URLs. On `/dashboard/inventory/<uuid>?q=<search>` each of
 * those names an item and quotes a search term, and the owner's rule for this
 * telemetry is that it carries route templates and nothing else (performance
 * program 2026-09).
 *
 * So, for an event whose name starts with `perf_`:
 *   - `$current_url` and `$pathname` become the route TEMPLATE;
 *   - every other `$`-prefixed string that looks like a URL or a path (contains
 *     `/`, `http` or `?`) is deleted, together with referrers and titles by
 *     name: a performance chart needs none of them;
 *   - the `$set` / `$set_once` bags get the same treatment one level down.
 *
 * Every other event is returned untouched, the same object: this hook does not
 * get to change product analytics.
 *
 * PURE and TOTAL. No imports beyond the template function, nothing read from
 * `window`, and it never throws: a `before_send` that throws drops the event
 * or, worse, breaks `capture` for the whole page.
 */
import type { CaptureResult } from 'posthog-js';

import { toRouteTemplate } from './route-template';

const PERF_EVENT_PREFIX = 'perf_';

/** Deleted by NAME, whatever they hold. `$session_entry_referrer` and friends match the pattern. */
const ALWAYS_DROP = new Set(['$referrer', '$referring_domain', 'title', '$title']);
const DROP_KEY_PATTERN = /referr|title/i;

function looksLikeUrlOrPath(value: string): boolean {
  return value.includes('/') || value.includes('?') || value.toLowerCase().includes('http');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function shouldDrop(key: string, value: unknown): boolean {
  if (ALWAYS_DROP.has(key)) return true;
  if (!key.startsWith('$')) return false;
  if (DROP_KEY_PATTERN.test(key)) return true;
  return typeof value === 'string' && looksLikeUrlOrPath(value);
}

function scrubBag(bag: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(bag)) {
    if (shouldDrop(key, value)) continue;
    out[key] = value;
  }
  return out;
}

function isPerfEvent(event: unknown): event is CaptureResult {
  try {
    if (!isPlainObject(event)) return false;
    const name: unknown = event.event;
    return typeof name === 'string' && name.startsWith(PERF_EVENT_PREFIX);
  } catch {
    // Cannot even read the name: not ours to touch.
    return false;
  }
}

export function scrubPerfEvent(event: CaptureResult | null): CaptureResult | null {
  if (!isPerfEvent(event)) return event;
  try {
    const next: Record<string, unknown> = { ...event };

    if (isPlainObject(event.properties)) {
      const source: Record<string, unknown> = event.properties;
      const where =
        typeof source.$pathname === 'string' && source.$pathname.length > 0
          ? source.$pathname
          : typeof source.$current_url === 'string' && source.$current_url.length > 0
            ? source.$current_url
            : null;

      const properties: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(source)) {
        if (key === '$current_url' || key === '$pathname') continue;
        if ((key === '$set' || key === '$set_once') && isPlainObject(value)) {
          properties[key] = scrubBag(value);
          continue;
        }
        if (shouldDrop(key, value)) continue;
        properties[key] = value;
      }
      if (where !== null) {
        const route = toRouteTemplate(where);
        properties.$current_url = route;
        properties.$pathname = route;
      }
      next.properties = properties;
    }

    // The SDK also carries the person bags at the top level of the payload.
    if (isPlainObject(event.$set)) next.$set = scrubBag(event.$set);
    if (isPlainObject(event.$set_once)) next.$set_once = scrubBag(event.$set_once);

    return next as unknown as CaptureResult;
  } catch {
    // Only a payload with a throwing getter can get here. The contract is
    // "never throws", and the choice is FAIL CLOSED: returning the input
    // unchanged would ship exactly the raw URLs this file exists to remove,
    // while a lost performance sample costs nothing. This is the one case in
    // which a non-null event becomes null, and it can only be a `perf_` event.
    return null;
  }
}
