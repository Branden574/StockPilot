import 'server-only';

import { clientPlaceFromHeaders } from '@/lib/client-ip';
import { reportError } from '@/lib/error-reporter';
import { createAdminClient } from '@/lib/supabase/admin';
import type { ProbeSampleInput } from '@/lib/security/probe-sample';
import { keepAlive } from '@/server/services/lib/defer';

import {
  isSampleMethod,
  isSecurityProbeKind,
  isStorableSample,
  isStorableTarget,
  SAMPLE_BATCH_MAX,
  SAMPLE_COUNT_MAX,
  type SampleMethod,
  type SecurityProbeKind,
} from '@stockpilot/core';

/**
 * THE RECORDER of what scanners asked for (public.security_event_samples,
 * migration 0479; security tools part 5, stage 3): the scrubbed path, method
 * and query string of a request on a scanner path, with its country, by UTC
 * hour, with a count.
 *
 * ITS OWN MODULE, BUFFER, TIMER AND COUNTERS (review S1). Nothing here is
 * shared with server/security/events.ts: a flood of samples never delays or
 * drops a security event, and the writer takes its own lock.
 *
 * NEVER ON THE CALLER'S PATH. recordSecurityEventSample returns nothing (the
 * route cannot wait on it), never throws, and only adds to this instance's
 * buffer. The first sample into an empty buffer schedules ONE flush about
 * SAMPLE_FLUSH_DELAY_MS later, kept alive past the response (keepAlive, the
 * same mechanism events.ts uses); the flush sends everything waiting to
 * record_security_event_samples(jsonb) in one call.
 *
 * THE BUFFER holds at most SAMPLE_BATCH_MAX (50, what the writer reads of one
 * call) different samples, keyed like the table's row: hour, reason, method,
 * target, query string and country. A sample whose key waits adds to its
 * count (at most SAMPLE_COUNT_MAX). A new key when the buffer is full is
 * dropped and counted (`dropped` in the next count line): the security
 * event of the same request is recorded whatever happens here.
 *
 * ONE CALL AT A TIME per instance, with a time limit of its own. A flush that
 * finds a call still out leaves the samples for the next one. A failed call
 * drops its batch, never retried:
 *   - 55P03 (the writer waited 2 s for its lock): dropped and counted;
 *   - the function missing (42883, PGRST202): dropped, and said once per
 *     instance, not per call: a log line and a report (tag
 *     security.event_samples_missing, warning, the code and the row count
 *     only). This code ships after migration 0479 is live, so a missing
 *     writer means the migration was rolled back or something is wrong;
 *   - anything else: dropped, reported at most once per
 *     FAILURE_REPORT_INTERVAL_MS (tag security.event_samples_flush_failed,
 *     warning, the code and the row count only).
 *
 * THE COUNT LINE. After every call one log line, numbers only besides its
 * tag: `stored`, `overflowed`, `skipped`, `not_read` from the writer's answer
 * (review S7), and `dropped`, `busy`, `failed`, this instance's own drops
 * since the last line. Never a target, a query string or a country. A
 * non-zero `skipped` is a fault in the scrubber (it and the table disagree on
 * a text) and is logged at warning level.
 *
 * SERVER CODE ONLY: `import 'server-only'` and never 'use server'
 * (server/security/events.guard.test.ts): exported from a server action
 * module, the recorder would be an endpoint anyone could call to write
 * samples.
 */

/** Delay between the first sample into an empty buffer and its flush (review S1: about one call per instance per 10 s). */
export const SAMPLE_FLUSH_DELAY_MS = 10_000;
/** A flush call still out after this long is aborted and counted as failed. */
export const SAMPLE_FLUSH_CALL_TIMEOUT_MS = 3_000;
/** A failed flush is reported at most this often per instance. */
export const SAMPLE_FAILURE_REPORT_INTERVAL_MS = 10 * 60_000;
/** The tag of the count line. */
export const SAMPLE_COUNT_LINE_TAG = 'security.event_samples';
/** The tag of the one line and the one report an instance makes when the writer is missing. */
export const SAMPLE_MISSING_LINE_TAG = 'security.event_samples_missing';

/** A reader of request headers: a Request's headers or `next/headers`' answer. */
export type SampleHeaders = { get(name: string): string | null };

/** One element of record_security_event_samples' array, as it is sent. */
interface PendingSample {
  category: 'exploit';
  reason: SecurityProbeKind;
  source: 'web';
  method: SampleMethod;
  target: string;
  sample: string | null;
  country: string | null;
  count: number;
  /** The newest request folded in, in ms since 1970 (inside the row's hour). */
  at_ms: number;
}

/** What the writer answers (CONTRACT.md: always five keys). */
interface WriterAnswer {
  stored: number;
  overflowed: number;
  skipped: number;
  not_read: number;
}

interface SampleRecorderState {
  waiting: Map<string, PendingSample>;
  flushTimer: ReturnType<typeof setTimeout> | null;
  settleScheduledFlush: (() => void) | null;
  flushCallOut: boolean;
  flushDelayMs: number;
  /** Drops since the last count line: a full buffer, a busy writer, any other failure. */
  dropped: number;
  busy: number;
  failed: number;
  /** Whether this instance has said the writer is missing. */
  saidMissing: boolean;
  lastReportAt: number | null;
}

/**
 * ONE state per server instance, on globalThis under its own registered
 * symbol (never the security events' one), so every copy of this module a
 * build makes shares the same buffer and the same "one call at a time".
 */
const SAMPLE_RECORDER_STATE = Symbol.for('stockpilot.security-event-samples.recorder-state.v1');
const state: SampleRecorderState = ((
  globalThis as { [SAMPLE_RECORDER_STATE]?: SampleRecorderState }
)[SAMPLE_RECORDER_STATE] ??= {
  waiting: new Map(),
  flushTimer: null,
  settleScheduledFlush: null,
  flushCallOut: false,
  flushDelayMs: SAMPLE_FLUSH_DELAY_MS,
  dropped: 0,
  busy: 0,
  failed: 0,
  saidMissing: false,
  lastReportAt: null,
});

/** The country, by the security events' own rule (lib/client-ip.ts); never the city. */
function countryOf(headers: SampleHeaders | null | undefined): string | null {
  if (!headers) return null;
  const country = clientPlaceFromHeaders(headers).country;
  return typeof country === 'string' && /^[A-Z]{2}$/.test(country) ? country : null;
}

/**
 * Records one sample of what was asked for. Returns nothing and never throws:
 * a sample that is not well formed (a kind, a method of the seven, a storable
 * target and query string) is dropped without a word, since the security
 * event of the same request is already recorded.
 */
export function recordSecurityEventSample(
  sample: ProbeSampleInput,
  headers?: SampleHeaders | null,
): void {
  try {
    if (
      !sample ||
      !isSecurityProbeKind(sample.reason) ||
      !isSampleMethod(sample.method) ||
      typeof sample.target !== 'string' ||
      !isStorableTarget(sample.target) ||
      (sample.sample !== null && typeof sample.sample !== 'string') ||
      !isStorableSample(sample.sample)
    ) {
      return;
    }
    add({
      category: 'exploit',
      reason: sample.reason,
      source: 'web',
      method: sample.method,
      target: sample.target,
      sample: sample.sample === '' ? null : sample.sample,
      country: countryOf(headers),
      count: 1,
      at_ms: Date.now(),
    });
  } catch {
    // Never the caller's problem.
  }
}

function keyOf(s: PendingSample): string {
  return [
    Math.floor(s.at_ms / 3_600_000),
    s.reason,
    s.method,
    s.target,
    s.sample ?? '',
    s.country ?? '',
  ].join('\u001f');
}

function add(s: PendingSample): void {
  const key = keyOf(s);
  const same = state.waiting.get(key);
  if (same) {
    same.count = Math.min(same.count + s.count, SAMPLE_COUNT_MAX);
    same.at_ms = Math.max(same.at_ms, s.at_ms);
  } else if (state.waiting.size < SAMPLE_BATCH_MAX) {
    state.waiting.set(key, s);
  } else {
    state.dropped++;
    return;
  }
  scheduleFlush();
}

/** The first sample into an empty buffer starts the one timer; its promise is kept alive. */
function scheduleFlush(): void {
  if (state.flushTimer !== null) return;
  if (state.settleScheduledFlush === null) {
    const flushed = new Promise<void>((resolve) => {
      state.settleScheduledFlush = resolve;
    });
    keepAlive(flushed);
  }
  state.flushTimer = setTimeout(() => {
    state.flushTimer = null;
    keepAlive(flushSecurityEventSamples());
  }, state.flushDelayMs);
  (state.flushTimer as { unref?: () => void }).unref?.();
}

function settleScheduled(): void {
  const settle = state.settleScheduledFlush;
  state.settleScheduledFlush = null;
  settle?.();
}

/**
 * Sends everything waiting to record_security_event_samples, now, in one
 * call. Never throws. The timer calls it; a test calls it to flush at once.
 * A flush that finds a call still out sends nothing and leaves the samples
 * for the next one.
 */
export async function flushSecurityEventSamples(): Promise<void> {
  if (state.flushTimer !== null) {
    clearTimeout(state.flushTimer);
    state.flushTimer = null;
  }
  if (state.flushCallOut) {
    if (state.waiting.size > 0) scheduleFlush();
    else settleScheduled();
    return;
  }
  const batch = [...state.waiting.values()];
  state.waiting = new Map();
  const settle = state.settleScheduledFlush;
  state.settleScheduledFlush = null;
  try {
    if (batch.length > 0) await sendBatch(batch);
  } finally {
    settle?.();
  }
}

class SampleFlushTimeout extends Error {
  readonly code = 'flush_timeout';
  constructor() {
    super('record_security_event_samples did not answer in time');
    this.name = 'SampleFlushTimeout';
  }
}

const MISSING_FUNCTION_CODES = new Set(['42883', 'PGRST202']);

function codeOf(failure: unknown): string | null {
  if (failure && typeof failure === 'object' && 'code' in failure) {
    return String((failure as { code: unknown }).code ?? '') || null;
  }
  return failure instanceof Error ? failure.name : null;
}

/** A count from the answer: a whole number from 0 up, else null. */
function countOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

function answerOf(data: unknown): WriterAnswer | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  const stored = countOf(d.stored);
  const overflowed = countOf(d.overflowed);
  const skipped = countOf(d.skipped);
  const notRead = countOf(d.not_read);
  if (stored === null || overflowed === null || skipped === null || notRead === null) return null;
  return { stored, overflowed, skipped, not_read: notRead };
}

/** One call with a time limit, then its one count line. Never throws. */
async function sendBatch(batch: PendingSample[]): Promise<void> {
  state.flushCallOut = true;
  const controller = new AbortController();
  const deadline = new Promise<never>((_, reject) => {
    controller.signal.addEventListener('abort', () => reject(new SampleFlushTimeout()), {
      once: true,
    });
  });
  deadline.catch(() => undefined);
  const timer = setTimeout(() => controller.abort(), SAMPLE_FLUSH_CALL_TIMEOUT_MS);
  (timer as { unref?: () => void }).unref?.();
  let answer: WriterAnswer | null = null;
  let failure: unknown = null;
  try {
    const admin = createAdminClient();
    const request = Promise.resolve(
      admin
        .rpc('record_security_event_samples', { p_samples: batch })
        .abortSignal(controller.signal),
    );
    request.catch(() => undefined);
    const { data, error } = await Promise.race([request, deadline]);
    if (error) failure = error;
    else {
      answer = answerOf(data);
      if (answer === null)
        failure = new Error('record_security_event_samples answered without its counts');
    }
  } catch (e) {
    failure = e;
  } finally {
    clearTimeout(timer);
    state.flushCallOut = false;
  }
  try {
    if (answer !== null) {
      countLine(answer);
      return;
    }
    const code = codeOf(failure);
    if (code !== null && MISSING_FUNCTION_CODES.has(code)) {
      // The writer is not in the database: drop, and say so once per instance.
      if (!state.saidMissing) {
        state.saidMissing = true;
        console.warn(JSON.stringify({ tag: SAMPLE_MISSING_LINE_TAG, code, rows: batch.length }));
        void reportError(
          new Error('Security event samples could not be stored: the writer is missing'),
          {
            tag: SAMPLE_MISSING_LINE_TAG,
            level: 'warning',
            extra: { code, rows: batch.length },
          },
        );
      }
      return;
    }
    if (code === '55P03') state.busy += batch.length;
    else {
      state.failed += batch.length;
      reportFailure(code, batch.length);
    }
    countLine({ stored: 0, overflowed: 0, skipped: 0, not_read: 0 });
  } catch {
    // A log or report that fails changes nothing.
  }
}

/** The one count line after a call: numbers only, then the instance's drop counters start again. */
function countLine(answer: WriterAnswer): void {
  const line = JSON.stringify({
    tag: SAMPLE_COUNT_LINE_TAG,
    stored: answer.stored,
    overflowed: answer.overflowed,
    skipped: answer.skipped,
    not_read: answer.not_read,
    dropped: state.dropped,
    busy: state.busy,
    failed: state.failed,
  });
  state.dropped = 0;
  state.busy = 0;
  state.failed = 0;
  // A skipped element is the scrubber and the table disagreeing on a text.
  if (answer.skipped > 0) console.warn(line);
  else console.info(line);
}

function reportFailure(code: string | null, rows: number): void {
  const now = Date.now();
  const last = state.lastReportAt;
  if (last !== null && now - last >= 0 && now - last < SAMPLE_FAILURE_REPORT_INTERVAL_MS) return;
  state.lastReportAt = now;
  void reportError(new Error('Security event samples could not be stored'), {
    tag: 'security.event_samples_flush_failed',
    level: 'warning',
    extra: { code, rows },
  });
}

/** Test only: an empty buffer, no timer, no call out, counters at zero, the default delay. */
export function __resetSecurityEventSamplesForTests(): void {
  if (state.flushTimer !== null) clearTimeout(state.flushTimer);
  state.flushTimer = null;
  settleScheduled();
  state.flushCallOut = false;
  state.waiting = new Map();
  state.dropped = 0;
  state.busy = 0;
  state.failed = 0;
  state.saidMissing = false;
  state.lastReportAt = null;
  state.flushDelayMs = SAMPLE_FLUSH_DELAY_MS;
}

/** Test only: what is waiting, as it would be sent. */
export function __pendingSecurityEventSamplesForTests(): PendingSample[] {
  return [...state.waiting.values()].map((s) => ({ ...s }));
}

/** Test only: the delay before a scheduled flush. */
export function __setSecurityEventSampleFlushDelayForTests(ms: number): void {
  state.flushDelayMs = ms;
}
