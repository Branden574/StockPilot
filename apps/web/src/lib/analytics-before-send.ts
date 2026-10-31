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
 * So every string in the event, nested bags, element lists and keys included
 * (heatmap points are keyed by page URL), goes through redactCredentialUrls,
 * which replaces only a credential and leaves every other character as it was.
 * A session replay's records are read apart: the page address, a network
 * request's URL, a console line, a custom record; never a snapshot or a
 * mutation, which is the page itself, often compressed into a binary string
 * that any rewrite would break. The provider has switched replay off since
 * docket S22; this part stays for a tab still running an older bundle. An
 * event with no credential comes back as the same object: product analytics
 * is otherwise untouched. `perf_` events are reduced to route templates first
 * (lib/perf/scrub.ts).
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
 * entry in the list (an autocaptured element), and that entry's fields.
 */
const MAX_DEPTH = 4;

/** Where posthog-js puts a session replay's records ($snapshot events). */
const REPLAY_RECORDS_KEY = '$snapshot_data';

/**
 * The rrweb records posthog-js never compresses and that hold no page content:
 * meta (4: the page's URL in `data.href`), custom (5) and plugin (6: a network
 * request by URL, a console line). Snapshots and mutations (2, 3) are the page.
 */
const REPLAY_RECORD_TYPES_READ: ReadonlySet<unknown> = new Set([4, 5, 6]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A replay's records with only the plain ones read; the same array when none changed. */
function scrubReplayRecords(records: unknown): unknown {
  if (!Array.isArray(records)) return records;
  let changed = false;
  const next = records.map((record: unknown) => {
    if (!isRecord(record) || !REPLAY_RECORD_TYPES_READ.has(record.type)) return record;
    const data = scrubValue(record.data, 0);
    if (data === record.data) return record;
    changed = true;
    return { ...record, data };
  });
  return changed ? next : records;
}

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
  let changed = false;
  const entries = Object.entries(value).map(([key, item]) => {
    // A key can be a URL too. Two keys that redact alike keep the later value.
    const nextKey = redactCredentialUrls(key);
    const nextItem =
      key === REPLAY_RECORDS_KEY ? scrubReplayRecords(item) : scrubValue(item, depth + 1);
    if (nextKey !== key || nextItem !== item) changed = true;
    return [nextKey, nextItem] as const;
  });
  return changed ? Object.fromEntries(entries) : value;
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
