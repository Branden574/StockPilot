import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ROLE_PERMISSIONS, type ModuleId, type Permission, type Role } from '@stockpilot/core';

import {
  makeServiceContext,
  makeSupabaseStub,
  servedLikePostgrest,
  type MockCall,
  type QueryResult,
} from '@/test/supabase-mock';

/**
 * Docket S36 (part a), with B72 part 3: Today's briefing (gatherInsights, the
 * page path) shows a reader only the lines they can open
 * (insights-access.ts), and the AI summary is written from those lines. The
 * approvals line counts the pending requests this reader could approve
 * (approvablePendingCount): none without orders:approve or for a viewer, and
 * for a staff approver only those in the warehouses they can write in.
 *
 * The count here is the REAL OrderRequestsService against the stub (the stub
 * answers by the query's own filters), so a warehouse filter the count forgets
 * is a wrong number. The other sources are mocked.
 */

vi.mock('./audit', () => ({ audit: vi.fn(async () => {}) }));
vi.mock('./notifications', () => ({ createNotification: vi.fn(async () => 'notif-1') }));
vi.mock('./integration-events', () => ({ dispatchEvent: vi.fn(async () => {}) }));
vi.mock('@/lib/email/order-requests', () => ({ sendOrderRequestEmail: vi.fn(async () => {}) }));
vi.mock('@/lib/realtime/broadcast', () => ({ broadcastOrderChanged: vi.fn(async () => {}) }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => {}) }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => makeSupabaseStub().client }));

vi.mock('./movements', () => ({
  getLowStockItems: vi.fn(async () => [
    { id: 'i1', name: 'Widget', sku: 'W-1', quantity_on_hand: 1, reorder_point: 5 },
  ]),
  getDashboardActions: vi.fn(async () => ({
    openPoCount: 3,
    openCycleCount: 1,
    pendingReceipts: 0,
  })),
}));
vi.mock('./purchase-orders', () => ({
  PurchaseOrdersService: class {
    async overdueCount() {
      return 2;
    }
  },
}));

const { withContextMock, claudeMock } = vi.hoisted(() => ({
  withContextMock: vi.fn(),
  claudeMock: vi.fn(async (_args: { prompt: string }) => 'A short summary.'),
}));
vi.mock('./context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./context')>()),
  withContext: withContextMock,
}));
vi.mock('@/lib/env', () => ({
  env: { ANTHROPIC_API_KEY: 'test-key', GEMINI_API_KEY: '', GEMINI_MODEL: 'test-model' },
}));
vi.mock('@/lib/ai/provider', () => ({ resolveAiProvider: () => 'claude' }));
vi.mock('@/lib/ai/claude', () => ({
  claudeGenerateText: (args: { prompt: string }) => claudeMock(args),
}));

import { gatherInsights, gatherInsightsForCtx, summarizeInsights } from './insights';

const ORG = 'org-test';
const REQUESTS = [
  { id: 'o1', organization_id: ORG, status: 'pending_approval', warehouse_id: 'wh-a' },
  { id: 'o2', organization_id: ORG, status: 'pending_approval', warehouse_id: 'wh-a' },
  { id: 'o3', organization_id: ORG, status: 'pending_approval', warehouse_id: 'wh-b' },
  { id: 'o4', organization_id: ORG, status: 'pending_approval', warehouse_id: 'wh-c' },
  { id: 'o5', organization_id: ORG, status: 'approved', warehouse_id: 'wh-a' },
];

function counted(call: MockCall): QueryResult {
  const { data } = servedLikePostgrest(REQUESTS)(call);
  return { data: null, error: null, count: (data as unknown[]).length };
}

const MODULES = new Set<ModuleId>(['orders', 'purchase_orders', 'cycle_counts', 'ai']);

/** A signed-in reader's context: their role, their effective set, and the
 *  warehouses they are assigned to. */
function readerCtx(
  role: Role,
  opts: { add?: Permission[]; remove?: Permission[]; assigned?: string[]; noSet?: boolean } = {},
) {
  const permissions = new Set<string>(ROLE_PERMISSIONS[role]);
  for (const key of opts.add ?? []) permissions.add(key);
  for (const key of opts.remove ?? []) permissions.delete(key);
  const stub = makeSupabaseStub({
    'order_requests.select': counted,
    'user_warehouse_assignments.select': {
      data: (opts.assigned ?? []).map((id, i) => ({ warehouse_id: id, is_primary: i === 0 })),
      error: null,
    },
    'organization_members.select.maybeSingle': { data: { all_warehouses: false }, error: null },
    'warehouses.select': { data: [{ id: 'wh-a' }, { id: 'wh-b' }, { id: 'wh-c' }], error: null },
  });
  return makeServiceContext(stub.client, {
    role,
    userId: 'reader-1',
    enabledModules: MODULES,
    ...(opts.noSet ? {} : { permissions }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("gatherInsights (Today's briefing): only what the reader can open", () => {
  it('a staff member without orders:approve gets no approvals line, and the AI summary is not told of any', async () => {
    withContextMock.mockResolvedValue(readerCtx('staff', { assigned: ['wh-a'] }));
    const result = await gatherInsights();
    expect(result.signals.map((s) => s.key)).not.toContain('pending_approvals');
    expect(result.signals.map((s) => s.key)).toEqual([
      'overdue_pos',
      'low_stock',
      'open_cycle_counts',
      'open_pos',
    ]);
    // The page hands this same result to the summary (insights/page.tsx).
    await summarizeInsights(result);
    expect(claudeMock).toHaveBeenCalledTimes(1);
    expect(claudeMock.mock.calls[0]![0].prompt).not.toMatch(/awaiting approval/);
  });

  it("a staff approver's count is the pending requests in the warehouses they work in", async () => {
    withContextMock.mockResolvedValue(
      readerCtx('staff', { add: ['orders:approve'], assigned: ['wh-a'] }),
    );
    const result = await gatherInsights();
    const approvals = result.signals.find((s) => s.key === 'pending_approvals');
    expect(approvals).toMatchObject({ count: 2, label: 'orders awaiting approval' });
  });

  it('an admin whose orders:approve was revoked gets no approvals line', async () => {
    withContextMock.mockResolvedValue(readerCtx('admin', { remove: ['orders:approve'] }));
    const result = await gatherInsights();
    expect(result.signals.map((s) => s.key)).not.toContain('pending_approvals');
  });

  it('a reader whose purchase_orders:read was revoked gets neither purchase order line', async () => {
    withContextMock.mockResolvedValue(readerCtx('manager', { remove: ['purchase_orders:read'] }));
    const result = await gatherInsights();
    expect(result.signals.map((s) => s.key)).toEqual([
      'pending_approvals',
      'low_stock',
      'open_cycle_counts',
    ]);
  });
});

describe("gatherInsightsForCtx (the morning briefing's gathering)", () => {
  it("still counts the organization's pending requests under the cron's owner context", async () => {
    const result = await gatherInsightsForCtx(readerCtx('owner', { noSet: true }));
    expect(result.signals.find((s) => s.key === 'pending_approvals')).toMatchObject({ count: 4 });
    expect(result.signals.map((s) => s.key)).toEqual([
      'pending_approvals',
      'overdue_pos',
      'low_stock',
      'open_cycle_counts',
      'open_pos',
    ]);
    expect(result.lowStock).toHaveLength(1);
  });
});
