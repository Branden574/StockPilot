import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  hiddenItemFacts,
  orderReadinessFacts,
  READINESS_FAILED,
  readinessOk,
  visibleItemFacts,
} from '@/test/order-readiness-facts';

import { putAwayTargets, type OrderReadinessAssessment } from '@stockpilot/core';

import { ReadinessStrip } from './readiness-strip';
import {
  READINESS_TONE_STYLES,
  readinessLinePutAwayHref,
  readinessStripPutAway,
  readinessStripView,
  type ReadinessStripView,
} from './readiness-view';

const routerRefresh = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: routerRefresh, push: vi.fn() }),
}));

// "Hold available stock" (F2-2) calls this server action.
const holdOrderStock = vi.hoisted(() => vi.fn());
vi.mock('@/server/actions/order-requests', () => ({
  holdOrderStockAction: (input: unknown) => holdOrderStock(input),
}));
const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn() }));
vi.mock('sonner', () => ({ toast: toastMock }));

const TZ = 'America/Los_Angeles';
const ORDER = '11111111-1111-1111-1111-111111111111';

const facts = (status: string, items: Record<string, unknown>[], neededBy: string | null = null) =>
  orderReadinessFacts(
    ORDER,
    status,
    items.map((it, i) => ({ lineId: `L${i + 1}`, itemId: String(it.itemId), requested: 10 })),
    items,
    { neededBy },
  );

beforeEach(() => {
  routerRefresh.mockReset();
  holdOrderStock.mockReset();
  toastMock.success.mockReset();
  toastMock.error.mockReset();
  toastMock.warning.mockReset();
});

describe('readinessStripView: what the strip says, from core', () => {
  it('the full panel: the roll-up, the needed-by signal and when it was checked', () => {
    const view = readinessStripView(
      readinessOk(
        facts(
          'approved',
          [
            visibleItemFacts('a', { here: { rack: 10 } }),
            visibleItemFacts('b', { here: { rack: 4 } }),
          ],
          '2026-09-20T17:00:00Z',
        ),
      ),
      'full',
      { timeZone: TZ },
    );
    expect(view).toEqual({
      mode: 'full',
      headline: '1 line short',
      tone: 'danger',
      icon: 'alert',
      details: ['1 of 2 lines ready to pick'],
      neededBy: 'Past its needed-by date (Sep 20)',
      checkedAt: 'Checked at 10:42 AM. Stock can change after this.',
      detail: null,
      failed: false,
    });
  });

  it('green only when every line is ready', () => {
    const view = readinessStripView(
      readinessOk(facts('pending_approval', [visibleItemFacts('a', { here: { rack: 10 } })])),
      'full',
      {
        timeZone: TZ,
      },
    );
    expect(view).toMatchObject({
      headline: 'Ready to pick (1 of 1 line)',
      tone: 'success',
      icon: 'check',
    });
    const hidden = readinessStripView(
      readinessOk(facts('pending_approval', [hiddenItemFacts('a')])),
      'full',
      {
        timeZone: TZ,
      },
    );
    expect(hidden).toMatchObject({ headline: "1 line can't be confirmed", tone: 'neutral' });
  });

  it('a failed read is "Couldn\'t check readiness", never a time it was checked', () => {
    expect(readinessStripView(READINESS_FAILED, 'full', { timeZone: TZ })).toMatchObject({
      mode: 'full',
      headline: "Couldn't check readiness. Try again.",
      checkedAt: null,
      detail: null,
      failed: true,
    });
  });

  it("a failure's own reason, in core's words (the phone shows the same line)", () => {
    for (const message of [
      'Order not found.',
      'You are not allowed to check readiness for this order.',
      'Orders are turned off for this organization.',
      'The order changed while it was being checked. Check again.',
    ]) {
      expect(readinessStripView({ state: 'failed', message }, 'full', { timeZone: TZ })).toMatchObject({
        headline: "Couldn't check readiness. Try again.",
        detail: message,
      });
    }
    // An internal fault's generic text is never shown as a reason.
    expect(
      readinessStripView({ state: 'failed', message: 'An internal error occurred. Please try again.' }, 'full', {
        timeZone: TZ,
      }),
    ).toMatchObject({ detail: null });
  });

  it('the requester: one sentence, toned by what it says; a failed read says so, never "in stock" or "checking"', () => {
    expect(
      readinessStripView(
        readinessOk(facts('approved', [visibleItemFacts('a', { here: { rack: 10 } })])),
        'requester',
        {
          timeZone: TZ,
        },
      ),
    ).toEqual({
      mode: 'requester',
      sentence: 'All items are in stock.',
      tone: 'success',
      icon: 'check',
      checkedAt: 'Checked at 10:42 AM. Stock can change after this.',
      failed: false,
    });
    expect(
      readinessStripView(
        readinessOk(facts('approved', [visibleItemFacts('a', { here: { rack: 4 } })])),
        'requester',
        {
          timeZone: TZ,
        },
      ),
    ).toMatchObject({
      sentence: 'Some items are waiting on stock.',
      tone: 'warning',
      icon: 'clock',
    });
    expect(readinessStripView(READINESS_FAILED, 'requester', { timeZone: TZ })).toMatchObject({
      sentence: "Stock couldn't be checked just now.",
      tone: 'neutral',
      checkedAt: null,
      failed: true,
    });
  });

  it('nothing for anyone outside the audience, and nothing for a closed order', () => {
    const ok = readinessOk(facts('approved', [visibleItemFacts('a', { here: { rack: 10 } })]));
    expect(readinessStripView(ok, 'none', { timeZone: TZ })).toBeNull();
    expect(readinessStripView(READINESS_FAILED, 'none', { timeZone: TZ })).toBeNull();
    const closed = readinessOk(orderReadinessFacts(ORDER, 'completed', [], []));
    expect(readinessStripView(closed, 'full', { timeZone: TZ })).toBeNull();
    expect(readinessStripView(closed, 'requester', { timeZone: TZ })).toBeNull();
  });
});

describe('ReadinessStrip', () => {
  const full: ReadinessStripView = {
    mode: 'full',
    headline: '2 lines need put-away',
    tone: 'warning',
    icon: 'package',
    details: ['1 line short', '3 of 6 lines ready to pick'],
    neededBy: 'May miss its needed-by date',
    checkedAt: 'Checked at 10:42 AM. Stock can change after this.',
    detail: null,
    failed: false,
  };

  it('renders the words with an icon (never colour alone), the details, the needed-by signal and when it was checked', () => {
    const { container } = render(<ReadinessStrip view={full} />);
    expect(screen.getByTestId('readiness-headline')).toHaveTextContent(
      'Readiness: 2 lines need put-away',
    );
    expect(screen.getByTestId('readiness-details')).toHaveTextContent(
      '1 line short · 3 of 6 lines ready to pick',
    );
    expect(screen.getByTestId('readiness-needed-by')).toHaveTextContent(
      'May miss its needed-by date',
    );
    expect(screen.getByTestId('readiness-checked-at')).toHaveTextContent(
      'Checked at 10:42 AM. Stock can change after this.',
    );
    expect(container.querySelector('svg.lucide-package')).not.toBeNull();
    expect(screen.getByTestId('readiness-strip').className).toContain(
      READINESS_TONE_STYLES.warning.band,
    );
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('Check again re-renders the page, which reads readiness again', async () => {
    const user = userEvent.setup();
    render(<ReadinessStrip view={full} />);
    await user.click(screen.getByRole('button', { name: 'Check again' }));
    expect(routerRefresh).toHaveBeenCalledTimes(1);
  });

  it('a failed read is announced, and its button says Try again', async () => {
    const user = userEvent.setup();
    const view = readinessStripView(READINESS_FAILED, 'full', { timeZone: TZ })!;
    render(<ReadinessStrip view={view} />);
    expect(screen.getByRole('alert')).toHaveTextContent("Couldn't check readiness. Try again.");
    expect(screen.queryByTestId('readiness-checked-at')).toBeNull();
    expect(screen.queryByTestId('readiness-detail')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(routerRefresh).toHaveBeenCalledTimes(1);
  });

  it("a failure's reason is shown under the headline", () => {
    const view = readinessStripView(
      { state: 'failed', message: 'The order changed while it was being checked. Check again.' },
      'full',
      { timeZone: TZ },
    )!;
    render(<ReadinessStrip view={view} />);
    expect(screen.getByTestId('readiness-detail')).toHaveTextContent(
      'The order changed while it was being checked. Check again.',
    );
  });

  it("the requester's sentence, and nothing else", () => {
    render(
      <ReadinessStrip
        view={{
          mode: 'requester',
          sentence: 'Some items are waiting on stock.',
          tone: 'warning',
          icon: 'clock',
          checkedAt: 'Checked at 10:42 AM. Stock can change after this.',
          failed: false,
        }}
      />,
    );
    expect(screen.getByTestId('readiness-strip')).toHaveAttribute('data-mode', 'requester');
    expect(screen.getByTestId('readiness-headline')).toHaveTextContent(
      'Stock: Some items are waiting on stock.',
    );
    expect(screen.queryByTestId('readiness-details')).toBeNull();
    expect(screen.queryByTestId('readiness-needed-by')).toBeNull();
  });
});

describe('ReadinessStrip — Hold available stock (F2-2)', () => {
  const view = (): ReadinessStripView =>
    readinessStripView(
      readinessOk(facts('approved', [visibleItemFacts('a', { here: { rack: 10 }, heldOwn: 0 })])),
      'full',
      { timeZone: TZ },
    )!;

  it('is offered only when the page says so', () => {
    const { rerender } = render(<ReadinessStrip view={view()} />);
    expect(screen.queryByRole('button', { name: 'Hold available stock' })).toBeNull();
    rerender(<ReadinessStrip view={view()} holdOrderId={ORDER} />);
    expect(screen.getByRole('button', { name: 'Hold available stock' })).toBeEnabled();
  });

  it('holds for THIS order, says what it held in core\'s words, and reads the page again', async () => {
    holdOrderStock.mockResolvedValue({
      ok: true,
      data: { held: [{ itemId: 'a', added: 10 }], stillShort: [], hiddenHeldItems: 0, hiddenShortItems: 0 },
    });
    const user = userEvent.setup();
    render(<ReadinessStrip view={view()} holdOrderId={ORDER} />);

    await user.click(screen.getByRole('button', { name: 'Hold available stock' }));

    expect(holdOrderStock).toHaveBeenCalledWith({ id: ORDER });
    expect(toastMock.success).toHaveBeenCalledWith('Held 10 more units for this order.');
    expect(routerRefresh).toHaveBeenCalledTimes(1);
  });

  it('what could not be held for want of free stock is a warning, never hidden', async () => {
    holdOrderStock.mockResolvedValue({
      ok: true,
      data: {
        held: [{ itemId: 'a', added: 4 }],
        stillShort: [{ itemId: 'a', quantity: 6 }],
        hiddenHeldItems: 0,
        hiddenShortItems: 0,
      },
    });
    const user = userEvent.setup();
    render(<ReadinessStrip view={view()} holdOrderId={ORDER} />);

    await user.click(screen.getByRole('button', { name: 'Hold available stock' }));

    expect(toastMock.warning).toHaveBeenCalledWith(
      'Held 4 more units for this order. 6 units are still short: there is no free stock to hold for them.',
      expect.anything(),
    );
  });

  it("an item the caller can't see that is still short is a warning too, counted and never numbered", async () => {
    holdOrderStock.mockResolvedValue({
      ok: true,
      data: {
        held: [{ itemId: 'a', added: 4 }],
        stillShort: [],
        hiddenHeldItems: 1,
        hiddenShortItems: 1,
      },
    });
    const user = userEvent.setup();
    render(<ReadinessStrip view={view()} holdOrderId={ORDER} />);

    await user.click(screen.getByRole('button', { name: 'Hold available stock' }));

    expect(toastMock.warning).toHaveBeenCalledWith(
      "Held 4 more units for this order. Stock was also held for 1 item that isn't visible to you. " +
        "1 item that isn't visible to you is still short.",
      expect.anything(),
    );
    expect(toastMock.success).not.toHaveBeenCalled();
  });

  it("a refusal is the service's sentence, and the page is not re-read", async () => {
    holdOrderStock.mockResolvedValue({
      ok: false,
      error: { code: 'forbidden', message: 'Holding stock for this order needs write access to its warehouse.' },
    });
    const user = userEvent.setup();
    render(<ReadinessStrip view={view()} holdOrderId={ORDER} />);

    await user.click(screen.getByRole('button', { name: 'Hold available stock' }));

    expect(toastMock.error).toHaveBeenCalledWith('Holding stock for this order needs write access to its warehouse.');
    expect(routerRefresh).not.toHaveBeenCalled();
  });
});

// ── F2-3: put away from the order ───────────────────────────────────────────

describe('readinessStripPutAway / readinessLinePutAwayHref: where put away goes, from core', () => {
  /** B: 10 rack + 30 Staging (25 asked); C: short with 4 in Staging; A: ready. */
  const assessment = (): Extract<OrderReadinessAssessment, { phase: 'to_pick' }> => {
    const r = readinessOk(
      orderReadinessFacts(
        ORDER,
        'pending_approval',
        [
          { lineId: 'LA', itemId: 'a', requested: 20 },
          { lineId: 'LB', itemId: 'b', requested: 25 },
          { lineId: 'LC', itemId: 'c', requested: 20 },
        ],
        [
          visibleItemFacts('a', { here: { rack: 40 } }),
          visibleItemFacts('b', { here: { rack: 10, staging: 30 } }),
          visibleItemFacts('c', { here: { rack: 2, staging: 4 } }),
        ],
      ),
    );
    if (r.state !== 'ok' || r.assessment.phase !== 'to_pick') throw new Error('to_pick expected');
    return r.assessment;
  };
  const opts = { orderId: ORDER, access: { canTransfer: true, canReadItems: true } };
  const noTransfer = { orderId: ORDER, access: { canTransfer: false, canReadItems: true } };
  const noItems = { orderId: ORDER, access: { canTransfer: true, canReadItems: false } };

  it('the strip links to Staging for every item with units there, from this order', () => {
    expect(readinessStripPutAway(putAwayTargets(assessment()), opts)).toEqual({
      kind: 'link',
      label: 'Put away 2 items',
      href: `/dashboard/inventory/staging?order=${ORDER}&item=b,c`,
    });
  });

  it("without Transfer stock: core's sentence, never a link", () => {
    expect(readinessStripPutAway(putAwayTargets(assessment()), noTransfer)).toEqual({
      kind: 'needs_permission',
      message: 'Putting stock away needs the Transfer stock permission.',
    });
  });

  it("without View items (Staging's own gate): core's sentence naming it, never a link to a 404", () => {
    expect(readinessStripPutAway(putAwayTargets(assessment()), noItems)).toEqual({
      kind: 'needs_permission',
      message: 'Putting stock away needs the View items permission.',
    });
    expect(readinessLinePutAwayHref(assessment().lines[1]!, noItems)).toBeNull();
  });

  it('nothing when nothing needs putting away, or readiness was not checked', () => {
    expect(readinessStripPutAway(null, opts)).toBeNull();
    expect(readinessStripPutAway({ itemIds: [], lineIds: [], units: 0 }, opts)).toBeNull();
    expect(readinessStripPutAway({ itemIds: [], lineIds: [], units: 0 }, noTransfer)).toBeNull();
  });

  it("a line links to Staging for its own item; nothing for a line with none there, or for a viewer who can't move stock", () => {
    const a = assessment();
    const [la, lb, lc] = a.lines;
    expect(readinessLinePutAwayHref(la!, opts)).toBeNull();
    expect(readinessLinePutAwayHref(lb!, opts)).toBe(`/dashboard/inventory/staging?order=${ORDER}&item=b`);
    expect(readinessLinePutAwayHref(lc!, opts)).toBe(`/dashboard/inventory/staging?order=${ORDER}&item=c`);
    // The strip says why once; the lines repeat nothing.
    expect(readinessLinePutAwayHref(lb!, noTransfer)).toBeNull();
    expect(readinessLinePutAwayHref(null, opts)).toBeNull();
  });
});

describe('ReadinessStrip — Put away (F2-3)', () => {
  const view = (): ReadinessStripView =>
    readinessStripView(
      readinessOk(facts('pending_approval', [visibleItemFacts('a', { here: { rack: 10, staging: 30 } })])),
      'full',
      { timeZone: TZ },
    )!;

  it('"Put away N items" is a plain link to the filtered Staging list', () => {
    const href = `/dashboard/inventory/staging?order=${ORDER}&item=a`;
    render(<ReadinessStrip view={view()} putAway={{ kind: 'link', label: 'Put away 1 item', href }} />);
    const link = screen.getByRole('link', { name: 'Put away 1 item' });
    expect(link).toHaveAttribute('href', href);
    expect(link.querySelector('svg')).not.toBeNull();
    expect(screen.queryByTestId('readiness-put-away-permission')).toBeNull();
  });

  it('the permission sentence instead, for a viewer who may not move stock', () => {
    render(
      <ReadinessStrip
        view={view()}
        putAway={{ kind: 'needs_permission', message: 'Putting stock away needs the Transfer stock permission.' }}
      />,
    );
    expect(screen.queryByRole('link', { name: /Put away/ })).toBeNull();
    expect(screen.getByTestId('readiness-put-away-permission')).toHaveTextContent(
      'Putting stock away needs the Transfer stock permission.',
    );
  });

  it('nothing when the page passes nothing', () => {
    render(<ReadinessStrip view={view()} />);
    expect(screen.queryByTestId('readiness-put-away')).toBeNull();
    expect(screen.queryByTestId('readiness-put-away-permission')).toBeNull();
  });
});
