import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PICKUP_COMPLETED_STATUS_LABEL } from '@stockpilot/core';

import { TrackForm } from './track-form';

/**
 * B22: the public tracker's steps follow how the order is fulfilled and what
 * the order row records. A pickup is never in transit and is handed over, not
 * delivered (core's PICKUP_COMPLETED_STATUS_LABEL, the word the order page,
 * the orders list and the phone already use). Both signature paths stamp
 * signed_at at every hand-over, in full or in part, and completed_at only when
 * nothing is still owed (0395 confirm_physical_signature and
 * confirm_order_signature), so "Signed for" is its own step, before the last.
 */

vi.mock('@/components/orders/delivery-map', () => ({ DeliveryMap: () => null }));

const T = {
  created: '2026-08-17T15:00:00Z',
  approved: '2026-08-17T16:00:00Z',
  packed: '2026-08-17T17:00:00Z',
  staged: '2026-08-17T18:00:00Z',
  inTransit: '2026-08-17T19:00:00Z',
  signed: '2026-08-17T20:00:00Z',
  closed: '2026-08-18T09:30:00Z',
};

function result(extra: Record<string, unknown>) {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    status: 'approved',
    requesterName: 'Lillian',
    warehouseName: 'DC4',
    fulfillmentType: 'delivery',
    lines: [{ itemName: 'Polo S', quantityRequested: 2, quantityFulfilled: 0 }],
    createdAt: T.created,
    approvedAt: T.approved,
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

async function look(extra: Record<string, unknown>) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, status: 200, json: async () => result(extra) })),
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

/** Each step's word, and whether it is done (it then carries its time). */
function steps(container: HTMLElement): Array<[string, 'done' | 'open']> {
  return Array.from(container.querySelectorAll('[data-slot="timeline-entry"]')).map((li) => {
    const label = li.querySelector('.font-medium')?.textContent ?? '';
    const rest = (li.textContent ?? '').replace(label, '');
    return [label, /\d/.test(rest) ? 'done' : 'open'];
  });
}

/** The time a step shows (empty while it is still to come). */
function timeOf(container: HTMLElement, label: string): string {
  const li = Array.from(container.querySelectorAll('[data-slot="timeline-entry"]')).find(
    (el) => el.querySelector('.font-medium')?.textContent === label,
  );
  return (li?.textContent ?? '').replace(label, '');
}

function heading(): string {
  return screen.getByRole('heading', { level: 2 }).textContent ?? '';
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('/r/track steps: a delivery', () => {
  it('in transit: Submitted to In transit done; Signed for and Delivered still to come', async () => {
    const { container } = await look({
      status: 'in_transit',
      packingSlipGeneratedAt: T.packed,
      stagedAt: T.staged,
      inTransitAt: T.inTransit,
    });
    expect(heading()).toBe('In transit');
    expect(steps(container)).toEqual([
      ['Submitted', 'done'],
      ['Approved', 'done'],
      ['Packed', 'done'],
      ['Staged', 'done'],
      ['In transit', 'done'],
      ['Signed for', 'open'],
      ['Delivered', 'open'],
    ]);
  });

  it('delivered in full: every step done, the last one Delivered', async () => {
    const { container } = await look({
      status: 'completed',
      packingSlipGeneratedAt: T.packed,
      stagedAt: T.staged,
      inTransitAt: T.inTransit,
      signedAt: T.signed,
      completedAt: T.signed,
    });
    expect(heading()).toBe('Delivered');
    expect(steps(container)).toEqual([
      ['Submitted', 'done'],
      ['Approved', 'done'],
      ['Packed', 'done'],
      ['Staged', 'done'],
      ['In transit', 'done'],
      ['Signed for', 'done'],
      ['Delivered', 'done'],
    ]);
  });
});

describe('/r/track steps: a pickup', () => {
  it('staged: no In transit step, and it ends Handed over, never Delivered', async () => {
    const { container } = await look({
      status: 'staged_for_pickup',
      fulfillmentType: 'pickup',
      packingSlipGeneratedAt: T.packed,
      stagedAt: T.staged,
    });
    expect(heading()).toBe('Staged for pickup');
    expect(steps(container)).toEqual([
      ['Submitted', 'done'],
      ['Approved', 'done'],
      ['Packed', 'done'],
      ['Staged', 'done'],
      ['Signed for', 'open'],
      [PICKUP_COMPLETED_STATUS_LABEL, 'open'],
    ]);
    expect(container.textContent).not.toMatch(/In transit|Delivered/);
  });

  it('handed over in full: the status and the last step say Handed over', async () => {
    const { container } = await look({
      status: 'completed',
      fulfillmentType: 'pickup',
      packingSlipGeneratedAt: T.packed,
      stagedAt: T.staged,
      signedAt: T.signed,
      completedAt: T.signed,
    });
    expect(PICKUP_COMPLETED_STATUS_LABEL).toBe('Handed over');
    expect(heading()).toBe('Handed over');
    expect(steps(container)).toEqual([
      ['Submitted', 'done'],
      ['Approved', 'done'],
      ['Packed', 'done'],
      ['Staged', 'done'],
      ['Signed for', 'done'],
      ['Handed over', 'done'],
    ]);
    expect(container.textContent).not.toMatch(/In transit|Delivered/);
  });
});

describe('/r/track steps: signed for, the rest still owed', () => {
  // A short hand-over stamps signed_at and leaves completed_at null: the
  // order is backordered until the rest is handed over or closed.
  it('a delivery signed for in part: Signed for done at the signature, Delivered still to come', async () => {
    const { container } = await look({
      status: 'backordered',
      packingSlipGeneratedAt: T.packed,
      stagedAt: T.staged,
      inTransitAt: T.inTransit,
      signedAt: T.signed,
      lines: [{ itemName: 'Polo S', quantityRequested: 2, quantityFulfilled: 1 }],
    });
    expect(heading()).toBe('Backordered');
    expect(steps(container).slice(-2)).toEqual([
      ['Signed for', 'done'],
      ['Delivered', 'open'],
    ]);
  });

  it('a pickup signed for in part, its rest closed later: Signed for at the signature, Handed over at the close', async () => {
    const { container } = await look({
      status: 'completed',
      fulfillmentType: 'pickup',
      packingSlipGeneratedAt: T.packed,
      stagedAt: T.staged,
      signedAt: T.signed,
      completedAt: T.closed,
      lines: [{ itemName: 'Polo S', quantityRequested: 2, quantityFulfilled: 1 }],
    });
    // Each step carries its own time: the signature's, then the close's.
    expect(timeOf(container, 'Signed for')).toMatch(/\d/);
    expect(timeOf(container, 'Handed over')).toMatch(/\d/);
    expect(timeOf(container, 'Signed for')).not.toBe(timeOf(container, 'Handed over'));
    expect(steps(container).slice(-2)).toEqual([
      ['Signed for', 'done'],
      ['Handed over', 'done'],
    ]);
  });
});

describe('/r/track steps: a paper hand-over', () => {
  // confirm_physical_signature stamps signed_at and completed_at exactly as
  // the sign page does (0395), so a paper signature reads Signed for too.
  it('reads Signed for like a digital one, and the page never names the method or the signer', async () => {
    const { container } = await look({
      status: 'completed',
      fulfillmentType: 'pickup',
      packingSlipGeneratedAt: T.packed,
      stagedAt: T.staged,
      signedAt: T.signed,
      completedAt: T.signed,
    });
    expect(steps(container).slice(-2)).toEqual([
      ['Signed for', 'done'],
      ['Handed over', 'done'],
    ]);
    expect(container.textContent).not.toMatch(/paper|physical|digital|Signed by/i);
  });

  it('the public read sends signed_at only: never the signer, the method or the image', () => {
    const src = readFileSync(
      path.resolve(__dirname, '../../app/api/v1/public/order-requests/[id]/route.ts'),
      'utf8',
    );
    const select = /\.from\('order_requests'\)\s*\.select\(\s*`([^`]*)`/.exec(src)?.[1] ?? '';
    expect(select).toMatch(/\bsigned_at\b/);
    expect(select).not.toMatch(/signed_by|signature/);
    expect(src).toContain('signedAt: h.signed_at,');
  });
});

describe('/r/track steps: cancelled, denied and legacy', () => {
  it('cancelled: no steps at all, just when it was cancelled', async () => {
    const { container } = await look({
      status: 'cancelled',
      fulfillmentType: 'pickup',
      cancelledAt: '2026-08-18T10:00:00Z',
    });
    expect(heading()).toBe('Cancelled');
    expect(container.querySelector('[data-slot="timeline"]')).toBeNull();
    expect(container.textContent).toMatch(/This request was cancelled on .*\d/);
    expect(container.textContent).not.toMatch(/Signed for|Handed over|Delivered/);
  });

  it('denied: no steps either', async () => {
    const { container } = await look({
      status: 'denied',
      deniedReason: 'Your request was not approved.',
    });
    expect(container.querySelector('[data-slot="timeline"]')).toBeNull();
    expect(container.textContent).not.toMatch(/Signed for/);
  });

  // Orders completed before signatures were recorded have completed_at and
  // no signed_at: the signature step never happened and never will, so it is
  // left out rather than shown as still to come.
  it('an order completed with no signature (legacy) has no Signed for step', async () => {
    const { container } = await look({
      status: 'completed',
      packingSlipGeneratedAt: T.packed,
      stagedAt: T.staged,
      inTransitAt: T.inTransit,
      completedAt: T.signed,
    });
    expect(steps(container)).toEqual([
      ['Submitted', 'done'],
      ['Approved', 'done'],
      ['Packed', 'done'],
      ['Staged', 'done'],
      ['In transit', 'done'],
      ['Delivered', 'done'],
    ]);
  });

  it('a payload with no fulfilment type keeps the delivery steps it always had', async () => {
    const { container } = await look({ fulfillmentType: undefined });
    expect(steps(container).map(([label]) => label)).toEqual([
      'Submitted',
      'Approved',
      'Packed',
      'Staged',
      'In transit',
      'Signed for',
      'Delivered',
    ]);
  });
});
