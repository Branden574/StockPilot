import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

const { mockTransferStockAction } = vi.hoisted(() => ({
  mockTransferStockAction: vi.fn(),
}));

vi.mock('@/server/actions/inventory', () => ({
  transferStockAction: mockTransferStockAction,
}));

import { StockTransferDialog } from './stock-transfer-dialog';

// ---------------------------------------------------------------------------
// Field regression 2026-07-07: a rejected transfer (plan_limit_exceeded from
// the inline new-rack path) produced ZERO visible feedback — the only signal
// was a bottom-right toast that auto-dismisses outside the modal. The dialog
// now ALSO renders the server error inline (role="alert"), persistently,
// until the next attempt. These tests pin that.
// ---------------------------------------------------------------------------

const LOC_A = { id: 'loc-a', name: 'Receiving Dock', kind: null, warehouse_id: 'wh-1' };
const LOC_B = { id: 'loc-b', name: 'Aisle A', kind: null, warehouse_id: 'wh-1' };

function renderDialog() {
  return render(
    <StockTransferDialog
      itemId="item-1"
      itemName="Countertop Blender"
      currentQuantity={40}
      currentLocationId={null}
      locations={[LOC_A, LOC_B] as never}
      holdings={
        [{ locationId: 'loc-a', locationName: 'Receiving Dock', quantity: 40, kind: null, warehouseId: 'wh-1' }] as never
      }
      itemType="asset"
      canManageLocations
    />,
  );
}

async function openAndSubmitToExisting(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: /transfer/i }));
  // Destination select (second combobox; the source select auto-picks the
  // only holding). Radix triggers carry no label-derived accessible name.
  const destination = screen.getAllByRole('combobox')[1]!;
  await user.click(destination);
  await user.click(await screen.findByRole('option', { name: /aisle a/i }));
  await user.click(screen.getByRole('button', { name: /transfer stock/i }));
}

describe('StockTransferDialog server-error surfacing', () => {
  it('renders a persistent inline alert when the action rejects, and stays open', async () => {
    mockTransferStockAction.mockResolvedValueOnce({
      ok: false,
      error: { code: 'plan_limit_exceeded', message: 'Upgrade to add more.' },
    });
    const user = userEvent.setup();
    renderDialog();
    await openAndSubmitToExisting(user);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Upgrade to add more.');
    // Dialog still open (title visible) so the user can correct and retry.
    expect(screen.getByText('Transfer stock', { selector: 'h2' })).toBeInTheDocument();
  });

  it('clears the inline error on the next attempt and closes on success', async () => {
    mockTransferStockAction
      .mockResolvedValueOnce({
        ok: false,
        error: { code: 'insufficient_stock', message: 'Not enough stock.' },
      })
      .mockResolvedValueOnce({ ok: true, data: null });
    const user = userEvent.setup();
    renderDialog();
    await openAndSubmitToExisting(user);
    expect(await screen.findByRole('alert')).toHaveTextContent('Not enough stock.');

    await user.click(screen.getByRole('button', { name: /transfer stock/i }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByText('Transfer stock', { selector: 'h2' })).not.toBeInTheDocument();
  });
});
