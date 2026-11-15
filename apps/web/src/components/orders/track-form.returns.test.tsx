import { fireEvent, render, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TrackForm } from './track-form';

/**
 * Public /r/track — the requester's own view of their order. The requester is
 * the person who MADE a return, so the line that came back must say so here
 * too: "1 / 1 · 1 returned" beside the shipped figure, never folded into it
 * (SO-000085 sweep, surfaces that state order-line quantities).
 */

vi.mock('@/components/orders/delivery-map', () => ({ DeliveryMap: () => null }));

function trackResult(lines: Array<Record<string, unknown>>) {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    status: 'completed',
    requesterName: 'Reggie Requester',
    warehouseName: 'DC4',
    fulfillmentType: 'pickup',
    lines,
    createdAt: '2026-08-17T15:00:00Z',
    approvedAt: '2026-08-17T16:00:00Z',
    packingSlipGeneratedAt: null,
    stagedAt: null,
    inTransitAt: null,
    signedAt: null,
    completedAt: '2026-08-17T16:40:00Z',
    cancelledAt: null,
    delivery: null,
  };
}

async function renderWithResult(lines: Array<Record<string, unknown>>) {
  const fetchMock = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => trackResult(lines),
  }));
  vi.stubGlobal('fetch', fetchMock);
  const utils = render(
    <TrackForm initialToken="tok" initialId="11111111-1111-1111-1111-111111111111" initialEmail="l@example.org" />,
  );
  fireEvent.submit(utils.container.querySelector('form') as HTMLFormElement);
  await waitFor(() => expect(utils.container.textContent).toContain('Items'));
  return utils;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('track page lines — returned units beside the shipped figure', () => {
  it('a line with returnedQuantity 1 reads "1 / 1 · 1 returned"; the others stay "1 / 1"', async () => {
    const { container } = await renderWithResult([
      { itemName: "Women's Polo S", quantityRequested: 1, quantityFulfilled: 1, returnedQuantity: 1 },
      { itemName: "Women's Polo M", quantityRequested: 1, quantityFulfilled: 1, returnedQuantity: 0 },
      { itemName: "Men's Polo XL", quantityRequested: 1, quantityFulfilled: 1 },
    ]);
    const items = Array.from(container.querySelectorAll('li'))
      .map((li) => li.textContent ?? '')
      .filter((t) => t.includes('Polo'));
    expect(items).toEqual([
      "Women's Polo S1 / 1 · 1 returned",
      "Women's Polo M1 / 1",
      "Men's Polo XL1 / 1",
    ]);
  });

  it('MUTATION / golden: with no returned units the wording is exactly the pre-feature "1 / 1"', async () => {
    const { container } = await renderWithResult([
      { itemName: "Women's Polo S", quantityRequested: 1, quantityFulfilled: 1, returnedQuantity: 0 },
    ]);
    expect(container.textContent).not.toMatch(/returned/i);
    const item = Array.from(container.querySelectorAll('li')).find((li) => li.textContent?.includes('Polo'));
    expect(item?.textContent).toBe("Women's Polo S1 / 1");
  });

  it('the public route selects returned_quantity and maps it to returnedQuantity (source pin — the route needs a token + admin client to drive)', () => {
    const src = readFileSync(
      path.resolve(__dirname, '../../app/api/v1/public/order-requests/[id]/route.ts'),
      'utf8',
    );
    expect(src).toMatch(/quantity_fulfilled, returned_quantity,/);
    expect(src).toContain('returnedQuantity: Number(row.returned_quantity) || 0');
  });
});

/**
 * The return link on a completed order. The tracker's answer carries
 * `returnPath` when the organization's returns module is on, null when it is
 * off or the order has nothing to return, and `returnPathUnavailable` when
 * that could not be checked: the page then says so and offers Check again,
 * which asks the tracker again.
 */
describe('track page: the return link', () => {
  const LINE = { itemName: 'Polo', quantityRequested: 1, quantityFulfilled: 1 };

  function answer(extra: Record<string, unknown>) {
    return vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ...trackResult([LINE]), ...extra }),
    }));
  }

  async function open(fetchMock: ReturnType<typeof answer>) {
    vi.stubGlobal('fetch', fetchMock);
    const utils = render(
      <TrackForm initialToken="tok" initialId="11111111-1111-1111-1111-111111111111" initialEmail="l@example.org" />,
    );
    fireEvent.submit(utils.container.querySelector('form') as HTMLFormElement);
    await waitFor(() => expect(utils.container.textContent).toContain('Items'));
    return utils;
  }

  it('with a return link: Request a return, and no "could not check" note', async () => {
    const { container, getByRole } = await open(answer({ returnPath: '/returns/request/abc' }));
    expect(getByRole('link', { name: 'Request a return' }).getAttribute('href')).toBe(
      '/returns/request/abc',
    );
    expect(container.textContent).not.toContain("couldn't check");
  });

  it('with no return link and nothing unread: neither the link nor the note', async () => {
    const { container, queryByRole } = await open(answer({ returnPath: null }));
    expect(queryByRole('link', { name: 'Request a return' })).toBeNull();
    expect(container.textContent).not.toContain("couldn't check");
    expect(queryByRole('button', { name: 'Check again' })).toBeNull();
  });

  it('when the return link could not be checked: the page says so, and Check again asks the tracker again', async () => {
    const fetchMock = answer({ returnPath: null, returnPathUnavailable: true });
    const { container, getByRole, queryByRole } = await open(fetchMock);
    expect(queryByRole('link', { name: 'Request a return' })).toBeNull();
    expect(container.textContent).toContain(
      "We couldn't check whether you can request a return for this order right now.",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // The next answer has the link.
    fetchMock.mockImplementation(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ...trackResult([LINE]), returnPath: '/returns/request/abc' }),
    }));
    fireEvent.click(getByRole('button', { name: 'Check again' }));
    await waitFor(() =>
      expect(queryByRole('link', { name: 'Request a return' })).not.toBeNull(),
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(container.textContent).not.toContain("couldn't check");
  });
});
