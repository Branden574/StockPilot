// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ONE buffer per server instance, however many copies of the module a build
 * makes. A production build can bundle server/security/events.ts into more
 * than one chunk (a route handler's and a server action's), and each copy
 * evaluates the module again. The recorder's promises (one buffer, one flush
 * call at a time, one failure report per ten minutes, the memory bound) are
 * about the instance, so its state lives on globalThis and every copy shares
 * it. Here two copies are made by evaluating the module twice.
 *
 * Addresses are from the documentation ranges (RFC 5737).
 */

const h = vi.hoisted(() => ({
  rpc: vi.fn(),
  reportError: vi.fn(async () => undefined),
  keepAlive: vi.fn(),
  env: { CRON_SECRET: 'test-cron-secret' } as { CRON_SECRET?: string },
}));

vi.mock('next/headers', () => ({
  headers: async () => {
    throw new Error('`headers` was called outside a request scope.');
  },
}));
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    rpc: (...args: unknown[]) => {
      const builder = {
        abortSignal() {
          return builder;
        },
        then(ok?: (value: unknown) => unknown, bad?: (reason: unknown) => unknown) {
          return Promise.resolve(h.rpc(...args)).then(ok, bad);
        },
      };
      return builder;
    },
  }),
}));
vi.mock('@/lib/error-reporter', () => ({ reportError: h.reportError }));
vi.mock('@/server/services/lib/defer', () => ({ keepAlive: h.keepAlive, defer: vi.fn() }));
vi.mock('@/lib/env', () => ({
  get env() {
    return h.env;
  },
}));

type Events = typeof import('./events');
let first: Events;
let second: Events;

const requestFrom = (address: string) =>
  new Headers({ 'x-forwarded-for': `${address}, 10.0.0.1`, 'x-vercel-ip-country': 'NL' });

const probe = { category: 'exploit', outcome: 'blocked', reason: 'env_file', source: 'web' } as const;
const wrongPassword = {
  category: 'password_guessing',
  outcome: 'blocked',
  reason: 'wrong_password',
  source: 'web',
} as const;

beforeEach(async () => {
  vi.useFakeTimers({ now: new Date('2026-11-21T10:15:05Z') });
  vi.stubEnv('VERCEL', '1');
  h.rpc.mockReset();
  h.rpc.mockResolvedValue({ data: 1, error: null });
  h.reportError.mockClear();
  h.keepAlive.mockReset();
  vi.resetModules();
  first = await vi.importActual<Events>('./events');
  vi.resetModules();
  second = await vi.importActual<Events>('./events');
  first.__resetSecurityEventsForTests();
});

afterEach(() => {
  first.__resetSecurityEventsForTests();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('two copies of the recorder in one server instance', () => {
  it('are two evaluations of the module', () => {
    expect(first).not.toBe(second);
    expect(first.recordSecurityEvent).not.toBe(second.recordSecurityEvent);
  });

  it('share one buffer: what one copy records, the other sees waiting', async () => {
    await first.recordSecurityEvent(probe, requestFrom('203.0.113.7'));
    await second.recordSecurityEvent(wrongPassword, requestFrom('198.51.100.9'));
    expect(first.__pendingSecurityEventsForTests()).toHaveLength(2);
    expect(second.__pendingSecurityEventsForTests()).toHaveLength(2);
  });

  it('schedule one flush between them, and one call carries both copies events', async () => {
    await first.recordSecurityEvent(probe, requestFrom('203.0.113.7'));
    await second.recordSecurityEvent(wrongPassword, requestFrom('198.51.100.9'));
    expect(h.keepAlive).toHaveBeenCalledTimes(1);
    await second.flushSecurityEvents();
    expect(h.rpc).toHaveBeenCalledTimes(1);
    const [name, args] = h.rpc.mock.calls[0]!;
    expect(name).toBe('record_security_events');
    expect((args as { p_events: unknown[] }).p_events).toHaveLength(2);
    expect(first.__pendingSecurityEventsForTests()).toHaveLength(0);
  });

  it('keep to one call at a time: while one copy has a call out, the other sends none', async () => {
    let answer: (value: unknown) => void = () => undefined;
    h.rpc.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    await first.recordSecurityEvent(probe, requestFrom('203.0.113.7'));
    const out = first.flushSecurityEvents();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.rpc).toHaveBeenCalledTimes(1);

    await second.recordSecurityEvent(wrongPassword, requestFrom('198.51.100.9'));
    await second.flushSecurityEvents();
    expect(h.rpc).toHaveBeenCalledTimes(1);
    expect(second.__pendingSecurityEventsForTests()).toHaveLength(1);

    answer({ data: 1, error: null });
    await out;
  });

  it('report a failed flush once between them in ten minutes', async () => {
    h.rpc.mockResolvedValue({ data: null, error: { code: '57014', message: 'made-up failure' } });
    await first.recordSecurityEvent(probe, requestFrom('203.0.113.7'));
    await first.flushSecurityEvents();
    await vi.advanceTimersByTimeAsync(1_000);
    await second.recordSecurityEvent(wrongPassword, requestFrom('198.51.100.9'));
    await second.flushSecurityEvents();
    expect(h.rpc).toHaveBeenCalledTimes(2);
    expect(h.reportError).toHaveBeenCalledTimes(1);
  });
});
