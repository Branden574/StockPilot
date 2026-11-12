import { render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { classicDom, classicStructure, glassOnlyCount } from '@/test/classic-dom';

/**
 * CLASSIC IS SACRED (Liquid Glass stage 4, operations lane). A cycle count's
 * page, its record header included (the way back, the reference as the h1
 * with its copy button, what the count covers, when it started, the sheet or
 * report link) above the count itself, normalised as the classic proof
 * normalises it (src/test/classic-dom.ts), pinned in __classic__/ from the
 * code BEFORE Liquid Glass added anything to the header
 * (Cycle-Count-Detail.dc.html draws the status beside the title). Glass may
 * add only inert hook attributes and glass-only elements; with them
 * stripped, the page must render exactly the pinned DOM:
 *   - under the `off` rollout, with no glass-only element rendered at all;
 *   - under `default` (the Classic chooser's page: the same tree), once those
 *     are dropped;
 *   - and under `default` every Classic element keeps its place among its
 *     siblings (classicStructure), because a hidden glass-only sibling still
 *     counts for :first-child, :last-child and the like.
 * The count below the header is pinned state by state in
 * components/cycle-counts/cycle-count-detail.classic-dom.test.tsx; here it is
 * the page around it. A failure here means a change touched Classic: fix the
 * change, never the snapshot (regenerate only from a commit whose Classic
 * output is the accepted baseline).
 */

const h = vi.hoisted(() => ({
  role: 'manager' as 'owner' | 'admin' | 'manager' | 'staff' | 'viewer',
  detail: vi.fn(),
  inScope: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  notFound: vi.fn(() => {
    throw new Error('notFound');
  }),
  redirect: vi.fn((url: string) => {
    throw new Error(`redirect:${url}`);
  }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/dashboard/cycle-counts/00000000-0000-4000-8000-000000000042',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/server/actions/cycle-counts', () => ({
  assignCycleCountAction: vi.fn(),
  cancelCycleCountAction: vi.fn(),
  clearCycleCountLineAction: vi.fn(),
  postCycleCountAction: vi.fn(),
  recordCycleCountLineAction: vi.fn(),
}));
vi.mock('@/lib/auth/session', () => ({
  requireOrgContext: vi.fn(async () => ({
    organizationId: 'org-1',
    userId: 'u-1',
    role: h.role,
    permissions: undefined,
  })),
}));
vi.mock('@/lib/dashboard/request-cache', () => ({
  getOrgRowForRequest: vi.fn(async () => ({ timezone: 'America/Los_Angeles' })),
}));
// Staff read the assignee's name from user_profiles (the page's own read).
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({
            data: { full_name: 'Avery Example', email: 'avery@example.test' },
          }),
        }),
      }),
    }),
  })),
}));
vi.mock('@/server/lib/count-assignees', () => ({
  fetchCountAssignees: vi.fn(async () => [
    { id: 'u-1', name: 'Morgan Manager', email: 'morgan@example.test' },
    { id: 'u-2', name: 'Avery Example', email: 'avery@example.test' },
  ]),
}));
vi.mock('@/server/lib/path-id', () => ({ notFoundUnlessUuid: vi.fn() }));
vi.mock('@/components/exceptions/linked-exceptions-block', () => ({
  LinkedExceptionsBlock: () => <div data-testid="linked-exceptions" />,
}));
vi.mock('@/server/services/cycle-counts', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  CycleCountsService: {
    forCurrentUser: vi.fn(async () => ({ getDetailPage: h.detail, itemsInScopeCount: h.inScope })),
  },
}));
vi.mock('@/server/services/warehouses', () => ({
  WarehousesService: {
    forCurrentUser: vi.fn(async () => ({
      listNames: async () => [{ id: 'wh-a', name: 'North DC' }],
    })),
  },
}));

import CycleCountDetailPage from './page';

const NOW = new Date('2026-11-02T18:00:00.000Z');
const ID = '00000000-0000-4000-8000-000000000042';

const HEADER = {
  id: ID,
  count_number: 42,
  status: 'in_progress',
  warehouse_id: 'wh-a',
  scope: 'warehouse',
  notes: 'Full count',
  assigned_to: 'u-2',
  started_at: '2026-10-30T15:05:00Z',
  completed_at: null,
};

function line(n: number, expected: number, counted: number | null) {
  return {
    id: `line-${n}`,
    counted_quantity: counted,
    expected_quantity: expected,
    item: { name: `Example item ${n}`, sku: `EX-${n}`, barcode: null },
  };
}

function detailOf(header: Record<string, unknown>) {
  return {
    header: { ...HEADER, ...header },
    lines: [line(1, 75, 72), line(2, 140, 136), line(3, 64, null)],
    summary: { total: 140, counted: 96, varianceCount: 6, netDelta: -8 },
    total: 3,
    pageSize: 50,
    page: 1,
  };
}

const SCENARIOS: Array<[string, () => void]> = [
  // A manager with an open count: the sheet link, the assignee picker.
  ['open-manager', () => h.detail.mockResolvedValue(detailOf({}))],
  // Staff: the assignee's name read-only.
  [
    'open-staff',
    () => {
      h.role = 'staff';
      h.detail.mockResolvedValue(detailOf({}));
    },
  ],
  // A closed count: the variance report link.
  [
    'completed',
    () =>
      h.detail.mockResolvedValue(
        detailOf({ status: 'completed', completed_at: '2026-10-31T17:00:00Z' }),
      ),
  ],
  ['canceled', () => h.detail.mockResolvedValue(detailOf({ status: 'canceled' }))],
  // A count whose number cannot be read: the title "Cycle count", no copy
  // button, the unavailable note in the meta row.
  ['no-reference', () => h.detail.mockResolvedValue(detailOf({ count_number: null }))],
];

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
  vi.clearAllMocks();
  h.role = 'manager';
  h.inScope.mockResolvedValue(140);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

async function classicOf(rollout: 'off' | 'default') {
  vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', rollout);
  const view = render(
    await CycleCountDetailPage({
      params: Promise.resolve({ id: ID }),
      searchParams: Promise.resolve({}),
    }),
  );
  const out = {
    dom: classicDom(view.container),
    structure: classicStructure(view.container),
    glassOnly: glassOnlyCount(view.container),
  };
  view.unmount();
  return out;
}

describe('A cycle count page: the Classic DOM is the pinned one', () => {
  for (const [name, setup] of SCENARIOS) {
    it(`${name}: off renders no glass-only part, off and default normalise to the pinned DOM, and default moves no Classic element among its siblings`, async () => {
      setup();
      const off = await classicOf('off');
      setup();
      const glassBuild = await classicOf('default');
      expect(off.glassOnly).toBe(0);
      expect(glassBuild.dom).toBe(off.dom);
      expect(glassBuild.structure).toBe(off.structure);
      await expect(off.dom).toMatchFileSnapshot(`./__classic__/cycle-count-page.${name}.txt`);
    });
  }
});
