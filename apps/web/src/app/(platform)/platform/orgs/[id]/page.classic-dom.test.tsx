import { cleanup, render } from '@testing-library/react';
import type { AnchorHTMLAttributes, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { classicDom, classicStructure, glassOnlyCount } from '@/test/classic-dom';

/**
 * CLASSIC IS SACRED (Liquid Glass stage 4, admin lane). An organization's
 * page in the platform console (Platform-Console.dc.html): the header with
 * its billing summary and Act as, the tab strip, the Overview, Users (members
 * with their Order items access, Last active and actions), Inventory and
 * Orders tabs, and the Danger zone: their Classic DOM, normalised as the
 * classic proof normalises a page (src/test/classic-dom.ts), pinned in
 * __classic__/ from the code BEFORE Liquid Glass added its hooks. Liquid
 * Glass may add only inert hook attributes and glass-only elements; with them
 * stripped each tab must render exactly the pinned DOM under the `off`
 * rollout and under `default`. Fix the change, never the snapshot.
 *
 * The dialogs the page opens have their own pins
 * (components/platform/platform-dialogs.classic-dom.test.tsx); here their
 * triggers are page.layout.test.tsx's stubs.
 */

const ORG = '11111111-1111-1111-1111-111111111111';

const h = vi.hoisted(() => ({
  overview: null as Record<string, unknown> | null,
  inventory: [] as unknown[],
  orders: [] as unknown[],
  members: [] as unknown[],
  access: new Map<string, unknown>() as Map<string, unknown> | null,
}));

vi.mock('next/link', async () => {
  const React = await import('react');
  return {
    default: ({
      href,
      prefetch,
      children,
      ...rest
    }: {
      href: string;
      prefetch?: boolean | null;
      children?: ReactNode;
    } & AnchorHTMLAttributes<HTMLAnchorElement>) =>
      React.createElement('a', { href, 'data-prefetch': String(prefetch), ...rest }, children),
    useLinkStatus: () => ({ pending: false }),
  };
});
vi.mock('next/navigation', () => ({
  usePathname: () => null,
  useSearchParams: () => null,
  notFound: vi.fn(() => {
    throw new Error('notFound');
  }),
}));
vi.mock('@/lib/auth/platform-admin', () => ({
  requirePlatformAdmin: vi.fn(async () => {}),
  isPlatformAdmin: () => false,
}));
vi.mock('@/lib/auth/session', () => ({
  requireSession: vi.fn(async () => ({ userId: 'god', email: 'operator@example.test' })),
}));
vi.mock('@/server/services/platform/audit', () => ({
  recordPlatformAudit: vi.fn(async () => true),
}));
vi.mock('@/server/services/platform/orgs', () => ({
  DETAIL_PREVIEW_LIMIT: 2,
  getOrgOverview: vi.fn(async () => h.overview),
  getOrgInventory: vi.fn(async () => h.inventory),
  getOrgOrders: vi.fn(async () => h.orders),
  getOrgMembers: vi.fn(async () => ({
    members: h.members,
    total: h.members.length,
    page: 1,
    pageSize: 50,
    pageCount: 1,
    search: null,
    activityAvailable: true,
  })),
  getOrgMembersOrderItemsAccess: vi.fn(async () => h.access),
  getOrgBillingState: vi.fn(async () => null),
}));
vi.mock('@/components/platform/act-as-button', () => ({
  ActAsButton: ({ orgName }: { orgName: string }) => <button>Act as this org ({orgName})</button>,
}));
vi.mock('@/components/platform/billing-panel', () => ({ BillingPanel: () => null }));
vi.mock('@/components/platform/remove-org-dialog', () => ({
  RemoveOrgDialog: () => <button>Remove organization</button>,
}));
vi.mock('@/components/platform/user-actions-menu', () => ({
  UserActionsMenu: ({ userId }: { userId: string }) => <button>actions {userId}</button>,
}));

import PlatformOrgDetailPage from './page';

import { orderCatalogAccessPreview } from '@stockpilot/core';

function member(n: number, over: Record<string, unknown> = {}) {
  return {
    userId: `u-${n}`,
    email: `member${n}@example.test`,
    fullName: `Member ${n}`,
    role: n === 1 ? 'owner' : 'staff',
    joinedAt: '2026-01-01T00:00:00Z',
    disabledAt: null,
    lastSignInAt: null,
    lastSessionAt: null,
    lastActionAt: null,
    lastSeenAt: null,
    ...over,
  };
}

/** A member's Order items access, previewed by the core function the page uses. */
function access(
  role: 'owner' | 'staff',
  exception: 'default' | 'allow' | 'deny',
  disabled = false,
) {
  const input = { role, exception, disabled, ordersModuleEnabled: true, canRequestOrders: true };
  return { ...input, preview: orderCatalogAccessPreview(input) };
}

beforeEach(() => {
  vi.useFakeTimers({ now: new Date('2026-11-02T18:00:00Z'), toFake: ['Date'] });
  h.overview = {
    id: ORG,
    name: 'Example Schools',
    slug: 'example-schools',
    industry: 'Education',
    size: '11-50',
    timezone: 'America/Los_Angeles',
    currency: 'USD',
    createdAt: '2026-01-01T00:00:00Z',
    ownerEmail: 'owner@example.test',
    effective: { tier: 'business', source: 'trial', trialDaysRemaining: 6 },
    billingArrangement: 'trial',
    counts: { members: 4, items: 12, orders: 3, warehouses: 2 },
  };
  h.inventory = [
    { name: 'Staff Polo', sku: 'POLO-M', quantityOnHand: 12, unitCost: 9.5, status: 'active' },
    { name: 'Lanyard', sku: null, quantityOnHand: 0, unitCost: null, status: null },
  ];
  h.orders = [
    {
      id: 'abcdef12-0000-4000-8000-000000000001',
      status: 'approved',
      requester: 'Member 2',
      createdAt: '2026-10-01T00:00:00Z',
    },
  ];
  h.members = [
    member(1, { lastSignInAt: '2026-11-02T17:00:00Z' }),
    member(2, { disabledAt: '2026-10-20T00:00:00Z' }),
    member(3, { userId: null }),
  ];
  h.access = new Map([
    ['u-1', access('owner', 'default')],
    ['u-2', access('staff', 'allow', true)],
  ]);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  cleanup();
});

const STATES = [
  { name: 'overview', tab: undefined, unreadableAccess: false },
  { name: 'users', tab: 'users', unreadableAccess: false },
  { name: 'users-access-unreadable', tab: 'users', unreadableAccess: true },
  { name: 'inventory', tab: 'inventory', unreadableAccess: false },
  { name: 'orders', tab: 'orders', unreadableAccess: false },
] as const;

async function renderUnder(rollout: 'off' | 'default', state: (typeof STATES)[number]) {
  cleanup();
  vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', rollout);
  if (state.unreadableAccess) h.access = null;
  const tree = await PlatformOrgDetailPage({
    params: Promise.resolve({ id: ORG }),
    searchParams: Promise.resolve(state.tab ? { tab: state.tab } : {}),
  });
  render(tree);
  return {
    dom: classicDom(document.body),
    structure: classicStructure(document.body),
    glassOnly: glassOnlyCount(document.body),
  };
}

describe("An organization's console page, Classic DOM", () => {
  for (const state of STATES) {
    it(`${state.name}: the pinned Classic DOM under off and under default`, async () => {
      const off = await renderUnder('off', state);
      expect(off.glassOnly).toBe(0);
      const glass = await renderUnder('default', state);
      expect(glass.dom).toBe(off.dom);
      expect(glass.structure).toBe(off.structure);
      await expect(off.dom).toMatchFileSnapshot(`./__classic__/platform-org.${state.name}.txt`);
    });
  }
});
