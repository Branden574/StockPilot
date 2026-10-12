// @vitest-environment node
// FIRST: Next builds its request storages from this global when they load.
import '@/test/next-als';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runRouteThroughNext } from '@/test/next-route-harness';
import { makeSupabaseStub, servedLikePostgrest, type QueryResult } from '@/test/supabase-mock';

/**
 * The nightly false alarm, end to end: the REAL restore-points cron through
 * Next's REAL App Route module (src/test/next-route-harness.ts waits for
 * everything handed to waitUntil, as Vercel does before it may suspend the
 * instance), with the REAL createSnapshot and audit() against a Supabase stub.
 *
 * 2026-09-25..10-12, 17 nights: the cron snapshots each org in id order and
 * returns right after the last one, whose restore_point.created audit is a
 * `void audit(...)`. Its INSERT committed at 02:00:38Z, but nothing held the
 * invocation: Vercel suspended the instance before the reply was read, and the
 * drain-outbox cron resumed it at 02:10:22Z with the 5 s deadline long past,
 * so a written row was reported lost ('Audit rows were not written').
 * Here every audit INSERT answers 50 ms after it is sent.
 */

const envHolder = { env: { CRON_SECRET: 'test-cron-secret' } as { CRON_SECRET?: string } };
vi.mock('@/lib/env', () => ({
  get env() {
    return envHolder.env;
  },
}));

const h = vi.hoisted(() => ({
  client: null as unknown,
  /** "event entity_id" per audit INSERT that answered, in order. */
  answered: [] as string[],
  inFlight: [] as Promise<unknown>[],
  reportError: vi.fn(async () => undefined),
}));
vi.mock('@/lib/error-reporter', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/error-reporter')>()),
  reportError: h.reportError,
}));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => h.client }));
// src/test/setup.ts stubs this module for every other test; this file runs
// the real one.
vi.unmock('@/server/services/audit');

import * as route from './route';

const AUDIT_INSERT_MS = 50;

/** Two Business orgs, listed out of order: the cron reads them by id. */
const ORGS = ['org-b', 'org-a'].map((id) => ({
  id,
  plan: 'business',
  access_tier: null,
  billing_arrangement: null,
  stripe_subscription_id: null,
  trial_ends_at: null,
  trial_tier: null,
}));
const ITEMS = ['org-a', 'org-b'].map((org, i) => ({
  id: `item-${i + 1}`,
  organization_id: org,
  deleted_at: null,
  sku: `SKU-${i + 1}`,
  name: `Item ${i + 1}`,
  quantity_on_hand: 3,
}));

function adminStub() {
  return makeSupabaseStub({
    'organizations.select': servedLikePostgrest(ORGS),
    'organization_members.select': { data: [{ user_id: 'owner-1' }], error: null },
    'organization_modules.select': { data: [{ module_id: 'inventory' }], error: null },
    'inventory_items.select': servedLikePostgrest(ITEMS),
    'restore_points.insert': (call) => ({
      data: { id: `rp-${(call.args[0]![0] as { organization_id: string }).organization_id}` },
      error: null,
    }),
    // Prune: nothing past the retention window.
    'restore_points.select': { data: [], error: null },
    'audit_logs.insert': (call) => {
      const row = call.args[0]![0] as { event: string; metadata: { entity_id: string } };
      const answer = new Promise<QueryResult>((resolve) =>
        setTimeout(() => {
          h.answered.push(`${row.event} ${row.metadata.entity_id}`);
          resolve({ data: null, error: null });
        }, AUDIT_INSERT_MS),
      );
      h.inFlight.push(answer);
      // The stub hands this to the awaiting caller's resolve, which adopts it.
      return answer as unknown as QueryResult;
    },
  }).client;
}

const cronRequest = () =>
  new Request('https://test.local/api/cron/restore-points', {
    headers: { authorization: 'Bearer test-cron-secret' },
  });

beforeEach(() => {
  envHolder.env = { CRON_SECRET: 'test-cron-secret' };
  h.client = adminStub();
  h.answered = [];
  h.inFlight = [];
  h.reportError.mockReset();
  h.reportError.mockImplementation(async () => undefined);
});

afterEach(async () => {
  await Promise.allSettled(h.inFlight);
});

describe('GET /api/cron/restore-points', () => {
  it("writes each org's restore_point.created row before the invocation may end, and reports nothing", async () => {
    let answeredWhenReturned: string[] | null = null;
    const { status, body } = await runRouteThroughNext(
      {
        dynamic: 'force-dynamic',
        GET: async (req) => {
          const res = await route.GET(req);
          answeredWhenReturned = [...h.answered];
          return res;
        },
      },
      cronRequest(),
      { page: '/api/cron/restore-points/route' },
    );

    expect(status).toBe(200);
    expect(JSON.parse(body)).toEqual({ eligible: 2, snapshotted: 2 });
    // The cron answers with the last org's audit INSERT still in flight: the
    // response does not wait for it ...
    expect(answeredWhenReturned).toEqual([]);
    // ... and the invocation is held until both rows are written, in id order.
    expect(h.answered).toEqual([
      'restore_point.created rp-org-a',
      'restore_point.created rp-org-b',
    ]);
    expect(h.reportError).not.toHaveBeenCalled();
  });
});
