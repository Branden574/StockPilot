// @vitest-environment happy-dom
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The RMA workbench page (returns RX-1): returns:read or returns:manage
 * views, a missing or foreign RMA is a 404, an internal failure is thrown
 * (not hidden as a 404), and the page renders the workbench the service
 * built in one call. The line-name batching (100 ids per request, a failed
 * batch reported) moved into the workbench builder:
 * server/services/returns-workbench.test.ts.
 */

const { workbench, notFound } = vi.hoisted(() => ({
  workbench: vi.fn(),
  notFound: vi.fn(() => {
    throw new Error('notFound');
  }),
}));

vi.mock('next/navigation', () => ({
  notFound,
  redirect: vi.fn((u: string) => {
    throw new Error(`redirect:${u}`);
  }),
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));
vi.mock('next/link', async () => {
  const React = await import('react');
  return {
    default: ({ href, children }: { href: string; children: React.ReactNode }) => React.createElement('a', { href }, children),
  };
});
vi.mock('@/lib/modules/module-gate', () => ({
  checkModuleAccess: vi.fn(async (m: string) => ({ enabled: m === 'returns', canManage: false })),
}));
const orgCtx = vi.hoisted(() => ({ value: { organizationId: 'org-1', userId: 'u1', role: 'viewer', permissions: new Set(['returns:read']) } }));
vi.mock('@/lib/auth/session', () => ({ requireOrgContext: vi.fn(async () => orgCtx.value) }));
vi.mock('@/server/services/returns', () => ({ RMAService: { forCurrentUser: vi.fn(async () => ({ workbench })) } }));
vi.mock('@/server/services/shipping', () => ({ ShippingService: { forCurrentUser: vi.fn() } }));
vi.mock('@/server/actions/returns', () => ({
  runReturnStepsAction: vi.fn(),
  denyReturnAction: vi.fn(),
  cancelReturnAction: vi.fn(),
  planReturnDispositionsAction: vi.fn(),
  buyReturnLabelAction: vi.fn(),
}));

import { ServiceError } from '@/server/services/context';

import ReturnDetailPage from './page';

const args = { params: Promise.resolve({ id: 'r1' }) };

function bench(over: Record<string, unknown> = {}) {
  return {
    organizationId: 'org-1',
    return: {
      id: 'r1',
      returnNumber: 'RMA-1',
      status: 'approved',
      source: 'requester',
      reasonCode: 'damaged',
      notes: null,
      denialReason: null,
      orderRequestId: 'o1',
      orderNumber: 103,
      warehouseId: 'w1',
      warehouseName: 'Main',
      requesterName: 'Pat Lee',
      requesterEmail: null,
      createdAt: '2026-10-01T00:00:00Z',
      approvedAt: '2026-10-02T00:00:00Z',
      receivedAt: null,
      closedAt: null,
      deniedAt: null,
      requestedByName: null,
      approvedByName: 'Dana',
      receivedByName: null,
      closedByName: null,
      deniedByName: null,
    },
    revision: 1,
    planSeq: 3,
    createdOnCounter: false,
    lines: [
      {
        id: 'l1',
        orderRequestLineId: 'ol1',
        itemId: 'i1',
        quantity: 1,
        disposition: 'restock',
        applied: false,
        item: { name: 'Walk New Hire Shirt', sku: 'NH-M', variant: 'Size M', deleted: false, imageUrl: null, thumbUrl: null },
        restock: null,
        legs: [],
        inboundState: 'Waiting',
      },
    ],
    decisions: [],
    chain: [{ at: '2026-10-01T00:00:00Z', kind: 'created', label: 'Return requested by the requester', actorName: null }],
    viewer: { canManageReturns: false, canApproveOrders: false, canReadDecisions: true },
    actions: { primary: null, secondary: [], readOnlyReason: "You don't have permission to manage returns." },
    ...over,
  };
}

beforeEach(() => vi.clearAllMocks());

describe('the RMA workbench page', () => {
  it('renders the workbench for a returns:read viewer, read-only', async () => {
    workbench.mockResolvedValueOnce(bench());
    render(await ReturnDetailPage(args));
    expect(screen.getByRole('heading', { name: 'RMA-1' })).toBeInTheDocument();
    expect(screen.getByText('Walk New Hire Shirt')).toBeInTheDocument();
    expect(screen.getByText('Size M · NH-M')).toBeInTheDocument();
    expect(screen.getByText('Qty returning: 1')).toBeInTheDocument();
    expect(screen.getByText("You don't have permission to manage returns.")).toBeInTheDocument();
    expect(screen.getByText('Return requested by the requester')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Receive' })).not.toBeInTheDocument();
  });

  it('a missing or foreign RMA is a 404', async () => {
    workbench.mockRejectedValueOnce(new ServiceError('not_found', "This return isn't available."));
    await expect(ReturnDetailPage(args)).rejects.toThrow('notFound');
  });

  it('an internal failure is thrown, never dressed up as a 404', async () => {
    workbench.mockRejectedValueOnce(new ServiceError('internal_error', 'boom'));
    await expect(ReturnDetailPage(args)).rejects.toBeInstanceOf(ServiceError);
    expect(notFound).not.toHaveBeenCalled();
  });

  it('a member without returns:read or returns:manage is sent away', async () => {
    orgCtx.value = { organizationId: 'org-1', userId: 'u1', role: 'viewer', permissions: new Set([]) };
    await expect(ReturnDetailPage(args)).rejects.toThrow('redirect:/dashboard');
    orgCtx.value = { organizationId: 'org-1', userId: 'u1', role: 'viewer', permissions: new Set(['returns:read']) };
  });
});
