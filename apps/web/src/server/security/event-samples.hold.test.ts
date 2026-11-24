// @vitest-environment node
import { randomBytes } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Security invariant (review 3B S5): a probe request is held no longer with
 * its sample than with its security event alone. Both real recorders, in the
 * probe route's order (app/api/security/probe/[kind]/route.ts): the event
 * first, then the sample. Every promise either recorder hands to keepAlive is
 * timed; the request is held until the last one settles. The same requests
 * are run twice, once with the event only (the instance before samples
 * existed) and once with both, and the second may not end later.
 *
 * Addresses are from the documentation ranges (RFC 5737); paths are made up.
 */

const h = vi.hoisted(() => ({
  /** How long each write call takes to answer; null: it never answers. */
  callMs: 250 as number | null,
  calls: [] as string[],
  kept: [] as Array<Promise<number>>,
  env: {} as { CRON_SECRET?: string },
}));

vi.mock('next/headers', () => ({
  headers: async () => {
    throw new Error('`headers` was called outside a request scope.');
  },
}));
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    rpc: (name: string) => {
      h.calls.push(name);
      const answer =
        name === 'record_security_event_samples'
          ? { data: { stored: 1, overflowed: 0, skipped: 0, not_read: 0, not_a_list: false }, error: null }
          : { data: null, error: null };
      const builder = {
        abortSignal() {
          return builder;
        },
        then(ok?: (value: unknown) => unknown, bad?: (reason: unknown) => unknown) {
          const ms = h.callMs;
          const settled = new Promise((resolve) => {
            if (ms !== null) setTimeout(() => resolve(answer), ms);
          });
          return settled.then(ok, bad);
        },
      };
      return builder;
    },
  }),
}));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => undefined) }));
vi.mock('@/server/services/lib/defer', () => ({
  keepAlive: (work: Promise<unknown>) => {
    h.kept.push(work.then(() => Date.now()));
  },
  defer: vi.fn(),
}));
vi.mock('@/lib/env', () => ({
  get env() {
    return h.env;
  },
}));
// The real recorders (src/test/setup.ts replaces both for every other test).
vi.mock('./events', async (importOriginal) => importOriginal());
vi.mock('./event-samples', async (importOriginal) => importOriginal());

type Events = typeof import('./events');
type Samples = typeof import('./event-samples');
let events: Events;
let samples: Samples;
const START = new Date('2026-11-24T10:15:05Z').getTime();

beforeEach(async () => {
  vi.useFakeTimers({ now: START });
  vi.stubEnv('VERCEL', '1');
  h.env.CRON_SECRET = randomBytes(16).toString('hex');
  h.callMs = 250;
  h.calls = [];
  h.kept = [];
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  events = await import('./events');
  samples = await import('./event-samples');
  events.__resetSecurityEventsForTests();
  samples.__resetSecurityEventSamplesForTests();
});

afterEach(() => {
  events.__resetSecurityEventsForTests();
  samples.__resetSecurityEventSamplesForTests();
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

/** One probe request, as the route records it: the event, then (with `withSample`) the sample. */
async function probeRequest(n: number, withSample: boolean): Promise<void> {
  const headers = new Headers({
    'x-forwarded-for': `203.0.113.${1 + (n % 250)}`,
    'x-vercel-ip-country': 'NL',
  });
  await events.recordSecurityEvent(
    { category: 'exploit', outcome: 'blocked', reason: 'env_file', source: 'web' },
    headers,
  );
  if (withSample) {
    samples.recordSecurityEventSample(
      { reason: 'env_file', method: 'GET', target: `/backup${n}/.env`, sample: null },
      headers,
    );
  }
}

/** Runs `requests` and answers how long after START the last kept-alive promise settled. */
async function heldFor(requests: number, withSample: boolean): Promise<number> {
  events.__resetSecurityEventsForTests();
  samples.__resetSecurityEventSamplesForTests();
  vi.setSystemTime(START);
  h.kept = [];
  h.calls = [];
  for (let n = 0; n < requests; n++) await probeRequest(n, withSample);
  await vi.advanceTimersByTimeAsync(60_000);
  const settled = await Promise.all(h.kept);
  expect(settled.length).toBeGreaterThan(0);
  return Math.max(...settled) - START;
}

describe('a probe request is held no longer with its sample than with its event alone', () => {
  it('one request, calls that answer: both flush together, 2 s and one call', async () => {
    const before = await heldFor(1, false);
    const after = await heldFor(1, true);
    expect(before).toBe(2_250);
    expect(after).toBe(before);
    expect(h.calls.sort()).toEqual(['record_security_event_samples', 'record_security_events']);
  });

  it('one request, calls that never answer: both end at the 3 s limit', async () => {
    h.callMs = null;
    const before = await heldFor(1, false);
    const after = await heldFor(1, true);
    expect(before).toBe(5_000);
    expect(after).toBe(before);
  });

  it("a flood that fills the events' budget brings their flush forward, and the samples' with it", async () => {
    const before = await heldFor(50, false);
    const after = await heldFor(50, true);
    expect(before).toBeLessThan(2_000);
    expect(after).toBeLessThanOrEqual(before);
  });
});
