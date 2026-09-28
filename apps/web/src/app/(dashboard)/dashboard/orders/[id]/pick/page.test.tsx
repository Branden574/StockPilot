import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { OrderReadinessResult } from '@stockpilot/core';

/**
 * The digital pick page (F2-2): it reads the order's readiness beside the
 * order, so the pick's completion confirm can project complete_picking with
 * what the picker enters (core digitalPickCompletionConfirm), and hands it to
 * the pick only for someone who can pick. A read that fails, or a service
 * that cannot start, is a failed result: the confirm then says stock could
 * not be checked, and the page never throws.
 */

const events: string[] = [];
const orderGet = vi.fn();
const readinessResult = vi.fn();
const readinessForCurrentUser = vi.fn(async () => ({ result: readinessResult }));
const digitalPickProps = vi.fn();
const ctxHolder = vi.hoisted(() => ({
  current: { role: 'manager' as 'manager' | 'staff', userId: 'u1' },
}));

vi.mock('next/navigation', () => ({
  notFound: vi.fn(() => {
    throw new Error('notFound');
  }),
  redirect: vi.fn((to: string) => {
    throw new Error(`redirect:${to}`);
  }),
}));
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));
vi.mock('@/components/orders/digital-pick', () => ({
  DigitalPick: (props: Record<string, unknown>) => {
    digitalPickProps(props);
    return null;
  },
}));
vi.mock('@/lib/auth/session', () => ({
  requireOrgContext: vi.fn(async () => ({
    organizationId: 'org-1',
    userId: ctxHolder.current.userId,
    role: ctxHolder.current.role,
    permissions: new Set(['orders:read', 'items:update']),
  })),
}));
vi.mock('@/lib/auth/warehouse', () => ({
  getWarehouseAccess: vi.fn(async () => ({ hasAllAccess: true, writableIds: [] })),
}));
vi.mock('@/lib/modules/module-gate', () => ({
  checkModuleAccess: vi.fn(async () => ({ enabled: false, canManage: false })),
}));
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => {
    const self: Record<string, unknown> = {};
    for (const m of ['from', 'select', 'eq']) self[m] = () => self;
    self.maybeSingle = async () => ({ data: { full_name: 'Dana Diaz', email: 'd@x.test' }, error: null });
    return self;
  }),
}));
vi.mock('@/lib/error-reporter', () => ({
  reportError: vi.fn(async () => undefined),
  isNextControlFlowError: () => false,
}));
vi.mock('@/server/services/lots', () => ({ LotsService: { forCurrentUser: vi.fn() } }));
vi.mock('@/server/services/order-requests', () => ({
  OrderRequestsService: {
    forCurrentUser: vi.fn(async () => ({
      get: (id: string) => {
        events.push('order read');
        return orderGet(id);
      },
    })),
  },
}));
vi.mock('@/server/services/order-readiness', () => ({
  OrderReadinessService: {
    forCurrentUser: () => {
      events.push('readiness read');
      return readinessForCurrentUser();
    },
  },
}));

import DigitalPickPage from './page';

const ORDER = '11111111-1111-4111-8111-111111111111';
const FAILED: OrderReadinessResult = { state: 'failed', message: 'Could not check readiness.' };

function detail(over: Record<string, unknown> = {}) {
  return {
    request: {
      id: ORDER,
      status: 'picking_in_progress',
      warehouse_id: 'wh-1',
      assigned_picker_id: null,
      ...over,
    },
    lines: [],
    requesterName: 'Jane Smith',
    requesterEmail: null,
  };
}

async function renderPage() {
  render(await DigitalPickPage({ params: Promise.resolve({ id: ORDER }) }));
}

const lastProps = () => digitalPickProps.mock.calls.at(-1)![0] as Record<string, unknown>;

beforeEach(() => {
  vi.clearAllMocks();
  events.length = 0;
  ctxHolder.current = { role: 'manager', userId: 'u1' };
  orderGet.mockResolvedValue(detail());
  readinessResult.mockResolvedValue(FAILED);
  readinessForCurrentUser.mockImplementation(async () => ({ result: readinessResult }));
});

describe('orders/[id]/pick: readiness for the completion confirm (F2-2)', () => {
  it("reads THIS order's readiness beside the order read, and hands it to the pick", async () => {
    const ok = { state: 'ok', assessment: { phase: 'to_pick' } } as unknown as OrderReadinessResult;
    readinessResult.mockResolvedValue(ok);

    await renderPage();

    expect(readinessResult).toHaveBeenCalledWith(ORDER);
    // Started before the order is read, so it is never a round trip of its own.
    expect(events).toEqual(['readiness read', 'order read']);
    expect(lastProps()).toMatchObject({ orderId: ORDER, canPick: true, readiness: ok });
  });

  it('a service that cannot start is a failed read handed to the pick, never a thrown page', async () => {
    readinessForCurrentUser.mockImplementation(async () => {
      throw new Error('context failed');
    });

    await renderPage();

    expect(lastProps().readiness).toEqual(FAILED);
  });

  it('someone who cannot pick gets no stock numbers: the read is dropped', async () => {
    ctxHolder.current = { role: 'staff', userId: 'u1' };
    orderGet.mockResolvedValue(detail({ assigned_picker_id: 'someone-else' }));

    await renderPage();

    expect(lastProps()).toMatchObject({ canPick: false, readiness: null });
  });
});
