import 'server-only';

import { z } from 'zod';

import { reportError } from '@/lib/error-reporter';
import { createAdminClient } from '@/lib/supabase/admin';
import { rawErrorText } from '@/server/services/lib/fetch-by-ids';

import {
  SECURITY_EVENT_REASON_RE,
  SECURITY_MAP_CITY_MAX,
  SECURITY_MAP_MAX_BY_COUNTRY,
  SECURITY_MAP_MAX_COUNTED_ROWS,
  SECURITY_MAP_MAX_FEED,
  SECURITY_MAP_MAX_FLAGGED_FEED,
  SECURITY_MAP_MAX_FLOORS,
  SECURITY_MAP_MAX_LATE_SOURCES,
  SECURITY_MAP_MAX_POLL_TIMELINE,
  SECURITY_MAP_MAX_TIMELINE,
  SECURITY_MAP_MAX_WINDOW_HOURS,
  SECURITY_MAP_ORGANIZATION_NAME_MAX,
  SECURITY_MAP_POLL_FAILED,
  SECURITY_MAP_REFUSALS,
  isSecurityMapFloorName,
  readSecurityMapAnswer,
  securityMapViewOf,
  type SecurityMapPollResult,
} from '@stockpilot/core';

/**
 * The platform console's attack map (migration platform_security_map): one
 * read of the security record across every organization and none, for a
 * window, by country and by time.
 *
 * Read with the service client: the function is granted to service_role
 * only. So this module has no gate of its own, like its sibling platform
 * services, and the files that import it are the doors to that data
 * (security-map.callers.test.ts pins them): the map section, which only the
 * gated platform Security page renders, and the Server Action the open page
 * polls, which asks checkPlatformConsoleRead() first.
 *
 * The read has its own time budget, is checked against the contract's shape
 * twice (the zod schema below, and core's plain reader, which must agree),
 * and on any failure (the function missing because the code is ahead of the
 * migration, the database's own five-second cancel, a timeout, a shape this
 * build does not know) is "could not check", reported once. Never an empty
 * map in a failed read's place. Nothing here throws.
 *
 * WHAT LEAVES THIS MODULE is core's view, not the database's document: only
 * what the page draws and says. At the database's caps the document is about
 * 770 KB; the view of the whole window is at most about 90 KB and the view of
 * the last ten minutes at most about 40 KB (security-map.test.ts in core
 * measures both), and far less on any ordinary day. A category the map does
 * not show is in no drawing, no table and no plain feed; its flagged entries
 * are in the flagged list with no category, and its other events are numbers
 * for one line of words. The flagged list carries its organization as the
 * plain feed does (id, name, how many; review M1 reversed by the owner for his
 * console, 2026-11-24) and no source, and every entry's identity is a key core
 * makes here (it already held the organization's id, so it did not change).
 */

/** How long the read may take before the page gives up on it. */
export const SECURITY_MAP_READ_BUDGET_MS = 6000;
/**
 * A read of the whole window slower than this is reported once, as a
 * warning, with its duration and whether the window was shortened: if it
 * happens in production the row ceiling is halved in a later migration.
 */
export const SECURITY_MAP_SLOW_READ_MS = 2500;

/** The live play: a read of the last ten minutes starts this long before now. */
export const SECURITY_MAP_RECENT_MINUTES = 10;

/* ───────────────────────── the database's answer ───────────────────────── */

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
/** A time as Postgres writes a timestamptz into jsonb. */
const time = z
  .string()
  .max(64)
  .refine((v) => Number.isFinite(Date.parse(v)));
const country = z.string().regex(/^[A-Z]{2}$/);
const category = z.enum(['password_guessing', 'exploit', 'bots', 'phishing', 'malware']);
const outcome = z.enum(['blocked', 'flagged', 'allowed']);
const source = z.enum(['web', 'phone', 'api', 'email', 'edge']);
const reason = z.string().regex(SECURITY_EVENT_REASON_RE);
/** At most `max` characters, counted as the database counts them. */
const text = (max: number) =>
  z
    .string()
    .max(max * 2)
    .refine((v) => [...v].length <= max);

const outcomes = z.object({ blocked: count, flagged: count, allowed: count }).strict();
/** Always the five categories, zeros included. */
const byCategory = z
  .object({
    password_guessing: outcomes,
    exploit: outcomes,
    bots: outcomes,
    phishing: outcomes,
    malware: outcomes,
  })
  .strict();
const countedRow = z
  .object({ reason, source, category, outcome, events: count, rows: count })
  .strict();
const feedEntry = z
  .object({
    minute: time,
    category,
    outcome,
    reason,
    source,
    country: country.nullable(),
    city: text(SECURITY_MAP_CITY_MAX).nullable(),
    events: count,
    at_least: z.boolean(),
    organization_id: uuid.nullable(),
    organization_name: text(SECURITY_MAP_ORGANIZATION_NAME_MAX).nullable(),
    organizations: count,
  })
  .strict();

const readWindow = z
  .object({
    window: z.object({ from: time, to: time, live_from: time, asked_from: time }).strict(),
    window_shortened: z.boolean(),
    short_window: z.boolean(),
    refused: z.null(),
    generated_at: time,
    oldest_event_at: time.nullable(),
    timeline: z
      .array(
        z
          .object({
            bucket_start: time,
            bucket_seconds: z.union([z.literal(600), z.literal(60)]),
            country,
            category,
            outcome,
            events: count,
          })
          .strict(),
      )
      .max(SECURITY_MAP_MAX_TIMELINE),
    timeline_truncated: z.boolean(),
    by_country: z
      .array(z.object({ country, category, outcome, events: count }).strict())
      .max(SECURITY_MAP_MAX_BY_COUNTRY),
    by_country_truncated: z.boolean(),
    totals: byCategory,
    no_place: byCategory,
    blocked_window: count,
    flagged_window: count,
    allowed_window: count,
    day_start: time.nullable(),
    blocked_since_day_start: count.nullable(),
    blocked_since_day_start_partial: z.boolean(),
    floors: z
      .array(z.string().refine((name) => isSecurityMapFloorName(name)))
      .max(SECURITY_MAP_MAX_FLOORS),
    feed: z.array(feedEntry).max(SECURITY_MAP_MAX_FEED),
    flagged_feed: z
      .array(feedEntry.refine((entry) => entry.outcome === 'flagged'))
      .max(SECURITY_MAP_MAX_FLAGGED_FEED),
    late_sources: z
      .array(z.object({ source, category, outcome, events: count }).strict())
      .max(SECURITY_MAP_MAX_LATE_SOURCES),
    tallies: z.array(countedRow).max(SECURITY_MAP_MAX_COUNTED_ROWS),
    flood_rows: z.array(countedRow).max(SECURITY_MAP_MAX_COUNTED_ROWS),
  })
  .strict()
  .superRefine((answer, ctx) => {
    const issue = (path: string, message: string) =>
      ctx.addIssue({ code: 'custom', path: [path], message });
    const from = Date.parse(answer.window.from);
    const asked = Date.parse(answer.window.asked_from);
    if (answer.window_shortened !== from > asked)
      issue('window_shortened', 'not as the window says');
    if (from < asked) issue('window', 'read from before the start asked for');
    if (answer.blocked_since_day_start_partial && answer.blocked_since_day_start === null) {
      issue('blocked_since_day_start_partial', 'beside no count');
    }
    if (
      answer.blocked_since_day_start_partial &&
      !answer.floors.includes('blocked_since_day_start')
    ) {
      issue('floors', 'a partial day count that is not a floor');
    }
    // A poll: the live cells only, and no groups by country.
    if (answer.short_window) {
      if (answer.timeline.length > SECURITY_MAP_MAX_POLL_TIMELINE) issue('timeline', 'past a poll');
      if (answer.timeline.some((cell) => cell.bucket_seconds !== 60)) issue('timeline', 'replay');
      if (answer.by_country.length > 0 || answer.by_country_truncated) issue('by_country', 'poll');
    }
  });

/** A window the database would not read: exactly three keys. */
const refusedWindow = z
  .object({ window: z.null(), refused: z.enum(SECURITY_MAP_REFUSALS), generated_at: time })
  .strict();

/** The contract's two shapes (VERSION 2): the twenty-four keys, or the three of a refused window. */
export const platformSecurityMapSchema = z.union([readWindow, refusedWindow]);

/* ─────────────────────────────── the read ─────────────────────────────── */

export interface PlatformSecurityMapRead {
  /**
   * The whole window (the last 24 hours, or from the viewer's midnight on a
   * day whose midnight is more than 24 hours ago), or the last ten minutes.
   */
  scope: 'whole' | 'recent';
  /**
   * The instant the viewer's day began, as an ISO time, for the day's count.
   * Only a read of the whole window can hold it. Null: no day count.
   */
  dayStart: string | null;
}

const FN = 'platform_security_map';

/** The whole window's usual length, and the margin kept under the database's longest window. */
const WHOLE_WINDOW_MS = 24 * 60 * 60_000;
const LONGEST_WINDOW_MARGIN_MS = 60_000;

/**
 * Where the whole window starts: null (the database's default, 24 hours
 * before now) on every day but one. On the day the viewer's clocks go back,
 * their midnight is more than 24 hours before the day's last hour; then the
 * window starts at that midnight, so the day's count can still be counted
 * (up to 26 hours is read; a minute is kept in hand for the clocks of the two
 * machines). A day start that is not a time, or later, changes nothing.
 */
export function securityMapWholeWindowStart(dayStart: string | null, now: number): string | null {
  if (dayStart === null) return null;
  const at = Date.parse(dayStart);
  if (!Number.isFinite(at)) return null;
  const longest = SECURITY_MAP_MAX_WINDOW_HOURS * 60 * 60_000 - LONGEST_WINDOW_MARGIN_MS;
  if (now - at <= WHOLE_WINDOW_MS || now - at > longest) return null;
  return new Date(at).toISOString();
}

/**
 * One read of the map. Never throws, and never answers the gate's refusal:
 * either the view, or a window the database would not read, or "could not
 * check".
 */
export async function readPlatformSecurityMap(
  input: PlatformSecurityMapRead,
  now: number = Date.now(),
): Promise<SecurityMapPollResult> {
  // The read's own time: the call to the database, from sending to its answer or its error.
  const started = performance.now();
  let tookMs: number | null = null;
  const took = () => (tookMs ??= Math.round(performance.now() - started));
  let slowReported = false;
  const reportSlow = async (shortened: boolean | null) => {
    if (input.scope !== 'whole' || slowReported || took() <= SECURITY_MAP_SLOW_READ_MS) return;
    slowReported = true;
    // Only the duration and whether the window was shortened: nothing of the answer.
    await reportError(new Error(`${FN}: a read of the whole window was slow`), {
      tag: 'platform.security-map.slow-read',
      level: 'warning',
      extra: { ms: took(), shortened },
    });
  };
  const fail = async (problem: unknown, code?: string): Promise<SecurityMapPollResult> => {
    took();
    await reportSlow(null);
    await reportError(problem instanceof Error ? problem : new Error(rawErrorText(problem)), {
      tag: `platform.security-map.${FN}`,
      level: 'warning',
      extra: { scope: input.scope, code: code ?? null },
    });
    return SECURITY_MAP_POLL_FAILED;
  };
  try {
    const args =
      input.scope === 'recent'
        ? {
            p_from: new Date(now - SECURITY_MAP_RECENT_MINUTES * 60_000).toISOString(),
            p_to: null,
            p_day_start: null,
          }
        : {
            p_from: securityMapWholeWindowStart(input.dayStart, now),
            p_to: null,
            p_day_start: input.dayStart,
          };
    const { data, error } = (await createAdminClient()
      .rpc('platform_security_map', args)
      .abortSignal(AbortSignal.timeout(SECURITY_MAP_READ_BUDGET_MS))) as {
      data: unknown;
      error: { message: string; code?: string } | null;
    };
    took();
    if (error) {
      if (error.code === 'PGRST202') {
        return await fail(
          new Error(`${FN} is not in the database yet: the code is ahead of the migration`),
          error.code,
        );
      }
      return await fail(new Error(error.message), error.code);
    }
    const parsed = platformSecurityMapSchema.safeParse(data);
    // Core's plain reader is the same contract written a second time.
    const read = readSecurityMapAnswer(data);
    if (!parsed.success) {
      // Where the shape differs, never a value from the answer. Core's reader
      // names the first part that differs (review S6: zod's union names only
      // the root for a key missing or a value of the wrong kind); zod's own
      // places only when core's reader took the answer.
      const where = read.ok
        ? `zod: ${parsed.error.issues
            .slice(0, 5)
            .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.code}`)
            .join('; ')}`
        : read.where;
      return await fail(new Error(`${FN} answered a shape this build does not know (${where})`));
    }
    if (!read.ok) {
      return await fail(new Error(`${FN}: the two readers of the answer disagree (${read.where})`));
    }
    if (read.refused !== null) {
      await reportSlow(null);
      return { ok: true, view: null, refusedWindow: read.refused };
    }
    await reportSlow(read.answer.window_shortened);
    return { ok: true, view: securityMapViewOf(read.answer, input.scope), refusedWindow: null };
  } catch (err) {
    return await fail(err);
  }
}
