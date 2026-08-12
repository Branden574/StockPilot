import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

const { mockPlaceStockAction } = vi.hoisted(() => ({ mockPlaceStockAction: vi.fn() }));

vi.mock('@/server/actions/inventory', () => ({
  placeStockAction: mockPlaceStockAction,
}));

import { PlaceFromStagingDialog } from './place-from-staging-dialog';

// The warehouse from the 2026-07-23 incident: 1-A and 10-A exist, no 100-A.
const DESTINATIONS = [
  { id: 'r-1a', name: '1-A', kind: 'rack', rackNumber: '1', rackRow: 'A', crateColor: null, crateNumber: null },
  { id: 'r-10a', name: '10-A', kind: 'rack', rackNumber: '10', rackRow: 'A', crateColor: null, crateNumber: null },
  { id: 'r-22b', name: '22-B', kind: 'rack', rackNumber: '22', rackRow: 'B', crateColor: null, crateNumber: null },
];

function renderDialog() {
  return render(
    <PlaceFromStagingDialog
      itemId="item-1"
      itemName="Trail Runner"
      itemType="asset"
      sourceLocationId="stg-1"
      sourceKind="staging"
      warehouseId="wh-1"
      warehouseName="Main Warehouse"
      availableQuantity={242}
      destinations={DESTINATIONS}
    />,
  );
}

async function openNewRackForm(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: /^place$/i }));
  const destination = screen.getByRole('combobox');
  await user.click(destination);
  await user.click(await screen.findByRole('option', { name: /new rack \/ crate/i }));
}

describe('PlaceFromStagingDialog — new-rack confirmation', () => {
  beforeEach(() => {
    mockPlaceStockAction.mockReset();
    mockPlaceStockAction.mockResolvedValue({ ok: true, data: { toLocationId: 'x' } });
  });

  it('placing into an EXISTING rack never asks — the common path is unchanged', async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.click(screen.getByRole('button', { name: /^place$/i }));
    const destination = screen.getByRole('combobox');
    await user.click(destination);
    await user.click(await screen.findByRole('option', { name: '22-B' }));
    await user.click(screen.getByRole('button', { name: /place stock/i }));

    // Went straight through — no confirmation dialog was interposed.
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(mockPlaceStockAction).toHaveBeenCalledTimes(1);
    expect(mockPlaceStockAction.mock.calls[0]![0].destination).toEqual({
      existingLocationId: 'r-22b',
    });
  });

  it('typing a genuinely new rack pauses for confirmation before creating it', async () => {
    const user = userEvent.setup();
    renderDialog();
    await openNewRackForm(user);
    await user.type(screen.getByPlaceholderText(/e\.g\. A1/i), '100-A');
    await user.click(screen.getByRole('button', { name: /place stock/i }));

    // Nothing created yet — the write is withheld until confirmation.
    expect(mockPlaceStockAction).not.toHaveBeenCalled();
    const confirm = screen.getByRole('alertdialog');
    expect(confirm).toHaveTextContent('Create new rack 100-A?');
    expect(confirm).toHaveTextContent('does not exist in Main Warehouse yet');
    expect(confirm).toHaveTextContent('242 units');
    // Near-match offered as a one-tap alternative.
    expect(confirm).toHaveTextContent(/Did you mean/i);
    expect(within(confirm).getByRole('button', { name: /use 10-A instead/i })).toBeInTheDocument();

    // Confirming creates the rack and places into it.
    await user.click(screen.getByRole('button', { name: /create and place/i }));
    expect(mockPlaceStockAction).toHaveBeenCalledTimes(1);
    expect(mockPlaceStockAction.mock.calls[0]![0].destination).toEqual({
      newRack: { warehouseId: 'wh-1', rackNumber: '100-A' },
    });
  });

  it('the near-match one-tap places into the EXISTING rack, creating nothing', async () => {
    const user = userEvent.setup();
    renderDialog();
    await openNewRackForm(user);
    await user.type(screen.getByPlaceholderText(/e\.g\. A1/i), '100-A');
    await user.click(screen.getByRole('button', { name: /place stock/i }));

    await user.click(screen.getByRole('button', { name: /use 10-A instead/i }));
    expect(mockPlaceStockAction).toHaveBeenCalledTimes(1);
    // Existing-location path — no rack is minted.
    expect(mockPlaceStockAction.mock.calls[0]![0].destination).toEqual({
      existingLocationId: 'r-10a',
    });
  });

  it('typing the name of an existing rack in the new-rack form does not ask', async () => {
    const user = userEvent.setup();
    renderDialog();
    await openNewRackForm(user);
    // "22-b " — same rack to a human; the server reuses it, so no confirmation.
    await user.type(screen.getByPlaceholderText(/e\.g\. A1/i), '22-b ');
    await user.click(screen.getByRole('button', { name: /place stock/i }));

    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(mockPlaceStockAction).toHaveBeenCalledTimes(1);
  });
});
