import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The returns surfaces show which order a return is filed AGAINST. `returns`
// holds only the FK order_request_id, so both pages used to print the raw UUID
// prefix — a pre-SO handle that disagreed with the SO-###### number the order
// page itself renders. These tests pin the contract: print
// formatOrderNumber(order_number) when the parent order has a number, and fall
// back to the id prefix when it does not (legacy orders predate order_number).

const ORDER_ID = '11111111-1111-4111-8111-111111111111';

vi.mock('@/lib/auth/session', () => ({
  requireOrgContext: vi.fn(async () => ({
    organizationId: 'org-1',
    userId: 'u1',
    role: 'manager',
  })),
}));

vi.mock('next/navigation', () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`redirect:${url}`);
  }),
  notFound: vi.fn(() => {
    throw new Error('notFound');
  }),
}));

vi.mock('@/lib/modules/module-gate', () => ({
  checkModuleAccess: vi.fn(async () => ({ enabled: true, canManage: true })),
}));
vi.mock('@/components/dashboard/module-not-enabled', () => ({
  ModuleNotEnabled: () => null,
}));

// Item name/sku lookup on the detail page — empty is fine, the lines table is
// not what these tests assert.
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => {
    const chain: Record<string, unknown> = {};
    const self = new Proxy(chain, {
      get(_t, prop) {
        if (prop === 'then') {
          return (resolve: (v: unknown) => void) => resolve({ data: [], error: null });
        }
        return () => self;
      },
    });
    return { from: () => self };
  }),
}));

vi.mock('@/server/services/shipping', () => ({
  ShippingService: {
    forCurrentUser: vi.fn(async () => ({ getReturnLabel: vi.fn(async () => null) })),
  },
}));
vi.mock('@/components/returns/return-actions-panel', () => ({
  ReturnActionsPanel: () => null,
}));

const returnsList = vi.fn(async () => [] as unknown[]);
const returnsGet = vi.fn(async () => ({}) as unknown);
vi.mock('@/server/services/returns', () => ({
  RMAService: {
    forCurrentUser: vi.fn(async () => ({ list: returnsList, get: returnsGet })),
  },
}));

import ReturnsPage from './page';
import ReturnDetailPage from './[id]/page';

const LIST_ROW = {
  id: 'ret-1',
  organization_id: 'org-1',
  order_request_id: ORDER_ID,
  return_number: 'RMA-20260726-ABCDEF',
  status: 'requested' as const,
  source: 'internal' as const,
  reason_code: 'damaged' as const,
  created_at: '2026-07-26T00:00:00Z',
};

const DETAIL_ROW = {
  ...LIST_ROW,
  notes: null,
  denial_reason: null,
  requester_email: null,
  requester_name: null,
  approved_at: null,
  received_at: null,
  closed_at: null,
  denied_at: null,
  lines: [] as unknown[],
};

beforeEach(() => {
  vi.clearAllMocks();
});

const listArgs = { searchParams: Promise.resolve({}) };
const detailArgs = { params: Promise.resolve({ id: 'ret-1' }) };

describe('returns list — order column', () => {
  it('prints the SO number when the parent order has one', async () => {
    returnsList.mockResolvedValueOnce([{ ...LIST_ROW, order_number: 49 }]);
    render(await ReturnsPage(listArgs));
    expect(screen.getByRole('link', { name: 'SO-000049' })).toHaveAttribute(
      'href',
      `/dashboard/orders/${ORDER_ID}`,
    );
    expect(screen.queryByText(ORDER_ID.slice(0, 8))).not.toBeInTheDocument();
  });

  it('falls back to the order id prefix when order_number is null', async () => {
    returnsList.mockResolvedValueOnce([{ ...LIST_ROW, order_number: null }]);
    render(await ReturnsPage(listArgs));
    expect(screen.getByRole('link', { name: ORDER_ID.slice(0, 8) })).toBeInTheDocument();
  });
});

describe('returns detail — "Against order …"', () => {
  it('prints the SO number when the parent order has one', async () => {
    returnsGet.mockResolvedValueOnce({ ...DETAIL_ROW, order_number: 1234 });
    render(await ReturnDetailPage(detailArgs));
    expect(screen.getByRole('link', { name: 'order SO-001234' })).toHaveAttribute(
      'href',
      `/dashboard/orders/${ORDER_ID}`,
    );
  });

  it('falls back to the order id prefix when order_number is null', async () => {
    returnsGet.mockResolvedValueOnce({ ...DETAIL_ROW, order_number: null });
    render(await ReturnDetailPage(detailArgs));
    expect(
      screen.getByRole('link', { name: `order ${ORDER_ID.slice(0, 8)}` }),
    ).toBeInTheDocument();
  });
});
