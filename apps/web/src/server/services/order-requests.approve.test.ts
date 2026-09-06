import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModuleId } from '@stockpilot/core';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

vi.mock('@/lib/auth/warehouse', () => ({ assertWarehouseAccess: vi.fn() }));
vi.mock('./audit', () => ({ audit: vi.fn(async () => {}) }));
vi.mock('./integration-events', () => ({ dispatchEvent: vi.fn(async () => {}) }));
vi.mock('@/lib/email/order-requests', () => ({ sendOrderRequestEmail: vi.fn(async () => {}) }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => adminHandle.client }));
// `after` is Next's post-response scheduler. Mocking it lets a test observe
// that the tail work was REGISTERED with the request (SP-092) rather than
// left dangling, and run the callbacks by hand.
vi.mock('next/server', () => ({ after: (fn: () => unknown) => afterCalls.push(fn) }));

import { OrderRequestsService } from './order-requests';
import { sendOrderRequestEmail } from '@/lib/email/order-requests';

const adminHandle: { client: unknown } = { client: null };
let afterCalls: Array<() => unknown> = [];

async function flushAfter() {
  const queued = afterCalls.slice();
  afterCalls = [];
  for (const fn of queued) await fn();
}

const APPROVED_ROW = {
  id: 'ord-1',
  organization_id: 'org-test',
  warehouse_id: 'wh-1',
  order_number: 21,
  status: 'approved',
  fulfillment_type: 'delivery',
  requester_name: 'Doua Vang',
  requester_email: 'doua@example.org',
  needed_by: '2026-09-11T02:00:00.000Z',
};

function build(results: Record<string, any> = {}) {
  const stub = makeSupabaseStub({
    // requireWarehouseAccess reads the order's warehouse.
    'order_requests.select.maybeSingle': { data: { warehouse_id: 'wh-1' }, error: null },
    'rpc:approve_order_request': { data: APPROVED_ROW, error: null },
    ...results,
  });
  const admin = makeSupabaseStub({
    'organizations.select.maybeSingle': { data: { timezone: 'America/Los_Angeles' }, error: null },
    'schedule_events.insert': { data: null, error: null },
  });
  adminHandle.client = admin.client;
  const svc = new (OrderRequestsService as unknown as new (ctx: unknown) => OrderRequestsService)(
    makeServiceContext(stub.client, {
      role: 'manager',
      userId: 'mgr-1',
      enabledModules: new Set<ModuleId>(['orders']),
    }),
  );
  return { stub, admin, svc };
}

beforeEach(() => {
  afterCalls = [];
  vi.clearAllMocks();
});

// ── SP-130: internal notes must not be erased by the approve path ──────────
describe('OrderRequestsService.approve — internal notes', () => {
  it('does not touch internal_notes when the caller supplies none', async () => {
    const { stub, svc } = build();
    await svc.approve('ord-1');
    expect(stub.chains.get('order_requests.update')).toBeUndefined();
  });

  it('does NOT erase saved notes when the caller passes an absent-coerced null', async () => {
    // Both callers (server action + /api/v1 transition route) spell the
    // optional field `internalNotes ?? null`, so "the manager clicked Approve
    // without touching the notes box" arrives here as `null`.
    const { stub, svc } = build();
    await svc.approve('ord-1', null);
    expect(stub.chains.get('order_requests.update')).toBeUndefined();
  });

  it('writes a supplied note and proves the row was actually updated', async () => {
    const { stub, svc } = build({
      'order_requests.update.maybeSingle': { data: { id: 'ord-1' }, error: null },
    });
    await svc.approve('ord-1', 'Ship via FedEx');
    const args = stub.chainArgs.get('order_requests.update') ?? [];
    expect(args[0]?.[0]).toEqual({ internal_notes: 'Ship via FedEx' });
    // Row-proof: the write asks for the row back rather than trusting a
    // 0-row PostgREST 204 (bug-pattern #2). The fail-closed behaviour itself
    // is pinned by the next test.
    expect(stub.chains.get('order_requests.update')).toContain('select');
  });

  it('fails CLOSED when the notes update matches no row, before the approval RPC runs', async () => {
    const { stub, svc } = build({
      'order_requests.update.maybeSingle': { data: null, error: null },
    });
    await expect(svc.approve('ord-1', 'Ship via FedEx')).rejects.toMatchObject({
      code: 'internal_error',
    });
    expect(stub.rpcCalls).toHaveLength(0);
  });
});

// ── SP-092: post-response tails must be registered with the request ────────
describe('OrderRequestsService.approve — post-response work', () => {
  it('registers the email + auto-schedule tails with after() instead of dangling them', async () => {
    const { admin, svc } = build();
    await svc.approve('ord-1');
    expect(afterCalls.length).toBeGreaterThanOrEqual(2);
    // Nothing has run yet — the response can flush first.
    expect(sendOrderRequestEmail).not.toHaveBeenCalled();
    expect(admin.chains.get('schedule_events.insert')).toBeUndefined();
    await flushAfter();
    expect(sendOrderRequestEmail).toHaveBeenCalledTimes(1);
    expect(admin.chains.get('schedule_events.insert')).toBeDefined();
  });
});

// ── SP-043: the auto-created schedule event's details must be org-local ────
describe('OrderRequestsService.approve — auto-created schedule event', () => {
  // Vercel Node functions run in UTC. Pin the process zone to UTC so this
  // test reproduces PRODUCTION and not the developer's own machine — on a
  // Pacific laptop the buggy `toLocaleString('en-US')` accidentally printed
  // the right wall clock and the defect was invisible.
  const realTz = process.env.TZ;
  beforeAll(() => {
    process.env.TZ = 'UTC';
  });
  afterAll(() => {
    process.env.TZ = realTz;
  });

  it('renders "Needed by" in the ORG timezone, not the server UTC wall clock', async () => {
    const { admin, svc } = build();
    await svc.approve('ord-1');
    await flushAfter();
    const payload = (admin.chainArgs.get('schedule_events.insert') ?? [])[0]?.[0] as {
      details: string;
    };
    // 2026-09-11T02:00:00Z is Sep 10, 7:00 PM in America/Los_Angeles.
    expect(payload.details).toContain('Sep 10, 2026');
    expect(payload.details).toContain('7:00 PM');
    expect(payload.details).not.toContain('9/11/2026');
  });
});
