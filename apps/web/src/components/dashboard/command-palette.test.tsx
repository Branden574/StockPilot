import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CommandPalette } from './command-palette';

const push = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, prefetch: vi.fn() }),
}));

/**
 * CONFLICTS D10: a purchase order found by the palette printed its raw status
 * key, capitalised ("Expected_inbound", "Partially_received"). It now says what
 * the PO list says ("Expected", "Partial").
 */
describe('CommandPalette purchase-order hits', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              items: [],
              purchaseOrders: [
                { id: 'p1', poNumber: 'PO-1042', status: 'expected_inbound' },
                { id: 'p2', poNumber: 'PO-1043', status: 'partially_received' },
              ],
              suppliers: [],
              warehouses: [],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
      ),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    push.mockReset();
  });

  it('shows each PO status in its label, never the raw key, and opens the PO', async () => {
    render(<CommandPalette open onOpenChange={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText(/Search items, POs, suppliers/), {
      target: { value: 'PO-10' },
    });
    expect(await screen.findByText('PO-1042', undefined, { timeout: 3000 })).toBeInTheDocument();
    expect(screen.getByText('Expected')).toBeInTheDocument();
    expect(screen.getByText('Partial')).toBeInTheDocument();
    expect(screen.queryByText(/expected_inbound|partially_received/i)).toBeNull();

    fireEvent.click(screen.getByText('PO-1042'));
    expect(push).toHaveBeenCalledWith('/dashboard/purchase-orders/p1');
  });
});
