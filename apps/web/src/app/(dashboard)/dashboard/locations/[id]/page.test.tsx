// @vitest-environment happy-dom
import { render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * One location's page (F1-3). What it must never get wrong:
 *   - a failed read says "Couldn't load verification" (role="alert"), never
 *     an empty location and never "Not counted";
 *   - not found, not visible, a malformed id or a reader without items:read
 *     says "Couldn't load verification" and why, in the phone's words (not
 *     found and not visible are the same answer, so existence is not leaked);
 *   - a location the reader's warehouses do not cover says so, never
 *     "nothing here";
 *   - the totals line covers EVERY row, not the 50 on the page;
 *   - "No open exceptions" is said only once a check has run, and only when
 *     nothing here is hidden from the reader;
 *   - rows link through to their items; "Recount items here" is offered
 *     only to a reader the server says may start one, disabled with the
 *     reason above the recount cap;
 *   - nothing says "verified" or shows a percentage.
 */

const { location, withContextMock, reportError } = vi.hoisted(() => ({
  location: vi.fn(),
  withContextMock: vi.fn(),
  reportError: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  notFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));
vi.mock('next/link', async () => {
  const React = await import('react');
  return {
    default: ({ href, children }: { href: string; children: React.ReactNode }) =>
      React.createElement('a', { href }, children),
  };
});
vi.mock('@/server/services/verification', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/services/verification')>()),
  VerificationService: class {
    location = location;
  },
}));
vi.mock('@/server/services/context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/services/context')>()),
  withContext: withContextMock,
}));
vi.mock('@/lib/error-reporter', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/error-reporter')>()),
  reportError: (...a: unknown[]) => reportError(...a),
}));
vi.mock('@/server/actions/exceptions', () => ({
  listItemsRecountTargetsAction: vi.fn(),
  listCountAssigneesAction: vi.fn(),
  startRecountAction: vi.fn(),
}));

import { ServiceError } from '@/server/services/context';
import type { LocationVerification, LocationVerificationRow } from '@/server/services/verification';

import LocationPage from './page';

const LOC = '22222222-2222-4222-8222-222222222222';
const OTHER_LOC = '33333333-3333-4333-8333-333333333333';
const CC = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const OPEN_CC = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

function itemId(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

type Summary = NonNullable<LocationVerificationRow['summary']>;

function summary(
  id: string,
  o: Partial<Summary> = {},
  count: Partial<NonNullable<Summary['lastCount']>> | null = {},
): Summary {
  return {
    itemId: id,
    item: {
      status: 'active',
      isRental: false,
      isBundle: false,
      deleted: false,
      countable: true,
      quantityOnHand: 12,
    },
    lastCount:
      count === null
        ? null
        : {
            cycleCountId: CC,
            countNumber: 31,
            completedAt: '2026-09-12T16:00:00Z',
            countedAt: '2026-09-12T15:02:00Z',
            capturedAt: null,
            baselineAt: '2026-09-12T15:02:00Z',
            expectedQuantity: 10,
            expectedAtStart: 10,
            countedQuantity: 10,
            countedLocationId: null,
            countedLocation: null,
            aiAssisted: false,
            countedBy: null,
            postedBy: null,
            ...count,
          },
    movementsSince: count === null ? null : 2,
    outsideLedgerSince: count === null ? null : 0,
    openCount: null,
    ...o,
  };
}

function rowOf(
  n: number,
  s: Summary | null,
  o: Partial<LocationVerificationRow> = {},
): LocationVerificationRow {
  return {
    itemId: itemId(n),
    name: `Item ${n}`,
    sku: `SKU-${n}`,
    quantity: 4,
    summary: s,
    issues: [],
    ...o,
  };
}

function data(o: Partial<LocationVerification> = {}): LocationVerification {
  return {
    location: {
      id: LOC,
      name: 'A-12',
      kind: 'rack',
      type: 'shelf',
      warehouseId: 'wh-a',
      warehouseName: 'Main',
      archived: false,
    },
    holdingsVisible: true,
    openIssues: [],
    openIssuesTruncated: false,
    rows: [
      rowOf(
        1,
        summary(
          itemId(1),
          {},
          {
            countedLocationId: LOC,
            countedLocation: { name: 'A-12', kind: 'rack', type: 'shelf', archived: false },
          },
        ),
      ),
      rowOf(2, summary(itemId(2), {}, null)),
      rowOf(3, summary(itemId(3))),
    ],
    page: 1,
    pageSize: 50,
    pageCount: 1,
    totalRows: 3,
    totals: {
      items: 3,
      quantity: 12,
      countedHere: 1,
      countedItemTotal: 1,
      notCounted: 1,
      unavailable: 0,
      hiddenItems: 0,
      hiddenQuantity: 0,
      countable: 3,
    },
    truncated: false,
    checkedAt: '2026-09-24T18:00:02Z',
    canRecount: false,
    recountUnavailableReason: 'not_permitted',
    recountProblem: null,
    recountItemIds: [],
    timeZone: 'America/Chicago',
    ...o,
  };
}

async function renderPage(id = LOC, page?: string) {
  return render(
    await LocationPage({
      params: Promise.resolve({ id }),
      searchParams: Promise.resolve(page === undefined ? {} : { page }),
    }),
  );
}

function expectHonestWords() {
  const text = document.body.textContent ?? '';
  expect(text).not.toMatch(/verified/i);
  expect(text).not.toMatch(/%/);
}

beforeEach(() => {
  vi.clearAllMocks();
  withContextMock.mockResolvedValue({ organizationId: 'org-1', role: 'staff' });
  location.mockResolvedValue(data());
});

describe('Location page', () => {
  // L5 (review 2026-09-27): the phone says why a location cannot be shown;
  // the web page now says the same, in core's words, instead of a bare 404.
  it('a malformed id says the link is not valid, without a read', async () => {
    await renderPage('not-an-id');
    expect(screen.getByRole('alert')).toHaveTextContent("Couldn't load verification");
    expect(screen.getByTestId('location-refusal')).toHaveTextContent('This link is not valid.');
    expect(location).not.toHaveBeenCalled();
  });

  it.each([
    ['not_found', undefined, 'This location is not available to you, or it no longer exists.'],
    ['forbidden', undefined, 'You do not have permission to see this.'],
    ['validation_error', { reason: 'invalid_location_id' }, 'This link is not valid.'],
    [
      'forbidden',
      { reason: 'mfa_required' },
      'Your organization requires two-factor authentication. Set it up on the web, then sign in again.',
    ],
  ] as const)(
    '%s (%j): says why, as the phone does, not reported',
    async (code, details, words) => {
      location.mockRejectedValue(
        new ServiceError(code, 'no', details as Record<string, unknown> | undefined),
      );
      await renderPage();
      expect(screen.getByRole('alert')).toHaveTextContent("Couldn't load verification");
      expect(screen.getByTestId('location-refusal')).toHaveTextContent(words);
      expect(screen.queryByText(/Not counted|0 items|No open exceptions/)).not.toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Locations' })).toHaveAttribute(
        'href',
        '/dashboard/locations',
      );
      expect(reportError).not.toHaveBeenCalled();
    },
  );

  it('any other failure says "Couldn\'t load verification", never an empty location, and is reported', async () => {
    location.mockRejectedValue(new ServiceError('internal_error', 'relation exploded'));
    await renderPage();
    expect(screen.getByRole('alert')).toHaveTextContent("Couldn't load verification");
    expect(screen.queryByText(/Not counted|0 items|No open exceptions/)).not.toBeInTheDocument();
    expect(screen.queryByText(/relation exploded/)).not.toBeInTheDocument();
    expect(reportError).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'internal_error' }),
      expect.objectContaining({ tag: 'locations.verification_page', organizationId: 'org-1' }),
    );
  });

  it('the header: name, kind and warehouse, and an archived badge that points back to the archived list', async () => {
    location.mockResolvedValue(data({ location: { ...data().location, archived: true } }));
    await renderPage();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('A-12');
    expect(screen.getByTestId('location-kind')).toHaveTextContent('Rack · Main');
    expect(screen.getByText('Archived')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Locations' })).toHaveAttribute(
      'href',
      '/dashboard/locations?view=archived',
    );
  });

  it('reads the page it was asked for; anything that is not a page number reads page 1', async () => {
    await renderPage(LOC, '3');
    expect(location).toHaveBeenLastCalledWith(LOC, { page: 3 });
    for (const bad of ['0', '-1', 'abc', '1.5', '9999999']) {
      location.mockClear();
      await renderPage(LOC, bad);
      expect(location).toHaveBeenLastCalledWith(LOC, { page: 1 });
    }
  });

  it('each row: the item (linked), the units here and what its latest count says about this place', async () => {
    await renderPage();
    const rows = screen.getAllByTestId('location-row');
    expect(rows).toHaveLength(3);
    expect(within(rows[0]!).getByRole('link', { name: 'Item 1' })).toHaveAttribute(
      'href',
      `/dashboard/inventory/${itemId(1)}`,
    );
    expect(within(rows[0]!).getByTestId('location-row-quantity')).toHaveTextContent('4 here');
    expect(within(rows[0]!).getByTestId('location-row-count')).toHaveTextContent(
      'Counted Sep 12, 2026, while this was its only shelf location',
    );
    expect(
      within(rows[0]!).getByRole('link', { name: '2 recorded stock movements since' }),
    ).toHaveAttribute('href', `/dashboard/inventory/${itemId(1)}?tab=movements`);
    expect(within(rows[1]!).getByTestId('location-row-count')).toHaveTextContent('Not counted');
    expect(within(rows[2]!).getByTestId('location-row-count')).toHaveTextContent(
      'Item total counted Sep 12, 2026, location not recorded',
    );
    expectHonestWords();
  });

  it('a row whose summary could not be read says "Couldn\'t load verification", never "Not counted"', async () => {
    location.mockResolvedValue(data({ rows: [rowOf(1, null)] }));
    await renderPage();
    expect(screen.getByTestId('location-row-count')).toHaveTextContent(
      "Couldn't load verification",
    );
    expect(screen.queryByText('Not counted')).not.toBeInTheDocument();
  });

  it('the totals line covers every row, not only the page shown', async () => {
    location.mockResolvedValue(
      data({
        rows: Array.from({ length: 50 }, (_, i) => rowOf(51 + i, summary(itemId(51 + i)))),
        page: 2,
        pageCount: 3,
        totalRows: 120,
        totals: {
          items: 120,
          quantity: 480,
          countedHere: 20,
          countedItemTotal: 70,
          notCounted: 30,
          unavailable: 0,
          hiddenItems: 2,
          hiddenQuantity: 5,
          countable: 118,
        },
      }),
    );
    await renderPage(LOC, '2');
    expect(screen.getByTestId('location-totals')).toHaveTextContent(
      '120 items, 480 units here. 20 counted while this was their only shelf location, 70 item totals counted, 30 not counted. 2 more items here (5 units) are not listed because you cannot open them.',
    );
    expect(screen.getAllByTestId('location-row')).toHaveLength(50);
    // The pager moves between pages of this location.
    expect(screen.getByRole('link', { name: '← Prev' })).toHaveAttribute(
      'href',
      `/dashboard/locations/${LOC}`,
    );
    expect(screen.getByRole('link', { name: 'Next →' })).toHaveAttribute(
      'href',
      `/dashboard/locations/${LOC}?page=3`,
    );
    expect(screen.getByText('Page 2 of 3')).toBeInTheDocument();
  });

  it('a holdings read that reached its cap says the totals are partial', async () => {
    location.mockResolvedValue(data({ truncated: true }));
    await renderPage();
    expect(screen.getByTestId('location-truncated')).toHaveTextContent(
      'Only the first 20,000 holdings here were read, so these totals are partial.',
    );
  });

  // L5: the phone disabled "Recount items here" on a partial read; the web
  // did not. Both apply core's rule now (the server's reason, else this).
  it('"Recount items here" on a partial holdings read is disabled, with the reason', async () => {
    location.mockResolvedValue(
      data({
        truncated: true,
        canRecount: true,
        recountUnavailableReason: null,
        recountProblem: null,
        recountItemIds: [itemId(1)],
      }),
    );
    await renderPage();
    expect(screen.getByTestId('location-recount')).toBeDisabled();
    expect(screen.getByTestId('location-recount-problem')).toHaveTextContent(
      'Only the first 20,000 holdings here were read, so these totals are partial.',
    );
  });

  it("outside the reader's warehouses: says so, never an empty location, with no totals and no recount", async () => {
    location.mockResolvedValue(
      data({
        holdingsVisible: false,
        rows: [],
        totals: null,
        totalRows: 0,
        canRecount: true,
        recountUnavailableReason: null,
      }),
    );
    await renderPage();
    expect(screen.getByTestId('location-out-of-scope')).toHaveTextContent(
      'Stock at this location is in a warehouse you are not assigned to, so it is not listed here.',
    );
    expect(screen.queryByTestId('location-totals')).not.toBeInTheDocument();
    expect(screen.queryByTestId('location-rows')).not.toBeInTheDocument();
    expect(screen.queryByTestId('location-recount')).not.toBeInTheDocument();
  });

  // M2 (review 2026-09-27): the open exceptions are read under the same RLS,
  // so out of the reader's warehouses none come back. That is not "none
  // recorded".
  it("outside the reader's warehouses, open issues say they are not listed, never that none are recorded", async () => {
    location.mockResolvedValue(
      data({ holdingsVisible: false, rows: [], totals: null, totalRows: 0, openIssues: [] }),
    );
    await renderPage();
    const here = screen.getByTestId('location-open-issues');
    expect(within(here).getByTestId('location-issues-out-of-scope')).toHaveTextContent(
      'This location is in a warehouse you are not assigned to, so its open exceptions are not listed here.',
    );
    expect(here).not.toHaveTextContent('No open exceptions');
  });

  it('with items here the reader cannot open, no open exceptions is "none you can see"', async () => {
    location.mockResolvedValue(
      data({ totals: { ...data().totals!, hiddenItems: 2, hiddenQuantity: 5 } }),
    );
    await renderPage();
    expect(screen.getByTestId('location-no-open-issues')).toHaveTextContent(
      'No open exceptions you can see are recorded here.',
    );
    expect(
      screen.queryByText('No open exceptions are recorded at this location.'),
    ).not.toBeInTheDocument();
  });

  it('open issues here are chips linking to their pages, with when they were checked', async () => {
    location.mockResolvedValue(
      data({
        openIssues: [
          {
            id: 'o-1',
            number: 1,
            reference: 'EX-000001',
            rule: 'stale_staging',
            itemId: itemId(1),
            locationId: LOC,
          },
        ],
        rows: [
          rowOf(1, summary(itemId(1)), {
            issues: [
              {
                id: 'o-2',
                number: 2,
                reference: 'EX-000002',
                rule: 'count_variance',
                itemId: itemId(1),
                locationId: null,
              },
            ],
          }),
        ],
      }),
    );
    await renderPage();
    const here = screen.getByTestId('location-open-issues');
    expect(within(here).getByRole('link', { name: /EX-000001/ })).toHaveAttribute(
      'href',
      '/dashboard/exceptions/o-1',
    );
    expect(within(here).getByText(/^Checked at /)).toBeInTheDocument();
    const row = screen.getByTestId('location-row');
    expect(
      within(row).getByRole('link', { name: 'EX-000002 · Count did not match the book' }),
    ).toHaveAttribute('href', '/dashboard/exceptions/o-2');
  });

  it('no open exceptions is said only once a check has run; before the first check it says the check has not run', async () => {
    await renderPage();
    expect(
      screen.getByText('No open exceptions are recorded at this location.'),
    ).toBeInTheDocument();
    location.mockResolvedValue(data({ checkedAt: null }));
    document.body.innerHTML = '';
    await renderPage();
    expect(
      screen.queryByText('No open exceptions are recorded at this location.'),
    ).not.toBeInTheDocument();
    expect(screen.getByText(/The first check has not run yet/)).toBeInTheDocument();
  });

  it('an item being counted links to its count for a reader who can open counts, and is named for one who cannot', async () => {
    const counting = data({
      rows: [
        rowOf(1, summary(itemId(1), { openCount: { cycleCountId: OPEN_CC, countNumber: 45 } })),
      ],
    });
    location.mockResolvedValue(counting);
    await renderPage();
    expect(screen.getByRole('link', { name: 'Being counted in CC-000045' })).toHaveAttribute(
      'href',
      `/dashboard/cycle-counts/${OPEN_CC}`,
    );
    document.body.innerHTML = '';
    withContextMock.mockResolvedValue({
      organizationId: 'org-1',
      role: 'viewer',
      permissions: new Set(['items:read']),
    });
    await renderPage();
    expect(screen.getByText('Being counted in CC-000045').closest('a')).toBeNull();
  });

  it('"Recount items here": offered to a reader the server says may recount, with the server\'s item ids', async () => {
    location.mockResolvedValue(
      data({
        canRecount: true,
        recountUnavailableReason: null,
        recountItemIds: [itemId(1), itemId(3)],
      }),
    );
    await renderPage();
    expect(screen.getByTestId('location-recount')).toBeEnabled();
    expect(screen.getByTestId('location-recount')).toHaveTextContent('Recount items here');
  });

  it('"Recount items here" above the recount cap is disabled, with the reason', async () => {
    const problem =
      'A recount can include at most 200 items, and 240 items here can be counted. Count this location from Cycle Counts instead.';
    location.mockResolvedValue(
      data({ canRecount: true, recountUnavailableReason: null, recountProblem: problem }),
    );
    await renderPage();
    expect(screen.getByTestId('location-recount')).toBeDisabled();
    expect(screen.getByTestId('location-recount-problem')).toHaveTextContent(problem);
  });

  it('a reader who may not start a recount gets no button', async () => {
    await renderPage();
    expect(screen.queryByTestId('location-recount')).not.toBeInTheDocument();
  });

  // M1: Unplaced is recorded while Staging may also hold some (pgTAP 0374
  // S28), so never "all of it was here".
  it('the Unplaced page reads "while this was its only place outside Staging", never "all of it" or a shelf', async () => {
    location.mockResolvedValue(
      data({
        location: { ...data().location, name: 'Unplaced', kind: 'unplaced', type: 'other' },
        rows: [
          rowOf(
            1,
            summary(
              itemId(1),
              {},
              {
                countedLocationId: LOC,
                countedLocation: {
                  name: 'Unplaced',
                  kind: 'unplaced',
                  type: 'other',
                  archived: false,
                },
              },
            ),
          ),
        ],
        totals: {
          ...data().totals!,
          items: 1,
          quantity: 4,
          countedHere: 1,
          countedItemTotal: 0,
          notCounted: 0,
        },
      }),
    );
    await renderPage();
    expect(screen.getByTestId('location-kind')).toHaveTextContent('System location · Main');
    expect(screen.getByTestId('location-row-count')).toHaveTextContent(
      'Counted Sep 12, 2026, while this was its only place outside Staging',
    );
    expect(screen.getByTestId('location-totals')).toHaveTextContent(
      '1 item, 4 units here. 1 counted while this was its only place outside Staging.',
    );
    expect(document.body.textContent).not.toMatch(/shelf location|all of it/);
  });

  // L2: a Site is not a shelf.
  it("a job site's page: its only place outside Staging, never a shelf location", async () => {
    location.mockResolvedValue(
      data({
        location: {
          ...data().location,
          name: 'Job site',
          kind: null,
          type: 'jobsite',
          warehouseName: null,
        },
        rows: [rowOf(1, summary(itemId(1), {}, { countedLocationId: LOC }))],
        totals: {
          ...data().totals!,
          items: 1,
          quantity: 4,
          countedHere: 1,
          countedItemTotal: 0,
          notCounted: 0,
        },
      }),
    );
    await renderPage();
    expect(screen.getByTestId('location-kind')).toHaveTextContent('Job site');
    expect(screen.getByTestId('location-row-count')).toHaveTextContent(
      'Counted Sep 12, 2026, while this was its only place outside Staging',
    );
    expect(screen.getByTestId('location-totals')).toHaveTextContent(
      '1 item, 4 units here. 1 counted while this was its only place outside Staging.',
    );
    expect(document.body.textContent).not.toMatch(/shelf location/);
  });

  it('counted elsewhere and moved here since: says where the count was taken', async () => {
    location.mockResolvedValue(
      data({
        rows: [
          rowOf(
            1,
            summary(
              itemId(1),
              {},
              {
                countedLocationId: OTHER_LOC,
                countedLocation: { name: 'B-3', kind: 'rack', type: 'shelf', archived: false },
              },
            ),
          ),
        ],
      }),
    );
    await renderPage();
    expect(screen.getByTestId('location-row-count')).toHaveTextContent(
      'Item total counted Sep 12, 2026, while B-3 was its only shelf location',
    );
  });
});
