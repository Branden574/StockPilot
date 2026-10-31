import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * audit() and auditMany().
 *
 * Two defects from the 443-item lab run:
 *  - bulk Set rack fired one `void audit()` per item, 443 INSERTs at once; the
 *    gateway answered 190 of them 502 and the bulk op's next read failed too.
 *    auditMany writes the same rows 100 per INSERT, at most 2 in flight.
 *  - audit() awaited the INSERT without reading `error`. supabase-js returns a
 *    failed request as { error } rather than throwing, so the catch never ran:
 *    runs wrote 274, 286 and 253 of 443 rows and nothing was reported.
 */

const h = vi.hoisted(() => ({
  insert: vi.fn(),
  headersCalls: 0,
  reportError: vi.fn(),
  withContext: vi.fn(),
  after: vi.fn(),
}));

// Next's after(), which lib/defer.ts keepAlive hands each write to. A mock
// records what was registered; audit.keepalive.test.ts runs the real one.
vi.mock('next/server', () => ({ after: h.after }));
vi.mock('next/headers', () => ({
  headers: async () => {
    h.headersCalls += 1;
    const values: Record<string, string> = {
      'x-forwarded-for': '203.0.113.7, 10.0.0.1',
      'user-agent': 'lab-agent/1.0',
    };
    return { get: (k: string) => values[k] ?? null };
  },
}));
// Shaped like the real postgrest builder: lazy, thenable, and carrying an
// optional abort signal. `h.insert(rows, signal)` answers the request.
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: () => ({
      insert: (rows: unknown) => {
        let signal: AbortSignal | undefined;
        const builder = {
          abortSignal(s: AbortSignal) {
            signal = s;
            return builder;
          },
          then(onOk: (v: unknown) => unknown, onErr?: (e: unknown) => unknown) {
            return Promise.resolve()
              .then(() => h.insert(rows, signal))
              .then(onOk, onErr);
          },
        };
        return builder;
      },
    }),
  }),
}));
vi.mock('@/lib/error-reporter', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/error-reporter')>()),
  reportError: h.reportError,
}));
vi.mock('./context', () => ({ withContext: h.withContext }));
// src/test/setup.ts stubs this module for every other test; this file tests
// the real one.
vi.unmock('@/server/services/audit');

import {
  audit,
  AUDIT_INSERT_BATCH_ROWS,
  AUDIT_INSERT_CONCURRENCY,
  AUDIT_INSERT_TIMEOUT_MS,
  AUDIT_LOSS_REPORT_WINDOW_MS,
  auditMany,
  insertAuditRowReported,
  resetAuditLossReportsForTests,
  type AuditPayload,
} from './audit';
import type { ServiceContext } from './context';

const ctx = { organizationId: 'org-1', userId: 'user-1' } as unknown as ServiceContext;

const SENSITIVE_NAME = 'Item name that must never reach a report';

function payload(i: number): AuditPayload {
  return {
    event: 'inventory.item.updated',
    entityType: 'inventory_item',
    entityId: `item-${i}`,
    before: { bin_location: SENSITIVE_NAME },
    after: { bin_location: '947-Q' },
    extra: { bulk_op: 'set_rack', changed_keys: ['bin_location'] },
  };
}

const ok = { error: null, status: 201, statusText: 'Created' };
const badGateway = { error: { message: '', code: '' }, status: 502, statusText: 'Bad Gateway' };

beforeEach(() => {
  h.insert.mockReset();
  h.reportError.mockReset();
  h.withContext.mockReset();
  h.after.mockReset();
  h.headersCalls = 0;
  resetAuditLossReportsForTests();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('audit()', () => {
  it('reports a refused INSERT with the event and the status, never the row', async () => {
    h.insert.mockResolvedValue(badGateway);
    await audit(payload(1), ctx);
    expect(h.reportError).toHaveBeenCalledTimes(1);
    const [, report] = h.reportError.mock.calls[0]!;
    expect(report).toMatchObject({
      tag: 'audit.write_failed',
      organizationId: 'org-1',
      extra: { event: 'inventory.item.updated', lost: 1, status: 502 },
    });
    expect(JSON.stringify(h.reportError.mock.calls)).not.toContain(SENSITIVE_NAME);
  });

  it('writes the row it has always written: user, IP, user agent, event and metadata', async () => {
    h.insert.mockResolvedValue(ok);
    await audit(payload(7), ctx);
    expect(h.insert).toHaveBeenCalledWith(
      {
        organization_id: 'org-1',
        user_id: 'user-1',
        event: 'inventory.item.updated',
        ip: '203.0.113.7',
        user_agent: 'lab-agent/1.0',
        metadata: {
          entity_type: 'inventory_item',
          entity_id: 'item-7',
          warehouse_id: null,
          before: { bin_location: SENSITIVE_NAME },
          after: { bin_location: '947-Q' },
          reason: null,
          bulk_op: 'set_rack',
          changed_keys: ['bin_location'],
        },
      },
      expect.any(AbortSignal),
    );
  });

  it('reports nothing when the row is written', async () => {
    h.insert.mockResolvedValue(ok);
    await audit(payload(1), ctx);
    expect(h.insert).toHaveBeenCalledTimes(1);
    expect(h.reportError).not.toHaveBeenCalled();
  });

  it('never throws, even when the INSERT itself rejects', async () => {
    h.insert.mockRejectedValue(new TypeError('fetch failed'));
    await expect(audit(payload(1), ctx)).resolves.toBeUndefined();
    expect(h.reportError).toHaveBeenCalledTimes(1);
  });
});

// The four places that shape their own row (auth events, a platform admin's
// cross-organization event, invite acceptance, email change) wrapped
// `await insert` in try/catch, which never sees a refused write: supabase-js
// returns it as { error }.
describe('insertAuditRowReported()', () => {
  const row = {
    organization_id: null,
    user_id: 'user-9',
    event: 'user.sign_in_failed' as const,
    ip: '203.0.113.7',
    user_agent: 'lab-agent/1.0',
    metadata: { entity_type: 'user', entity_id: 'user-9', attempted_email: SENSITIVE_NAME },
  };

  it('writes exactly the row it was given, organization_id null included', async () => {
    h.insert.mockResolvedValue(ok);
    await expect(insertAuditRowReported(row)).resolves.toBe(true);
    expect(h.insert).toHaveBeenCalledWith(row, expect.any(AbortSignal));
    expect(h.reportError).not.toHaveBeenCalled();
  });

  it('reports a refused INSERT with the event and the status, never the row', async () => {
    h.insert.mockResolvedValue({
      error: { message: `Failing row contains (${SENSITIVE_NAME})`, code: '23502' },
      status: 400,
      statusText: 'Bad Request',
    });
    await expect(insertAuditRowReported(row)).resolves.toBe(false);
    expect(h.reportError).toHaveBeenCalledTimes(1);
    const [, report] = h.reportError.mock.calls[0]!;
    expect(report).toMatchObject({
      tag: 'audit.write_failed',
      organizationId: null,
      extra: { event: 'user.sign_in_failed', entityType: 'user', lost: 1, status: 400, code: '23502' },
    });
    expect(JSON.stringify(h.reportError.mock.calls)).not.toContain(SENSITIVE_NAME);
  });

  it('never throws, even when the INSERT itself rejects', async () => {
    h.insert.mockRejectedValue(new TypeError('fetch failed'));
    await expect(insertAuditRowReported(row)).resolves.toBe(false);
    expect(h.reportError).toHaveBeenCalledTimes(1);
  });
});

describe('auditMany()', () => {
  it('writes 443 rows in INSERTs of 100 with at most 2 in flight', async () => {
    let inFlight = 0;
    let peak = 0;
    h.insert.mockImplementation(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 2));
      inFlight -= 1;
      return ok;
    });
    const payloads = Array.from({ length: 443 }, (_, i) => payload(i));
    const res = await auditMany(payloads, ctx);

    expect(res).toEqual({ written: 443, lost: 0 });
    expect(AUDIT_INSERT_BATCH_ROWS).toBe(100);
    expect(AUDIT_INSERT_CONCURRENCY).toBe(2);
    expect(h.insert.mock.calls.map(([rows]) => (rows as unknown[]).length)).toEqual([
      100, 100, 100, 100, 43,
    ]);
    expect(peak).toBe(2);
    // The request headers are read once for the whole batch.
    expect(h.headersCalls).toBe(1);
    expect(h.reportError).not.toHaveBeenCalled();
  });

  it('writes exactly the row audit() writes for the same payload', async () => {
    h.insert.mockResolvedValue(ok);
    await audit(payload(7), ctx);
    const single = h.insert.mock.calls[0]![0];
    h.insert.mockClear();

    await auditMany([payload(7)], ctx);
    const [batch] = h.insert.mock.calls[0]! as [unknown[]];
    expect(batch).toEqual([single]);
  });

  it('keeps writing after a failed chunk and reports how many rows were lost', async () => {
    let n = 0;
    h.insert.mockImplementation(async () => {
      n += 1;
      if (n === 2) return badGateway;
      if (n === 4) throw new TypeError('fetch failed');
      return ok;
    });
    const payloads = Array.from({ length: 443 }, (_, i) => payload(i));
    const res = await auditMany(payloads, ctx);

    expect(h.insert).toHaveBeenCalledTimes(5);
    expect(res).toEqual({ written: 243, lost: 200 });
    expect(h.reportError).toHaveBeenCalledTimes(1);
    const [, report] = h.reportError.mock.calls[0]!;
    expect(report).toMatchObject({
      tag: 'audit.write_failed',
      level: 'warning',
      organizationId: 'org-1',
      extra: { event: 'inventory.item.updated', lost: 200, total: 443, status: 502 },
    });
    expect(JSON.stringify(h.reportError.mock.calls)).not.toContain(SENSITIVE_NAME);
  });

  it('reports every row as lost when the context cannot be read, and never throws', async () => {
    h.withContext.mockRejectedValue(new Error('no session'));
    const res = await auditMany([payload(1), payload(2)]);
    expect(res).toEqual({ written: 0, lost: 2 });
    expect(h.insert).not.toHaveBeenCalled();
    expect(h.reportError.mock.calls[0]![1]).toMatchObject({ extra: { lost: 2, total: 2 } });
  });

  it('does nothing for an empty list', async () => {
    const res = await auditMany([], ctx);
    expect(res).toEqual({ written: 0, lost: 0 });
    expect(h.insert).not.toHaveBeenCalled();
    expect(h.headersCalls).toBe(0);
  });
});

/**
 * B9: the six scheduled jobs (restore points, auto-reorder, recurring POs,
 * auto-archive, auto-delete, daily briefing) run under a context that BORROWS
 * an owner's or admin's user id, and their rows carried nothing else to say a
 * job wrote them. Readers had only the user agent to guess from: the platform
 * console's Last active (0351 allowlists browser and app agents) and the
 * hourly anomaly monitor, which does not read the agent at all and counted a
 * nightly auto-archive of 25 items as that person mass-archiving.
 */
describe('rows a scheduled job writes (metadata.is_system)', () => {
  const systemCtx = {
    organizationId: 'org-1',
    userId: 'user-1',
    isSystem: true,
  } as unknown as ServiceContext;
  type Row = { user_id: string; metadata: Record<string, unknown> };

  it('audit() marks the row as written by the system, keeping the borrowed user id', async () => {
    h.insert.mockResolvedValue(ok);
    await audit(payload(3), systemCtx);
    const [row] = h.insert.mock.calls[0]! as [Row];
    expect(row.user_id).toBe('user-1');
    expect(row.metadata).toMatchObject({
      entity_id: 'item-3',
      bulk_op: 'set_rack',
      is_system: true,
    });
  });

  it("auditMany() marks every row, and a payload's extra cannot unmark one", async () => {
    h.insert.mockResolvedValue(ok);
    await auditMany([payload(1), { ...payload(2), extra: { is_system: false } }], systemCtx);
    const [rows] = h.insert.mock.calls[0]! as [Row[]];
    expect(rows.map((r) => r.metadata.is_system)).toEqual([true, true]);
  });

  it("a person's row never carries the mark, even when a payload's extra names it", async () => {
    h.insert.mockResolvedValue(ok);
    await audit({ ...payload(4), extra: { is_system: true, bulk_op: 'set_rack' } }, ctx);
    await auditMany([{ ...payload(5), extra: { is_system: true } }], ctx);
    const [one] = h.insert.mock.calls[0]! as [Row];
    const [[many]] = h.insert.mock.calls[1]! as [Row[]];
    expect(one.metadata).not.toHaveProperty('is_system');
    expect(one.metadata.bulk_op).toBe('set_rack');
    expect(many!.metadata).not.toHaveProperty('is_system');
  });
});

/**
 * Review of this branch: audit() now reports a lost row, one report per failed
 * INSERT. reportError posts to the alerts webhook on every call, with no
 * dedupe, so the placement pass of a bulk Set rack during a gateway incident
 * (409 transfers, one audit() each) could post hundreds of webhooks at once.
 */
describe('lost-row reports during an incident', () => {
  it('sends one report for a burst of failed writes, then one with the running count', async () => {
    vi.useFakeTimers();
    h.insert.mockResolvedValue(badGateway);
    await Promise.all(Array.from({ length: 409 }, (_, i) => audit(payload(i), ctx)));

    // The first loss is reported at once, so the incident is never silent.
    expect(h.reportError).toHaveBeenCalledTimes(1);
    expect(h.reportError.mock.calls[0]![1]).toMatchObject({
      tag: 'audit.write_failed',
      organizationId: 'org-1',
      extra: { event: 'inventory.item.updated', lost: 1, status: 502 },
    });

    // The other 408 are counted and sent as ONE report when the window closes.
    await vi.advanceTimersByTimeAsync(AUDIT_LOSS_REPORT_WINDOW_MS);
    expect(h.reportError).toHaveBeenCalledTimes(2);
    expect(h.reportError.mock.calls[1]![1]).toMatchObject({
      tag: 'audit.write_failed',
      level: 'warning',
      organizationId: 'org-1',
      extra: { event: 'inventory.item.updated', lost: 408, total: 408, status: 502 },
    });
    expect(JSON.stringify(h.reportError.mock.calls)).not.toContain(SENSITIVE_NAME);

    // A quiet window sends nothing more.
    await vi.advanceTimersByTimeAsync(AUDIT_LOSS_REPORT_WINDOW_MS * 3);
    expect(h.reportError).toHaveBeenCalledTimes(2);

    // After that, the next loss is reported at once again.
    await audit(payload(1), ctx);
    expect(h.reportError).toHaveBeenCalledTimes(3);
    expect(h.reportError.mock.calls[2]![1]).toMatchObject({ extra: { lost: 1 } });
  });

  it('folds a batched loss into the open window, and keeps each organization separate', async () => {
    vi.useFakeTimers();
    h.insert.mockResolvedValue(badGateway);
    await auditMany(
      Array.from({ length: 443 }, (_, i) => payload(i)),
      ctx,
    );
    await auditMany(
      Array.from({ length: 200 }, (_, i) => payload(i)),
      ctx,
    );
    await audit(payload(1), ctx);
    const otherOrg = { organizationId: 'org-2', userId: 'user-2' } as unknown as ServiceContext;
    await audit(payload(2), otherOrg);

    // org-1's first batch and org-2's first loss, at once.
    expect(h.reportError.mock.calls.map(([, r]) => [r.organizationId, r.extra.lost])).toEqual([
      ['org-1', 443],
      ['org-2', 1],
    ]);
    await vi.advanceTimersByTimeAsync(AUDIT_LOSS_REPORT_WINDOW_MS);
    expect(h.reportError).toHaveBeenCalledTimes(3);
    expect(h.reportError.mock.calls[2]![1]).toMatchObject({
      organizationId: 'org-1',
      extra: { lost: 201, total: 201 },
    });
  });

  it('does not count a Next.js redirect as a lost row', async () => {
    vi.useFakeTimers();
    h.withContext.mockRejectedValue(
      Object.assign(new Error('NEXT_REDIRECT'), {
        digest: 'NEXT_REDIRECT;replace;/signin;307;',
      }),
    );
    await audit(payload(1));
    await audit(payload(2));
    await vi.advanceTimersByTimeAsync(AUDIT_LOSS_REPORT_WINDOW_MS);
    // Handed to reportError (which drops control flow quietly), never counted.
    expect(h.reportError.mock.calls.every(([, r]) => r.extra?.lost === undefined)).toBe(true);
  });
});

/**
 * Review of this branch: bulk actions now AWAIT their audit INSERTs, and the
 * admin client's fetch has no timeout. A gateway that accepts the connection
 * and never answers (the 2026-09-22 Supabase-entry stalls) held the finished
 * action until undici gave up, about 300 s.
 */
describe('an INSERT that never answers', () => {
  it('auditMany gives up after AUDIT_INSERT_TIMEOUT_MS per request and reports the rows as lost', async () => {
    vi.useFakeTimers();
    const signals: Array<AbortSignal | undefined> = [];
    h.insert.mockImplementation((_rows: unknown, signal?: AbortSignal) => {
      signals.push(signal);
      return new Promise(() => {});
    });
    let settled: { written: number; lost: number } | null = null;
    void auditMany(
      Array.from({ length: 250 }, (_, i) => payload(i)),
      ctx,
    ).then((r) => {
      settled = r;
    });

    // Three chunks, two in flight: two rounds of one deadline each.
    await vi.advanceTimersByTimeAsync(AUDIT_INSERT_TIMEOUT_MS);
    expect(settled).toBeNull();
    await vi.advanceTimersByTimeAsync(AUDIT_INSERT_TIMEOUT_MS);
    expect(settled).toEqual({ written: 0, lost: 250 });

    // Each request carried a signal that was aborted, so the socket is let go.
    expect(signals).toHaveLength(3);
    expect(signals.every((s) => s?.aborted)).toBe(true);
    expect(h.reportError).toHaveBeenCalledTimes(1);
    expect(h.reportError.mock.calls[0]![1]).toMatchObject({
      tag: 'audit.write_failed',
      extra: { lost: 250, total: 250, timedOut: true },
    });
  });

  it('audit() gives up after AUDIT_INSERT_TIMEOUT_MS and reports the row as lost', async () => {
    vi.useFakeTimers();
    h.insert.mockImplementation(() => new Promise(() => {}));
    let done = false;
    void audit(payload(1), ctx).then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(AUDIT_INSERT_TIMEOUT_MS);
    expect(done).toBe(true);
    expect(h.reportError.mock.calls[0]![1]).toMatchObject({
      extra: { lost: 1, timedOut: true },
    });
  });

  it('a fast INSERT leaves no timer behind', async () => {
    vi.useFakeTimers();
    h.insert.mockResolvedValue(ok);
    await auditMany(
      Array.from({ length: 250 }, (_, i) => payload(i)),
      ctx,
    );
    await audit(payload(1), ctx);
    expect(vi.getTimerCount()).toBe(0);
  });
});

/**
 * 2026-09-24..10-12: 35 'Audit rows were not written' reports, each an
 * AuditInsertTimeout with no status. Every one came from a `void audit(...)`
 * whose INSERT was still in flight when the route returned. Nothing held the
 * invocation, so Vercel suspended the instance, and the next request resumed
 * it with the 5 s deadline long past: 33 rows had committed (the reply was
 * never read) and 2 Learn4Life item-create rows were never sent. Each writer
 * now hands its write to after() (lib/defer.ts keepAlive), so the platform
 * keeps the invocation up until the INSERT answers. audit.keepalive.test.ts
 * shows the same through Next's real App Route module.
 */
describe('the write outlives the response', () => {
  const signIn = {
    organization_id: null,
    user_id: 'user-9',
    event: 'user.sign_in_failed' as const,
    metadata: { entity_type: 'user', entity_id: 'user-9' },
  };
  const writers: Array<[string, () => Promise<unknown>]> = [
    ['audit()', () => audit(payload(1), ctx)],
    ['insertAuditRowReported()', () => insertAuditRowReported(signIn)],
    ['auditMany()', () => auditMany([payload(1), payload(2)], ctx)],
  ];
  /** Lets a write reach its INSERT (headers, context) before a check. */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  // Mutation caught: a writer that does not hand its write to after() (the
  // `void` shape), or hands it something other than the promise its caller
  // gets (a callback started after the response, a copy that settles early).
  it.each(writers)(
    '%s registers its write with after() once, and it settles only when the INSERT answers',
    async (_name, write) => {
      let answer!: (v: typeof ok) => void;
      h.insert.mockReturnValue(
        new Promise((resolve) => {
          answer = resolve;
        }),
      );
      const returned = write();
      try {
        expect(h.after).toHaveBeenCalledTimes(1);
        const registered = h.after.mock.calls[0]![0] as Promise<unknown>;
        // The promise the caller gets: a caller that awaits it sees no change.
        expect(registered).toBe(returned);
        let settled = false;
        void registered.then(() => {
          settled = true;
        });
        await settle();
        expect(h.insert).toHaveBeenCalledTimes(1);
        expect(settled).toBe(false);

        answer(ok);
        await returned;
        expect(settled).toBe(true);
        expect(h.reportError).not.toHaveBeenCalled();
      } finally {
        answer(ok);
        await returned;
      }
    },
  );

  // Mutation caught: letting after()'s "called outside a request scope" throw
  // out of the writer (scripts, a cron service run as a plain function, tests).
  it.each(writers)(
    '%s outside a request (after() throws): the row is still written and nothing is reported',
    async (_name, write) => {
      h.after.mockImplementation(() => {
        throw new Error('`after` was called outside a request scope.');
      });
      h.insert.mockResolvedValue(ok);

      await write();

      expect(h.insert).toHaveBeenCalledTimes(1);
      expect(h.reportError).not.toHaveBeenCalled();
    },
  );

  // Mutation caught: `void reportError(...)` in sendLossReport. The alert's
  // own webhook POST was suspended with the instance too: 13 of the 35
  // reports' alert POSTs failed with a TimeoutError on a later resume.
  it('the loss report is kept alive too: the first one, and the count sent when the window closes', async () => {
    vi.useFakeTimers();
    const firstReport = Promise.resolve();
    const countReport = Promise.resolve();
    h.reportError.mockReturnValueOnce(firstReport).mockReturnValueOnce(countReport);
    h.insert.mockResolvedValue(badGateway);
    const registered = () => h.after.mock.calls.map(([p]) => p as unknown);

    await audit(payload(1), ctx);
    await audit(payload(2), ctx);
    expect(h.reportError).toHaveBeenCalledTimes(1);
    expect(registered()).toContain(firstReport);

    await vi.advanceTimersByTimeAsync(AUDIT_LOSS_REPORT_WINDOW_MS);
    expect(h.reportError).toHaveBeenCalledTimes(2);
    expect(registered()).toContain(countReport);
  });
});

/**
 * The 35 reports all said AuditInsertTimeout and nothing else, so a 5 s
 * deadline that fired on time and one that fired ten minutes late, when the
 * next request resumed a suspended instance, looked the same.
 */
describe('how long a timed-out INSERT waited', () => {
  it('a deadline that fires on time says 5 s', async () => {
    vi.useFakeTimers();
    h.insert.mockImplementation(() => new Promise(() => {}));
    void audit(payload(1), ctx);
    await vi.advanceTimersByTimeAsync(AUDIT_INSERT_TIMEOUT_MS);
    expect(h.reportError.mock.calls[0]![1]).toMatchObject({
      extra: { lost: 1, timedOut: true, elapsedMs: AUDIT_INSERT_TIMEOUT_MS },
    });
  });

  it('a deadline that fires late (a suspended instance) says how long it really was', async () => {
    vi.useFakeTimers();
    h.insert.mockImplementation(() => new Promise(() => {}));
    void audit(payload(1), ctx);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.insert).toHaveBeenCalledTimes(1);
    // Suspended: the wall clock moves on for ten minutes, the process runs
    // nothing, and the deadline fires when it runs again.
    vi.setSystemTime(Date.now() + 600_000);
    await vi.advanceTimersByTimeAsync(AUDIT_INSERT_TIMEOUT_MS);

    const extra = h.reportError.mock.calls[0]![1].extra as Record<string, unknown>;
    expect(extra).toMatchObject({ lost: 1, timedOut: true, elapsedMs: expect.any(Number) });
    expect(extra.elapsedMs).toBeGreaterThanOrEqual(600_000);
  });
});
