import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { OrderCatalogManageListAnswer, OrderCatalogManageRow } from '@stockpilot/core';

import { classicDom, glassOnlyCount } from '@/test/classic-dom';

/**
 * CLASSIC IS SACRED (Liquid Glass stage 3, orders lane). Manage order items
 * with its list rendered for real: the Classic DOM of the list, the
 * selection bar, the Review selection sheet, the Select family dialog, the
 * Hide confirm, the access refusal and the empty list, normalised as the
 * classic proof normalises a page (src/test/classic-dom.ts), pinned in
 * __classic__/ from the code BEFORE Liquid Glass added the page's hooks.
 * Liquid Glass may add only inert hook attributes and glass-only elements;
 * with them stripped, the page must render exactly the pinned DOM under the
 * `off` rollout (with no glass-only element at all) and under `default`. Fix
 * the change, never the snapshot.
 *
 * The page's mocks are page.test.tsx's, except that the list is real; its
 * mocks are manage-order-items.test.tsx's. Invented names only.
 */

const m = vi.hoisted(() => ({
  checkModuleAccess: vi.fn(),
  withContext: vi.fn(),
  list: vi.fn(),
  categories: vi.fn(),
  warehouses: vi.fn(),
  action: vi.fn(),
}));

// The real module (the page's refusal path rethrows control flow through
// it), with the list's router stubbed.
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    prefetch: _p,
    scroll: _s,
    replace: _r,
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
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/server/actions/order-catalog-visibility', () => ({
  setOrderCatalogVisibilityAction: (...args: unknown[]) => m.action(...args),
}));
vi.mock('@/components/auth/step-up-modal', () => ({
  useStepUp: () => ({ ensure: vi.fn(async () => true), modal: null }),
}));
vi.mock('@/lib/modules/module-gate', () => ({ checkModuleAccess: m.checkModuleAccess }));
vi.mock('@/server/services/context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/services/context')>()),
  withContext: m.withContext,
}));
vi.mock('@/server/services/order-catalog-visibility', () => ({
  OrderCatalogVisibilityService: class {
    list = m.list;
  },
}));
vi.mock('@/server/services/categories', () => ({
  CategoriesService: class {
    list = m.categories;
  },
}));
vi.mock('@/lib/dashboard/request-cache', () => ({ getWarehousesForRequest: m.warehouses }));
vi.mock('@/lib/dashboard/cached-org', () => ({
  getCachedOrgTimezone: vi.fn(async () => 'America/Los_Angeles'),
}));

import { ServiceError } from '@/server/services/context';

import ManageOrderItemsPage from './page';

const ORG = '0a000000-0000-4000-8000-00000000000a';
const USER = '6d80b722-1e44-4059-aa99-efd69718cb14';
const WH = '0a000000-0000-4000-8000-0000000000d1';
const WH2 = '0a000000-0000-4000-8000-0000000000d2';
const CAT = '0a000000-0000-4000-8000-0000000000c1';
const FAMILY = '0a000000-0000-4000-8000-0000000000f0';
const id = (n: number) => `0a000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function row(n: number, over: Partial<OrderCatalogManageRow> = {}): OrderCatalogManageRow {
  return {
    id: id(n),
    name: `Record ${n}`,
    sku: `SKU-${n}`,
    identifier: null,
    itemType: 'item',
    sizeOrEdition: null,
    warehouseId: WH,
    warehouseName: 'North',
    categoryName: null,
    familyId: null,
    familyName: null,
    expected: false,
    visible: true,
    hiddenSince: null,
    thumbUrl: null,
    ...over,
  };
}

const SHIRT_XS = row(1, {
  name: 'New Hire Shirt',
  sizeOrEdition: 'XS',
  familyId: FAMILY,
  familyName: 'New Hire Shirt',
  visible: false,
  hiddenSince: '2026-10-25T18:00:00Z',
});
const SHIRT_S = row(2, {
  name: 'New Hire Shirt',
  sizeOrEdition: 'S',
  familyId: FAMILY,
  familyName: 'New Hire Shirt',
});
const BOOK = row(3, {
  name: 'Field Guide to Ponds',
  itemType: 'book',
  sizeOrEdition: 'A. Example',
  identifier: '9780000000002',
  expected: true,
});

const answerOf = (rows: OrderCatalogManageRow[]): OrderCatalogManageListAnswer => ({
  organizationId: ORG,
  viewer: { canManage: true },
  page: 1,
  pageSize: 25,
  total: rows.length === 0 ? 0 : 60,
  rows,
});

type Step = 'list' | 'selection' | 'review' | 'family' | 'confirm';

const SCENARIOS: Array<{ name: string; setup: () => void; step?: Step }> = [
  { name: 'list', setup: () => m.list.mockResolvedValue(answerOf([SHIRT_XS, SHIRT_S, BOOK])) },
  {
    name: 'selection',
    setup: () => m.list.mockResolvedValue(answerOf([SHIRT_XS, SHIRT_S, BOOK])),
    step: 'selection',
  },
  {
    name: 'review-sheet-open',
    setup: () => m.list.mockResolvedValue(answerOf([SHIRT_XS, SHIRT_S, BOOK])),
    step: 'review',
  },
  {
    name: 'family-dialog-open',
    setup: () => m.list.mockResolvedValue(answerOf([SHIRT_XS, SHIRT_S, BOOK])),
    step: 'family',
  },
  {
    name: 'hide-confirm-open',
    setup: () => m.list.mockResolvedValue(answerOf([SHIRT_XS, SHIRT_S, BOOK])),
    step: 'confirm',
  },
  {
    name: 'no-access',
    setup: () =>
      m.list.mockRejectedValue(new ServiceError('forbidden', 'x', { reason: 'forbidden' })),
  },
  { name: 'empty', setup: () => m.list.mockResolvedValue(answerOf([])) },
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ now: new Date('2026-11-02T18:00:00Z'), toFake: ['Date'] });
  m.checkModuleAccess.mockResolvedValue({ enabled: true, canManage: false });
  m.withContext.mockResolvedValue({ organizationId: ORG, userId: USER, role: 'manager' });
  m.categories.mockResolvedValue([{ id: CAT, name: 'Apparel', color: null }]);
  m.warehouses.mockResolvedValue([
    { id: WH, name: 'North' },
    { id: WH2, name: 'South' },
  ]);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      json: async () => ({
        organizationId: ORG,
        familyId: FAMILY,
        familyName: 'New Hire Shirt',
        rows: [SHIRT_XS, SHIRT_S, row(4, { name: 'New Hire Shirt', sizeOrEdition: 'M' })],
        truncated: false,
      }),
    })),
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  cleanup();
});

async function step(to: Step | undefined) {
  if (to === undefined || to === 'list') return;
  if (to === 'family') {
    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: 'Select family: New Hire Shirt' })[0]!);
    });
    await screen.findByRole('list', { name: 'Family records' });
    return;
  }
  if (to === 'confirm') {
    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', { name: 'Hide Field Guide to Ponds from Orders' }),
      );
    });
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    return;
  }
  for (const label of ['Select New Hire Shirt', 'Select Field Guide to Ponds']) {
    await act(async () => {
      fireEvent.click(screen.getAllByRole('checkbox', { name: label })[0]!);
    });
  }
  expect(within(screen.getByRole('region', { name: 'Selection' })).getByText(/2 selected/));
  if (to === 'review') {
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Review selection' }));
    });
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  }
}

async function renderUnder(rollout: 'off' | 'default', scenario: (typeof SCENARIOS)[number]) {
  cleanup();
  vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', rollout);
  scenario.setup();
  render(await ManageOrderItemsPage({ searchParams: Promise.resolve({}) }));
  await step(scenario.step);
  // Sheets and dialogs are portalled to body, so the whole body is read.
  return { dom: classicDom(document.body), glassOnly: glassOnlyCount(document.body) };
}

describe('Manage order items page, Classic DOM', () => {
  for (const scenario of SCENARIOS) {
    it(`${scenario.name}: the pinned Classic DOM under off and under default`, async () => {
      const off = await renderUnder('off', scenario);
      expect(off.glassOnly).toBe(0);
      const glass = await renderUnder('default', scenario);
      expect(glass.dom).toBe(off.dom);
      await expect(off.dom).toMatchFileSnapshot(`./__classic__/manage-items.${scenario.name}.txt`);
    });
  }
});
