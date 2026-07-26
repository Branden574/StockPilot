// @vitest-environment happy-dom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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
    expect(
      await screen.findByText(ORDER_ID.slice(0, 8).toUpperCase()),
    ).toBeInTheDocument();
  });

  it('renders an em dash for a pick with no order at all', async () => {
    traceMock.mockResolvedValue(result({ orderRequestId: null, orderNumber: null }));
    await trace();
    expect(await screen.findByText('—')).toBeInTheDocument();
  });
});
