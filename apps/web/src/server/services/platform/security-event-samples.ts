import 'server-only';

import { z } from 'zod';

import { reportError } from '@/lib/error-reporter';
import { createAdminClient } from '@/lib/supabase/admin';
import { rawErrorText } from '@/server/services/lib/fetch-by-ids';

import {
  isSecurityEventSamplesCountry,
  isSecurityEventSamplesHour,
  isSecurityProbeKind,
  isStorableSample,
  isStorableTarget,
  SAMPLE_METHODS,
  SECURITY_EVENT_SAMPLES_FAILED,
  SECURITY_EVENT_SAMPLES_LIMIT,
  SECURITY_EVENT_SAMPLES_PAIRS_MAX,
  SECURITY_PROBE_KINDS,
  type SecurityEventSamplesAsk,
  type SecurityEventSamplesResult,
  type SecurityEventSamplesView,
  withEntryBudget,
} from '@stockpilot/core';

/**
 * "WHAT WAS ASKED FOR" ON THE PLATFORM CONSOLE (security tools part 5, stage
 * 3): one read of platform_security_event_samples (migration 0479, CONTRACT.md
 * section 3) for the how-to-respond panel of an exploit-attempt entry: one
 * probe kind and one UTC hour (an entry of the map's feeds or of the Security
 * page's list), or every kind in the last 24 hours (a card opened from the
 * map's legend), with the read's highest limit (review S4: one hour of one
 * kind holds at most 50 listed paths, so a card gets all of them).
 *
 * Read with the service client: the function is granted to service_role
 * only. So this module has no gate of its own, like its sibling platform
 * services, and the file that imports it is the door to the data
 * (security-event-samples.callers.test.ts pins it): the panel's Server Action,
 * which asks checkPlatformConsoleRead() first.
 *
 * Every argument is checked here again (the action checks it first): a kind
 * of the six or none, a whole UTC hour within 7 days or none, two capitals or
 * no country. A bad one reads nothing.
 *
 * "COULD NOT CHECK", NEVER AN EMPTY LIST, for: the function missing (42883,
 * PGRST202), the database's own five-second cancel (57014), a refused
 * privilege (42501), a network error or this read's own time limit, any
 * other error, an answer this build does not know (zod below), a path or
 * query string the table's own rules refuse, and any refused window. Each is
 * reported once, as a warning, with its code only. Nothing here throws.
 *
 * WHAT LEAVES THIS MODULE is core's SecurityEventSamplesView: the paths with
 * their counts, their method and query string pairs, the country when one was
 * asked for, the truncation flags, what the overflow rows counted, and the
 * start of a shortened window. Never an organization, a row's times, an id,
 * the table's totals or anything else of the database's document.
 */

/** How long the read may take before the panel gives up on it. */
export const SECURITY_EVENT_SAMPLES_READ_BUDGET_MS = 6000;

const FN = 'platform_security_event_samples';
const HOUR_MS = 3_600_000;

/* ───────────────────────── the database's answer ───────────────────────── */

const count = (min: number) => z.number().int().min(min).max(Number.MAX_SAFE_INTEGER);
/** A time as Postgres writes a timestamptz into jsonb (with an offset). */
const time = z.string().max(64).datetime({ offset: true });
const reason = z.enum(SECURITY_PROBE_KINDS);

const pair = z
  .object({
    method: z.enum(SAMPLE_METHODS),
    sample: z
      .string()
      .min(1)
      .max(300)
      .refine((s) => isStorableSample(s))
      .nullable(),
    events: count(1),
    last_seen_at: time,
  })
  .strict();

const target = z
  .object({
    reason,
    target: z
      .string()
      .max(200)
      .refine((t) => isStorableTarget(t)),
    events: count(1),
    first_seen_at: time,
    last_seen_at: time,
    samples: z.array(pair).min(1).max(SECURITY_EVENT_SAMPLES_PAIRS_MAX),
    samples_truncated: z.boolean(),
  })
  .strict();

const readWindow = z
  .object({
    window: z.object({ from: time, to: time, asked_from: time }).strict(),
    window_shortened: z.boolean(),
    refused: z.null(),
    generated_at: time,
    oldest_hour: time.nullable(),
    targets: z.array(target).max(SECURITY_EVENT_SAMPLES_LIMIT),
    targets_truncated: z.boolean(),
    listed_targets: count(0),
    listed_events: count(0),
    more_than_listed: z
      .array(z.object({ reason, events: count(1), hours: count(1).max(168) }).strict())
      .max(SECURITY_PROBE_KINDS.length),
  })
  .strict();

const refusedWindow = z
  .object({
    window: z.null(),
    refused: z.string().max(64),
    generated_at: time,
  })
  .strict();

/**
 * The whole answer. A list inside a list (paths, then each path's pairs), so
 * it sits behind an entry budget (zod-array-bounds.guard.test.ts): the largest
 * answer the contract allows holds about 310 list entries and as many objects,
 * so 2,000 refuses only an answer this build does not know.
 */
export const platformSecurityEventSamplesSchema = withEntryBudget(
  z.union([readWindow, refusedWindow]),
  2_000,
);

/* ─────────────────────────────── the read ─────────────────────────────── */

/** The arguments of the call, or null when what was asked is not a read this module makes. */
export function securityEventSamplesArgs(
  ask: SecurityEventSamplesAsk,
  now: number,
): Record<string, string | number | null> | null {
  if (ask.reason !== null && !isSecurityProbeKind(ask.reason)) return null;
  if (ask.country !== null && !isSecurityEventSamplesCountry(ask.country)) return null;
  let from: string | null = null;
  let to: string | null = null;
  if (ask.hour !== null) {
    if (!isSecurityEventSamplesHour(ask.hour, now)) return null;
    const at = Date.parse(ask.hour);
    from = new Date(at).toISOString();
    // The hour running now: "up to now" leaves the end out (the two clocks
    // can disagree by a second near the hour; CONTRACT.md section 3).
    const current = Math.floor(now / HOUR_MS) * HOUR_MS;
    to = at === current ? null : new Date(at + HOUR_MS).toISOString();
  }
  return {
    p_from: from,
    p_to: to,
    p_reason: ask.reason,
    p_category: null,
    p_country: ask.country,
    p_limit: SECURITY_EVENT_SAMPLES_LIMIT,
  };
}

/**
 * One read of what was asked for. Never throws, and never answers the gate's
 * refusal: either the view, or "could not check".
 */
export async function readPlatformSecurityEventSamples(
  ask: SecurityEventSamplesAsk,
  now: number = Date.now(),
): Promise<SecurityEventSamplesResult> {
  const fail = async (
    problem: unknown,
    code: string | null,
  ): Promise<SecurityEventSamplesResult> => {
    await reportError(problem instanceof Error ? problem : new Error(rawErrorText(problem)), {
      tag: `platform.security-event-samples.${FN}`,
      level: 'warning',
      extra: { code },
    });
    return SECURITY_EVENT_SAMPLES_FAILED;
  };
  try {
    const args = securityEventSamplesArgs(ask, now);
    if (args === null) return SECURITY_EVENT_SAMPLES_FAILED;
    const { data, error } = (await createAdminClient()
      // The name as a literal: the guards read every .rpc( call by its name.
      .rpc('platform_security_event_samples', args)
      .abortSignal(AbortSignal.timeout(SECURITY_EVENT_SAMPLES_READ_BUDGET_MS))) as {
      data: unknown;
      error: { message: string; code?: string } | null;
    };
    if (error) {
      const code = typeof error.code === 'string' ? error.code : null;
      if (code === '42883' || code === 'PGRST202') {
        return await fail(
          new Error(`${FN} is not in the database: is migration 0479 applied?`),
          code,
        );
      }
      return await fail(new Error(error.message), code);
    }
    const parsed = platformSecurityEventSamplesSchema.safeParse(data);
    if (!parsed.success) {
      // Where the shape differs, never a value from the answer.
      const where = parsed.error.issues
        .slice(0, 5)
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.code}`)
        .join('; ');
      return await fail(
        new Error(`${FN} answered a shape this build does not know (${where})`),
        null,
      );
    }
    const answer = parsed.data;
    if (answer.window === null) {
      // The console asked for a window the database would not read: its own mistake.
      return await fail(new Error(`${FN} refused the window: ${answer.refused}`), answer.refused);
    }
    const view: SecurityEventSamplesView = {
      country: ask.country,
      windowFrom: answer.window_shortened ? new Date(answer.window.from).toISOString() : null,
      targets: answer.targets.map((t) => ({
        reason: t.reason,
        target: t.target,
        events: t.events,
        pairs: t.samples.map((p) => ({ method: p.method, sample: p.sample, events: p.events })),
        pairsTruncated: t.samples_truncated,
      })),
      targetsTruncated: answer.targets_truncated,
      listedTargets: answer.listed_targets,
      moreThanListed: answer.more_than_listed.map((o) => ({
        reason: o.reason,
        events: o.events,
        hours: o.hours,
      })),
    };
    return { ok: true, view };
  } catch (err) {
    const code =
      err && typeof err === 'object' && 'name' in err && typeof err.name === 'string'
        ? err.name
        : null;
    return await fail(err, code);
  }
}
