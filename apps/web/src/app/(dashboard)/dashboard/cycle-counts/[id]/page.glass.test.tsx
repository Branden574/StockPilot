import { render, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A cycle count's record header in Liquid Glass (Cycle-Count-Detail.dc.html:
 * the title row is the h1, its copy button and the count's status badge).
 * The status is the one the lines card head already shows: glass draws a
 * copy of it in the title row (glass-only, stateless, from the header the
 * page already has) and pages/counts.css hides the card head's while the
 * copy is drawn, so the status is on screen once in either design. The copy
 * goes BETWEEN the h1 and the copy button, where it changes neither one's
 * place among its siblings (the page pin, page.classic-dom.test.tsx), and
 * counts.css draws it after the button, as the board does. Rendered under
 * opt-in and default, never under off, and not at all for a count whose
 * reference cannot be read (no copy button: the h1 would stop being the
 * title row's last child, so the status stays in the card head there).
 * Mocks as page.classic-dom.test.tsx sets them.
 */

const h = vi.hoisted(() => ({ detail: vi.fn(), inScope: vi.fn() }));

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
    role: 'manager',
    permissions: undefined,
  })),
}));
vi.mock('@/lib/dashboard/request-cache', () => ({
  getOrgRowForRequest: vi.fn(async () => ({ timezone: 'America/Los_Angeles' })),
}));
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn(async () => ({})) }));
vi.mock('@/server/lib/count-assignees', () => ({
  fetchCountAssignees: vi.fn(async () => [
    { id: 'u-2', name: 'Avery Example', email: 'avery@example.test' },
  ]),
}));
vi.mock('@/server/lib/path-id', () => ({ notFoundUnlessUuid: vi.fn() }));
vi.mock('@/components/exceptions/linked-exceptions-block', () => ({
  LinkedExceptionsBlock: () => null,
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

import { cascaded } from '@/styles/liquid-glass/stage4-ops-cascade';

import CycleCountDetailPage from './page';

const ID = '00000000-0000-4000-8000-000000000042';

function detailOf(header: Record<string, unknown>) {
  return {
    header: {
      id: ID,
      count_number: 42,
      status: 'in_progress',
      warehouse_id: 'wh-a',
      scope: 'warehouse',
      notes: 'Full count',
      assigned_to: 'u-2',
      started_at: '2026-10-30T15:05:00Z',
      completed_at: null,
      ...header,
    },
    lines: [],
    summary: { total: 140, counted: 96, varianceCount: 6, netDelta: -8 },
    total: 0,
    pageSize: 50,
    page: 1,
  };
}

beforeEach(() => {
  vi.useFakeTimers({ now: new Date('2026-11-02T18:00:00.000Z'), toFake: ['Date'] });
  vi.clearAllMocks();
  h.inScope.mockResolvedValue(140);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

async function page(rollout: 'off' | 'opt-in' | 'default', header: Record<string, unknown> = {}) {
  vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', rollout);
  h.detail.mockResolvedValue(detailOf(header));
  const view = render(
    await CycleCountDetailPage({
      params: Promise.resolve({ id: ID }),
      searchParams: Promise.resolve({}),
    }),
  );
  const titleRow = view.container.querySelector('#cycle-count-title')!.parentElement!;
  return { ...view, titleRow };
}

describe('A cycle count page in Liquid Glass: the status in the title row', () => {
  it('draws the count status, glass-only, between the h1 and the copy button', async () => {
    const { titleRow } = await page('default');
    const parts = [...titleRow.children].map(
      (c) => c.getAttribute('data-glass') ?? c.tagName.toLowerCase(),
    );
    expect(parts).toEqual(['h1', 'count-title-status', 'button']);
    const status = titleRow.querySelector('[data-glass="count-title-status"]')!;
    expect(status.hasAttribute('data-glass-only')).toBe(true);
    expect(status.textContent).toBe('In progress');
    expect(
      within(status as HTMLElement)
        .getByText('In progress')
        .closest('[data-glass-role="status"]')
        ?.getAttribute('data-glass-state'),
    ).toBe('in_progress');
  });

  it.each([
    ['completed', 'Completed'],
    ['canceled', 'Canceled'],
  ])('words a %s count as the badge does', async (status, words) => {
    const { titleRow } = await page('default', {
      status,
      completed_at: '2026-10-31T17:00:00Z',
    });
    expect(titleRow.querySelector('[data-glass="count-title-status"]')?.textContent).toBe(words);
  });

  it('keeps the card head status in the DOM (glass hides it there while the copy is drawn)', async () => {
    const { container } = await page('default');
    expect(
      container.querySelectorAll('[data-glass-role="status"][data-glass-state="in_progress"]'),
    ).toHaveLength(2);
  });

  it('draws it under opt-in too', async () => {
    const { titleRow } = await page('opt-in');
    expect(titleRow.querySelector('[data-glass="count-title-status"]')).not.toBeNull();
  });

  it('renders none under the off rollout', async () => {
    const { titleRow, container } = await page('off');
    expect(titleRow.querySelector('[data-glass="count-title-status"]')).toBeNull();
    expect(container.querySelectorAll('[data-glass-only]')).toHaveLength(0);
  });

  it('draws none when the reference cannot be read (the status stays in the card head)', async () => {
    const { titleRow } = await page('default', { count_number: null });
    expect([...titleRow.children].map((c) => c.tagName.toLowerCase())).toEqual(['h1']);
  });
});

/**
 * The cascade on the rendered page (styles/liquid-glass/stage4-ops-cascade.ts:
 * the global glass files, then the page's pages/ops.css and pages/counts.css,
 * ranked by specificity and order as a browser ranks them).
 */
describe('A cycle count page in Liquid Glass: the head and the lines toolbar as the board draws them', () => {
  const FILES = ['pages/ops.css', 'pages/counts.css'];
  const at = (el: Element, prop: string, width = 1440) => cascaded(el, prop, FILES, width)?.value;

  beforeEach(() => {
    document.documentElement.setAttribute('data-appearance', 'liquid-glass');
  });
  afterEach(() => {
    document.documentElement.removeAttribute('data-appearance');
  });

  it('draws the title row as .row.g10 with the status after the copy button, and the way back 4 px above it', async () => {
    const { titleRow, container } = await page('default');
    expect(at(titleRow, 'column-gap')).toBe('10px');
    expect(at(titleRow.querySelector('[data-glass="count-title-status"]')!, 'order')).toBe('1');
    const back = container.querySelector('[data-glass="page-header"] > .mb-2')!;
    expect(at(back, 'margin-bottom')).toBe('4px');
  });

  it('hides the card head status while the title row shows it, and keeps it there without a reference', async () => {
    const shown = await page('default');
    const head = (root: HTMLElement) =>
      root.querySelector('.min-h-\\[49px\\] [data-glass-role="status"]')!;
    expect(at(head(shown.container), 'display')).toBe('none');
    shown.unmount();
    const noReference = await page('default', { count_number: null });
    expect(at(head(noReference.container), 'display')).not.toBe('none');
  });

  it('runs the subline and the start time on as one meta line, 4 px under the title row', async () => {
    const { titleRow } = await page('default');
    expect(at(titleRow, 'margin-bottom')).toBe('4px');
    const subline = titleRow.nextElementSibling!;
    const started = subline.nextElementSibling!;
    expect(started.tagName).toBe('P');
    expect(started.textContent).toMatch(/^Started /);
    expect(at(subline, 'display')).toBe('inline');
    expect(at(started, 'display')).toBe('inline');
    expect(at(started, 'color')).toBe('var(--lg-ink-2)');
    expect(at(started, 'font-size')).toBe('13px');
  });

  it('lays the lines toolbar out as .toolbar: the search, the views right after it, the note at the end', async () => {
    const { container } = await page('default');
    const note = container.querySelector('[data-glass="count-lines-note"]')!;
    const bar = note.parentElement!;
    expect(at(bar, 'justify-content')).toBe('flex-start');
    expect(at(bar, 'gap')).toBe('8px');
    expect(at(bar.firstElementChild!, 'flex')).toBe('1 1 280px');
    expect(at(bar.firstElementChild!, 'max-width')).toBe('360px');
    expect(at(note, 'order')).toBe('1');
    expect(at(note, 'margin-left')).toBe('auto');
    expect(at(note, 'color')).toBe('var(--lg-ink-3)');
    expect(at(note, 'font-size')).toBe('12px');
    expect(at(note, 'display')).toBeUndefined();
    expect(at(note, 'display', 760)).toBe('none');
  });

  it.each([
    [-8, 'var(--lg-danger)'],
    [3, 'var(--lg-ok)'],
  ])('draws a net variance of %i in the board tone (%s)', async (netDelta, colour) => {
    vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', 'default');
    h.detail.mockResolvedValue({
      ...detailOf({}),
      summary: { total: 140, counted: 96, varianceCount: 6, netDelta },
    });
    const view = render(
      await CycleCountDetailPage({
        params: Promise.resolve({ id: ID }),
        searchParams: Promise.resolve({}),
      }),
    );
    const figure = view.container.querySelector(
      '[data-testid="count-stat-net-variance"] > div:nth-child(2)',
    )!;
    expect(at(figure, 'color')).toBe(colour);
  });
});
