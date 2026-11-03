import { render } from '@testing-library/react';
import type * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { classicDom, classicStructure, glassOnlyCount } from '@/test/classic-dom';

/**
 * CLASSIC IS SACRED (Liquid Glass stage 3, orders lane). The Orders list's
 * Classic DOM, normalised as the classic proof normalises it
 * (src/test/classic-dom.ts), pinned in __classic__/ from the code BEFORE the
 * glass composition was added. Liquid Glass may add only inert hook
 * attributes and glass-only elements; with them stripped, the page must
 * render exactly the pinned DOM:
 *   - under the `off` rollout, with no glass-only element rendered at all;
 *   - under `default` (the Classic chooser's page: same tree, the glass-only
 *     parts present but hidden), once those are dropped;
 *   - and under `default` every Classic element keeps its place among its
 *     siblings (classicStructure: :first-child, :last-child, :only-child,
 *     :empty and the *-of-type ones), because a hidden glass-only sibling
 *     still counts for those selectors (the phone cards once took the table
 *     scroll wrapper's :last-child, and with it its rounded bottom corners,
 *     for a requester, whose card has no pager).
 * A failure here means a change touched Classic: fix the change, never the
 * snapshot (regenerate only from a commit whose Classic output is the
 * accepted baseline).
 */

const m = vi.hoisted(() => ({
  checkModuleAccess: vi.fn(),
  requireOrgContext: vi.fn(),
  withContext: vi.fn(),
  list: vi.fn(),
  myRequests: vi.fn(),
  forCurrentUser: vi.fn(),
  canManageOrderItems: vi.fn(),
}));

vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    prefetch: _prefetch,
    scroll: _scroll,
    replace: _replace,
    ...rest
  }: React.AnchorHTMLAttributes<HTMLAnchorElement> & {
    href: string;
    prefetch?: unknown;
    scroll?: unknown;
    replace?: unknown;
  }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('@/lib/modules/module-gate', () => ({ checkModuleAccess: m.checkModuleAccess }));
vi.mock('@/components/onboarding/page-tour', () => ({
  PageTour: ({ tour }: { tour: { id: string } }) => <span data-tour={tour.id} />,
}));
vi.mock('@/components/perf/perf-useful', () => ({ PerfUseful: () => <span data-perf="" /> }));
vi.mock('@/lib/auth/session', () => ({ requireOrgContext: m.requireOrgContext }));
vi.mock('@/server/services/context', () => ({ withContext: m.withContext }));
vi.mock('@/server/services/order-requests', () => ({
  OrderRequestsService: { forCurrentUser: m.forCurrentUser },
}));
vi.mock('@/server/services/order-catalog-visibility', () => ({
  canManageOrderItems: m.canManageOrderItems,
}));

import OrdersPage from './page';

const NOW = new Date('2026-11-02T18:00:00.000Z');
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000).toISOString();

let seq = 0;
function row(over: Record<string, unknown> = {}) {
  seq += 1;
  return {
    id: `o${seq}`,
    orderNumber: 200 + seq,
    status: 'pending_approval',
    warehouseId: 'w1',
    warehouseName: 'North DC',
    requesterUserId: 'u-9',
    requesterEmail: 'pat@example.test',
    requesterName: 'Pat Lee',
    requesterOrgLabel: 'Ridge Academy',
    requesterDeleted: false,
    source: 'internal',
    lineCount: 2,
    totalQuantity: 12,
    notes: null,
    createdAt: ago(120 + seq),
    updatedAt: ago(5 * seq),
    approvedAt: null,
    deliveredAt: null,
    fulfillmentType: 'pickup',
    inTransitAt: null,
    assignedPickerId: null,
    assignedPickerName: null,
    assignedDeliveryUserId: null,
    assignedDeliveryUserName: null,
    replacementForReturnId: null,
    exchange: null,
    ...over,
  };
}

const ROWS = () => [
  row(),
  row({ status: 'approved', requesterOrgLabel: null, source: 'public_link' }),
  row({ status: 'picking_in_progress', assignedPickerId: 'p1', assignedPickerName: 'Luis Ortega' }),
  row({
    status: 'in_transit',
    fulfillmentType: 'delivery',
    inTransitAt: ago(30),
    assignedDeliveryUserId: 'd1',
    assignedDeliveryUserName: 'Sam Reyes',
  }),
  row({
    status: 'completed',
    replacementForReturnId: 'r1',
    exchange: { state: 'Waiting for return' },
  }),
  row({ status: 'denied', requesterName: null, requesterEmail: null, requesterUserId: null }),
];

function viewer(approver: boolean) {
  m.requireOrgContext.mockResolvedValue({
    organizationId: 'org-1',
    userId: 'u-1',
    role: approver ? 'manager' : 'staff',
    permissions: new Set(approver ? ['orders:request', 'orders:approve'] : ['orders:request']),
  });
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
  vi.clearAllMocks();
  seq = 0;
  m.checkModuleAccess.mockResolvedValue({ enabled: true, canManage: true });
  m.withContext.mockResolvedValue({ organizationId: 'org-1' });
  m.forCurrentUser.mockResolvedValue({ list: m.list, myRequests: m.myRequests });
  m.list.mockImplementation(async () => ROWS());
  m.myRequests.mockImplementation(async () => ROWS());
  m.canManageOrderItems.mockReturnValue(true);
  viewer(true);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

/** The page's normalised Classic DOM under one rollout. */
async function classicOf(rollout: 'off' | 'default', params: Record<string, string>) {
  vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', rollout);
  seq = 0;
  const view = render(await OrdersPage({ searchParams: Promise.resolve(params) }));
  const out = {
    dom: classicDom(view.container),
    structure: classicStructure(view.container),
    glassOnly: glassOnlyCount(view.container),
  };
  view.unmount();
  return out;
}

const SCENARIOS: Array<[string, Record<string, string>, () => void]> = [
  ['approver-all-active', { status: 'all_active' }, () => {}],
  ['approver-awaiting-signature', { status: 'awaiting_signature' }, () => {}],
  ['approver-empty-tab', { status: 'picking', page: '2' }, () => m.list.mockResolvedValue([])],
  [
    'approver-failed',
    { status: 'needs_approval' },
    () => m.list.mockRejectedValue(new Error('boom')),
  ],
  ['requester', {}, () => viewer(false)],
  [
    'requester-empty',
    {},
    () => {
      viewer(false);
      m.myRequests.mockResolvedValue([]);
    },
  ],
];

describe('Orders list: the Classic DOM is the pinned one', () => {
  for (const [name, params, setup] of SCENARIOS) {
    it(`${name}: off renders no glass-only part, off and default normalise to the pinned DOM, and default moves no Classic element among its siblings`, async () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      setup();
      const off = await classicOf('off', params);
      setup();
      const glassBuild = await classicOf('default', params);
      spy.mockRestore();
      expect(off.glassOnly).toBe(0);
      expect(glassBuild.dom).toBe(off.dom);
      expect(glassBuild.structure).toBe(off.structure);
      await expect(off.dom).toMatchFileSnapshot(`./__classic__/orders-page.${name}.txt`);
    });
  }
});
