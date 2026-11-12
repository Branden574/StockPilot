import { render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { classicDom, classicStructure, glassOnlyCount } from '@/test/classic-dom';

/**
 * CLASSIC IS SACRED (Liquid Glass stage 4, operations lane). A cycle count's
 * Classic DOM (the whole-count figures, the rail, the lines card with its
 * head, toolbar, table, pager and notes, and the two confirmations' hosts),
 * normalised as the classic proof normalises it (src/test/classic-dom.ts),
 * pinned in __classic__/ from the code BEFORE Liquid Glass added anything to
 * it (Cycle-Count-Detail.dc.html). Glass may add only inert hook attributes
 * and glass-only elements; with them stripped, the count must render exactly
 * the pinned DOM:
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

const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => router,
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

import { CycleCountDetail } from './cycle-count-detail';

import type {
  CycleCountLineWithItem,
  CycleCountRow,
  CycleCountSummary,
} from '@/server/services/cycle-counts';

const NOW = new Date('2026-11-02T18:00:00.000Z');

const HEADER = {
  id: '00000000-0000-4000-8000-000000000042',
  count_number: 42,
  status: 'in_progress',
  warehouse_id: 'wh-a',
  scope: 'warehouse',
  notes: 'Full count',
  assigned_to: 'u-2',
  started_at: '2026-10-30T15:05:00Z',
  completed_at: null,
} as unknown as CycleCountRow;

function line(n: number, expected: number, counted: number | null, extra = {}) {
  return {
    id: `line-${n}`,
    counted_quantity: counted,
    expected_quantity: expected,
    item: { name: `Example item ${n}`, sku: `EX-${n}`, barcode: null },
    ...extra,
  };
}

const LINES = [
  line(1, 75, 72),
  line(2, 140, 136),
  line(3, 64, null),
  line(4, 30, 30),
] as unknown as CycleCountLineWithItem[];

const SUMMARY = {
  total: 140,
  counted: 96,
  varianceCount: 6,
  netDelta: -8,
} as CycleCountSummary;

const MEMBERS = [
  { id: 'u-1', name: 'Morgan Manager', email: 'morgan@example.test' },
  { id: 'u-2', name: 'Avery Example', email: 'avery@example.test' },
];

type Props = React.ComponentProps<typeof CycleCountDetail>;

const BASE: Props = {
  header: HEADER,
  lines: LINES,
  summary: SUMMARY,
  page: 1,
  pageSize: 50,
  total: 4,
  search: '',
  filter: 'all',
  canAssign: true,
  canAdjust: true,
  members: MEMBERS,
  assigneeName: 'Avery Example',
  itemsInScopeCount: 140,
  timeZone: 'America/Los_Angeles',
  role: 'manager',
  titleId: 'cycle-count-title',
  linkedExceptions: <div data-testid="linked-exceptions" />,
};

const SCENARIOS: Array<[string, Partial<Props>]> = [
  // A manager with an open count: Cancel count and Review & post.
  ['open-manager', {}],
  // Staff count but do not post: the manager-posts sentence.
  ['open-staff', { role: 'staff', canAssign: false, members: [] }],
  // A read-only visitor: no fields, the view-only note.
  ['open-read-only', { role: 'viewer', canAdjust: false, canAssign: false, members: [] }],
  // Items added after the start, and a second page of lines.
  ['open-new-items-paged', { itemsInScopeCount: 146, total: 120, page: 2 }],
  // Nothing counted yet: Review & post disabled, no variance.
  [
    'open-nothing-counted',
    {
      lines: [line(1, 75, null)] as unknown as CycleCountLineWithItem[],
      summary: { total: 1, counted: 0, varianceCount: 0, netDelta: 0 } as CycleCountSummary,
      total: 1,
    },
  ],
  // A search that matches no line.
  ['open-no-match', { lines: [], total: 0, search: 'zzz', filter: 'variance' }],
  // Closed counts: read-only lines and the closing note.
  [
    'completed',
    {
      header: {
        ...HEADER,
        status: 'completed',
        completed_at: '2026-10-31T17:00:00Z',
      } as unknown as CycleCountRow,
    },
  ],
  ['canceled', { header: { ...HEADER, status: 'canceled' } as unknown as CycleCountRow }],
];

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

function classicOf(rollout: 'off' | 'default', props: Partial<Props>) {
  vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', rollout);
  const view = render(<CycleCountDetail {...BASE} {...props} />);
  const out = {
    dom: classicDom(view.container),
    structure: classicStructure(view.container),
    glassOnly: glassOnlyCount(view.container),
  };
  view.unmount();
  return out;
}

describe('A cycle count: the Classic DOM is the pinned one', () => {
  for (const [name, props] of SCENARIOS) {
    it(`${name}: off renders no glass-only part, off and default normalise to the pinned DOM, and default moves no Classic element among its siblings`, async () => {
      const off = classicOf('off', props);
      const glassBuild = classicOf('default', props);
      expect(off.glassOnly).toBe(0);
      expect(glassBuild.dom).toBe(off.dom);
      expect(glassBuild.structure).toBe(off.structure);
      await expect(off.dom).toMatchFileSnapshot(`./__classic__/cycle-count-detail.${name}.txt`);
    });
  }
});
