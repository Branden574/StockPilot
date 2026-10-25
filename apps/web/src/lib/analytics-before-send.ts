/**
 * PostHog's `before_send` hook for every event (docket B39 review).
 *
 * The SDK decorates each event with the page URL (`$current_url`), the
 * referrer, the first and the session-entry URL (again in the `$set_once`
 * person bag), and on autocapture the clicked element's `href` and its
 * element chain. components/analytics/posthog-provider.tsx keeps PostHog off a
 * page whose PATH is a credential (lib/share-paths.ts), but a credential can
 * sit in another page's URL: the invite page's Sign in link is
 * /signin?redirect=/invite/<token>, and a link Supabase verified itself lands
 * on /signin with a live session in the fragment. Before this hook every event
 * but a `perf_` one went out as the SDK built it (GC 27: never log a share
 * token or a signed URL).
 *
 * So every string in the event, nested bags and element lists included, goes
 * through redactCredentialUrls, which replaces only a credential and leaves
 * every other character as it was. An event with no credential comes back as
 * the same object: product analytics is otherwise untouched. `perf_` events are
 * reduced to route templates first (lib/perf/scrub.ts).
 *
 * TOTAL and FAIL CLOSED. It never throws (a throwing before_send drops the
 * event or breaks capture for the page), and an event it cannot read is
 * dropped rather than sent unread.
 */
import type { CaptureResult } from 'posthog-js';

import { scrubPerfEvent } from '@/lib/perf/scrub';
import { redactCredentialUrls } from '@/lib/redact-urls';

/**
 * How deep the walk goes: the event, its properties, a bag or a list there, an
 * entry in the list (an autocaptured element, or a session-replay record), and
 * that entry's own fields (a replay meta record's `data.href` is the page's
 * URL). A replay snapshot's DOM tree sits deeper and is not walked.
 */
const MAX_DEPTH = 5;

function scrubValue(value: unknown, depth: number): unknown {
  if (typeof value === 'string') return redactCredentialUrls(value);
  if (value === null || typeof value !== 'object' || depth >= MAX_DEPTH) return value;
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item: unknown) => {
      const scrubbed = scrubValue(item, depth + 1);
      if (scrubbed !== item) changed = true;
      return scrubbed;
    });
    return changed ? next : value;
  }
  let copy: Record<string, unknown> | null = null;
  for (const [key, item] of Object.entries(value)) {
    const scrubbed = scrubValue(item, depth + 1);
    if (scrubbed !== item) {
      copy ??= { ...(value as Record<string, unknown>) };
      copy[key] = scrubbed;
    }
  }
  return copy ?? value;
}

/** No credential in any URL the event carries; the same object when there was none. */
export function scrubCredentialUrls(event: CaptureResult | null): CaptureResult | null {
  if (event === null) return null;
  try {
    return scrubValue(event, 0) as CaptureResult;
  } catch {
    return null;
  }
}

/** The hook the provider passes to posthog.init. */
export function scrubAnalyticsEvent(event: CaptureResult | null): CaptureResult | null {
  return scrubCredentialUrls(scrubPerfEvent(event));
}
