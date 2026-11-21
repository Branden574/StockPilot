// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The security-events recorder (server/security/events.ts), the real module
 * (src/test/setup.ts replaces it with a no-op for every other test):
 *
 *   - never throws and never waits on the database: an event is buffered and
 *     the call returns; nothing is sent until the flush;
 *   - the buffer is keyed like the row, with a count; the first event
 *     schedules ONE flush, kept alive with keepAlive; the flush is ONE
 *     record_security_events call with every waiting element;
 *   - events about no organization wait in one budget of distinct keys, and
 *     each organization has its own slice, so neither noise about no
 *     organization nor another organization's flood can push an
 *     organization's events out; past a slice or the budget, events are
 *     counted on an over_buffer_cap entry with no place or hash, the
 *     organization's own; only past 100 organizations in one window does an
 *     event fall to the entry with no organization, and that is reported;
 *   - a slice or budget that fills sends the flush early (never while a call
 *     is out, and no sooner than half a second after the last flush);
 *   - a flush of more than 200 elements is split into calls of at most 200,
 *     one after another;
 *   - one flush call at a time: a flush that finds one still out leaves its
 *     events for the next; a call still out after 3 seconds is aborted;
 *     flushSecurityEvents settles the kept-alive promise, whoever calls it;
 *   - a failed flush (an aborted one too) drops its batch and is reported at
 *     most once per 10 minutes, with no event content;
 *   - the place and the source hash come from the request's headers
 *     (lib/client-ip.ts); the address itself is never sent.
 *
 * Addresses are from the documentation ranges (RFC 5737).
 */

const h = vi.hoisted(() => ({
  rpc: vi.fn(),
  createAdminClient: vi.fn(),
  reportError: vi.fn(async () => undefined),
  keepAlive: vi.fn(),
  headers: vi.fn(),
  /** The abort signal each record_security_events call was given, in order. */
  signals: [] as AbortSignal[],
  env: { CRON_SECRET: 'test-cron-secret' } as { CRON_SECRET?: string },
}));

vi.mock('next/headers', () => ({ headers: h.headers }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: h.createAdminClient }));
vi.mock('@/lib/error-reporter', () => ({ reportError: h.reportError }));
vi.mock('@/server/services/lib/defer', () => ({ keepAlive: h.keepAlive, defer: vi.fn() }));
vi.mock('@/lib/env', () => ({
  get env() {
    return h.env;
  },
}));

type Events = typeof import('./events');
let events: Events;

const ORG = '5eed0000-0001-4000-8000-000000000001';
const ORG_2 = '5eed0000-0001-4000-8000-000000000002';
const ADDRESS = '203.0.113.7';

const requestFrom = (address = ADDRESS, city = 'Utrecht') =>
  new Headers({
    'x-forwarded-for': `${address}, 10.0.0.1`,
    'x-vercel-ip-country': 'NL',
    'x-vercel-ip-city': city,
  });

/** The i-th made-up address (RFC 5737 documentation ranges), each a different source. */
const address = (i: number) =>
  `${['203.0.113', '198.51.100', '192.0.2'][Math.floor(i / 250) % 3]}.${(i % 250) + 1}`;

/** The n-th made-up organization id. */
const organization = (n: number) => `5eed0000-0009-4000-8000-${String(n).padStart(12, '0')}`;

/** An entry that counts events past a budget: no place and no hash. */
const overflowEntry = (category: string, organizationId: string | null) => ({
  category,
  outcome: 'blocked',
  reason: 'over_buffer_cap',
  source: 'web',
  organization_id: organizationId,
  country: null,
  city: null,
  source_hash: null,
  at_ms: expect.any(Number),
});

const wrongPassword = {
  category: 'password_guessing',
  outcome: 'blocked',
  reason: 'wrong_password',
  source: 'web',
} as const;

/**
 * The service client as the recorder uses it: rpc() answers supabase-js's
 * builder, which takes an abort signal and sends the request EACH time it is
 * awaited (its `then`), so the recorder must await it exactly once.
 */
function adminClient() {
  return {
    rpc: (...args: unknown[]) => {
      const builder = {
        abortSignal(signal: AbortSignal) {
          h.signals.push(signal);
          return builder;
        },
        then(ok?: (value: unknown) => unknown, bad?: (reason: unknown) => unknown) {
          let answer: Promise<unknown>;
          try {
            answer = Promise.resolve(h.rpc(...args));
          } catch (e) {
            answer = Promise.reject(e);
          }
          return answer.then(ok, bad);
        },
      };
      return builder;
    },
  };
}

/** Whether a promise has settled, without waiting for it. */
function settledFlag(p: Promise<unknown>): { settled: boolean } {
  const flag = { settled: false };
  void p.then(
    () => {
      flag.settled = true;
    },
    () => {
      flag.settled = true;
    },
  );
  return flag;
}

beforeEach(async () => {
  vi.useFakeTimers({ now: new Date('2026-11-21T10:15:05Z') });
  vi.stubEnv('VERCEL', '1');
  h.env = { CRON_SECRET: 'test-cron-secret' };
  h.rpc.mockReset();
  h.rpc.mockResolvedValue({ data: 1, error: null });
  h.createAdminClient.mockReset();
  h.createAdminClient.mockImplementation(adminClient);
  h.signals = [];
  h.reportError.mockClear();
  h.keepAlive.mockReset();
  h.headers.mockReset();
  h.headers.mockImplementation(async () => {
    throw new Error('`headers` was called outside a request scope.');
  });
  events = await vi.importActual<Events>('./events');
  events.__resetSecurityEventsForTests();
});

afterEach(() => {
  events.__resetSecurityEventsForTests();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

/** The elements of the n-th record_security_events call. */
function sent(call = 0): Array<Record<string, unknown>> {
  const [name, args] = h.rpc.mock.calls[call]!;
  expect(name).toBe('record_security_events');
  return (args as { p_events: Array<Record<string, unknown>> }).p_events;
}

describe('recordSecurityEvent: never on the caller path', () => {
  it('buffers and returns: nothing is sent until the flush', async () => {
    await events.recordSecurityEvent(wrongPassword, requestFrom());
    expect(h.createAdminClient).not.toHaveBeenCalled();
    expect(h.rpc).not.toHaveBeenCalled();
    expect(events.__pendingSecurityEventsForTests()).toHaveLength(1);
  });

  it('never throws: headers outside a request, a thrown header read, an invalid event', async () => {
    await expect(events.recordSecurityEvent(wrongPassword)).resolves.toBeUndefined();
    const throwing = { get: () => { throw new Error('boom'); } };
    await expect(events.recordSecurityEvent(wrongPassword, throwing)).resolves.toBeUndefined();
    await expect(
      events.recordSecurityEvent({ ...wrongPassword, category: 'nonsense' as never }),
    ).resolves.toBeUndefined();
  });

  it('drops an event whose category, outcome, source or reason the database would refuse', async () => {
    for (const bad of [
      { ...wrongPassword, category: 'ransomware' },
      { ...wrongPassword, outcome: 'maybe' },
      { ...wrongPassword, source: 'pigeon' },
      { ...wrongPassword, reason: 'Wrong Password' },
      { ...wrongPassword, reason: '' },
      { ...wrongPassword, reason: 'a'.repeat(49) },
    ]) {
      await events.recordSecurityEvent(bad as never, requestFrom());
    }
    expect(events.__pendingSecurityEventsForTests()).toEqual([]);
  });

  it('outside a request (no headers): no place and no hash', async () => {
    await events.recordSecurityEvent(wrongPassword);
    expect(events.__pendingSecurityEventsForTests()).toEqual([
      expect.objectContaining({ country: null, city: null, source_hash: null, count: 1 }),
    ]);
  });

  it('without headers passed, reads the request headers through next/headers', async () => {
    h.headers.mockImplementation(async () => requestFrom());
    await events.recordSecurityEvent(wrongPassword);
    const [row] = events.__pendingSecurityEventsForTests();
    expect(row).toMatchObject({ country: 'NL', city: 'Utrecht' });
    expect(row!.source_hash).toMatch(/^[0-9a-f]{32}$/);
  });

  it('Vercel’s percent-encoded city reaches the writer decoded; a bad encoding sends no city', async () => {
    await events.recordSecurityEvent(wrongPassword, requestFrom(ADDRESS, 'New%20York'));
    await events.recordSecurityEvent(wrongPassword, requestFrom(ADDRESS, 'S%C3%A3o%20Paulo'));
    await events.recordSecurityEvent(wrongPassword, requestFrom(ADDRESS, 'Bad%E0%A4%A'));
    await events.flushSecurityEvents();
    const [, args] = h.rpc.mock.calls[0] as unknown as [string, { p_events: Array<{ city: unknown }> }];
    expect(args.p_events.map((e) => e.city)).toEqual(['New York', 'São Paulo', null]);
    expect(JSON.stringify(args.p_events)).not.toContain('%');
  });
});

describe('the buffer', () => {
  it('folds events with the same key into one count', async () => {
    for (let i = 0; i < 3; i++) await events.recordSecurityEvent(wrongPassword, requestFrom());
    const pending = events.__pendingSecurityEventsForTests();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ ...wrongPassword, count: 3, organization_id: null });
  });

  it('keys like the row: reason, organization, place, source and minute each make a new key', async () => {
    await events.recordSecurityEvent(wrongPassword, requestFrom());
    await events.recordSecurityEvent({ ...wrongPassword, reason: 'sign_in_paused' }, requestFrom());
    await events.recordSecurityEvent({ ...wrongPassword, organizationId: ORG }, requestFrom());
    await events.recordSecurityEvent({ ...wrongPassword, organizationId: ORG_2 }, requestFrom());
    await events.recordSecurityEvent(wrongPassword, requestFrom(ADDRESS, 'Amersfoort'));
    await events.recordSecurityEvent(wrongPassword, requestFrom('203.0.113.8'));
    await vi.advanceTimersByTimeAsync(0);
    vi.setSystemTime(new Date('2026-11-21T10:16:00Z'));
    await events.recordSecurityEvent(wrongPassword, requestFrom());
    expect(events.__pendingSecurityEventsForTests()).toHaveLength(7);
  });

  it('an organization that is not a uuid is no organization', async () => {
    await events.recordSecurityEvent({ ...wrongPassword, organizationId: 'org-1' }, requestFrom());
    expect(events.__pendingSecurityEventsForTests()[0]!.organization_id).toBeNull();
  });

  it('a key that already waits still adds to its own count when its budget is full', async () => {
    for (let i = 0; i < 150; i++) await events.recordSecurityEvent(wrongPassword, requestFrom(address(i)));
    await events.recordSecurityEvent(wrongPassword, requestFrom(address(0)));
    const first = events.__pendingSecurityEventsForTests()[0]!;
    expect(first).toMatchObject({ reason: 'wrong_password', count: 2 });
  });
});

describe('events about no organization: one budget of their own', () => {
  it('a full buffer of events with no organization does not touch an organization’s event', async () => {
    // Scanner noise: far more distinct sources than the budget, none about an organization.
    for (let i = 0; i < 150; i++) {
      await events.recordSecurityEvent(
        { category: 'exploit', outcome: 'blocked', reason: 'env_file', source: 'web' },
        requestFrom(address(i)),
      );
    }
    for (let i = 0; i < 150; i++) await events.recordSecurityEvent(wrongPassword, requestFrom(address(i)));

    await events.recordSecurityEvent({ ...wrongPassword, organizationId: ORG }, requestFrom());

    const about = events.__pendingSecurityEventsForTests().filter((e) => e.organization_id === ORG);
    expect(about).toEqual([
      {
        ...wrongPassword,
        organization_id: ORG,
        country: 'NL',
        city: 'Utrecht',
        source_hash: expect.stringMatching(/^[0-9a-f]{32}$/),
        count: 1,
        at_ms: expect.any(Number),
      },
    ]);
  });

  it('events with no organization past their budget are counted per category, outcome and source', async () => {
    for (let i = 0; i < 150; i++) await events.recordSecurityEvent(wrongPassword, requestFrom(address(i)));
    await events.recordSecurityEvent({ ...wrongPassword, reason: 'sign_in_paused' }, requestFrom());
    await events.recordSecurityEvent(
      { category: 'exploit', outcome: 'blocked', reason: 'env_file', source: 'web' },
      requestFrom(),
    );
    const pending = events.__pendingSecurityEventsForTests();
    const listed = pending.filter((e) => e.reason !== 'over_buffer_cap');
    expect(listed).toHaveLength(50);
    expect(pending.filter((e) => e.reason === 'over_buffer_cap')).toEqual([
      { ...overflowEntry('password_guessing', null), count: 101 },
      { ...overflowEntry('exploit', null), count: 1 },
    ]);
  });
});

describe('events about an organization: each organization has its own slice', () => {
  const ORG_A = organization(1);
  const ORG_B = organization(2);
  const about = (organizationId: string) =>
    events.__pendingSecurityEventsForTests().filter((e) => e.organization_id === organizationId);
  const supportPaused = { category: 'bots', outcome: 'blocked', reason: 'support_paused', source: 'web' } as const;

  it('organization A filling its slice does not change what organization B stores', async () => {
    // What B stores with nobody else about.
    for (let i = 0; i < 5; i++) {
      await events.recordSecurityEvent({ ...wrongPassword, organizationId: ORG_B }, requestFrom(address(i)));
    }
    const alone = about(ORG_B);
    expect(alone).toHaveLength(5);
    expect(alone.every((e) => e.reason === 'wrong_password' && e.source_hash !== null)).toBe(true);
    events.__resetSecurityEventsForTests();

    // The same five events, after A was hit from 150 sources and again in between.
    for (let i = 0; i < 150; i++) {
      await events.recordSecurityEvent({ ...wrongPassword, organizationId: ORG_A }, requestFrom(address(i)));
    }
    for (let i = 0; i < 5; i++) {
      await events.recordSecurityEvent({ ...wrongPassword, organizationId: ORG_B }, requestFrom(address(i)));
      await events.recordSecurityEvent({ ...wrongPassword, organizationId: ORG_A }, requestFrom(address(200 + i)));
    }
    expect(about(ORG_B)).toEqual(alone);
  });

  it('an organization keeps at most 8 distinct keys; the rest are counted on its own entry', async () => {
    for (let i = 0; i < 20; i++) {
      await events.recordSecurityEvent({ ...wrongPassword, organizationId: ORG_A }, requestFrom(address(i)));
    }
    // A key that already waits still adds to its own count.
    await events.recordSecurityEvent({ ...wrongPassword, organizationId: ORG_A }, requestFrom(address(0)));
    const rows = about(ORG_A);
    const listed = rows.filter((e) => e.reason === 'wrong_password');
    expect(listed).toHaveLength(8);
    expect(listed[0]!.count).toBe(2);
    expect(rows.filter((e) => e.reason === 'over_buffer_cap')).toEqual([
      { ...overflowEntry('password_guessing', ORG_A), count: 12 },
    ]);
    // Nothing of it went to the entry with no organization.
    expect(about(ORG_A)).toHaveLength(9);
    expect(events.__pendingSecurityEventsForTests()).toHaveLength(9);
  });

  it('A’s overflow keeps A’s id and is separate from B’s', async () => {
    for (let i = 0; i < 20; i++) {
      await events.recordSecurityEvent({ ...wrongPassword, organizationId: ORG_A }, requestFrom(address(i)));
    }
    for (let i = 0; i < 10; i++) {
      await events.recordSecurityEvent({ ...wrongPassword, organizationId: ORG_B }, requestFrom(address(i)));
    }
    // Another kind for A, past its slice: its own entry, still A's.
    await events.recordSecurityEvent({ ...supportPaused, organizationId: ORG_A }, requestFrom());

    const capped = events.__pendingSecurityEventsForTests().filter((e) => e.reason === 'over_buffer_cap');
    expect(capped).toEqual([
      { ...overflowEntry('password_guessing', ORG_A), count: 12 },
      { ...overflowEntry('bots', ORG_A), count: 1 },
      { ...overflowEntry('password_guessing', ORG_B), count: 2 },
    ]);
    expect(about(ORG_B).filter((e) => e.reason === 'wrong_password')).toHaveLength(8);
    expect(events.__pendingSecurityEventsForTests().filter((e) => e.organization_id === null)).toEqual([]);
  });

  it('100 organizations each keep their own entries', async () => {
    for (let n = 0; n < 100; n++) {
      for (let i = 0; i < 9; i++) {
        await events.recordSecurityEvent(
          { ...wrongPassword, organizationId: organization(n) },
          requestFrom(address(i)),
        );
      }
    }
    for (let n = 0; n < 100; n++) {
      const rows = about(organization(n));
      expect(rows.filter((e) => e.reason === 'wrong_password'), `organization ${n}`).toHaveLength(8);
      expect(rows.filter((e) => e.reason === 'over_buffer_cap'), `organization ${n}`).toEqual([
        { ...overflowEntry('password_guessing', organization(n)), count: 1 },
      ]);
    }
    expect(events.__pendingSecurityEventsForTests()).toHaveLength(900);
    expect(events.__pendingSecurityEventsForTests().filter((e) => e.organization_id === null)).toEqual([]);
    expect(h.reportError).not.toHaveBeenCalled();
  });

  it('the 101st organization of one window falls to the entry with no organization, reported once', async () => {
    for (let n = 0; n < 100; n++) {
      await events.recordSecurityEvent({ ...wrongPassword, organizationId: organization(n) }, requestFrom());
    }
    expect(h.reportError).not.toHaveBeenCalled();

    await events.recordSecurityEvent({ ...wrongPassword, organizationId: organization(100) }, requestFrom());
    await events.recordSecurityEvent({ ...wrongPassword, organizationId: organization(101) }, requestFrom());
    await events.recordSecurityEvent({ ...wrongPassword, organizationId: organization(100) }, requestFrom());
    // An organization already tracked still keeps its own.
    await events.recordSecurityEvent({ ...wrongPassword, organizationId: organization(0) }, requestFrom(address(5)));

    expect(about(organization(100))).toEqual([]);
    expect(about(organization(101))).toEqual([]);
    expect(about(organization(0))).toHaveLength(2);
    expect(events.__pendingSecurityEventsForTests().filter((e) => e.organization_id === null)).toEqual([
      { ...overflowEntry('password_guessing', null), count: 3 },
    ]);

    expect(h.reportError).toHaveBeenCalledTimes(1);
    const [error, context] = h.reportError.mock.calls[0] as unknown as [Error, Record<string, unknown>];
    expect(error.message).toBe('Security events of more organizations than one flush window tracks');
    expect(context).toEqual({
      tag: 'security.events_organization_ceiling',
      level: 'warning',
      extra: { organizations: 100 },
    });
    // No organization id, address or reason in the report.
    expect(JSON.stringify([error.message, context])).not.toMatch(/5eed0000|203\.0\.113|wrong_password/);

    // The next window starts clean, and the same thing within 10 minutes is not reported again.
    await events.flushSecurityEvents();
    for (let n = 0; n < 102; n++) {
      await events.recordSecurityEvent({ ...wrongPassword, organizationId: organization(200 + n) }, requestFrom());
    }
    expect(about(organization(200))).toHaveLength(1);
    expect(h.reportError).toHaveBeenCalledTimes(1);
  });

  it('the ceiling report has its own 10 minutes: a failed flush neither hides it nor is hidden by it', async () => {
    h.rpc.mockResolvedValue({ data: null, error: { code: '57014' } });
    await events.recordSecurityEvent(wrongPassword, requestFrom());
    await events.flushSecurityEvents();
    expect(h.reportError).toHaveBeenCalledTimes(1);
    for (let n = 0; n < 101; n++) {
      await events.recordSecurityEvent({ ...wrongPassword, organizationId: organization(n) }, requestFrom());
    }
    expect(h.reportError).toHaveBeenCalledTimes(2);
    expect((h.reportError.mock.calls[1] as unknown[])[1]).toMatchObject({
      tag: 'security.events_organization_ceiling',
    });
  });

  it('the constants, and the worst case they add up to', () => {
    expect(events.MAX_WAITING_KEYS_PER_ORGANIZATION).toBe(8);
    expect(events.MAX_ORGANIZATIONS_PER_WINDOW).toBe(100);
    expect(events.MAX_WAITING_KEYS_WITHOUT_ORGANIZATION).toBe(50);
    // record_security_events reads `limit 200` of its array (migration security_events).
    expect(events.MAX_FLUSH_CALL_ELEMENTS).toBe(200);
    const kinds = 5 * 3 * 5; // one overflow entry per category, outcome and source
    expect(events.MAX_WAITING_ENTRIES).toBe(100 * (8 + kinds) + 50 + kinds);
    expect(events.MAX_WAITING_ENTRIES).toBe(8_425);
  });

  it('total entries stay under the computed bound under a flood of every kind', async () => {
    const categories = ['password_guessing', 'exploit', 'bots', 'phishing', 'malware'] as const;
    const outcomes = ['blocked', 'allowed', 'flagged'] as const;
    const sources = ['web', 'phone', 'api', 'email', 'edge'] as const;
    let total = 0;
    const flood = async (organizationId: string | null, distinctSources: number) => {
      for (let i = 0; i < distinctSources; i++) {
        await events.recordSecurityEvent({ ...wrongPassword, organizationId }, requestFrom(address(i)));
        total += 1;
      }
      for (const category of categories)
        for (const outcome of outcomes)
          for (const source of sources) {
            await events.recordSecurityEvent(
              { category, outcome, reason: 'x_new', source, organizationId },
              requestFrom(),
            );
            total += 1;
          }
    };
    // 130 organizations, each with more keys than a slice and every kind past it; then none.
    for (let n = 0; n < 130; n++) await flood(organization(n), 9);
    await flood(null, 60);

    const pending = events.__pendingSecurityEventsForTests();
    expect(pending.length).toBeLessThanOrEqual(events.MAX_WAITING_ENTRIES);
    expect(pending.length).toBe(events.MAX_WAITING_ENTRIES);
    expect(new Set(pending.map((e) => e.organization_id)).size).toBe(101); // 100 organizations and none
    // Nothing was lost from the count.
    expect(pending.reduce((sum, e) => sum + e.count, 0)).toBe(total);
  });
});

describe('a flush of more than 200 elements', () => {
  it('is split into calls of at most 200, one after another, organizations first', async () => {
    let out = 0;
    let mostOut = 0;
    h.rpc.mockImplementation(async () => {
      out += 1;
      mostOut = Math.max(mostOut, out);
      await new Promise((resolve) => setTimeout(resolve, 20));
      out -= 1;
      return { data: 1, error: null };
    });
    for (let n = 0; n < 60; n++) {
      for (let i = 0; i < 8; i++) {
        await events.recordSecurityEvent(
          { ...wrongPassword, organizationId: organization(n) },
          requestFrom(address(i)),
        );
      }
    }
    for (let i = 0; i < 30; i++) await events.recordSecurityEvent(wrongPassword, requestFrom(address(i)));

    const flushed = events.flushSecurityEvents();
    await vi.advanceTimersByTimeAsync(1_000);
    await flushed;
    expect(h.rpc).toHaveBeenCalledTimes(3);
    expect([sent(0).length, sent(1).length, sent(2).length]).toEqual([200, 200, 110]);
    expect(mostOut).toBe(1);
    const all = [...sent(0), ...sent(1), ...sent(2)];
    expect(all.slice(0, 480).every((e) => e.organization_id !== null)).toBe(true);
    expect(all.slice(480).every((e) => e.organization_id === null)).toBe(true);
    expect(events.__pendingSecurityEventsForTests()).toEqual([]);
    expect(h.reportError).not.toHaveBeenCalled();
  });

  it('a call that fails drops the calls not yet made, in one report with every dropped row', async () => {
    h.rpc
      .mockResolvedValueOnce({ data: 200, error: null })
      .mockResolvedValueOnce({ data: null, error: { code: '55P03' } });
    for (let n = 0; n < 60; n++) {
      for (let i = 0; i < 8; i++) {
        await events.recordSecurityEvent(
          { ...wrongPassword, organizationId: organization(n) },
          requestFrom(address(i)),
        );
      }
    }
    const kept = settledFlag(h.keepAlive.mock.calls[0]![0] as Promise<unknown>);
    await events.flushSecurityEvents();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.rpc).toHaveBeenCalledTimes(2);
    expect(h.reportError).toHaveBeenCalledTimes(1);
    expect((h.reportError.mock.calls[0] as unknown[])[1]).toEqual({
      tag: 'security.events_flush_failed',
      level: 'warning',
      extra: { code: '55P03', rows: 280 },
    });
    expect(events.__pendingSecurityEventsForTests()).toEqual([]);
    expect(kept.settled).toBe(true);
  });
});

describe('a full slice or budget flushes early', () => {
  const fillSliceOf = async (organizationId: string, from = 0) => {
    for (let i = 0; i < 8; i++) {
      await events.recordSecurityEvent({ ...wrongPassword, organizationId }, requestFrom(address(from + i)));
    }
  };

  it('an organization’s eighth key sends the flush now, not 2 seconds later', async () => {
    for (let i = 0; i < 7; i++) {
      await events.recordSecurityEvent({ ...wrongPassword, organizationId: ORG }, requestFrom(address(i)));
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(h.rpc).not.toHaveBeenCalled();

    await events.recordSecurityEvent({ ...wrongPassword, organizationId: ORG }, requestFrom(address(7)));
    // Still never on the caller's path: the call starts after the event is in.
    expect(h.rpc).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.rpc).toHaveBeenCalledTimes(1);
    expect(sent()).toHaveLength(8);
    expect(events.__pendingSecurityEventsForTests()).toEqual([]);
    // One kept-alive promise for the window, settled by the early flush.
    expect(h.keepAlive).toHaveBeenCalledTimes(1);
    await expect(h.keepAlive.mock.calls[0]![0]).resolves.toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('the budget of events with no organization, when it fills', async () => {
    for (let i = 0; i < 49; i++) await events.recordSecurityEvent(wrongPassword, requestFrom(address(i)));
    await vi.advanceTimersByTimeAsync(0);
    expect(h.rpc).not.toHaveBeenCalled();
    await events.recordSecurityEvent(wrongPassword, requestFrom(address(49)));
    await vi.advanceTimersByTimeAsync(0);
    expect(h.rpc).toHaveBeenCalledTimes(1);
    expect(sent()).toHaveLength(50);
  });

  it('the hundredth organization of a window', async () => {
    for (let n = 0; n < 99; n++) {
      await events.recordSecurityEvent({ ...wrongPassword, organizationId: organization(n) }, requestFrom());
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(h.rpc).not.toHaveBeenCalled();
    await events.recordSecurityEvent({ ...wrongPassword, organizationId: organization(99) }, requestFrom());
    await vi.advanceTimersByTimeAsync(0);
    expect(h.rpc).toHaveBeenCalledTimes(1);
    expect(sent()).toHaveLength(100);
  });

  it('never while a call is out: the events wait, and go once it has answered', async () => {
    let answer!: (value: unknown) => void;
    h.rpc.mockReturnValueOnce(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    await fillSliceOf(ORG);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.rpc).toHaveBeenCalledTimes(1);

    // The slice fills again, twice over, while the first call is out.
    await fillSliceOf(ORG, 100);
    await fillSliceOf(ORG, 200);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.rpc).toHaveBeenCalledTimes(1);
    expect(events.__pendingSecurityEventsForTests()).toHaveLength(9);

    answer({ data: 8, error: null });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.rpc).toHaveBeenCalledTimes(2);
    expect(sent(1)).toHaveLength(9);
    expect(events.__pendingSecurityEventsForTests()).toEqual([]);
  });

  it('early flushes start at least half a second apart, so a flood cannot drive the call rate', async () => {
    await fillSliceOf(ORG);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.rpc).toHaveBeenCalledTimes(1);

    // Full again at once: the next flush waits out the gap, not the 2 seconds.
    await fillSliceOf(ORG, 100);
    await vi.advanceTimersByTimeAsync(499);
    expect(h.rpc).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.rpc).toHaveBeenCalledTimes(2);

    // A steady flood for 10 seconds: at most one flush per half second.
    h.rpc.mockClear();
    for (let tick = 0; tick < 100; tick++) {
      await fillSliceOf(ORG, tick * 8);
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(h.rpc.mock.calls.length).toBeLessThanOrEqual(20);
    expect(h.rpc.mock.calls.length).toBeGreaterThanOrEqual(19);
    expect(events.EARLY_FLUSH_MIN_GAP_MS).toBe(500);
  });

  it('a slice that is not full waits the usual 2 seconds', async () => {
    await events.recordSecurityEvent({ ...wrongPassword, organizationId: ORG }, requestFrom());
    await vi.advanceTimersByTimeAsync(1_999);
    expect(h.rpc).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(h.rpc).toHaveBeenCalledTimes(1);
  });
});

describe('the flush', () => {
  it('the first event schedules ONE flush about 2 seconds later, kept alive; it sends ONE call', async () => {
    await events.recordSecurityEvent(wrongPassword, requestFrom());
    await events.recordSecurityEvent({ ...wrongPassword, reason: 'sign_in_paused' }, requestFrom());
    await events.recordSecurityEvent(wrongPassword, requestFrom());
    expect(h.keepAlive).toHaveBeenCalledTimes(1);
    expect(h.keepAlive.mock.calls[0]![0]).toBeInstanceOf(Promise);

    await vi.advanceTimersByTimeAsync(1_999);
    expect(h.rpc).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(h.rpc).toHaveBeenCalledTimes(1);
    expect(sent()).toEqual([
      expect.objectContaining({ reason: 'wrong_password', count: 2 }),
      expect.objectContaining({ reason: 'sign_in_paused', count: 1 }),
    ]);
    expect(events.__pendingSecurityEventsForTests()).toEqual([]);

    // The kept-alive promise settles once the call has answered.
    await expect(h.keepAlive.mock.calls[0]![0]).resolves.toBeUndefined();
  });

  it('the element shape is the writer’s: category, outcome, reason, source, organization_id, country, city, source_hash, count, at_ms', async () => {
    await events.recordSecurityEvent({ ...wrongPassword, organizationId: ORG }, requestFrom());
    await events.flushSecurityEvents();
    const [element] = sent();
    expect(Object.keys(element!).sort()).toEqual(
      [
        'at_ms',
        'category',
        'city',
        'count',
        'country',
        'organization_id',
        'outcome',
        'reason',
        'source',
        'source_hash',
      ].sort(),
    );
    expect(element).toMatchObject({
      organization_id: ORG,
      country: 'NL',
      city: 'Utrecht',
      count: 1,
      at_ms: Date.parse('2026-11-21T10:15:05Z'),
    });
    expect(String(element!.at_ms)).toMatch(/^[0-9]{12,14}$/);
  });

  it('never sends the address, in the payload or anywhere in the call', async () => {
    await events.recordSecurityEvent(wrongPassword, requestFrom());
    await events.flushSecurityEvents();
    expect(JSON.stringify(h.rpc.mock.calls)).not.toContain(ADDRESS);
    expect(sent()[0]!.source_hash).toMatch(/^[0-9a-f]{32}$/);
  });

  it('a new event after a flush schedules the next one', async () => {
    await events.recordSecurityEvent(wrongPassword, requestFrom());
    await vi.advanceTimersByTimeAsync(2_000);
    await events.recordSecurityEvent(wrongPassword, requestFrom());
    expect(h.keepAlive).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.rpc).toHaveBeenCalledTimes(2);
  });

  it('the delay can be injected (tests)', async () => {
    events.__setSecurityEventFlushDelayForTests(10);
    await events.recordSecurityEvent(wrongPassword, requestFrom());
    await vi.advanceTimersByTimeAsync(10);
    expect(h.rpc).toHaveBeenCalledTimes(1);
  });
});

describe('flushSecurityEvents called by hand', () => {
  it('settles the kept-alive promise of the flush it replaced', async () => {
    await events.recordSecurityEvent(wrongPassword, requestFrom());
    const kept = settledFlag(h.keepAlive.mock.calls[0]![0] as Promise<unknown>);
    await events.flushSecurityEvents();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.rpc).toHaveBeenCalledTimes(1);
    expect(kept.settled).toBe(true);
    // And no timer is left behind to hold anything.
    expect(vi.getTimerCount()).toBe(0);
  });

  it('settles it when the call fails, too', async () => {
    h.rpc.mockRejectedValue(new Error('down'));
    await events.recordSecurityEvent(wrongPassword, requestFrom());
    const kept = settledFlag(h.keepAlive.mock.calls[0]![0] as Promise<unknown>);
    await events.flushSecurityEvents();
    await vi.advanceTimersByTimeAsync(0);
    expect(kept.settled).toBe(true);
  });
});

describe('one flush call at a time, with a time limit', () => {
  const paused = { ...wrongPassword, reason: 'sign_in_paused' } as const;

  it('a flush that finds one still out leaves its events in the buffer for the next', async () => {
    let answer!: (value: unknown) => void;
    h.rpc.mockReturnValueOnce(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    await events.recordSecurityEvent(wrongPassword, requestFrom());
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.rpc).toHaveBeenCalledTimes(1);

    // New events while the first call is out: their flush comes due and sends nothing.
    await events.recordSecurityEvent(paused, requestFrom());
    const kept = settledFlag(h.keepAlive.mock.calls[1]![0] as Promise<unknown>);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.rpc).toHaveBeenCalledTimes(1);
    expect(events.__pendingSecurityEventsForTests()).toEqual([
      expect.objectContaining({ reason: 'sign_in_paused', count: 1 }),
    ]);
    // Their invocation is still held: they have not been sent.
    expect(kept.settled).toBe(false);

    // The first call answers; the waiting events go out with the next flush.
    answer({ data: 1, error: null });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.rpc).toHaveBeenCalledTimes(2);
    expect(sent(1)).toEqual([expect.objectContaining({ reason: 'sign_in_paused', count: 1 })]);
    expect(events.__pendingSecurityEventsForTests()).toEqual([]);
    expect(kept.settled).toBe(true);
    expect(h.reportError).not.toHaveBeenCalled();
  });

  it('by hand too: a flush while one is out sends nothing and keeps the events', async () => {
    let answer!: (value: unknown) => void;
    h.rpc.mockReturnValueOnce(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    await events.recordSecurityEvent(wrongPassword, requestFrom());
    const first = events.flushSecurityEvents();
    await events.recordSecurityEvent(paused, requestFrom());
    await events.flushSecurityEvents();
    expect(h.rpc).toHaveBeenCalledTimes(1);
    expect(events.__pendingSecurityEventsForTests()).toHaveLength(1);
    answer({ data: 1, error: null });
    await first;
    await events.flushSecurityEvents();
    expect(h.rpc).toHaveBeenCalledTimes(2);
    expect(events.__pendingSecurityEventsForTests()).toEqual([]);
  });

  it('events that wait behind a call still fold and stay inside the bound', async () => {
    h.rpc.mockReturnValueOnce(new Promise(() => undefined));
    await events.recordSecurityEvent(wrongPassword, requestFrom());
    await vi.advanceTimersByTimeAsync(2_000);
    for (let i = 0; i < 500; i++) {
      await events.recordSecurityEvent(wrongPassword, requestFrom(address(i)));
      await events.recordSecurityEvent({ ...wrongPassword, organizationId: organization(i) }, requestFrom());
    }
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.rpc).toHaveBeenCalledTimes(1);
    // 50 keys and one entry with no organization, and one key for each of 100 organizations.
    expect(events.__pendingSecurityEventsForTests()).toHaveLength(151);
  });

  it('a call that has not answered after 3 seconds is aborted: an ordinary failed flush', async () => {
    h.rpc.mockReturnValue(new Promise(() => undefined));
    await events.recordSecurityEvent({ ...wrongPassword, organizationId: ORG }, requestFrom());
    const kept = settledFlag(h.keepAlive.mock.calls[0]![0] as Promise<unknown>);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.rpc).toHaveBeenCalledTimes(1);
    expect(h.signals).toHaveLength(1);
    expect(h.signals[0]!.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(2_999);
    expect(h.signals[0]!.aborted).toBe(false);
    expect(h.reportError).not.toHaveBeenCalled();
    expect(kept.settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(h.signals[0]!.aborted).toBe(true);
    expect(kept.settled).toBe(true);
    // Dropped and reported like any other failure: a code and a row count.
    expect(events.__pendingSecurityEventsForTests()).toEqual([]);
    expect(h.reportError).toHaveBeenCalledTimes(1);
    expect((h.reportError.mock.calls[0] as unknown[])[1]).toEqual({
      tag: 'security.events_flush_failed',
      level: 'warning',
      extra: { code: 'flush_timeout', rows: 1 },
    });

    // The next flush is not held up by the one that was aborted, and a second
    // abort inside the 10 minutes is not reported again.
    await events.recordSecurityEvent(wrongPassword, requestFrom());
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.rpc).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(h.signals[1]!.aborted).toBe(true);
    expect(h.reportError).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a call that answers in time is sent once, is not aborted, and leaves no timer behind', async () => {
    await events.recordSecurityEvent(wrongPassword, requestFrom());
    await vi.advanceTimersByTimeAsync(2_000);
    // h.rpc runs each time the builder is awaited: once.
    expect(h.rpc).toHaveBeenCalledTimes(1);
    expect(h.signals).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.signals[0]!.aborted).toBe(false);
    expect(h.reportError).not.toHaveBeenCalled();
  });
});

describe('a failed flush', () => {
  it('drops the batch and reports once, with the code and the row count only', async () => {
    h.rpc.mockResolvedValue({
      data: null,
      error: { code: '42883', message: `function failed for ${ADDRESS} wrong_password ${ORG}` },
    });
    await events.recordSecurityEvent({ ...wrongPassword, organizationId: ORG }, requestFrom());
    await events.flushSecurityEvents();
    expect(events.__pendingSecurityEventsForTests()).toEqual([]);
    expect(h.reportError).toHaveBeenCalledTimes(1);
    const [error, context] = h.reportError.mock.calls[0] as unknown as [Error, Record<string, unknown>];
    expect(error.message).toBe('Security events could not be stored');
    expect(context).toEqual({
      tag: 'security.events_flush_failed',
      level: 'warning',
      extra: { code: '42883', rows: 1 },
    });
    const reported = JSON.stringify([error.message, context]);
    for (const content of [ADDRESS, ORG, 'wrong_password', 'Utrecht', 'NL"']) {
      expect(reported).not.toContain(content);
    }
  });

  it('reports at most once per 10 minutes per instance', async () => {
    h.rpc.mockResolvedValue({ data: null, error: { code: '57014' } });
    for (let i = 0; i < 3; i++) {
      await events.recordSecurityEvent(wrongPassword, requestFrom());
      await events.flushSecurityEvents();
      await vi.advanceTimersByTimeAsync(60_000);
    }
    expect(h.reportError).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    await events.recordSecurityEvent(wrongPassword, requestFrom());
    await events.flushSecurityEvents();
    expect(h.reportError).toHaveBeenCalledTimes(2);
  });

  it('a busy writer (55P03, its 2 s turn wait) is an ordinary failed flush: dropped, same 10-minute window', async () => {
    h.rpc.mockResolvedValue({ data: null, error: { code: '55P03', message: 'lock timeout' } });
    await events.recordSecurityEvent(wrongPassword, requestFrom());
    await events.flushSecurityEvents();
    expect(events.__pendingSecurityEventsForTests()).toEqual([]);
    expect(h.reportError).toHaveBeenCalledTimes(1);
    expect((h.reportError.mock.calls[0] as unknown[])[1]).toEqual({
      tag: 'security.events_flush_failed',
      level: 'warning',
      extra: { code: '55P03', rows: 1 },
    });
    // Another failure inside the window, of any code, is not reported again.
    h.rpc.mockResolvedValue({ data: null, error: { code: '57014' } });
    await vi.advanceTimersByTimeAsync(60_000);
    await events.recordSecurityEvent(wrongPassword, requestFrom());
    await events.flushSecurityEvents();
    expect(h.reportError).toHaveBeenCalledTimes(1);
  });

  it('a client that cannot be made, or a call that throws, is a failed flush too', async () => {
    h.createAdminClient.mockImplementation(() => {
      throw new Error('SUPABASE_SERVICE_ROLE_KEY is not configured');
    });
    await events.recordSecurityEvent(wrongPassword, requestFrom());
    await expect(events.flushSecurityEvents()).resolves.toBeUndefined();
    expect(h.reportError).toHaveBeenCalledTimes(1);
    expect((h.reportError.mock.calls[0] as unknown[])[1]).toMatchObject({
      extra: { code: 'Error', rows: 1 },
    });

    events.__resetSecurityEventsForTests();
    h.createAdminClient.mockImplementation(adminClient);
    h.rpc.mockRejectedValue(new TypeError('fetch failed'));
    await events.recordSecurityEvent(wrongPassword, requestFrom());
    await expect(events.flushSecurityEvents()).resolves.toBeUndefined();
    expect(h.reportError).toHaveBeenCalledTimes(2);
  });

  it('the timer flush that fails settles the kept-alive promise, never rejecting it', async () => {
    h.rpc.mockRejectedValue(new Error('down'));
    await events.recordSecurityEvent(wrongPassword, requestFrom());
    const kept = h.keepAlive.mock.calls[0]![0] as Promise<unknown>;
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(kept).resolves.toBeUndefined();
  });
});
