import 'server-only';

import { headers as currentHeaders } from 'next/headers';

import { clientPlaceFromHeaders, clientSourceHash } from '@/lib/client-ip';
import { reportError } from '@/lib/error-reporter';
import { createAdminClient } from '@/lib/supabase/admin';
import { keepAlive } from '@/server/services/lib/defer';

import {
  isSecurityEventCategory,
  isSecurityEventOutcome,
  isSecurityEventSource,
  SECURITY_EVENT_REASON_RE,
  type SecurityEventCategory,
  type SecurityEventOutcome,
  type SecurityEventSource,
} from '@stockpilot/core';

/**
 * THE RECORDER of the shared security-events record (public.security_events,
 * migration 0472): what the app refused, by category, with the caller's
 * country and city and a keyed hash of their address.
 *
 * NEVER ON THE CALLER'S PATH. recordSecurityEvent never throws and never waits
 * on the database: it reads the place and the hash (lib/client-ip.ts), adds
 * the event to an in-memory buffer of this server instance, and returns. The
 * first event into an empty buffer schedules ONE flush about two seconds
 * later, kept alive past the response (keepAlive, server/services/lib/
 * defer.ts); the flush sends everything waiting in ONE call to
 * record_security_events(jsonb). So a flood costs at most one database call
 * per instance every two seconds, and an ordinary request costs none.
 *
 * THE BUFFER is keyed like the row (category, outcome, reason, source,
 * organization, country, city, source hash, and the UTC minute), with a count.
 * At most MAX_WAITING_KEYS distinct keys wait. Past that, a new key is counted
 * on an over_buffer_cap entry for its category, outcome and source, with no
 * place, organization or hash; an event whose key already waits still adds to
 * it. With 5 categories, 3 outcomes and 5 sources there are at most 75 such
 * entries, so a flush is at most 175 elements, under the writer's 200.
 *
 * A FAILED FLUSH drops its batch: these are counts for admins to read, not
 * records anything depends on, and a retry would hold a growing buffer during
 * an outage. The writer runs one call at a time across every instance (and
 * the retention cron); a call that waits 2 s for its turn ends with 55P03,
 * which is an ordinary failure here: dropped, and reported by the same rule
 * as any other. It is reported at most once per FAILURE_REPORT_INTERVAL_MS per
 * instance (tag security.events_flush_failed, warning), with the database's
 * error code and the number of rows only: never an event's content.
 *
 * SERVER CODE ONLY: `import 'server-only'` and never 'use server'. Exported
 * from a 'use server' module, recordSecurityEvent would be a Server Action:
 * an endpoint anyone could call to write security events in any
 * organization's name (server/security/events.guard.test.ts pins this).
 */

/** What a detector records. The place and the hash come from the request. */
export interface SecurityEventInput {
  category: SecurityEventCategory;
  outcome: SecurityEventOutcome;
  /** A short code, ^[a-z][a-z0-9_]{0,47}$ (packages/core security-events). */
  reason: string;
  source: SecurityEventSource;
  /** The organization the event is about, when it is about one. */
  organizationId?: string | null;
}

/** A reader of request headers: `next/headers`' answer or a Request's headers. */
export type SecurityEventHeaders = { get(name: string): string | null };

/** Delay between the first event into an empty buffer and its flush. */
export const SECURITY_EVENT_FLUSH_DELAY_MS = 2_000;
/** Distinct keys that may wait for a flush; the rest are counted, not listed. */
export const MAX_WAITING_KEYS = 100;
/** A failed flush is reported at most this often per instance. */
export const FAILURE_REPORT_INTERVAL_MS = 10 * 60_000;
/** The writer reads a count of at most six digits. */
const MAX_COUNT = 999_999;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One element of record_security_events' array, as it is sent. */
interface PendingEvent {
  category: SecurityEventCategory;
  outcome: SecurityEventOutcome;
  reason: string;
  source: SecurityEventSource;
  organization_id: string | null;
  country: string | null;
  city: string | null;
  source_hash: string | null;
  count: number;
  /** The newest event folded in, in ms since 1970 (the row's minute and last_seen_at). */
  at_ms: number;
}

let waiting = new Map<string, PendingEvent>();
let overflow = new Map<string, PendingEvent>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let flushDelayMs = SECURITY_EVENT_FLUSH_DELAY_MS;
let lastFailureReportAt: number | null = null;

/** The request's headers, or null outside a request (a script, a cron worker, a test). */
async function headersOfThisRequest(): Promise<SecurityEventHeaders | null> {
  try {
    return await currentHeaders();
  } catch {
    return null;
  }
}

/**
 * Records one security event. Never throws and never waits on the database:
 * the returned promise settles once the event is in the buffer.
 *
 * `headers` are the request's, when the caller has them (a route handler's
 * Request, or headers captured before the response). Without them the
 * request's own are read through `next/headers`; outside a request there are
 * none, and the event has no place and no hash.
 */
export async function recordSecurityEvent(
  event: SecurityEventInput,
  headers?: SecurityEventHeaders | null,
): Promise<void> {
  try {
    if (
      !isSecurityEventCategory(event.category) ||
      !isSecurityEventOutcome(event.outcome) ||
      !isSecurityEventSource(event.source) ||
      typeof event.reason !== 'string' ||
      !SECURITY_EVENT_REASON_RE.test(event.reason)
    ) {
      return;
    }
    const h = headers ?? (await headersOfThisRequest());
    const place = h ? clientPlaceFromHeaders(h) : { country: null, city: null };
    const sourceHash = h ? clientSourceHash(h) : null;
    const organizationId =
      typeof event.organizationId === 'string' && UUID_RE.test(event.organizationId)
        ? event.organizationId.toLowerCase()
        : null;
    add({
      category: event.category,
      outcome: event.outcome,
      reason: event.reason,
      source: event.source,
      organization_id: organizationId,
      country: place.country,
      city: place.city,
      source_hash: sourceHash,
      count: 1,
      at_ms: Date.now(),
    });
  } catch {
    // Never the caller's problem: an event that could not be read is dropped.
  }
}

function keyOf(e: PendingEvent): string {
  return [
    e.category,
    e.outcome,
    e.reason,
    e.source,
    e.organization_id ?? '',
    e.country ?? '',
    e.city ?? '',
    e.source_hash ?? '',
    Math.floor(e.at_ms / 60_000),
  ].join('\u001f');
}

function foldInto(into: PendingEvent, e: PendingEvent): void {
  into.count = Math.min(into.count + e.count, MAX_COUNT);
  into.at_ms = Math.max(into.at_ms, e.at_ms);
}

function add(e: PendingEvent): void {
  const key = keyOf(e);
  const same = waiting.get(key);
  if (same) {
    foldInto(same, e);
  } else if (waiting.size < MAX_WAITING_KEYS) {
    waiting.set(key, e);
  } else {
    const overflowKey = [e.category, e.outcome, e.source].join('\u001f');
    const counted = overflow.get(overflowKey);
    if (counted) {
      foldInto(counted, e);
    } else {
      overflow.set(overflowKey, {
        category: e.category,
        outcome: e.outcome,
        reason: 'over_buffer_cap',
        source: e.source,
        organization_id: null,
        country: null,
        city: null,
        source_hash: null,
        count: e.count,
        at_ms: e.at_ms,
      });
    }
  }
  scheduleFlush();
}

/**
 * One flush per buffer: the first event into an empty buffer starts the
 * timer, and every later event joins it. The flush's promise is handed to
 * keepAlive, so the request that started it keeps the instance running until
 * the events are sent (outside a request there is nothing to outlive).
 */
function scheduleFlush(): void {
  if (flushTimer !== null) return;
  let settle!: () => void;
  const flushed = new Promise<void>((resolve) => {
    settle = resolve;
  });
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushSecurityEvents().then(settle, settle);
  }, flushDelayMs);
  // A script is not held open for a flush; a request is, through keepAlive.
  (flushTimer as { unref?: () => void }).unref?.();
  keepAlive(flushed);
}

/**
 * Sends everything waiting in one record_security_events call, now. Never
 * throws. The timer calls it; a test calls it to flush at once.
 */
export async function flushSecurityEvents(): Promise<void> {
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  const batch = [...waiting.values(), ...overflow.values()];
  waiting = new Map();
  overflow = new Map();
  if (batch.length === 0) return;
  try {
    const admin = createAdminClient();
    const { error } = await admin.rpc('record_security_events', { p_events: batch });
    if (error) reportFlushFailure(error, batch.length);
  } catch (e) {
    reportFlushFailure(e, batch.length);
  }
}

/** At most once per FAILURE_REPORT_INTERVAL_MS: the code and the row count, never the events. */
function reportFlushFailure(failure: unknown, rows: number): void {
  const now = Date.now();
  if (lastFailureReportAt !== null && now - lastFailureReportAt < FAILURE_REPORT_INTERVAL_MS) {
    return;
  }
  lastFailureReportAt = now;
  const code =
    failure && typeof failure === 'object' && 'code' in failure
      ? String((failure as { code: unknown }).code ?? '') || null
      : failure instanceof Error
        ? failure.name
        : null;
  void reportError(new Error('Security events could not be stored'), {
    tag: 'security.events_flush_failed',
    level: 'warning',
    extra: { code, rows },
  });
}

/** Test only: an empty buffer, no timer, no failure reported yet, the default delay. */
export function __resetSecurityEventsForTests(): void {
  if (flushTimer !== null) clearTimeout(flushTimer);
  flushTimer = null;
  waiting = new Map();
  overflow = new Map();
  lastFailureReportAt = null;
  flushDelayMs = SECURITY_EVENT_FLUSH_DELAY_MS;
}

/** Test only: the delay before a scheduled flush. */
export function __setSecurityEventFlushDelayForTests(ms: number): void {
  flushDelayMs = ms;
}

/** Test only: what is waiting, as it would be sent. */
export function __pendingSecurityEventsForTests(): PendingEvent[] {
  return [...waiting.values(), ...overflow.values()].map((e) => ({ ...e }));
}
