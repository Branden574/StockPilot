import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { OrderReadinessResult } from '@stockpilot/core';

import { classicDom, glassOnlyCount } from '@/test/classic-dom';

/**
 * CLASSIC IS SACRED (Liquid Glass stage 3, orders lane). The digital pick
 * page with its pick card rendered for real: its Classic DOM for a picker
 * with lines to pick, with the short-completion confirm open, and for a
 * viewer the pick is locked to, normalised as the classic proof normalises a
 * page (src/test/classic-dom.ts), pinned in __classic__/ from the code BEFORE
 * Liquid Glass added the page's hooks. Liquid Glass may add only inert hook
 * attributes and glass-only elements; with them stripped, the page must
 * render exactly the pinned DOM under the `off` rollout (with no glass-only
 * element at all) and under `default`. Fix the change, never the snapshot.
 *
 * The page's mocks are page.test.tsx's, except that the pick card is real;
 * its server actions are stubs (nothing is clicked that would call one).
 * Invented names and example.test addresses only.
 */

const orderGet = vi.fn();
const readinessResult = vi.fn();
const readinessForCurrentUser = vi.fn(async () => ({ result: readinessResult }));
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
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/server/actions/order-requests', () => ({
  completePickingAction: vi.fn(),
  recordPickedLineAction: vi.fn(),
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
  checkModuleAccess: vi.fn(async (moduleId: string) => ({
    enabled: moduleId === 'orders',
    canManage: false,
  })),
}));
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => {
    const self: Record<string, unknown> = {};
    for (const m of ['from', 'select', 'eq']) self[m] = () => self;
    self.maybeSingle = async () => ({
      data: { full_name: 'Dana Example', email: 'dana@example.test' },
      error: null,
    });
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
    forCurrentUser: vi.fn(async () => ({ get: (id: string) => orderGet(id) })),
  },
}));
vi.mock('@/server/services/order-readiness', () => ({
  OrderReadinessService: { forCurrentUser: () => readinessForCurrentUser() },
}));

import DigitalPickPage from './page';

const ORDER = '11111111-1111-4111-8111-111111111111';
const FAILED: OrderReadinessResult = { state: 'failed', message: 'Could not check readiness.' };

const LINE = (id: string, name: string, sku: string, requested: number, picked: number | null) => ({
  id,
  order_request_id: ORDER,
  item_id: `item-${id}`,
  quantity_requested: requested,
  quantity_fulfilled: 0,
  quantity_picked: picked,
  returned_quantity: 0,
  unit_cost_at_request: 0,
  notes: null,
  item: { id: `item-${id}`, name, sku, quantity_on_hand: 40, tracking_type: 'none' },
});

function detail(over: Record<string, unknown> = {}) {
  return {
    request: {
      id: ORDER,
      status: 'picking_in_progress',
      warehouse_id: 'wh-1',
      assigned_picker_id: 'u1',
      ...over,
    },
    lines: [
      LINE('LA', 'Staff Polo, Navy, M', 'APP-POLO-NVY-M', 4, 2),
      LINE('LB', 'Safety Vest, Hi-Vis', 'SAF-VEST-HV', 6, null),
      LINE('LC', 'Whiteboard Markers, 4-pack', 'OFF-MRK-4PK', 10, 10),
    ],
    requesterName: 'Robin Example',
    requesterEmail: 'robin@example.test',
  };
}

const SCENARIOS: Array<{ name: string; setup: () => void; openConfirm?: boolean }> = [
  {
    name: 'picker',
    setup: () => {
      ctxHolder.current = { role: 'manager', userId: 'u1' };
      orderGet.mockResolvedValue(detail());
    },
  },
  {
    name: 'picker-short-confirm-open',
    setup: () => {
      ctxHolder.current = { role: 'manager', userId: 'u1' };
      orderGet.mockResolvedValue(detail());
    },
    openConfirm: true,
  },
  {
    name: 'locked-to-another-picker',
    setup: () => {
      ctxHolder.current = { role: 'staff', userId: 'u1' };
      orderGet.mockResolvedValue(detail({ assigned_picker_id: 'someone-else' }));
    },
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ now: new Date('2026-11-02T18:00:00Z'), toFake: ['Date'] });
  readinessResult.mockResolvedValue(FAILED);
  readinessForCurrentUser.mockImplementation(async () => ({ result: readinessResult }));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  cleanup();
});

async function renderUnder(rollout: 'off' | 'default', scenario: (typeof SCENARIOS)[number]) {
  cleanup();
  vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', rollout);
  scenario.setup();
  render(await DigitalPickPage({ params: Promise.resolve({ id: ORDER }) }));
  if (scenario.openConfirm) {
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Complete picking/ }));
    });
    expect(screen.getByTestId('completion-confirm')).toBeInTheDocument();
  }
  // The confirm is portalled to body, so the whole body is read.
  return { dom: classicDom(document.body), glassOnly: glassOnlyCount(document.body) };
}

describe('Digital pick page, Classic DOM', () => {
  for (const scenario of SCENARIOS) {
    it(`${scenario.name}: the pinned Classic DOM under off and under default`, async () => {
      const off = await renderUnder('off', scenario);
      expect(off.glassOnly).toBe(0);
      const glass = await renderUnder('default', scenario);
      expect(glass.dom).toBe(off.dom);
      await expect(off.dom).toMatchFileSnapshot(`./__classic__/order-pick.${scenario.name}.txt`);
    });
  }
});
