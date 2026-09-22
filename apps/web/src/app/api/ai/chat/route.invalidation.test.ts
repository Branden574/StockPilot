// @vitest-environment node
// FIRST: Next builds its request storages from this global when they load.
import '@/test/next-als';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModuleId } from '@stockpilot/core';

import { withApiContext } from '@/lib/auth/api-context';
import { checkRateLimit } from '@/lib/rate-limit';
import { runRouteThroughNext } from '@/test/next-route-harness';
import { makeSupabaseStub } from '@/test/supabase-mock';

/**
 * The AI chat route runs every write tool INSIDE its streamed body, after
 * POST has returned the Response. Next sends a Route Handler's recorded cache
 * tags to the cache only at that return, so each tool's Items/Books
 * invalidation (made by the service it calls) used to be recorded and then
 * dropped, silently: cancelOrder restocked picked units and applyReorderPoint
 * changed an item, and every manager's cached list kept the old rows for up to
 * the 60s TTL.
 *
 * These run the REAL route through Next's REAL App Route module
 * (src/test/next-route-harness.ts), the REAL tool executors and the REAL
 * services against a Supabase stub. Only the model is scripted: it calls the
 * tool the way the Claude loop does, from inside the stream. `expired` is what
 * Next actually handed the cache, so a present-but-dropped call fails here.
 */

vi.mock('@/lib/auth/api-context', () => ({ withApiContext: vi.fn() }));
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: vi.fn() }));
vi.mock('@/lib/ai/sessions', () => ({
  appendMessages: vi.fn(async () => undefined),
  createSession: vi.fn(async () => ({ id: 'sess-1' })),
  deriveTitle: vi.fn(() => 'title'),
  getSession: vi.fn(async () => null),
  listMessages: vi.fn(async () => []),
}));
vi.mock('@/lib/ai/chat', () => ({
  buildOrgSnapshot: vi.fn(async () => ''),
  streamChat: vi.fn(),
}));
vi.mock('@/lib/ai/chat-claude', () => ({ streamChatClaude: vi.fn() }));
vi.mock('@/lib/ai/provider', () => ({ resolveAiProvider: () => 'claude' }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => undefined) }));
// OrderRequestsService.cancel's tails (after()-deferred email + schedule
// sync, the integration event) are not what is under test.
vi.mock('@/server/services/integration-events', () => ({
  dispatchEvent: vi.fn(async () => undefined),
}));
vi.mock('@/lib/email/order-requests', () => ({ sendOrderRequestEmail: vi.fn(async () => {}) }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => makeSupabaseStub().client }));
// Warehouse scope is proven by the service's own tests; a manager passes here.
vi.mock('@/lib/auth/warehouse', () => ({
  assertWarehouseAccess: vi.fn(async () => undefined),
  getWarehouseAccess: vi.fn(async () => ({
    readableIds: ['wh-1'],
    writableIds: ['wh-1'],
    hasAllAccess: true,
    primaryWarehouseId: 'wh-1',
  })),
  forcedWarehouseId: vi.fn(async () => null),
  ForbiddenError: class ForbiddenError extends Error {},
}));
// setup.ts stubs the never-throwing wrapper for every other file; run the real one.
vi.mock('@/server/services/lib/inventory-list-cache', async (importOriginal) => importOriginal());

import { streamChatClaude } from '@/lib/ai/chat-claude';
import { reportError } from '@/lib/error-reporter';
import { TOOL_CATALOG } from '@/lib/ai/tools';
import type { ServiceContext } from '@/server/services/context';

import * as route from './route';

const ORG = 'org-1';

function ctxFor(stub: ReturnType<typeof makeSupabaseStub>) {
  return {
    organizationId: ORG,
    userId: 'mgr-1',
    role: 'manager' as const,
    supabase: stub.client as never,
    mfaRequired: false,
    mfaSatisfied: true,
    enabledModules: new Set<ModuleId>(['ai', 'orders']),
  };
}

/** Script the model: call one tool from inside the stream, as the Claude
 *  loop does, then finish the turn. */
function modelCalls(name: string, args: Record<string, unknown>) {
  vi.mocked(streamChatClaude).mockImplementation(async function* (
    _history: unknown,
    _message: unknown,
    ctx: ServiceContext,
  ) {
    let ok = true;
    try {
      await TOOL_CATALOG[name]!.execute(args, ctx);
    } catch (err) {
      ok = false;
      void reportError(err, { tag: 'test.tool' });
    }
    yield { type: 'tool', name, ok } as const;
    return { reply: ok ? 'Done.' : 'Failed.', toolCallsUsed: [{ name, ok }] };
  } as unknown as typeof streamChatClaude);
}

function chat() {
  return new Request('https://test.local/api/ai/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: 'please do it' }),
  });
}

async function runChat() {
  const run = await runRouteThroughNext(route, chat(), { page: '/api/ai/chat/route' });
  const events = run.body
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as Record<string, unknown>);
  return { ...run, events };
}

const inventoryExpiries = (expired: Awaited<ReturnType<typeof runChat>>['expired']) =>
  expired.filter((e) => e.tags.some((t) => t.startsWith('inventory-list-')));

describe('/api/ai/chat write tools expire the Items/Books cache for real', () => {
  beforeEach(() => {
    vi.mocked(checkRateLimit).mockResolvedValue({
      allowed: true,
      count: 1,
      resetAt: Date.now() + 60_000,
    });
  });

  it('cancelOrder: the restock the RPC made reaches the cache once the stream closes', async () => {
    const stub = makeSupabaseStub({
      'rpc:cancel_order_request': {
        data: { id: 'ord-1', status: 'cancelled', order_number: 7 },
        error: null,
      },
    });
    vi.mocked(withApiContext).mockResolvedValue(ctxFor(stub) as never);
    modelCalls('cancelOrder', { orderId: 'ord-1' });

    const { status, events, expired } = await runChat();

    expect(status).toBe(200);
    expect(stub.rpcCalls.map((c) => c.name)).toEqual(['cancel_order_request']);
    expect(events).toContainEqual({ type: 'tool', name: 'cancelOrder', ok: true });
    expect(events.at(-1)).toMatchObject({ type: 'done' });
    expect(inventoryExpiries(expired)).toEqual([
      { tags: [`inventory-list-${ORG}`], durations: { expire: 0 }, phase: 'after-close' },
    ]);
  });

  it('applyReorderPoint: the item update reaches the cache once the stream closes', async () => {
    const item = {
      id: 'item-1',
      organization_id: ORG,
      name: 'Widget',
      sku: null,
      warehouse_id: null,
      category_id: null,
      tracking_type: 'none',
      quantity_on_hand: 4,
      reorder_point: 2,
      reorder_quantity: 10,
    };
    const stub = makeSupabaseStub({
      'inventory_items.select': { data: item, error: null },
      'item_stock_levels.select': { data: [], error: null },
      'inventory_items.update': { data: { ...item, reorder_point: 5 }, error: null },
    });
    vi.mocked(withApiContext).mockResolvedValue(ctxFor(stub) as never);
    modelCalls('applyReorderPoint', { itemId: 'item-1', reorderPoint: 5 });

    const { events, expired } = await runChat();

    expect(vi.mocked(reportError).mock.calls).toEqual([]);
    expect(events).toContainEqual({ type: 'tool', name: 'applyReorderPoint', ok: true });
    expect(stub.chainArgs.get('inventory_items.update')?.[0]).toEqual([
      expect.objectContaining({ reorder_point: 5 }),
    ]);
    expect(inventoryExpiries(expired)).toEqual([
      { tags: [`inventory-list-${ORG}`], durations: { expire: 0 }, phase: 'after-close' },
    ]);
  });

  it('a refused write expires nothing (nothing moved)', async () => {
    const stub = makeSupabaseStub({
      'rpc:cancel_order_request': {
        data: null,
        error: { message: 'invalid_status_transition' },
      },
    });
    vi.mocked(withApiContext).mockResolvedValue(ctxFor(stub) as never);
    modelCalls('cancelOrder', { orderId: 'ord-1' });

    const { events, expired } = await runChat();

    expect(events).toContainEqual({ type: 'tool', name: 'cancelOrder', ok: false });
    expect(inventoryExpiries(expired)).toEqual([]);
  });
});
