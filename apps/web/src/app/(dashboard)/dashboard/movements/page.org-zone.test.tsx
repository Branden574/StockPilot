import { render, screen } from '@testing-library/react';
import type * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * L7 (owner decision Q1, 2026-10-05): the Movements page prints each
 * movement's time in the ORGANIZATION's zone, like counts, exceptions and
 * orders. It used to render <LocalDateTime> (the viewer's zone) in BOTH of its
 * modes: the page's own table (server mode, over 1000 movements) and the
 * instant table (the common case). The time is now formatted HERE, on the
 * server, and handed to the client table as text, so there is nothing for
 * hydration to disagree about.
 *
 * The org zone below is Asia/Tokyo on purpose: no test runner sits there, so a
 * viewer-zone string can never pass for the org-zone one.
 */

const state = vi.hoisted(() => ({
  count: 1 as number | null,
  rows: [] as Record<string, unknown>[],
  orgRow: { timezone: 'Asia/Tokyo' } as Record<string, unknown> | null,
  orgRowFails: false,
  instantProps: null as Record<string, unknown> | null,
  listCalls: [] as Array<Record<string, unknown>>,
  countCalls: [] as Array<Record<string, unknown>>,
}));

vi.mock('next/navigation', () => ({
  redirect: vi.fn(),
  usePathname: () => '/dashboard/movements',
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/lib/auth/session', () => ({
  requireOrgContext: vi.fn(async () => ({ organizationId: 'org-1', userId: 'u-1', role: 'manager' })),
}));
vi.mock('@/lib/warehouse-filter', () => ({ getActiveWarehouseFilter: vi.fn(async () => null) }));
vi.mock('@/lib/dashboard/request-cache', () => ({
  getOrgRowForRequest: vi.fn(async () => {
    if (state.orgRowFails) throw new Error('getOrgRowForRequest: read failed');
    return state.orgRow;
  }),
}));
const reportError = vi.hoisted(() => vi.fn());
vi.mock('@/lib/error-reporter', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/error-reporter')>()),
  reportError: (...args: unknown[]) => reportError(...args),
}));
vi.mock('@/server/services/movements', () => ({
  MovementsService: {
    forCurrentUser: async () => ({
      count: async (args: Record<string, unknown>) => {
        state.countCalls.push(args);
        return state.count;
      },
      list: async (args: Record<string, unknown>) => {
        state.listCalls.push(args);
        return state.rows;
      },
    }),
  },
}));
vi.mock('@/components/movements/movements-instant-table', () => ({
  MovementsInstantTable: (props: Record<string, unknown>) => {
    state.instantProps = props;
    return <div data-testid="instant-table" />;
  },
}));
vi.mock('@/components/movements/movements-filter-bar', () => ({ MovementsFilterBar: () => null }));
vi.mock('@/components/movements/editable-movement-note', () => ({ EditableMovementNote: () => null }));
vi.mock('@/components/ui/pagination', () => ({ Pagination: () => null }));
vi.mock('@/components/perf/perf-useful', () => ({ PerfUseful: () => null }));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children?: React.ReactNode } & Record<string, unknown>) => (
    <a href={String(href)} {...rest}>
      {children}
    </a>
  ),
}));

import MovementsPage from './page';

/** 05:30 UTC on 5 October: 22:30 on 4 October in Los Angeles, 14:30 on 5
 *  October in Tokyo. */
const LATE = '2026-10-05T05:30:00.000Z';

function movement(id: string) {
  return {
    id,
    movement_type: 'add',
    quantity_change: 1,
    new_quantity: 5,
    moved_quantity: null,
    reason: null,
    notes: null,
    created_at: LATE,
    order_ref_id: null,
    item: { name: `Item ${id}`, sku: `SKU-${id}` },
    actor: { fullName: 'Pat Lee', email: 'pat@example.com' },
    user_id: 'u-1',
  };
}

async function renderPage(searchParams: Record<string, string> = {}) {
  render(await MovementsPage({ searchParams: Promise.resolve(searchParams) }));
}

beforeEach(() => {
  state.count = 1;
  state.rows = [movement('m-1')];
  state.orgRow = { timezone: 'Asia/Tokyo' };
  state.orgRowFails = false;
  state.instantProps = null;
  state.listCalls = [];
  state.countCalls = [];
  reportError.mockClear();
});

describe('Movements page: times in the organization zone (L7)', () => {
  it('instant mode hands the client table the org-zone time as text', async () => {
    await renderPage();
    const rows = state.instantProps!.rows as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ createdAt: LATE, createdAtLabel: 'Oct 5, 2026, 2:30 PM' });
  });

  it('server mode prints the org-zone time in its own table, and no viewer-zone time beside it', async () => {
    state.count = 5000;
    await renderPage();
    expect(screen.queryByTestId('instant-table')).toBeNull();
    expect(screen.getByText('Oct 5, 2026, 2:30 PM')).toBeInTheDocument();
    expect(screen.getAllByText(/, 2026, /)).toHaveLength(1);
  });

  it('an org on UTC reads UTC', async () => {
    state.orgRow = { timezone: 'UTC' };
    await renderPage();
    const rows = state.instantProps!.rows as Array<Record<string, unknown>>;
    expect(rows[0]!.createdAtLabel).toBe('Oct 5, 2026, 5:30 AM');
  });

  it('a failed zone read still renders the page, in core’s documented default zone, and is reported', async () => {
    state.orgRowFails = true;
    await renderPage();
    const rows = state.instantProps!.rows as Array<Record<string, unknown>>;
    expect(rows[0]!.createdAtLabel).toBe('Oct 4, 2026, 10:30 PM');
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledWith(expect.any(Error), {
      tag: 'movements.page.org_timezone_failed',
      level: 'warning',
      organizationId: 'org-1',
    });
  });

  it('a zone read that answers reports nothing', async () => {
    await renderPage();
    expect(reportError).not.toHaveBeenCalled();
  });
});

// Slice 3 review F4: the page prints org-zone days (L7), so its From and To
// filter must cut days in the same zone. It cut them at UTC midnight (the
// SP-079 note in lib/movements-filters.ts), so From=To=2026-10-10 dropped a
// movement at 18:30 on the 10th in Los Angeles (01:30Z on the 11th) and kept
// the evening of the 9th.
describe('Movements page: From and To cut days in the organization zone (F4)', () => {
  const ONE_DAY = { from: '2026-10-10', to: '2026-10-10' };

  it("server mode asks the ledger for the org's whole day", async () => {
    state.count = 5000;
    state.orgRow = { timezone: 'America/Los_Angeles' };
    await renderPage(ONE_DAY);
    const page = state.listCalls.find((c) => c.since !== undefined)!;
    expect(page).toMatchObject({ since: '2026-10-10T07:00:00.000Z', until: '2026-10-11T07:00:00.000Z' });
    expect(state.countCalls.find((c) => c.since !== undefined)).toMatchObject({
      since: '2026-10-10T07:00:00.000Z',
      until: '2026-10-11T07:00:00.000Z',
    });
    // An 18:30 PT movement on the 10th is inside; 23:30 PT on the 9th is not.
    expect(Date.parse('2026-10-11T01:30:00.000Z')).toBeGreaterThanOrEqual(Date.parse(page.since as string));
    expect(Date.parse('2026-10-11T01:30:00.000Z')).toBeLessThan(Date.parse(page.until as string));
    expect(Date.parse('2026-10-10T06:30:00.000Z')).toBeLessThan(Date.parse(page.since as string));
  });

  it('instant mode hands the client table the zone its From and To cut days in', async () => {
    await renderPage();
    expect(state.instantProps).toMatchObject({ timeZone: 'Asia/Tokyo' });
  });

  it("a failed zone read cuts days in core's documented default zone, as its times print", async () => {
    state.count = 5000;
    state.orgRowFails = true;
    await renderPage(ONE_DAY);
    expect(state.listCalls.find((c) => c.since !== undefined)).toMatchObject({
      since: '2026-10-10T07:00:00.000Z',
      until: '2026-10-11T07:00:00.000Z',
    });
  });
});
