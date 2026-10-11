import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { hydrateAcrossClockShift } from '@/test/hydration';

import {
  forbiddenRequesterKeys,
  RETURNS_COPY,
  requesterTrackingSentences,
  type RequesterTrackingReturn,
} from '@stockpilot/core';

import { RequesterTracking } from './requester-tracking';

/** An exchange the warehouse approved with another item, waiting for the return. */
const SUBSTITUTED: RequesterTrackingReturn = {
  returnNumber: 'RMA-20261011-AAA111',
  createdAt: '2026-10-06T02:30:00.000Z',
  returnStatus: 'approved',
  exchangeStatus: 'waiting_for_return',
  sentences: requesterTrackingSentences({ returnStatus: 'approved', exchangeStatus: 'waiting_for_return' }),
  replacementOrderNumber: 'SO-000104',
  lines: [
    {
      returning: { name: 'New Hire Shirt', sizeLabel: 'Size M', quantity: 1 },
      exchange: {
        state: 'approved',
        replacement: { name: 'New Hire Shirt Navy', sizeLabel: 'Size L', quantity: 1 },
        substituted: true,
      },
    },
  ],
};

/** A warehouse-review request (a note, no item), and a return-only line. */
const REVIEW: RequesterTrackingReturn = {
  returnNumber: 'RMA-20261011-BBB222',
  createdAt: '2026-10-07T18:00:00.000Z',
  returnStatus: 'requested',
  exchangeStatus: 'requested',
  sentences: requesterTrackingSentences({ returnStatus: 'requested', exchangeStatus: 'requested' }),
  replacementOrderNumber: null,
  lines: [
    {
      returning: { name: 'Composition Notebook', sizeLabel: null, quantity: 2 },
      exchange: { state: 'requested', replacement: null, substituted: false },
    },
    { returning: { name: 'Pencil Pack', sizeLabel: null, quantity: 1 }, exchange: null },
  ],
};

const DECLINED: RequesterTrackingReturn = {
  returnNumber: 'RMA-20261011-CCC333',
  createdAt: '2026-10-08T18:00:00.000Z',
  returnStatus: 'approved',
  exchangeStatus: 'declined',
  sentences: requesterTrackingSentences({ returnStatus: 'approved', exchangeStatus: 'declined' }),
  replacementOrderNumber: null,
  lines: [
    {
      returning: { name: 'New Hire Shirt', sizeLabel: 'Size M', quantity: 1 },
      exchange: { state: 'declined', replacement: { name: 'New Hire Shirt', sizeLabel: 'Size L', quantity: 1 }, substituted: false },
    },
  ],
};

describe('RequesterTracking', () => {
  it('renders nothing when the requester has no requests on the order', () => {
    const { container } = render(<RequesterTracking requests={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("says each request's number, the server's sentences, what comes back and what replaces it, and the replacement's SO", () => {
    render(<RequesterTracking requests={[SUBSTITUTED]} />);
    const section = screen.getByRole('region', { name: RETURNS_COPY.requesterYourRequests });
    expect(within(section).getByRole('heading', { level: 2, name: RETURNS_COPY.requesterYourRequests })).toBeInTheDocument();
    expect(within(section).getByText('RMA-20261011-AAA111')).toBeInTheDocument();
    // Return status and exchange status side by side, never merged (brief 8, 28).
    expect(SUBSTITUTED.sentences).toEqual(['Replacement reserved. Waiting for your return.']);
    for (const s of SUBSTITUTED.sentences) expect(within(section).getByText(s)).toBeInTheDocument();
    expect(within(section).getByText('New Hire Shirt, M ×1')).toBeInTheDocument();
    expect(within(section).getByText('New Hire Shirt Navy, L ×1')).toBeInTheDocument();
    expect(within(section).getByText(RETURNS_COPY.replacementChangedByWarehouse)).toBeInTheDocument();
    expect(within(section).getByText('SO-000104')).toBeInTheDocument();
  });

  it('says "Warehouse will review" for a request made with a note, and shows a return-only line without a replacement', () => {
    render(<RequesterTracking requests={[REVIEW]} />);
    expect(screen.getByText('Exchange requested. The warehouse will review it.')).toBeInTheDocument();
    expect(screen.getByText(RETURNS_COPY.replacementWarehouseReview)).toBeInTheDocument();
    expect(screen.getByText('Composition Notebook ×2')).toBeInTheDocument();
    expect(screen.getByText('Pencil Pack ×1')).toBeInTheDocument();
    // One REPLACEMENT box: the return-only line has none.
    expect(screen.getAllByText(RETURNS_COPY.replacement)).toHaveLength(1);
    expect(screen.getAllByText(RETURNS_COPY.returning)).toHaveLength(2);
  });

  it('marks a declined line, and says the exchange was declined and the return approved', () => {
    render(<RequesterTracking requests={[DECLINED]} />);
    expect(screen.getByText('Exchange declined. Your return was approved.')).toBeInTheDocument();
    expect(screen.getByText(RETURNS_COPY.replacementDeclined)).toBeInTheDocument();
  });

  // RX-3 fix round 1 (desk checks M3 and L4): core's line words, the phone's
  // too. A note-only request the warehouse declined read "Warehouse will
  // review" beside "Declined"; and every line state is named, as on the phone.
  it('a declined or cancelled note-only request reads "A different replacement", never "Warehouse will review"', () => {
    for (const state of ['declined', 'cancelled'] as const) {
      const { container, unmount } = render(
        <RequesterTracking
          requests={[
            {
              ...REVIEW,
              returnStatus: 'approved',
              exchangeStatus: state === 'declined' ? 'declined' : 'cancelled',
              sentences: requesterTrackingSentences({ returnStatus: 'approved', exchangeStatus: state === 'declined' ? 'declined' : 'cancelled' }),
              lines: [{ returning: { name: 'Composition Notebook', sizeLabel: null, quantity: 2 }, exchange: { state, replacement: null, substituted: false } }],
            },
          ]}
        />,
      );
      expect(within(container).getByText('A different replacement')).toBeInTheDocument();
      expect(container.textContent, state).not.toContain(RETURNS_COPY.replacementWarehouseReview);
      unmount();
    }
  });

  it('names every line state, as the phone does: Requested and Approved too', () => {
    render(<RequesterTracking requests={[REVIEW, SUBSTITUTED]} />);
    expect(screen.getByText(RETURNS_COPY.replacementRequested)).toBeInTheDocument();
    expect(screen.getByText(RETURNS_COPY.replacementApproved)).toBeInTheDocument();
  });

  it('keeps the newest first, as the server sent them, under a level-3 heading when asked', () => {
    render(<RequesterTracking requests={[DECLINED, REVIEW, SUBSTITUTED]} headingLevel={3} density="compact" />);
    expect(screen.getByRole('heading', { level: 3, name: RETURNS_COPY.requesterYourRequests })).toBeInTheDocument();
    const numbers = screen.getAllByText(/^RMA-/).map((n) => n.textContent);
    expect(numbers).toEqual(['RMA-20261011-CCC333', 'RMA-20261011-BBB222', 'RMA-20261011-AAA111']);
  });

  // RX-3 merge: the phone's card says "Return request" for a request with no
  // RMA number; the web said "Request". Core's one title now.
  it('titles a request that has no RMA number "Return request", as the phone does', () => {
    render(<RequesterTracking requests={[{ ...REVIEW, returnNumber: null }]} />);
    expect(screen.getByText(RETURNS_COPY.requesterRequestTitle)).toBeInTheDocument();
    expect(screen.getByText('Return request')).toBeInTheDocument();
  });

  it('shows nothing a requester may not see: no rack, Staging, disposition, cost, supplier, note, reason or staff member (brief 28)', () => {
    const all = [SUBSTITUTED, REVIEW, DECLINED];
    expect(forbiddenRequesterKeys(all)).toEqual([]);
    const { container } = render(<RequesterTracking requests={all} />);
    expect(container.textContent).not.toMatch(/\brack\b|staging|scrap|restock|disposition|destination|cost|supplier|reason|on record|on hand/i);
  });

  it("prints each request's day in the viewer's zone once hydrated, never the server's, with no hydration error", async () => {
    const t0 = Date.parse('2026-10-06T04:00:00.000Z');
    // 7:30 PM on Oct 5 in Los Angeles; Oct 6 in UTC.
    const run = await hydrateAcrossClockShift(() => <RequesterTracking requests={[SUBSTITUTED]} />, {
      serverNow: t0,
      browserNow: t0 + 60_000,
    });
    try {
      expect(run.errors).toEqual([]);
      expect(run.html).not.toContain('Oct 6, 2026');
      expect(run.html).not.toContain('Oct 5, 2026');
      expect(within(run.container).getByText('Oct 5, 2026')).toBeInTheDocument();
    } finally {
      run.unmount();
    }
  });
});
