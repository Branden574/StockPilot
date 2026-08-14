/**
 * Org timezone helper.
 *
 * The app stores all timestamps as UTC in Postgres (timestamptz).
 * When rendering we pin the locale-aware formatters to the org's
 * operational timezone so a workspace in California sees PT, not the
 * serverless container's UTC or the visiting user's browser zone.
 *
 * Source of truth is the `organizations.timezone` column — settable
 * via /dashboard/settings/organization. Server code reads it through
 * `getCachedOrgTimezone(orgId)` (lib/dashboard/cached-org.ts) and
 * passes the string to the `tz` argument on these helpers. Client
 * components that can't async-fetch fall back to ORG_TIMEZONE_DEFAULT.
 *
 * Why LA as the default fallback: this app shipped against a single
 * California-based pilot org before the per-org tz column was wired
 * up. Defaulting to LA preserves the existing behavior for any caller
 * that hasn't been migrated yet, instead of silently flipping to UTC
 * and rendering "yesterday" dates for late-night exports.
 *
 * MOVED HERE 2026-08-13 (from apps/web/src/lib/timezone.ts), whole and
 * unchanged, because the delivery-request builder needs `formatOrgDateTime`
 * and that builder now serves both web and mobile — and mobile's only
 * workspace dependency is `@stockpilot/core`. Moving ONE function and leaving
 * the other three behind would have been recurring pattern #26 (a duplicated
 * function whose copies drift), so the file moved whole.
 *
 * `apps/web/src/lib/timezone.ts` still exists and re-exports these four names,
 * so all five of its web importers — and, critically, the
 * `vi.mock('@/lib/timezone', ...)` in `schedule-calendar.test.tsx` — keep
 * working untouched. Rewriting those imports to `@stockpilot/core` would have
 * silently defeated that mock.
 *
 * PLATFORM NOTE: these are `Intl`/`toLocaleString`, which is ES-standard and
 * present in Hermes. Hermes ships a REDUCED ICU by default, so a React Native
 * consumer that needs full named-timezone support must be built with
 * `jsc-intl`/full-ICU or polyfilled; that is a build concern for the consuming
 * app, not a reason to keep the formatter in web.
 */
export const ORG_TIMEZONE_DEFAULT = 'America/Los_Angeles';

/**
 * THE ONE EXPRESSION of "what zone do we print when the org's zone did not
 * arrive". Every surface that renders an org-local time must resolve its raw
 * `organizations.timezone` read through THIS, never through a fallback of its
 * own.
 *
 * THE DEFECT THIS CLOSES (2026-08-13). There were two fallbacks, and they
 * disagreed. Web's `getCachedOrgTimezone` returned `row?.timezone || 'UTC'`;
 * mobile's delivery-request mapping used `|| ORG_TIMEZONE_DEFAULT`. The same
 * order therefore stated a different needed-by time on each surface — a Pacific
 * time on the phone and a UTC time on the web — in mail to the same warehouse.
 * Both bodies name their zone, so neither is a lie, but they are 7-8 hours
 * apart and, for any needed-by after 16:00 Pacific, they name a DIFFERENT
 * CALENDAR DAY. Two dates for one delivery is the failure mode, not the
 * cosmetic difference.
 *
 * WHY PACIFIC AND NOT UTC. This is the fallback for a MISSING READ, not for an
 * unconfigured org: `organizations.timezone` is NOT NULL DEFAULT 'UTC', so an
 * org that never touched the setting has a real stored 'UTC' that both surfaces
 * read and agree on, and this function never sees it. What reaches here is the
 * degraded case — the org row missing, an RLS denial, a failed query. Guessing
 * UTC there prints a warehouse delivery time nobody operates on; guessing the
 * documented default prints the zone every org in the database actually uses
 * (all 3, measured 2026-08-13). It is also the value this module has documented
 * as the fallback since it was written, and having a SECOND, quieter answer
 * living in a web helper is exactly the duplicated-decision shape that let the
 * two surfaces drift in the first place.
 *
 * Whitespace is treated as absent: a `'   '` timezone would make
 * `toLocaleString` throw a RangeError, which is a worse outcome than the
 * documented default.
 *
 * AND SO WOULD A NON-EMPTY STRING THIS RUNTIME DOES NOT RECOGNISE (added
 * 2026-08-13). The whitespace note above had the right instinct and too narrow
 * a rule: `'America/Fresno'` is not blank, and it throws exactly the same
 * RangeError. That matters more than a mis-formatted date, because these
 * formatters are called inside React render paths — including a `useMemo` on
 * the native order screen — so one bad `organizations.timezone` row would not
 * mis-render a line, it would throw during render and take the whole screen
 * white. A stored value must never be able to do that.
 *
 * So the check is now what the runtime itself says, not a shape test: if
 * `Intl.DateTimeFormat` accepts the zone, it is usable. That is deliberately
 * runtime-specific — Hermes ships a reduced ICU, so which zones resolve is a
 * property of the engine, not something decidable from a list at build time.
 *
 * IT RETURNS THE ZONE RATHER THAN FORMATTING, so callers can label output with
 * the zone actually USED. Formatting in Pacific while printing
 * "(America/Fresno)" beside it would state a specific, checkable falsehood in
 * mail to a warehouse — a quieter failure than the crash it replaces.
 */
const VALID_TIMEZONES = new Map<string, boolean>();

export function resolveOrgTimezone(raw: string | null | undefined): string {
  const candidate = (typeof raw === 'string' ? raw.trim() : '') || '';
  if (!candidate) return ORG_TIMEZONE_DEFAULT;
  const cached = VALID_TIMEZONES.get(candidate);
  if (cached !== undefined) return cached ? candidate : ORG_TIMEZONE_DEFAULT;
  try {
    // Constructing the formatter is what validates the zone; formatting adds
    // nothing and the result would be discarded.
    new Intl.DateTimeFormat('en-US', { timeZone: candidate });
    VALID_TIMEZONES.set(candidate, true);
    return candidate;
  } catch {
    VALID_TIMEZONES.set(candidate, false);
    return ORG_TIMEZONE_DEFAULT;
  }
}

/** Locale-aware date formatter. Pass the org's tz explicitly via
 *  the third argument when available; falls back to the default. */
export function formatOrgDate(
  input: Date | string | number,
  opts: Intl.DateTimeFormatOptions = {},
  tz: string = ORG_TIMEZONE_DEFAULT,
): string {
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) return '—';
  // Resolved for the same reason as its two siblings below: an unrecognised
  // stored zone must degrade, never throw out of a render.
  return d.toLocaleDateString('en-US', { timeZone: resolveOrgTimezone(tz), ...opts });
}

/** Locale-aware time formatter. */
export function formatOrgTime(
  input: Date | string | number,
  opts: Intl.DateTimeFormatOptions = {},
  tz: string = ORG_TIMEZONE_DEFAULT,
): string {
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleTimeString('en-US', { timeZone: resolveOrgTimezone(tz), ...opts });
}

/** Combined date + time, locale-aware. */
export function formatOrgDateTime(
  input: Date | string | number,
  opts: Intl.DateTimeFormatOptions = {},
  tz: string = ORG_TIMEZONE_DEFAULT,
): string {
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) return '—';
  // Resolved, not passed through: an unrecognised stored zone degrades to the
  // default instead of throwing out of a render.
  return d.toLocaleString('en-US', { timeZone: resolveOrgTimezone(tz), ...opts });
}
