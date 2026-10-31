// @vitest-environment happy-dom
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { redirect } from 'next/navigation';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { LotTraceSearch } from './lot-trace-search';

// The Order column used to print orderRequestId.slice(0, 8).toUpperCase() — a
// UUID prefix mislabelled as an order number. It must print the same SO-######
// handle the order page does, falling back to the id prefix only when the
// parent order has no number (legacy orders predate order_number).

const ORDER_ID = '11111111-1111-4111-8111-111111111111';

const traceMock = vi.hoisted(() => vi.fn());
vi.mock('@/server/actions/lot-trace', () => ({ traceLotAction: traceMock }));

function result(pick: Record<string, unknown>) {
  return {
    ok: true as const,
    data: {
      lotNumber: 'A',
      receipts: [],
      picks: [
        {
          orderRequestId: ORDER_ID,
          orderNumber: null,
          qty: 3,
          pickedAt: '2026-07-01T00:00:00Z',
          pickedBy: null,
          ...pick,
        },
      ],
    },
  };
}

async function trace() {
  render(<LotTraceSearch />);
  await userEvent.type(screen.getByPlaceholderText('Lot number (partial ok)'), 'A');
  await userEvent.click(screen.getByRole('button', { name: 'Trace' }));
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('LotTraceSearch — picked/shipped Order column', () => {
  it('prints the SO number when the picking order has one', async () => {
    traceMock.mockResolvedValue(result({ orderNumber: 49 }));
    await trace();
    expect(await screen.findByText('SO-000049')).toBeInTheDocument();
    expect(screen.queryByText(ORDER_ID.slice(0, 8).toUpperCase())).not.toBeInTheDocument();
  });

  it('falls back to the order id prefix when there is no order number', async () => {
    traceMock.mockResolvedValue(result({ orderNumber: null }));
    await trace();
    expect(await screen.findByText(ORDER_ID.slice(0, 8).toUpperCase())).toBeInTheDocument();
  });

  it('renders an em dash for a pick with no order at all', async () => {
    traceMock.mockResolvedValue(result({ orderRequestId: null, orderNumber: null }));
    await trace();
    expect(await screen.findByText('—')).toBeInTheDocument();
  });
});

describe('LotTraceSearch — the field and a failed call', () => {
  it('names the lot field with its own words', () => {
    render(<LotTraceSearch />);
    expect(screen.getByRole('textbox', { name: 'Lot number (partial ok)' })).toBeInTheDocument();
  });

  it("shows the action's refusal and lets the person search again", async () => {
    traceMock.mockResolvedValue({
      ok: false,
      error: { code: 'validation_error', message: 'Enter a lot number.' },
    });
    render(<LotTraceSearch />);
    await userEvent.click(screen.getByRole('button', { name: 'Trace' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Enter a lot number.');
    expect(screen.getByRole('button', { name: 'Trace' })).toBeEnabled();
  });

  // The call itself can reject (the network dropped). The button used to stay
  // on "Searching…" and disabled until the page was reloaded.
  it('comes back from a call that rejects, with the reason shown', async () => {
    traceMock.mockRejectedValue(new Error('Failed to fetch'));
    await trace();
    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to fetch');
    expect(screen.getByRole('button', { name: 'Trace' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Searching…' })).toBeNull();
  });

  // A Server Action that redirected (the session ended) rejects with the
  // redirect the router is already following to sign-in. Nothing is shown for
  // it: the message used to read "NEXT_REDIRECT", on the way to sign-in.
  it('shows nothing for a call answered with a redirect to sign-in', async () => {
    let signInRedirect: unknown = null;
    try {
      redirect('/signin?redirect=%2Fdashboard%2Freports');
    } catch (e) {
      signInRedirect = e;
    }
    expect(signInRedirect).not.toBeNull();
    traceMock.mockRejectedValue(signInRedirect);
    await trace();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Trace' })).toBeEnabled());
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText(/NEXT_REDIRECT/)).toBeNull();
  });
});
