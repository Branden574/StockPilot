// @vitest-environment node
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Security invariant: the recorder of what scanners asked for
 * (server/security/event-samples.ts), the real module (src/test/setup.ts
 * replaces it with a no-op for every other test). Its own module, buffer,
 * timer and counters (review S1); never throws and is never waited on; at
 * most 50 different samples wait, merged by hour, reason, method, target,
 * query string and country with their counts added (at most 999,999); a full
 * buffer drops; one call about ten seconds after the first sample; 55P03 and
 * a missing writer drop the batch; after every call one count line of
 * numbers (review S7), at warning level when the writer skipped anything.
 * Never an address, a city, a header value or any text of a sample in a log
 * line or a report.
 *
 * Addresses are from the documentation ranges (RFC 5737); paths are made up.
 */

const h = vi.hoisted(() => ({
  rpc: vi.fn(),
  createAdminClient: vi.fn(),
  reportError: vi.fn(async () => undefined),
  keepAlive: vi.fn(),
  signals: [] as AbortSignal[],
  env: { CRON_SECRET: 'test-cron-secret' } as { CRON_SECRET?: string },
}));

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: h.createAdminClient }));
vi.mock('@/lib/error-reporter', () => ({ reportError: h.reportError }));
vi.mock('@/server/services/lib/defer', () => ({ keepAlive: h.keepAlive, defer: vi.fn() }));
vi.mock('@/lib/env', () => ({
  get env() {
    return h.env;
  },
}));

type Samples = typeof import('./event-samples');
let samples: Samples;

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

const ANSWER = (stored: number, overflowed = 0, skipped = 0, notRead = 0) => ({
  data: { stored, overflowed, skipped, not_read: notRead, not_a_list: false },
  error: null,
});

const from = (country = 'NL') =>
  new Headers({
    'x-forwarded-for': '203.0.113.7, 10.0.0.1',
    'x-vercel-ip-country': country,
    'x-vercel-ip-city': 'Utrecht',
    cookie: 'example=value',
  });

const probe = (overrides: Record<string, unknown> = {}) =>
  ({
    reason: 'env_file',
    method: 'GET',
    target: '/backup/.env',
    sample: 'debug=1',
    ...overrides,
  }) as Parameters<Samples['recordSecurityEventSample']>[0];

let info: ReturnType<typeof vi.spyOn>;
let warn: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  vi.useFakeTimers({ now: new Date('2026-11-24T10:15:05Z') });
  vi.stubEnv('VERCEL', '1');
  h.rpc.mockReset();
  h.rpc.mockResolvedValue(ANSWER(1));
  h.createAdminClient.mockReset();
  h.createAdminClient.mockImplementation(adminClient);
  h.signals = [];
  h.reportError.mockClear();
  h.keepAlive.mockReset();
  info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  samples = await vi.importActual<Samples>('./event-samples');
  samples.__resetSecurityEventSamplesForTests();
});

afterEach(() => {
  samples.__resetSecurityEventSamplesForTests();
  info.mockRestore();
  warn.mockRestore();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

/** The elements of the n-th call. */
function sent(call = 0): Array<Record<string, unknown>> {
  const [name, args] = h.rpc.mock.calls[call]!;
  expect(name).toBe('record_security_event_samples');
  return (args as { p_samples: Array<Record<string, unknown>> }).p_samples;
}

/** Every count line written, parsed. */
function countLines(): Array<Record<string, unknown>> {
  return [...info.mock.calls, ...warn.mock.calls]
    .map((c) => String(c[0]))
    .filter((line) => line.includes('"security.event_samples"'))
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('recordSecurityEventSample: never on the caller path', () => {
  it('returns nothing, sends nothing until the flush, and keeps the flush alive', async () => {
    const result = samples.recordSecurityEventSample(probe(), from());
    expect(result).toBeUndefined();
    expect(h.rpc).not.toHaveBeenCalled();
    expect(h.keepAlive).toHaveBeenCalledTimes(1);
    expect(h.keepAlive.mock.calls[0]![0]).toBeInstanceOf(Promise);
    await vi.advanceTimersByTimeAsync(samples.SAMPLE_FLUSH_DELAY_MS - 1);
    expect(h.rpc).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(h.rpc).toHaveBeenCalledTimes(1);
  });

  it('one flush for everything that arrives before it: one call, every element', async () => {
    for (let i = 0; i < 5; i++)
      samples.recordSecurityEventSample(probe({ target: `/backup${i}/.env` }), from());
    await vi.advanceTimersByTimeAsync(samples.SAMPLE_FLUSH_DELAY_MS);
    expect(h.rpc).toHaveBeenCalledTimes(1);
    expect(sent()).toHaveLength(5);
  });

  it('sends the element the contract names, with the country and nothing else of the request', async () => {
    samples.recordSecurityEventSample(probe(), from());
    await samples.flushSecurityEventSamples();
    expect(sent()).toEqual([
      {
        category: 'exploit',
        reason: 'env_file',
        source: 'web',
        method: 'GET',
        target: '/backup/.env',
        sample: 'debug=1',
        country: 'NL',
        count: 1,
        at_ms: Date.parse('2026-11-24T10:15:05Z'),
      },
    ]);
    const text = JSON.stringify(h.rpc.mock.calls);
    for (const value of ['203.0.113.7', 'Utrecht', 'example=value', '10.0.0.1']) {
      expect(text.includes(value), value).toBe(false);
    }
  });

  it('no country off Vercel, or with no headers, or a malformed one', async () => {
    samples.recordSecurityEventSample(probe({ target: '/a/.env' }), from('nl'));
    samples.recordSecurityEventSample(probe({ target: '/b/.env' }), null);
    vi.stubEnv('VERCEL', '');
    samples.recordSecurityEventSample(probe({ target: '/c/.env' }), from());
    await samples.flushSecurityEventSamples();
    expect(sent().map((e) => e.country)).toEqual([null, null, null]);
  });

  it.each([
    ['a reason that is not a probe kind', { reason: 'wrong_password' }],
    ['a method outside the seven', { method: 'TRACE' }],
    ['a target the table refuses', { target: '/someone@example.com' }],
    ['the overflow word as a target', { target: '(more than could be listed)' }],
    ['a target that is not a path', { target: 'backup/.env' }],
    ['a query string the table refuses', { sample: 'id=123456' }],
    ['a query string that is not text', { sample: 42 }],
  ])('drops %s without a word, and never throws', async (_what, overrides) => {
    expect(() => samples.recordSecurityEventSample(probe(overrides), from())).not.toThrow();
    expect(samples.__pendingSecurityEventSamplesForTests()).toEqual([]);
    expect(h.keepAlive).not.toHaveBeenCalled();
  });

  it('never throws, whatever it is handed', () => {
    const hostile = {
      get(): string | null {
        throw new Error('example failure');
      },
    };
    expect(() => samples.recordSecurityEventSample(probe(), hostile)).not.toThrow();
    expect(() => samples.recordSecurityEventSample(null as never)).not.toThrow();
    expect(() => samples.recordSecurityEventSample(undefined as never, undefined)).not.toThrow();
  });

  it('(unreadable) is a target it keeps', () => {
    samples.recordSecurityEventSample(probe({ target: '(unreadable)', sample: null }), from());
    expect(samples.__pendingSecurityEventSamplesForTests()).toHaveLength(1);
  });
});

describe('the buffer', () => {
  it('merges by hour, reason, method, target, query string and country, adding counts', async () => {
    samples.recordSecurityEventSample(probe(), from());
    samples.recordSecurityEventSample(probe(), from());
    vi.setSystemTime(new Date('2026-11-24T10:59:59Z'));
    samples.recordSecurityEventSample(probe(), from());
    // Each of these is another row.
    samples.recordSecurityEventSample(probe({ method: 'POST' }), from());
    samples.recordSecurityEventSample(probe({ sample: null }), from());
    samples.recordSecurityEventSample(probe({ sample: 'debug=2' }), from());
    samples.recordSecurityEventSample(probe({ target: '/old/.env' }), from());
    samples.recordSecurityEventSample(probe({ reason: 'git_dir' }), from());
    samples.recordSecurityEventSample(probe(), from('US'));
    vi.setSystemTime(new Date('2026-11-24T11:00:00Z'));
    samples.recordSecurityEventSample(probe(), from());
    await samples.flushSecurityEventSamples();
    const elements = sent();
    expect(elements).toHaveLength(8);
    expect(elements[0]).toMatchObject({ count: 3, at_ms: Date.parse('2026-11-24T10:59:59Z') });
    expect(elements.slice(1).every((e) => e.count === 1)).toBe(true);
  });

  it('a count stops at 999,999', () => {
    for (let i = 0; i < 1_000_002; i++) samples.recordSecurityEventSample(probe(), null);
    expect(samples.__pendingSecurityEventSamplesForTests()).toEqual([
      expect.objectContaining({ count: 999_999 }),
    ]);
  });

  it('holds at most 50 different samples: a new one past that is dropped and counted; a waiting one still adds', async () => {
    for (let i = 0; i < 50; i++)
      samples.recordSecurityEventSample(probe({ target: `/b${i}/.env` }), from());
    samples.recordSecurityEventSample(probe({ target: '/one-more/.env' }), from());
    samples.recordSecurityEventSample(probe({ target: '/and-another/.env' }), from());
    samples.recordSecurityEventSample(probe({ target: '/b0/.env' }), from());
    const pending = samples.__pendingSecurityEventSamplesForTests();
    expect(pending).toHaveLength(50);
    expect(pending.some((s) => s.target === '/one-more/.env')).toBe(false);
    expect(pending[0]!.count).toBe(2);
    h.rpc.mockResolvedValueOnce(ANSWER(50));
    await samples.flushSecurityEventSamples();
    expect(sent()).toHaveLength(50);
    expect(countLines()).toEqual([
      {
        tag: 'security.event_samples',
        stored: 50,
        overflowed: 0,
        skipped: 0,
        not_read: 0,
        dropped: 2,
        busy: 0,
        failed: 0,
      },
    ]);
  });

  it('its state is its own: its own registered symbol, nothing of the security events recorder', () => {
    const src = readFileSync(path.join(__dirname, 'event-samples.ts'), 'utf8');
    expect(src).toMatch(/Symbol\.for\('stockpilot\.security-event-samples\.recorder-state\.v1'\)/);
    expect(src).not.toMatch(/from '\.\/events'|from '@\/server\/security\/events'/);
    expect(src).not.toMatch(/stockpilot\.security-events\.recorder-state/);
    expect(src.trimStart().startsWith("import 'server-only';")).toBe(true);
  });
});

describe('the flush', () => {
  it('one call at a time: a flush while a call is out leaves its samples for the next', async () => {
    let answer!: (v: unknown) => void;
    h.rpc.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
    samples.recordSecurityEventSample(probe({ target: '/first/.env' }), from());
    const first = samples.flushSecurityEventSamples();
    await Promise.resolve();
    samples.recordSecurityEventSample(probe({ target: '/second/.env' }), from());
    await samples.flushSecurityEventSamples();
    expect(h.rpc).toHaveBeenCalledTimes(1);
    expect(samples.__pendingSecurityEventSamplesForTests().map((s) => s.target)).toEqual([
      '/second/.env',
    ]);
    answer(ANSWER(1));
    await first;
    await vi.advanceTimersByTimeAsync(samples.SAMPLE_FLUSH_DELAY_MS);
    expect(h.rpc).toHaveBeenCalledTimes(2);
    expect(sent(1).map((e) => e.target)).toEqual(['/second/.env']);
  });

  it('55P03: the batch is dropped, counted on the line, never retried and not reported', async () => {
    h.rpc.mockResolvedValueOnce({ data: null, error: { code: '55P03', message: 'lock timeout' } });
    samples.recordSecurityEventSample(probe({ target: '/a/.env' }), from());
    samples.recordSecurityEventSample(probe({ target: '/b/.env' }), from());
    await samples.flushSecurityEventSamples();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.rpc).toHaveBeenCalledTimes(1);
    expect(samples.__pendingSecurityEventSamplesForTests()).toEqual([]);
    expect(h.reportError).not.toHaveBeenCalled();
    expect(countLines()).toEqual([
      {
        tag: 'security.event_samples',
        stored: 0,
        overflowed: 0,
        skipped: 0,
        not_read: 0,
        dropped: 0,
        busy: 2,
        failed: 0,
      },
    ]);
  });

  it.each(['42883', 'PGRST202'])(
    'the writer missing (%s): dropped, said once per instance, not per call',
    async (code) => {
      h.rpc.mockResolvedValue({ data: null, error: { code, message: 'function not found' } });
      for (let call = 0; call < 3; call++) {
        samples.recordSecurityEventSample(probe({ target: `/c${call}/.env` }), from());
        await samples.flushSecurityEventSamples();
      }
      expect(h.rpc).toHaveBeenCalledTimes(3);
      const missing = warn.mock.calls
        .map((c) => String(c[0]))
        .filter((l) => l.includes('security.event_samples_missing'));
      expect(missing).toEqual([JSON.stringify({ tag: 'security.event_samples_missing', rows: 1 })]);
      expect(countLines()).toEqual([]);
      expect(h.reportError).not.toHaveBeenCalled();
    },
  );

  it('any other failure: dropped, counted, reported once per ten minutes with the code and the row count only', async () => {
    h.rpc.mockResolvedValue({ data: null, error: { code: '57014', message: 'statement timeout' } });
    samples.recordSecurityEventSample(probe(), from());
    await samples.flushSecurityEventSamples();
    samples.recordSecurityEventSample(probe(), from());
    await samples.flushSecurityEventSamples();
    expect(h.reportError).toHaveBeenCalledTimes(1);
    expect(h.reportError).toHaveBeenCalledWith(expect.any(Error), {
      tag: 'security.event_samples_flush_failed',
      level: 'warning',
      extra: { code: '57014', rows: 1 },
    });
    expect(countLines().map((l) => l.failed)).toEqual([1, 1]);
    vi.advanceTimersByTime(samples.SAMPLE_FAILURE_REPORT_INTERVAL_MS);
    samples.recordSecurityEventSample(probe(), from());
    await samples.flushSecurityEventSamples();
    expect(h.reportError).toHaveBeenCalledTimes(2);
  });

  it('an answer without its counts, a call that throws, and one that never answers are failures too', async () => {
    h.rpc.mockResolvedValueOnce({ data: { stored: 'many' }, error: null });
    samples.recordSecurityEventSample(probe(), from());
    await samples.flushSecurityEventSamples();
    expect(countLines().at(-1)).toMatchObject({ stored: 0, failed: 1 });

    h.rpc.mockRejectedValueOnce(new Error('fetch failed'));
    samples.recordSecurityEventSample(probe(), from());
    await samples.flushSecurityEventSamples();
    expect(countLines().at(-1)).toMatchObject({ failed: 1 });

    h.rpc.mockImplementationOnce(() => new Promise(() => undefined));
    samples.recordSecurityEventSample(probe(), from());
    const pending = samples.flushSecurityEventSamples();
    await vi.advanceTimersByTimeAsync(samples.SAMPLE_FLUSH_CALL_TIMEOUT_MS);
    await pending;
    expect(h.signals.at(-1)!.aborted).toBe(true);
    expect(countLines().at(-1)).toMatchObject({ failed: 1 });
  });
});

describe('the count line', () => {
  it('after every call, one line: its tag and numbers only, never a target, query string or country', async () => {
    h.rpc.mockResolvedValueOnce(ANSWER(3, 2, 0, 0));
    samples.recordSecurityEventSample(
      probe({ target: '/example-target/.env', sample: 'example=query' }),
      from('NL'),
    );
    await samples.flushSecurityEventSamples();
    expect(info).toHaveBeenCalledTimes(1);
    const line = String(info.mock.calls[0]![0]);
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual([
      'tag',
      'stored',
      'overflowed',
      'skipped',
      'not_read',
      'dropped',
      'busy',
      'failed',
    ]);
    expect(parsed.tag).toBe('security.event_samples');
    for (const [key, value] of Object.entries(parsed)) {
      if (key !== 'tag') expect(typeof value, key).toBe('number');
    }
    for (const text of ['example-target', 'example=query', 'NL', 'env_file', 'GET']) {
      expect(line.includes(text), text).toBe(false);
    }
  });

  it('a skipped element is a scrubber fault: the line is a warning', async () => {
    h.rpc.mockResolvedValueOnce(ANSWER(0, 0, 1, 0));
    samples.recordSecurityEventSample(probe(), from());
    await samples.flushSecurityEventSamples();
    expect(info).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(warn.mock.calls[0]![0]))).toMatchObject({
      tag: 'security.event_samples',
      skipped: 1,
    });
  });

  it('a console that throws changes nothing', async () => {
    info.mockImplementation(() => {
      throw new Error('example failure');
    });
    samples.recordSecurityEventSample(probe(), from());
    await expect(samples.flushSecurityEventSamples()).resolves.toBeUndefined();
  });
});
