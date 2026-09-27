import { render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The item's "last physical count" card (F1-3), on the item page and an
 * exception's page. What it must never get wrong:
 *   - a failed read says "Couldn't load verification" (role="alert"), never
 *     "No physical count on record.";
 *   - a reader who may not see the item, an item that is gone, a missing
 *     permission or a bad id is a refusal: the card says why in the phone's
 *     words (core verificationRefusalCopy), and it is not reported;
 *   - every state reads in core's words, never "verified" and never a
 *     percentage;
 *   - the count links only for a reader the count page lets in; movements
 *     since link to the Movements tab only when the number is known;
 *   - open exceptions are chips linking to their pages, and an exception's
 *     page leaves its own one out.
 */

vi.mock('next/link', async () => {
  const React = await import('react');
  return {
    default: ({ href, children }: { href: string; children: React.ReactNode }) =>
      React.createElement('a', { href }, children),
  };
});
const reportError = vi.hoisted(() => vi.fn());
vi.mock('@/lib/error-reporter', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/error-reporter')>()),
  reportError: (...a: unknown[]) => reportError(...a),
}));
const { item, ctxRef } = vi.hoisted(() => ({
  item: vi.fn(),
  ctxRef: { current: {} as Record<string, unknown> },
}));
vi.mock('@/server/services/verification', () => ({
  VerificationService: class {
    item = item;
  },
}));
vi.mock('@/server/services/context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/services/context')>()),
  withContext: vi.fn(async () => ctxRef.current),
}));

import { ServiceError } from '@/server/services/context';
import type { ItemVerification } from '@/server/services/verification';

import { ItemVerificationCard, ItemVerificationCardView } from './item-verification-card';

const ITEM = '11111111-1111-4111-8111-111111111111';
const CC = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const OPEN_CC = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const LOC = '22222222-2222-4222-8222-222222222222';
const MOVEMENTS = '?tab=movements';

type Summary = ItemVerification['summary'];
type LastCount = NonNullable<Summary['lastCount']>;

function lastCount(o: Partial<LastCount> = {}): LastCount {
  return {
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
    countedBy: { id: 'u-1', label: 'Dana Lee' },
    postedBy: { id: 'u-2', label: 'Sam Ortiz' },
    ...o,
  };
}

function verification(
  summary: Partial<Summary> = {},
  o: Partial<ItemVerification> = {},
): ItemVerification {
  return {
    itemId: ITEM,
    summary: {
      itemId: ITEM,
      item: {
        status: 'active',
        isRental: false,
        isBundle: false,
        deleted: false,
        countable: true,
        quantityOnHand: 12,
      },
      lastCount: lastCount(),
      movementsSince: 2,
      outsideLedgerSince: 0,
      openCount: null,
      ...summary,
    },
    openIssues: [],
    openIssuesTruncated: false,
    checkedAt: '2026-09-24T18:00:02Z',
    canCount: true,
    countUnavailableReason: null,
    timeZone: 'America/Chicago',
    ...o,
  };
}

function view(
  data: ItemVerification | null,
  o: { canOpenCounts?: boolean; excludeIssueId?: string } = {},
) {
  return render(
    <ItemVerificationCardView
      data={data}
      canOpenCounts={o.canOpenCounts ?? true}
      movementsHref={MOVEMENTS}
      excludeIssueId={o.excludeIssueId ?? null}
    />,
  );
}

const card = () => screen.getByTestId('item-verification-card');
const HEADLINE = 'Last physical count: Sep 12, 2026 · CC-000031';
/** The headline's link, if any (its text is split so the reference stays on one line). */
const headlineLink = () => {
  const h = screen.getByTestId('verification-headline');
  expect(h).toHaveTextContent(HEADLINE);
  return h.querySelector('a');
};
const hrefOf = (text: string | RegExp) =>
  screen.getByText(text).closest('a')?.getAttribute('href') ?? null;

/** No state may say "verified" or show a percentage. */
function expectHonestWords() {
  const text = card().textContent ?? '';
  expect(text).not.toMatch(/verified/i);
  expect(text).not.toMatch(/%/);
}

beforeEach(() => {
  vi.clearAllMocks();
  ctxRef.current = { organizationId: 'org-1', role: 'manager' };
});

describe('ItemVerificationCardView', () => {
  it('a failed read (null) says so with role="alert", never "No physical count on record."', () => {
    view(null);
    expect(screen.getByRole('alert')).toHaveTextContent("Couldn't load verification");
    expect(screen.queryByText('No physical count on record.')).toBeNull();
    expectHonestWords();
  });

  it('never counted: "No physical count on record.", with no movements line and no count link', () => {
    view(verification({ lastCount: null, movementsSince: null, outsideLedgerSince: null }));
    expect(screen.getByTestId('verification-headline')).toHaveTextContent(
      'No physical count on record.',
    );
    expect(screen.queryByTestId('verification-movements')).toBeNull();
    expect(card().querySelector('a[href^="/dashboard/cycle-counts/"]')).toBeNull();
    expectHonestWords();
  });

  it('matched: the headline links to the count, then the result, scope, who, movements since (linked) and book now', () => {
    view(verification());
    expect(headlineLink()?.getAttribute('href')).toBe(`/dashboard/cycle-counts/${CC}`);
    // The reference stays on one line on a narrow screen (no break at "CC-").
    expect(screen.getByText('CC-000031')).toHaveClass('whitespace-nowrap');
    expect(screen.getByTestId('verification-result')).toHaveTextContent('Matched the stock on record (10)');
    expect(
      screen.getByText('Item total counted. Which locations were checked was not recorded.'),
    ).toBeTruthy();
    expect(screen.getByText('Counted by Dana Lee, posted by Sam Ortiz.')).toBeTruthy();
    expect(hrefOf('2 recorded stock movements since')).toBe(MOVEMENTS);
    expect(screen.getByText('On record now: 12')).toBeTruthy();
    expect(screen.queryByTestId('verification-outside-ledger')).toBeNull();
    expectHonestWords();
  });

  it('a reader the count page would turn away sees the count named, not linked', () => {
    view(verification({ openCount: { cycleCountId: OPEN_CC, countNumber: 45 } }), {
      canOpenCounts: false,
    });
    expect(headlineLink()).toBeNull();
    expect(screen.getByText('Being counted in CC-000045').closest('a')).toBeNull();
  });

  it('corrected, counted at its only shelf location, offline capture, AI assistance, and rows outside the ledger', () => {
    view(
      verification({
        lastCount: lastCount({
          expectedQuantity: 8,
          countedLocationId: LOC,
          countedLocation: { name: 'A-12', kind: 'rack', type: 'shelf', archived: false },
          capturedAt: '2026-09-12T14:30:00Z',
          aiAssisted: true,
        }),
        outsideLedgerSince: 3,
      }),
    );
    expect(screen.getByTestId('verification-result')).toHaveTextContent(
      'Stock on record corrected from 8 to 10 (+2)',
    );
    expect(screen.getByText('Counted while A-12 was its only shelf location')).toBeTruthy();
    expect(screen.getByText('Taken 9:30 AM on the device, synced 10:02 AM')).toBeTruthy();
    expect(screen.getByText('Recorded with AI shelf-scan assistance')).toBeTruthy();
    expect(screen.getByTestId('verification-outside-ledger')).toHaveTextContent(
      '3 recorded outside the stock ledger',
    );
    expectHonestWords();
  });

  it('a line from before 0339 reads "Counted 10"; unknown movements are said, never shown as 0 and not linked', () => {
    view(verification({ lastCount: lastCount({ expectedAtStart: null }), movementsSince: null }));
    expect(screen.getByTestId('verification-result')).toHaveTextContent('Counted 10');
    const movements = screen.getByTestId('verification-movements');
    expect(movements).toHaveTextContent('Stock movements since this count are not known');
    expect(movements.querySelector('a')).toBeNull();
    expect(card().textContent).not.toMatch(/\b0 recorded stock movements/);
  });

  it('an open count holding the item links to it', () => {
    view(verification({ openCount: { cycleCountId: OPEN_CC, countNumber: 45 } }));
    expect(hrefOf('Being counted in CC-000045')).toBe(`/dashboard/cycle-counts/${OPEN_CC}`);
  });

  it.each([
    [
      'rental equipment',
      { isRental: true, countable: false },
      'Rental equipment and kits are not cycle counted',
    ],
    [
      'a kit',
      { isBundle: true, countable: false },
      'Rental equipment and kits are not cycle counted',
    ],
    ['an archived item', { status: 'archived', countable: false }, 'Archived'],
  ])('not countable: %s', (_what, itemFacts, words) => {
    const base = verification();
    view(
      verification({
        lastCount: null,
        movementsSince: null,
        item: { ...base.summary.item, ...itemFacts },
      }),
    );
    expect(screen.getByTestId('verification-not-countable')).toHaveTextContent(words);
    expectHonestWords();
  });

  it('open exceptions are chips linking to their pages, with when they were checked', () => {
    view(
      verification(
        {},
        {
          openIssues: [
            {
              id: 'o-1',
              number: 42,
              reference: 'EX-000042',
              rule: 'count_variance',
              itemId: ITEM,
              locationId: null,
            },
            {
              id: 'o-2',
              number: 43,
              reference: 'EX-000043',
              rule: 'stale_staging',
              itemId: ITEM,
              locationId: LOC,
            },
          ],
        },
      ),
    );
    const chips = screen.getAllByTestId('verification-issue-chip');
    expect(chips.map((c) => c.querySelector('a')?.getAttribute('href'))).toEqual([
      '/dashboard/exceptions/o-1',
      '/dashboard/exceptions/o-2',
    ]);
    expect(chips[0]).toHaveTextContent('EX-000042 · Count did not match the stock on record');
    const issues = screen.getByTestId('verification-issues');
    expect(within(issues).getByText('Open exceptions')).toBeTruthy();
    expect(within(issues).getByText(/^Checked at /)).toBeTruthy();
  });

  it("an exception's page leaves its own exception out, and says the rest are the other ones", () => {
    view(
      verification(
        {},
        {
          openIssues: [
            {
              id: 'o-1',
              number: 42,
              reference: 'EX-000042',
              rule: 'count_variance',
              itemId: ITEM,
              locationId: null,
            },
            {
              id: 'o-2',
              number: 43,
              reference: 'EX-000043',
              rule: 'label_mismatch',
              itemId: ITEM,
              locationId: null,
            },
          ],
        },
      ),
      { excludeIssueId: 'o-1' },
    );
    const chips = screen.getAllByTestId('verification-issue-chip');
    expect(chips.map((c) => c.querySelector('a')?.getAttribute('href'))).toEqual([
      '/dashboard/exceptions/o-2',
    ]);
    expect(screen.getByText('Other open exceptions')).toBeTruthy();
  });

  it('no open exceptions: no exceptions section at all (never an all-clear claim)', () => {
    view(verification({}, { openIssues: [] }));
    expect(screen.queryByTestId('verification-issues')).toBeNull();
    expect(card().textContent).not.toMatch(/no open exceptions|all clear/i);
  });
});

describe('ItemVerificationCard (the read)', () => {
  const props = { itemId: ITEM, movementsHref: MOVEMENTS };

  it('reads this item through VerificationService and renders its summary', async () => {
    item.mockResolvedValue(verification());
    render(await ItemVerificationCard(props));
    expect(item).toHaveBeenCalledWith(ITEM);
    expect(screen.getByText('Matched the stock on record (10)')).toBeTruthy();
  });

  it('links the count for a reader with cycle_counts:read, and not for one without it (or stock:adjust)', async () => {
    item.mockResolvedValue(verification());
    ctxRef.current = {
      organizationId: 'org-1',
      role: 'viewer',
      permissions: new Set(['items:read']),
    };
    const { unmount } = render(await ItemVerificationCard(props));
    expect(headlineLink()).toBeNull();
    unmount();
    ctxRef.current = {
      organizationId: 'org-1',
      role: 'viewer',
      permissions: new Set(['items:read', 'cycle_counts:read']),
    };
    render(await ItemVerificationCard(props));
    expect(headlineLink()?.getAttribute('href')).toBe(`/dashboard/cycle-counts/${CC}`);
  });

  // L5 (review 2026-09-27): the web card rendered nothing on a refusal while
  // the phone card said why. Both now show the same card, in core's words.
  it.each([
    ['not_found', undefined, 'This item is not available to you, or it no longer exists.'],
    ['forbidden', undefined, 'You do not have permission to see this.'],
    ['validation_error', { reason: 'invalid_item_id' }, 'This link is not valid.'],
    [
      'forbidden',
      { reason: 'aal2_required' },
      'Your account uses an authenticator app, and this session did not sign in with it. Sign out and sign back in with your code to see this.',
    ],
  ] as const)(
    '%s (%j): the card says why, as the phone does, and it is not reported',
    async (code, details, words) => {
      item.mockRejectedValue(
        new ServiceError(code, 'no', details as Record<string, unknown> | undefined),
      );
      render(await ItemVerificationCard(props));
      const alert = screen.getByRole('alert');
      expect(alert).toHaveTextContent("Couldn't load verification");
      expect(screen.getByTestId('verification-refusal')).toHaveTextContent(words);
      expect(alert).not.toHaveTextContent('Reload the page');
      expect(screen.queryByText('No physical count on record.')).toBeNull();
      expect(reportError).not.toHaveBeenCalled();
    },
  );

  it('any other failure is reported and says "Couldn\'t load verification"', async () => {
    item.mockRejectedValue(new ServiceError('internal_error', 'relation exploded'));
    render(await ItemVerificationCard(props));
    expect(screen.getByRole('alert')).toHaveTextContent("Couldn't load verification");
    expect(screen.queryByText(/relation exploded/)).toBeNull();
    expect(reportError).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'internal_error' }),
      expect.objectContaining({ tag: 'inventory.item_verification', organizationId: 'org-1' }),
    );
  });

  it("a redirect or not-found thrown by the framework is the framework's", async () => {
    const redirect = Object.assign(new Error('NEXT_REDIRECT'), {
      digest: 'NEXT_REDIRECT;replace;/signin/mfa;307;',
    });
    item.mockRejectedValue(redirect);
    await expect(ItemVerificationCard(props)).rejects.toBe(redirect);
    expect(reportError).not.toHaveBeenCalled();
  });
});
