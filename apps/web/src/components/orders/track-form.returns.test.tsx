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
    requesterName: 'Lillian',
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
