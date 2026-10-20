import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ORDER_STATUS_META } from '@stockpilot/core';

import { STATUS_LABELS, TrackForm } from './track-form';

/**
 * Public /r/track keeps its OWN status words (CONFLICTS E3: "Delivered" for
 * completed, the six-step timeline), and every status the API can answer has
 * a word (CONFLICTS D14: a backordered order printed the raw key). A lookup
 * that finds nothing is said in an alert.
 */

vi.mock('@/components/orders/delivery-map', () => ({ DeliveryMap: () => null }));

function result(status: string, extra: Record<string, unknown> = {}) {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    status,
    requesterName: 'Lillian',
    warehouseName: 'DC4',
    fulfillmentType: 'pickup',
    lines: [{ itemName: 'Polo S', quantityRequested: 2, quantityFulfilled: 1 }],
    createdAt: '2026-08-17T15:00:00Z',
    approvedAt: '2026-08-17T16:00:00Z',
    packingSlipGeneratedAt: null,
    stagedAt: null,
    inTransitAt: null,
    signedAt: null,
    completedAt: null,
    cancelledAt: null,
    deniedReason: null,
    notes: null,
    ...extra,
  };
}

async function look(status: string, extra?: Record<string, unknown>) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, status: 200, json: async () => result(status, extra) })),
  );
  const utils = render(
    <TrackForm
      initialToken="tok"
      initialId="11111111-1111-1111-1111-111111111111"
      initialEmail="l@example.org"
    />,
  );
  fireEvent.submit(utils.container.querySelector('form') as HTMLFormElement);
  await waitFor(() => expect(utils.container.textContent).toContain('Status'));
  return utils;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('/r/track status words', () => {
  it('D14: a backordered order reads "Backordered", never the raw key', async () => {
    await look('backordered');
    expect(screen.getByRole('heading', { level: 2, name: 'Backordered' })).toBeInTheDocument();
    expect(screen.queryByText('backordered')).toBeNull();
  });

  it('has a word for every status the app has (its own words, not the internal ones)', () => {
    for (const key of Object.keys(ORDER_STATUS_META)) {
      expect(STATUS_LABELS[key], key).toBeTruthy();
    }
    // Its own vocabulary stays: completed is "Delivered", the requester's
    // confirmation step is theirs.
    expect(STATUS_LABELS.completed).toBe('Delivered');
    expect(STATUS_LABELS.pending_confirmation).toBe('Waiting for your confirmation');
    expect(STATUS_LABELS.staged_for_delivery).toBe('Ready for delivery');
  });

  it('keeps the six-step timeline with its words, done steps marked apart from open ones by more than colour', async () => {
    const { container } = await look('approved');
    const steps = Array.from(container.querySelectorAll('[data-slot="timeline-entry"]'));
    expect(steps.map((li) => li.querySelector('.font-medium')?.textContent)).toEqual([
      'Submitted',
      'Approved',
      'Packed',
      'Staged',
      'In transit',
      'Delivered',
    ]);
    // Submitted and Approved carry a time; the rest none.
    expect(steps.filter((li) => /\d/.test(li.textContent ?? ''))).toHaveLength(2);
  });

  it('hides the timeline while the requester has not confirmed, and for denied or cancelled', async () => {
    const pending = await look('pending_confirmation');
    expect(pending.container.querySelector('[data-slot="timeline"]')).toBeNull();
    pending.unmount();
    const denied = await look('denied', { deniedReason: 'Out of budget' });
    expect(denied.container.querySelector('[data-slot="timeline"]')).toBeNull();
    expect(screen.getByText('Request denied')).toBeInTheDocument();
    expect(screen.getByText('Reason: Out of budget')).toBeInTheDocument();
  });

  it('sets only the figures of an item line in mono; "requested" and "returned" stay in the body face', async () => {
    const { container } = await look('completed', {
      lines: [
        { itemName: 'Polo S', quantityRequested: 2, quantityFulfilled: 2, returnedQuantity: 1 },
        { itemName: 'Polo M', quantityRequested: 3, quantityFulfilled: 0 },
      ],
    });
    const rows = Array.from(container.querySelectorAll('li')).filter((li) =>
      li.textContent?.includes('Polo'),
    );
    // Every word is unchanged.
    expect(rows.map((li) => li.textContent)).toEqual([
      'Polo S2 / 2 · 1 returned',
      'Polo M3 requested',
    ]);
    const monoText = (li: Element) =>
      Array.from(li.querySelectorAll('.font-mono')).map((el) => el.textContent);
    expect(monoText(rows[0]!)).toEqual(['2 / 2']);
    expect(monoText(rows[1]!)).toEqual(['3']);
    // The quantity cell itself is in the body face, so its words are too.
    for (const li of rows) {
      const cell = li.lastElementChild as HTMLElement;
      expect(cell.className.split(/\s+/)).not.toContain('font-mono');
      expect(cell.className.split(/\s+/)).toContain('tabular-nums');
    }
  });
});

describe('/r/track lookup miss', () => {
  it('says the miss in an alert, so a screen reader hears it after "Find my order"', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })),
    );
    const utils = render(
      <TrackForm
        initialToken="tok"
        initialId="11111111-1111-1111-1111-111111111111"
        initialEmail="l@example.org"
      />,
    );
    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.submit(utils.container.querySelector('form') as HTMLFormElement);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("We couldn't find that order.");
    expect(alert).toHaveTextContent(
      'Double-check the email address and request ID from your confirmation email and try again.',
    );
  });
});
