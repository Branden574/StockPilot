import { render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { classicDom, classicStructure, glassOnlyCount } from '@/test/classic-dom';

/**
 * CLASSIC IS SACRED (Liquid Glass stage 4, operations lane). The cycle count
 * history's Classic DOM, normalised as the classic proof normalises it
 * (src/test/classic-dom.ts), pinned in __classic__/ from the code BEFORE the
 * glass composition was added (Cycle-Counts.dc.html). Liquid Glass may add only
 * inert hook attributes and glass-only elements; with them stripped, the page
 * must render exactly the pinned DOM:
 *   - under the `off` rollout, with no glass-only element rendered at all;
 *   - under `default` (the Classic chooser's page: the same tree), once those
 *     are dropped;
 *   - and under `default` every Classic element keeps its place among its
 *     siblings (classicStructure), because a hidden glass-only sibling still
 *     counts for :first-child, :last-child and the like.
 * A failure here means a change touched Classic: fix the change, never the
 * snapshot (regenerate only from a commit whose Classic output is the
 * accepted baseline).
 */

const m = vi.hoisted(() => ({
  listPage: vi.fn(),
  role: 'manager' as 'owner' | 'admin' | 'manager' | 'staff' | 'viewer',
}));

vi.mock('@/lib/auth/session', () => ({
  requireOrgContext: vi.fn(async () => ({
    organizationId: 'org-1',
    userId: 'u-1',
    role: m.role,
    permissions: undefined,
  })),
}));
vi.mock('next/navigation', () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`redirect:${url}`);
  }),
  usePathname: () => '/dashboard/cycle-counts',
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
}));
vi.mock('@/lib/modules/module-gate', () => ({
  checkModuleAccess: vi.fn(async () => ({ enabled: true, canManage: false })),
}));
vi.mock('@/lib/dashboard/request-cache', () => ({
  getOrgRowForRequest: vi.fn(async () => ({ timezone: 'America/Los_Angeles' })),
}));
vi.mock('@/server/services/cycle-counts', () => ({
  CycleCountsService: { forCurrentUser: vi.fn(async () => ({ listPage: m.listPage })) },
}));

import CycleCountsPage from './page';

const NOW = new Date('2026-11-02T18:00:00.000Z');

function item(n: number, extra: Record<string, unknown> = {}) {
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    countNumber: n,
    warehouseId: 'wh-a',
    warehouseName: 'North DC',
    scope: 'warehouse',
    status: 'completed',
    notes: 'Monthly count: North DC',
    startedBy: 'u-mgr',
    startedByName: 'Morgan Manager',
    startedAt: '2026-10-30T15:05:00Z',
    completedAt: '2026-10-31T17:00:00Z',
    canceledAt: null,
    assignedTo: 'u-2',
    assigneeName: 'Avery Example',
    lineTotal: 20,
    lineCounted: 20,
    ...extra,
  };
}

function pageOf(items: ReturnType<typeof item>[]) {
  return {
    items,
    page: 1,
    pageSize: 25,
    total: items.length,
    totalPages: 1,
    hasPrevious: false,
    hasNext: false,
  };
}

const ROWS = () => [
  item(47, {
    status: 'in_progress',
    completedAt: null,
    lineTotal: 142,
    lineCounted: 68,
    startedAt: '2026-11-02T15:05:00Z',
  }),
  item(46, { status: 'in_progress', completedAt: null, lineTotal: 0, lineCounted: 0 }),
  item(45, { warehouseId: null, warehouseName: null, scope: 'selection', notes: null }),
  item(44, { status: 'canceled', completedAt: null, assignedTo: null, assigneeName: null }),
  item(43, { countNumber: null }),
];

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
  vi.clearAllMocks();
  m.role = 'manager';
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

async function classicOf(rollout: 'off' | 'default', params: Record<string, string>) {
  vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', rollout);
  const view = render(await CycleCountsPage({ searchParams: Promise.resolve(params) }));
  const out = {
    dom: classicDom(view.container),
    structure: classicStructure(view.container),
    glassOnly: glassOnlyCount(view.container),
  };
  view.unmount();
  return out;
}

const SCENARIOS: Array<[string, Record<string, string>, () => void]> = [
  ['rows', {}, () => m.listPage.mockResolvedValue(pageOf(ROWS()))],
  ['no-match', { q: 'zzz', status: 'completed' }, () => m.listPage.mockResolvedValue(pageOf([]))],
  ['empty-can-start', {}, () => m.listPage.mockResolvedValue(pageOf([]))],
  [
    'empty-staff',
    {},
    () => {
      m.role = 'staff';
      m.listPage.mockResolvedValue(pageOf([]));
    },
  ],
];

describe('Cycle counts history: the Classic DOM is the pinned one', () => {
  for (const [name, params, setup] of SCENARIOS) {
    it(`${name}: off renders no glass-only part, off and default normalise to the pinned DOM, and default moves no Classic element among its siblings`, async () => {
      setup();
      const off = await classicOf('off', params);
      setup();
      const glassBuild = await classicOf('default', params);
      expect(off.glassOnly).toBe(0);
      expect(glassBuild.dom).toBe(off.dom);
      expect(glassBuild.structure).toBe(off.structure);
      await expect(off.dom).toMatchFileSnapshot(`./__classic__/cycle-counts.${name}.txt`);
    });
  }
});
