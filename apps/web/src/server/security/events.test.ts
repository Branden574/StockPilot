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
 *   - at most 100 distinct keys wait; the rest are counted per category,
 *     outcome and source on an over_buffer_cap entry with no place,
 *     organization or hash;
 *   - a failed flush drops its batch and is reported at most once per 10
 *     minutes, with no event content;
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

const wrongPassword = {
  category: 'password_guessing',
  outcome: 'blocked',
  reason: 'wrong_password',
  source: 'web',
} as const;

beforeEach(async () => {
  vi.useFakeTimers({ now: new Date('2026-11-21T10:15:05Z') });
  vi.stubEnv('VERCEL', '1');
  h.env = { CRON_SECRET: 'test-cron-secret' };
  h.rpc.mockReset();
  h.rpc.mockResolvedValue({ data: 1, error: null });
  h.createAdminClient.mockReset();
  h.createAdminClient.mockImplementation(() => ({ rpc: h.rpc }));
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

  it('at most 100 distinct keys wait; the rest are counted per category, outcome and source', async () => {
    for (let i = 0; i < 100; i++) {
      await events.recordSecurityEvent(wrongPassword, requestFrom(`203.0.113.${i + 1}`));
    }
    // Past the cap: three new keys of one category/outcome/source, one of another.
    await events.recordSecurityEvent(wrongPassword, requestFrom('198.51.100.1'));
    await events.recordSecurityEvent({ ...wrongPassword, organizationId: ORG }, requestFrom('198.51.100.2'));
    await events.recordSecurityEvent({ ...wrongPassword, reason: 'sign_in_paused' }, requestFrom());
    await events.recordSecurityEvent(
      { category: 'exploit', outcome: 'blocked', reason: 'env_file', source: 'web' },
      requestFrom(),
    );
    // A key that already waits still adds to its own count.
    await events.recordSecurityEvent(wrongPassword, requestFrom('203.0.113.1'));

    const pending = events.__pendingSecurityEventsForTests();
    expect(pending).toHaveLength(102);
    const listed = pending.filter((e) => e.reason !== 'over_buffer_cap');
    expect(listed).toHaveLength(100);
    expect(listed.find((e) => e.count === 2)).toBeDefined();
    const capped = pending.filter((e) => e.reason === 'over_buffer_cap');
    expect(capped).toEqual([
      {
        category: 'password_guessing',
        outcome: 'blocked',
        reason: 'over_buffer_cap',
        source: 'web',
        organization_id: null,
        country: null,
        city: null,
        source_hash: null,
        count: 3,
        at_ms: expect.any(Number),
      },
      {
        category: 'exploit',
        outcome: 'blocked',
        reason: 'over_buffer_cap',
        source: 'web',
        organization_id: null,
        country: null,
        city: null,
        source_hash: null,
        count: 1,
        at_ms: expect.any(Number),
      },
    ]);
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

  it('a full buffer is one call, under the writer’s 200 elements', async () => {
    for (let i = 0; i < 100; i++) {
      await events.recordSecurityEvent(wrongPassword, requestFrom(`203.0.113.${i + 1}`));
    }
    const categories = ['password_guessing', 'exploit', 'bots', 'phishing', 'malware'] as const;
    const outcomes = ['blocked', 'allowed', 'flagged'] as const;
    const sources = ['web', 'phone', 'api', 'email', 'edge'] as const;
    for (const category of categories)
      for (const outcome of outcomes)
        for (const source of sources)
          await events.recordSecurityEvent({ category, outcome, reason: 'x_new', source }, requestFrom());
    await events.flushSecurityEvents();
    expect(h.rpc).toHaveBeenCalledTimes(1);
    expect(sent().length).toBe(175);
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
    h.createAdminClient.mockImplementation(() => ({ rpc: h.rpc }));
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
