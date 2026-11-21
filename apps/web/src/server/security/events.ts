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
  SECURITY_EVENT_CATEGORIES,
  SECURITY_EVENT_OUTCOMES,
  SECURITY_EVENT_REASON_RE,
  SECURITY_EVENT_SOURCES,
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
 * defer.ts); the flush sends everything waiting to
 * record_security_events(jsonb). An ordinary request costs no database call.
 *
 * THE BUFFER is keyed like the row (category, outcome, reason, source,
 * organization, country, city, source hash, and the UTC minute), with a count.
 * An event whose key already waits always adds to it. Who may take room from
 * whom is the point of its shape:
 *   - EVENTS ABOUT NO ORGANIZATION (scanner paths, bots, an unknown email)
 *     wait in one budget of their own, MAX_WAITING_KEYS_WITHOUT_ORGANIZATION
 *     distinct keys. Past it, a new key is counted, not listed, on an
 *     over_buffer_cap entry for its category, outcome and source, with no
 *     place and no hash.
 *   - EACH ORGANIZATION HAS ITS OWN SLICE, MAX_WAITING_KEYS_PER_ORGANIZATION
 *     distinct keys. Past its slice, an organization's events are counted on
 *     that organization's OWN over_buffer_cap entry (category, outcome,
 *     source and the organization). So neither traffic about no organization
 *     nor a flood aimed at one organization can push another organization's
 *     events out of the list its admins read, or onto an entry they cannot
 *     see. The database's writer keeps the same promise one step later (its
 *     minute caps).
 *   - AT MOST MAX_ORGANIZATIONS_PER_WINDOW organizations are tracked between
 *     two flushes, which is what bounds memory. Only an event of one more
 *     organization in the same window is counted on the entry with no
 *     organization. That is not expected to happen, so it is reported (tag
 *     security.events_organization_ceiling, warning, at most once per
 *     FAILURE_REPORT_INTERVAL_MS, the ceiling only: never an organization).
 * THE WORST CASE, with 5 categories, 3 outcomes and 5 sources (75 kinds of
 * overflow entry): 100 organizations x (8 keys + 75 entries) + 50 keys + 75
 * entries = 8,425 small entries (MAX_WAITING_ENTRIES). The organizations'
 * events that detectors write today are all of one kind, which makes the
 * real ceiling 100 x 9 + 125 = 1,025.
 *
 * A FULL SLICE OR BUDGET FLUSHES EARLY: when an organization's slice, the
 * budget of events with no organization, or the tracked organizations fill,
 * the flush is brought forward instead of waiting out the two seconds, so a
 * flood shortens the window instead of stacking events behind it. Two limits
 * keep a flood from setting the database's call rate: never while a call is
 * out, and no sooner than EARLY_FLUSH_MIN_GAP_MS after the last flush began.
 *
 * ONE FLUSH CALL AT A TIME per instance, each with a time limit of its own
 * (FLUSH_CALL_TIMEOUT_MS). The writer reads at most MAX_FLUSH_CALL_ELEMENTS
 * of one call, so a larger flush is sent as several calls of at most that
 * many, one after another, organizations first (the worst case is 43). A
 * flush that finds a call still out leaves its events in the buffer for the
 * next one, and a call that has not answered in time is aborted. So a slow or
 * busy database holds at most one connection per instance for this.
 *
 * A FAILED FLUSH drops its batch, and with it the calls of that flush not yet
 * made: these are counts for admins to read, not records anything depends on,
 * and a retry would hold a growing buffer during an outage. The writer runs
 * one call at a time across every instance (and the retention cron); a call
 * that waits 2 s for its turn ends with 55P03, which is an ordinary failure
 * here, as is a call aborted at its time limit: dropped, and reported by the
 * same rule as any other. It is reported at most once per
 * FAILURE_REPORT_INTERVAL_MS per instance (tag security.events_flush_failed,
 * warning), with the database's error code and the number of rows only: never
 * an event's content.
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
/** Distinct keys ONE organization may have waiting; each organization has its own. */
export const MAX_WAITING_KEYS_PER_ORGANIZATION = 8;
/** Organizations tracked between two flushes; what bounds the buffer's memory. */
export const MAX_ORGANIZATIONS_PER_WINDOW = 100;
/** Distinct keys about no organization that may wait for a flush. */
export const MAX_WAITING_KEYS_WITHOUT_ORGANIZATION = 50;
/** The kinds an overflow entry can be of: one per category, outcome and source (75). */
const OVERFLOW_KINDS =
  SECURITY_EVENT_CATEGORIES.length * SECURITY_EVENT_OUTCOMES.length * SECURITY_EVENT_SOURCES.length;
/**
 * The most entries the buffer can ever hold: every tracked organization with
 * a full slice and every kind of overflow entry, the full budget of events
 * with no organization, and every kind of entry with no organization.
 * 100 x (8 + 75) + 50 + 75 = 8,425.
 */
export const MAX_WAITING_ENTRIES =
  MAX_ORGANIZATIONS_PER_WINDOW * (MAX_WAITING_KEYS_PER_ORGANIZATION + OVERFLOW_KINDS) +
  MAX_WAITING_KEYS_WITHOUT_ORGANIZATION +
  OVERFLOW_KINDS;
/**
 * What record_security_events reads of one call (`limit 200` on its array); a
 * longer array would lose its tail without a word, so a flush is sent in
 * calls of at most this many.
 */
export const MAX_FLUSH_CALL_ELEMENTS = 200;
/**
 * An early flush (a slice or budget filled) starts no sooner than this after
 * the last flush began. Without it a flood would set the call rate: every
 * few keys a new call, as fast as the database answers.
 */
export const EARLY_FLUSH_MIN_GAP_MS = 500;
/** A flush call still out after this long is aborted and counted as failed. */
export const FLUSH_CALL_TIMEOUT_MS = 3_000;
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

/** What one organization has waiting: its slice of listed keys, and its own overflow entries. */
interface OrganizationSlice {
  /** Listed events, by row key; at most MAX_WAITING_KEYS_PER_ORGANIZATION. */
  waiting: Map<string, PendingEvent>;
  /** Counted events past the slice, by category, outcome and source. */
  overflow: Map<string, PendingEvent>;
}

/** The organizations with events waiting; at most MAX_ORGANIZATIONS_PER_WINDOW. */
let organizations = new Map<string, OrganizationSlice>();
/** Listed events about no organization, by row key. */
let waitingWithoutOrganization = new Map<string, PendingEvent>();
/** Counted events with no organization (and the last resort): category, outcome, source. */
let overflow = new Map<string, PendingEvent>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;
/** When the armed timer fires, in ms since 1970; null with no timer. */
let flushDueAt: number | null = null;
/** Settles the kept-alive promise of the events now waiting; null when none is held. */
let settleScheduledFlush: (() => void) | null = null;
/** Whether a flush of this instance still has a record_security_events call to answer or make. */
let flushCallOut = false;
/** When the last flush that sent anything began; null before the first. */
let lastFlushStartedAt: number | null = null;
/** Whether a slice or budget filled since the buffer was last emptied. */
let earlyFlushWanted = false;
let flushDelayMs = SECURITY_EVENT_FLUSH_DELAY_MS;
/** When each kind of report was last sent, by tag. */
let lastReportAt = new Map<string, number>();

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

/** A new entry that counts events past a slice or budget: no place and no hash. */
function overflowEntryFor(e: PendingEvent, organizationId: string | null): PendingEvent {
  return {
    category: e.category,
    outcome: e.outcome,
    reason: 'over_buffer_cap',
    source: e.source,
    organization_id: organizationId,
    country: null,
    city: null,
    source_hash: null,
    count: e.count,
    at_ms: e.at_ms,
  };
}

/** Counts `e` on the entry of its category, outcome and source in `entries`. */
function countOn(entries: Map<string, PendingEvent>, e: PendingEvent, organizationId: string | null): void {
  const kind = [e.category, e.outcome, e.source].join('\u001f');
  const counted = entries.get(kind);
  if (counted) foldInto(counted, e);
  else entries.set(kind, overflowEntryFor(e, organizationId));
}

function add(e: PendingEvent): void {
  const full =
    e.organization_id === null ? addWithoutOrganization(e) : addForOrganization(e, e.organization_id);
  scheduleFlush();
  if (full) flushEarly();
}

/** An event about no organization. True when its budget is now full. */
function addWithoutOrganization(e: PendingEvent): boolean {
  const key = keyOf(e);
  const same = waitingWithoutOrganization.get(key);
  if (same) foldInto(same, e);
  else if (waitingWithoutOrganization.size < MAX_WAITING_KEYS_WITHOUT_ORGANIZATION) {
    waitingWithoutOrganization.set(key, e);
  } else {
    countOn(overflow, e, null);
  }
  return waitingWithoutOrganization.size >= MAX_WAITING_KEYS_WITHOUT_ORGANIZATION;
}

/**
 * An event about an organization: into that organization's own slice, or past
 * it onto that organization's own overflow entry. Nothing here reads or
 * changes another organization's slice. True when the slice, or the number of
 * tracked organizations, is now full.
 */
function addForOrganization(e: PendingEvent, organizationId: string): boolean {
  let slice = organizations.get(organizationId);
  if (!slice) {
    if (organizations.size >= MAX_ORGANIZATIONS_PER_WINDOW) {
      // The last resort, and the only way an organization's event loses its
      // organization: more organizations in one window than are tracked.
      countOn(overflow, e, null);
      reportOrganizationCeiling();
      return true;
    }
    slice = { waiting: new Map(), overflow: new Map() };
    organizations.set(organizationId, slice);
  }
  const key = keyOf(e);
  const same = slice.waiting.get(key);
  if (same) foldInto(same, e);
  else if (slice.waiting.size < MAX_WAITING_KEYS_PER_ORGANIZATION) slice.waiting.set(key, e);
  else countOn(slice.overflow, e, organizationId);
  return (
    slice.waiting.size >= MAX_WAITING_KEYS_PER_ORGANIZATION ||
    organizations.size >= MAX_ORGANIZATIONS_PER_WINDOW
  );
}

/** Everything waiting, in the order it is sent: events about an organization first. */
function pendingEvents(): PendingEvent[] {
  const pending: PendingEvent[] = [];
  for (const slice of organizations.values()) {
    pending.push(...slice.waiting.values(), ...slice.overflow.values());
  }
  pending.push(...waitingWithoutOrganization.values(), ...overflow.values());
  return pending;
}

function hasPendingEvents(): boolean {
  return organizations.size > 0 || waitingWithoutOrganization.size > 0 || overflow.size > 0;
}

function emptyBuffer(): void {
  organizations = new Map();
  waitingWithoutOrganization = new Map();
  overflow = new Map();
  earlyFlushWanted = false;
}

/**
 * One flush per buffer: the first event into an empty buffer starts the
 * timer, and every later event joins it. The flush's promise is handed to
 * keepAlive, so the request that started it keeps the instance running until
 * the events are sent or dropped (outside a request there is nothing to
 * outlive). flushSecurityEvents settles it, whoever calls it.
 */
function scheduleFlush(): void {
  if (flushTimer !== null) return;
  if (settleScheduledFlush === null) {
    const flushed = new Promise<void>((resolve) => {
      settleScheduledFlush = resolve;
    });
    keepAlive(flushed);
  }
  armFlushTimer(flushDelayMs);
}

/** Arms the one flush timer, in place of any already armed. */
function armFlushTimer(delayMs: number): void {
  if (flushTimer !== null) clearTimeout(flushTimer);
  flushDueAt = Date.now() + delayMs;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushDueAt = null;
    // The flush is handed to keepAlive where it starts, as well as being
    // answered for by the promise handed over when it was scheduled
    // (server/fire-and-forget.guard.test.ts: nothing is left running with
    // `void`). flushSecurityEvents never rejects.
    keepAlive(flushSecurityEvents());
  }, delayMs);
  // A script is not held open for a flush; a request is, through keepAlive.
  (flushTimer as { unref?: () => void }).unref?.();
}

/**
 * A slice or budget is full: bring the flush forward. Not while a call is out
 * (the flush that owns it brings the next one forward when it ends), and no
 * sooner than EARLY_FLUSH_MIN_GAP_MS after the last flush began. Never later
 * than the timer already armed.
 */
function flushEarly(): void {
  earlyFlushWanted = true;
  if (flushCallOut) return;
  const now = Date.now();
  const sinceLast = lastFlushStartedAt === null ? Infinity : now - lastFlushStartedAt;
  // A clock that stepped back must not hold the flush longer than the gap.
  const wait = sinceLast < 0 ? EARLY_FLUSH_MIN_GAP_MS : Math.max(0, EARLY_FLUSH_MIN_GAP_MS - sinceLast);
  if (flushTimer !== null && flushDueAt !== null && flushDueAt <= now + wait) return;
  armFlushTimer(wait);
}

/** The flush call did not answer within FLUSH_CALL_TIMEOUT_MS. */
class FlushTimeout extends Error {
  readonly code = 'flush_timeout';
  constructor() {
    super('record_security_events did not answer in time');
    this.name = 'FlushTimeout';
  }
}

/**
 * Sends everything waiting to record_security_events, now, in calls of at
 * most MAX_FLUSH_CALL_ELEMENTS. Never throws. The timer calls it; a test
 * calls it to flush at once.
 *
 * ONE CALL AT A TIME per instance. A flush that finds a call still out sends
 * nothing: its events stay in the buffer (inside the same slices and
 * budgets) and the timer is armed again, so they go with the next flush and
 * their kept-alive promise is still held. So a slow database holds at most
 * one connection per instance for this, however many requests arrive.
 *
 * EACH CALL HAS A TIME LIMIT of its own, FLUSH_CALL_TIMEOUT_MS: the writer
 * waits at most 2 s for its turn, so a call still out after 3 s is aborted
 * (the request is cancelled, and the wait here ends whether or not the
 * cancel is honoured). That is an ordinary failed flush: what was not stored
 * is dropped and counted in the same once-per-interval report.
 */
export async function flushSecurityEvents(): Promise<void> {
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
    flushDueAt = null;
  }
  if (flushCallOut) {
    // Leave the events for the next flush; with nothing waiting, nothing is held.
    if (hasPendingEvents()) scheduleFlush();
    else settleScheduled();
    return;
  }
  const batch = pendingEvents();
  emptyBuffer();
  // This flush answers for the promise of the events it took; events that
  // arrive while its calls are out get a new one.
  const settle = settleScheduledFlush;
  settleScheduledFlush = null;
  try {
    if (batch.length > 0) {
      lastFlushStartedAt = Date.now();
      await sendBatch(batch);
    }
  } finally {
    settle?.();
    // A slice or budget that filled while the calls were out could not bring
    // its flush forward then; it does now.
    if (earlyFlushWanted && hasPendingEvents()) flushEarly();
  }
}

function settleScheduled(): void {
  const settle = settleScheduledFlush;
  settleScheduledFlush = null;
  settle?.();
}

/**
 * One flush: calls of at most MAX_FLUSH_CALL_ELEMENTS, one after another.
 * The first call that fails ends it: that call's elements and every element
 * not yet sent are dropped, in one report. Never throws.
 */
async function sendBatch(batch: PendingEvent[]): Promise<void> {
  flushCallOut = true;
  try {
    for (let from = 0; from < batch.length; from += MAX_FLUSH_CALL_ELEMENTS) {
      const failure = await sendCall(batch.slice(from, from + MAX_FLUSH_CALL_ELEMENTS));
      if (failure !== null) {
        reportFlushFailure(failure.cause, batch.length - from);
        return;
      }
    }
  } finally {
    flushCallOut = false;
  }
}

/** One record_security_events call with a time limit: null, or why it failed. Never throws. */
async function sendCall(elements: PendingEvent[]): Promise<{ cause: unknown } | null> {
  const controller = new AbortController();
  const deadline = new Promise<never>((_, reject) => {
    controller.signal.addEventListener('abort', () => reject(new FlushTimeout()), { once: true });
  });
  // The request may never settle once it is abandoned; neither promise may
  // become an unhandled rejection.
  deadline.catch(() => undefined);
  const timer = setTimeout(() => controller.abort(), FLUSH_CALL_TIMEOUT_MS);
  (timer as { unref?: () => void }).unref?.();
  try {
    const admin = createAdminClient();
    // supabase-js sends the request each time its builder is awaited, so it
    // is turned into ONE promise here and only that promise is used after.
    const request = Promise.resolve(
      admin.rpc('record_security_events', { p_events: elements }).abortSignal(controller.signal),
    );
    request.catch(() => undefined);
    const { error } = await Promise.race([request, deadline]);
    return error ? { cause: error } : null;
  } catch (e) {
    return { cause: e };
  } finally {
    clearTimeout(timer);
  }
}

/** True at most once per FAILURE_REPORT_INTERVAL_MS for each tag. */
function mayReport(tag: string): boolean {
  const now = Date.now();
  const last = lastReportAt.get(tag);
  if (last !== undefined && now - last >= 0 && now - last < FAILURE_REPORT_INTERVAL_MS) return false;
  lastReportAt.set(tag, now);
  return true;
}

/** At most once per FAILURE_REPORT_INTERVAL_MS: the code and the row count, never the events. */
function reportFlushFailure(failure: unknown, rows: number): void {
  if (!mayReport('security.events_flush_failed')) return;
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

/**
 * More organizations had events in one window than the buffer tracks, so an
 * organization's event was counted with no organization. At most once per
 * FAILURE_REPORT_INTERVAL_MS, on its own clock: the ceiling only, never an
 * organization or an event.
 */
function reportOrganizationCeiling(): void {
  if (!mayReport('security.events_organization_ceiling')) return;
  void reportError(new Error('Security events of more organizations than one flush window tracks'), {
    tag: 'security.events_organization_ceiling',
    level: 'warning',
    extra: { organizations: MAX_ORGANIZATIONS_PER_WINDOW },
  });
}

/** Test only: an empty buffer, no timer, no call out, no failure reported yet, the default delay. */
export function __resetSecurityEventsForTests(): void {
  if (flushTimer !== null) clearTimeout(flushTimer);
  flushTimer = null;
  flushDueAt = null;
  settleScheduled();
  flushCallOut = false;
  lastFlushStartedAt = null;
  emptyBuffer();
  lastReportAt = new Map();
  flushDelayMs = SECURITY_EVENT_FLUSH_DELAY_MS;
}

/** Test only: the delay before a scheduled flush. */
export function __setSecurityEventFlushDelayForTests(ms: number): void {
  flushDelayMs = ms;
}

/** Test only: what is waiting, as it would be sent. */
export function __pendingSecurityEventsForTests(): PendingEvent[] {
  return pendingEvents().map((e) => ({ ...e }));
}
