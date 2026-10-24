// @vitest-environment node
// FIRST: Next builds its request storages from this global when they load.
import '@/test/next-als';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runRouteThroughNext } from '@/test/next-route-harness';

/**
 * Tail work left running with `void` as a Route Handler answers, through
 * Next's REAL App Route module and the REAL after(). The harness
 * (src/test/next-route-harness.ts) waits for everything handed to waitUntil
 * before it returns, as Vercel does before it may suspend the instance, so
 * whatever has not finished when the harness returns is what a suspension
 * cut off.
 *
 * #352 fixed this for audit rows (audit.keepalive.test.ts). The same shape
 * was everywhere else: `void reportError(...)` (387 call sites),
 * `void dispatchEvent(...)` (39), `void broadcastOrderChanged(...)` (14) and
 * the support ticket emails held nothing once the response was sent. The
 * first three now keep their own work alive, as audit() does; the support
 * emails are handed to keepAlive where they start. Every network call below
 * answers LATENCY_MS after it is made.
 */

const h = vi.hoisted(() => ({
  /** What finished, in order. */
  done: [] as string[],
  /** Everything still running, so no test leaks into the next. */
  inFlight: [] as Promise<unknown>[],
  admin: null as unknown,
  /** How long an email to `to` takes to be accepted. */
  emailLatency: (_to: string): number | undefined => undefined,
}));

const LATENCY_MS = 50;

function later<T>(label: string, value: T, ms = LATENCY_MS): Promise<T> {
  const answer = new Promise<T>((resolve) =>
    setTimeout(() => {
      h.done.push(label);
      resolve(value);
    }, ms),
  );
  h.inFlight.push(answer);
  return answer;
}

vi.mock('@/lib/env', () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: 'https://proj.supabase.test',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-key',
    NEXT_PUBLIC_APP_URL: 'https://app.test',
  },
}));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => h.admin }));
vi.mock('@/lib/email/resend', () => ({
  sendEmail: (msg: { to: string }) =>
    later(`email to ${msg.to}`, { ok: true }, h.emailLatency(msg.to)),
}));

import { reportError } from '@/lib/error-reporter';
import { reportError as reportFromAnywhere } from '@/lib/error-reporter-core';
import { broadcastOrderChanged } from '@/lib/realtime/broadcast';
import { SUPPORT_EMAIL } from '@/lib/site';

import { dispatchEvent } from './integration-events';
import { createSupportTicket } from './support-tickets';

/** A PostgREST chain whose every method returns itself and which answers
 *  `result` LATENCY_MS after it is awaited. */
function chain(label: string, result: unknown): unknown {
  const self: Record<string, unknown> = new Proxy(
    {},
    {
      get: (_t, prop) =>
        prop === 'then'
          ? (onOk: (v: unknown) => unknown, onErr?: (e: unknown) => unknown) =>
              later(label, result).then(onOk, onErr)
          : () => self,
    },
  );
  return self;
}

const get = () => new Request('https://test.local/api/test', { method: 'GET' });

beforeEach(() => {
  h.done = [];
  h.inFlight = [];
  h.admin = null;
  h.emailLatency = () => undefined;
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string | URL) => later(`POST ${new URL(String(url)).host}`, new Response('ok'))),
  );
});

afterEach(async () => {
  // Settle everything, including work that settled work started (a few
  // microtasks later, hence the turn of the event loop before counting).
  let settled = -1;
  while (settled !== h.inFlight.length) {
    settled = h.inFlight.length;
    await Promise.allSettled([...h.inFlight]);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('a `void reportError()` as a route answers', () => {
  // Mutation caught: the server reportError without keepAlive (the core one,
  // below), whose webhook POST the harness does not wait for.
  it('the webhook POST is held until it answers, and the response is not delayed', async () => {
    vi.stubEnv('ERROR_WEBHOOK_URL', 'https://hooks.example.test/report');
    const { status, body } = await runRouteThroughNext(
      {
        GET: async () => {
          void reportError(new Error('boom'), { tag: 'test.keepalive' });
          return Response.json({ doneWhenReturned: h.done.length });
        },
      },
      get(),
    );
    expect(status).toBe(200);
    expect(JSON.parse(body)).toEqual({ doneWhenReturned: 0 });
    expect(h.done).toEqual(['POST hooks.example.test']);
  });

  it('the isomorphic core, which browser modules use, is not held: why the server reporter exists', async () => {
    vi.stubEnv('ERROR_WEBHOOK_URL', 'https://hooks.example.test/report');
    await runRouteThroughNext(
      {
        GET: async () => {
          void reportFromAnywhere(new Error('boom'), { tag: 'test.keepalive' });
          return Response.json({});
        },
      },
      get(),
    );
    expect(h.done).toEqual([]);
  });
});

describe('a `void dispatchEvent()` as a route answers', () => {
  // Mutation caught: dispatchEvent without keepAlive. Its endpoint read and
  // its delivery INSERT were left in flight, and an event whose rows were
  // never inserted is lost for good (the cron retries only rows that exist).
  it('its endpoint read and its delivery rows are held', async () => {
    h.admin = {
      from: (table: string) =>
        table === 'integration_endpoints'
          ? chain('endpoints read', {
              data: [
                {
                  id: 'ep-1',
                  organization_id: 'org-1',
                  type: 'webhook',
                  url: 'https://hooks.example.test/po',
                  secret: null,
                },
              ],
              error: null,
            })
          : chain('delivery rows inserted', { data: [], error: null }),
    };
    await runRouteThroughNext(
      {
        GET: async () => {
          void dispatchEvent('org-1', 'po.updated', { id: 'po-1', poNumber: 'PO-1', lineCount: 1 });
          return Response.json({});
        },
      },
      get(),
    );
    expect(h.done).toEqual(['endpoints read', 'delivery rows inserted']);
  });
});

describe('a `void broadcastOrderChanged()` as a route answers', () => {
  // Mutation caught: the broadcast POST left in flight, so the other open
  // order screens never heard of the change.
  it('the realtime POST is held', async () => {
    await runRouteThroughNext(
      {
        GET: async () => {
          void broadcastOrderChanged('org-1', 'order-1');
          return Response.json({});
        },
      },
      get(),
    );
    expect(h.done).toEqual(['POST proj.supabase.test']);
  });
});

describe('a new support ticket', () => {
  // Mutation caught, in each order: either email left as a bare `void`. The
  // harness waits only for what is held, so an email that is not held is cut
  // off when it is the one that finishes last (with the same latency, the
  // held one would cover it): support never hears of the ticket, or the
  // submitter, told it was received, gets no acknowledgment.
  const SUBMITTER = 'dana@example.com';
  for (const last of [SUPPORT_EMAIL, SUBMITTER]) {
    it(`the email to support and the acknowledgment are both held, and the route answers first (${last} last)`, async () => {
      h.emailLatency = (to) => (to === last ? 3 * LATENCY_MS : LATENCY_MS);
      h.admin = {
        from: () =>
          chain('ticket row inserted', {
            data: { id: '5e5e5e5e-0000-4000-8000-000000000001' },
            error: null,
          }),
      };
      const { body } = await runRouteThroughNext(
        {
          GET: async () => {
            const { id } = await createSupportTicket({
              email: SUBMITTER,
              name: 'Dana',
              category: 'bug',
              subject: 'Scanner stops after one scan',
              message: 'It stops.',
            });
            return Response.json({
              id,
              emailsWhenReturned: h.done.filter((d) => d.startsWith('email')).length,
            });
          },
        },
        get(),
      );
      expect(JSON.parse(body).emailsWhenReturned).toBe(0);
      expect(h.done[0]).toBe('ticket row inserted');
      expect(h.done.filter((d) => d.startsWith('email')).sort()).toEqual(
        [`email to ${SUPPORT_EMAIL}`, `email to ${SUBMITTER}`].sort(),
      );
      expect(h.done.at(-1)).toBe(`email to ${last}`);
    });
  }
});
