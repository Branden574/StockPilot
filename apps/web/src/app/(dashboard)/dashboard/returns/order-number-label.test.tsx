import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The returns surfaces show which order a return is filed AGAINST, as the
// SO-###### handle the order page prints, falling back to the id prefix for
// legacy orders without a number (returns RX-1: the list reads
// return_overview's order_number, the workbench its hinted order embed).

const ORDER_ID = '11111111-1111-4111-8111-111111111111';

vi.mock('@/lib/auth/session', () => ({
  requireOrgContext: vi.fn(async () => ({ organizationId: 'org-1', userId: 'u1', role: 'manager' })),
}));
vi.mock('next/navigation', () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`redirect:${url}`);
  }),
  notFound: vi.fn(() => {
    throw new Error('notFound');
  }),
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));
vi.mock('@/lib/modules/module-gate', () => ({
  checkModuleAccess: vi.fn(async (m: string) => ({ enabled: m === 'returns', canManage: true })),
}));
vi.mock('@/components/dashboard/module-not-enabled', () => ({ ModuleNotEnabled: () => null }));
vi.mock('@/server/services/shipping', () => ({
  ShippingService: { forCurrentUser: vi.fn(async () => ({ getReturnLabel: vi.fn(async () => null) })) },
}));
vi.mock('@/server/actions/returns', () => ({
  runReturnStepsAction: vi.fn(),
  denyReturnAction: vi.fn(),
  cancelReturnAction: vi.fn(),
  planReturnDispositionsAction: vi.fn(),
  buyReturnLabelAction: vi.fn(),
}));

const listPage = vi.fn(async (..._a: unknown[]) => ({}) as unknown);
const workbench = vi.fn(async (..._a: unknown[]) => ({}) as unknown);
vi.mock('@/server/services/returns', () => ({
  RMAService: { forCurrentUser: vi.fn(async () => ({ listPage, workbench })) },
}));

import ReturnsPage from './page';
import ReturnDetailPage from './[id]/page';

function row(orderNumber: number | null) {
  return {
    id: 'ret-1',
    returnNumber: 'RMA-20260726-ABCDEF',
    status: 'requested',
    source: 'internal',
    reasonCode: 'damaged',
    orderRequestId: ORDER_ID,
    orderNumber,
    requesterName: null,
    requesterEmail: null,
    createdAt: '2026-07-26T00:00:00Z',
    approvedAt: null,
    waitingDays: null,
    lineCount: 1,
    unitCount: 1,
    items: [],
    moreItems: 0,
    type: 'return',
  };
}

function bench(orderNumber: number | null) {
  return {
    organizationId: 'org-1',
    return: {
      id: 'ret-1',
      returnNumber: 'RMA-20260726-ABCDEF',
      status: 'closed',
      source: 'internal',
      reasonCode: null,
      notes: null,
      denialReason: null,
      orderRequestId: ORDER_ID,
      orderNumber,
      warehouseId: null,
      warehouseName: null,
      requesterName: null,
      requesterEmail: null,
      createdAt: '2026-07-26T00:00:00Z',
      approvedAt: null,
      receivedAt: null,
      closedAt: null,
      deniedAt: null,
      requestedByName: null,
      approvedByName: null,
      receivedByName: null,
      closedByName: null,
      deniedByName: null,
    },
    revision: 1,
    planSeq: 0,
    createdOnCounter: false,
    lines: [],
    decisions: [],
    chain: [],
    viewer: { canManageReturns: true, canApproveOrders: true, canReadDecisions: true },
    actions: { primary: null, secondary: [], readOnlyReason: null },
  };
}

beforeEach(() => vi.clearAllMocks());

const listArgs = { searchParams: Promise.resolve({}) };
const detailArgs = { params: Promise.resolve({ id: 'ret-1' }) };

describe('returns list — order column', () => {
  it('prints the SO number when the parent order has one', async () => {
    listPage.mockResolvedValueOnce({ organizationId: 'org-1', filter: 'all', q: '', rows: [row(49)], nextCursor: null, pageSize: 25 });
    render(await ReturnsPage(listArgs));
    expect(screen.getByRole('link', { name: 'SO-000049' })).toHaveAttribute('href', `/dashboard/orders/${ORDER_ID}`);
    expect(screen.queryByText(ORDER_ID.slice(0, 8))).not.toBeInTheDocument();
  });

  it('falls back to the order id prefix when order_number is null', async () => {
    listPage.mockResolvedValueOnce({ organizationId: 'org-1', filter: 'all', q: '', rows: [row(null)], nextCursor: null, pageSize: 25 });
    render(await ReturnsPage(listArgs));
    expect(screen.getByRole('link', { name: ORDER_ID.slice(0, 8) })).toBeInTheDocument();
  });
});

describe('returns detail — "Against order …"', () => {
  it('prints the SO number when the parent order has one', async () => {
    workbench.mockResolvedValueOnce(bench(1234));
    render(await ReturnDetailPage(detailArgs));
    expect(screen.getByRole('link', { name: 'SO-001234' })).toHaveAttribute('href', `/dashboard/orders/${ORDER_ID}`);
  });

  it('falls back to the order id prefix when order_number is null', async () => {
    workbench.mockResolvedValueOnce(bench(null));
    render(await ReturnDetailPage(detailArgs));
    expect(screen.getByRole('link', { name: ORDER_ID.slice(0, 8) })).toBeInTheDocument();
  });
});
