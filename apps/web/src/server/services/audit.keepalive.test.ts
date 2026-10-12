// @vitest-environment node
// FIRST: Next builds its request storages from this global when they load.
import '@/test/next-als';

import { after } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runRouteThroughNext } from '@/test/next-route-harness';

import type { ServiceContext } from './context';

/**
 * `void audit(...)` through Next's REAL App Route module, with the REAL after()
 * and next/headers. src/test/next-route-harness.ts waits for everything handed
 * to waitUntil before it returns, as Vercel does before it may suspend the
 * instance, so whatever is still running when the harness returns is what a
 * suspension caught.
 *
 * 2026-09-24..10-12, 35 'Audit rows were not written' reports: each was a
 * `void audit(...)` whose INSERT was still in flight when the route returned.
 * Nothing held the invocation, Vercel suspended the instance, and the next
 * request resumed it with the 5 s deadline long past. 33 rows had committed
 * (the reply was never read) and 2 Learn4Life item-create rows were never
 * sent. Here every INSERT answers 50 ms after it is sent.
 */

const h = vi.hoisted(() => ({
  /** "event entity_id" per INSERT that answered, in order. */
  answered: [] as string[],
  status: 201,
  /** Every INSERT and report still running, so no test leaks into the next. */
  inFlight: [] as Promise<unknown>[],
  reportError: vi.fn(),
}));

const INSERT_MS = 50;

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: () => ({
      insert: (row: { event: string; metadata: { entity_id: string | null } }) => {
        const builder = {
          abortSignal: () => builder,
          then(onOk: (v: unknown) => unknown, onErr?: (e: unknown) => unknown) {
            const answer = new Promise((resolve) => setTimeout(resolve, INSERT_MS)).then(() => {
              h.answered.push(`${row.event} ${row.metadata.entity_id}`);
              return h.status < 300
                ? { error: null, status: h.status, statusText: 'Created' }
                : { error: { message: '', code: '' }, status: h.status, statusText: 'Bad Gateway' };
            });
            h.inFlight.push(answer);
            return answer.then(onOk, onErr);
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
// src/test/setup.ts stubs this module for every other test; this file runs
// the real one.
vi.unmock('@/server/services/audit');

import { audit, resetAuditLossReportsForTests } from './audit';
import { defer, keepAlive } from './lib/defer';

const ctx = { organizationId: 'org-1', userId: 'user-1' } as unknown as ServiceContext;
const created = {
  event: 'inventory.item.created' as const,
  entityType: 'inventory_item',
  entityId: 'item-1',
};
const get = () => new Request('https://test.local/api/test', { method: 'GET' });

/** A handler shaped like POST /api/v1/items: audit without waiting, answer at once. */
const auditsAndReturns = {
  GET: async () => {
    void audit(created, ctx);
    return Response.json({ answeredWhenReturned: h.answered.length });
  },
};

beforeEach(() => {
  h.answered = [];
  h.status = 201;
  h.inFlight = [];
  h.reportError.mockReset();
  h.reportError.mockImplementation(async () => undefined);
  resetAuditLossReportsForTests();
});

afterEach(async () => {
  await Promise.allSettled(h.inFlight);
});

describe('a `void audit()` in a Route Handler', () => {
  it('is written before the invocation may end, and nothing is reported', async () => {
    const { status, body } = await runRouteThroughNext(auditsAndReturns, get());

    expect(status).toBe(200);
    // The handler answered before the INSERT did: the response is not delayed.
    expect(JSON.parse(body)).toEqual({ answeredWhenReturned: 0 });
    // And the invocation was held until the INSERT answered.
    expect(h.answered).toEqual(['inventory.item.created item-1']);
    expect(h.reportError).not.toHaveBeenCalled();
  });

  it('a refused INSERT: the loss report it sends is held too', async () => {
    h.status = 502;
    let reportSent = false;
    h.reportError.mockImplementation(() => {
      const post = new Promise<void>((resolve) =>
        setTimeout(() => {
          reportSent = true;
          resolve();
        }, INSERT_MS),
      );
      h.inFlight.push(post);
      return post;
    });

    await runRouteThroughNext(auditsAndReturns, get());

    expect(h.reportError).toHaveBeenCalledTimes(1);
    expect(h.reportError.mock.calls[0]![1]).toMatchObject({
      tag: 'audit.write_failed',
      organizationId: 'org-1',
      extra: { event: 'inventory.item.created', lost: 1, status: 502 },
    });
    // The report's own webhook POST finished inside the invocation as well.
    expect(reportSent).toBe(true);
  });

  it('started inside an after() callback (a deferred tail), it is held too', async () => {
    // Next binds the request's stores to the callback, so after() inside it
    // registers with the same waitUntil while the callback is still running.
    const { status } = await runRouteThroughNext(
      {
        GET: async () => {
          defer(async () => {
            void audit(created, ctx);
          });
          return Response.json({ ok: true });
        },
      },
      get(),
    );

    expect(status).toBe(200);
    expect(h.answered).toEqual(['inventory.item.created item-1']);
    expect(h.reportError).not.toHaveBeenCalled();
  });
});

describe('outside a request (a script, a test, a service called as a plain function)', () => {
  it("Next's real after() throws there; keepAlive swallows it and the work still runs", async () => {
    let done = false;
    const work = new Promise<void>((resolve) =>
      setTimeout(() => {
        done = true;
        resolve();
      }, 10),
    );

    expect(() => after(work)).toThrow('`after` was called outside a request scope');
    expect(() => keepAlive(work)).not.toThrow();
    await work;
    expect(done).toBe(true);
  });
});
