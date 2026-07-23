import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

const { mockBulkPlace } = vi.hoisted(() => ({ mockBulkPlace: vi.fn() }));

vi.mock('@/server/actions/inventory', () => ({
  bulkPlaceStockAction: mockBulkPlace,
}));

import { BulkPlaceDialog } from './bulk-place-dialog';

// The 2026-07-23 incident warehouse: 1-A and 10-A exist, no 100-A.
const DESTINATIONS_MAP = {
  'wh-1': [
    { id: 'r-1a', name: '1-A', kind: 'rack' },
    { id: 'r-10a', name: '10-A', kind: 'rack' },
  ],
};

const ROWS = [
  { itemId: 'i-1', name: 'Persepolis', sourceLocationId: 'stg-1', quantity: 140, warehouseId: 'wh-1' },
  { itemId: 'i-2', name: 'Maus I', sourceLocationId: 'stg-1', quantity: 40, warehouseId: 'wh-1' },
];

function renderDialog() {
  return render(
    <BulkPlaceDialog
      rows={ROWS}
      destinationsMap={DESTINATIONS_MAP}
      warehouseNames={{ 'wh-1': 'Main Warehouse' }}
      onPlaced={() => {}}
      trigger={<button>Place selected</button>}
    />,
  );
}

async function open(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: /place selected/i }));
}

async function chooseNewRack(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('combobox'));
  await user.click(await screen.findByRole('option', { name: /new rack/i }));
}

describe('BulkPlaceDialog — new-rack confirmation (2026-07-23 incident)', () => {
  beforeEach(() => {
    mockBulkPlace.mockReset();
    mockBulkPlace.mockResolvedValue({ ok: true, data: { placed: 2, failed: [] } });
  });

  it('placing into an EXISTING rack never asks — the common path is unchanged', async () => {
    const user = userEvent.setup();
    renderDialog();
    await open(user);
    await user.click(screen.getByRole('combobox'));
    await user.click(await screen.findByRole('option', { name: '1-A' }));
    await user.click(screen.getByRole('button', { name: /^place 2$/i }));

    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(mockBulkPlace).toHaveBeenCalledTimes(1);
    expect(mockBulkPlace.mock.calls[0]![0].destination).toEqual({ existingLocationId: 'r-1a' });
  });

  it('typing a genuinely new rack PAUSES for confirmation before creating it — the bug', async () => {
    const user = userEvent.setup();
    renderDialog();
    await open(user);
    await chooseNewRack(user);
    await user.type(screen.getByPlaceholderText(/e\.g\. a1/i), '100-A');
    await user.click(screen.getByRole('button', { name: /^place 2$/i }));

    // Nothing placed yet — this is the exact silent-create the incident hit.
    expect(mockBulkPlace).not.toHaveBeenCalled();
    const confirm = screen.getByRole('alertdialog');
    expect(within(confirm).getByText(/create new rack 100-A/i)).toBeInTheDocument();
    // The near-match from the incident is offered.
    expect(within(confirm).getByRole('button', { name: /use 1-A instead/i })).toBeInTheDocument();
  });

  it('confirming creates the rack and places every selected row into it', async () => {
    const user = userEvent.setup();
    renderDialog();
    await open(user);
    await chooseNewRack(user);
    await user.type(screen.getByPlaceholderText(/e\.g\. a1/i), '100-A');
    await user.click(screen.getByRole('button', { name: /^place 2$/i }));
    await user.click(screen.getByRole('button', { name: /create and place/i }));

    expect(mockBulkPlace).toHaveBeenCalledTimes(1);
    expect(mockBulkPlace.mock.calls[0]![0].destination).toEqual({
      newRack: { warehouseId: 'wh-1', rackNumber: '100-A' },
    });
    expect(mockBulkPlace.mock.calls[0]![0].placements).toHaveLength(2);
  });

  it('the near-match one-tap places into the EXISTING rack, creating nothing', async () => {
    const user = userEvent.setup();
    renderDialog();
    await open(user);
    await chooseNewRack(user);
    await user.type(screen.getByPlaceholderText(/e\.g\. a1/i), '100-A');
    await user.click(screen.getByRole('button', { name: /^place 2$/i }));
    await user.click(screen.getByRole('button', { name: /use 1-A instead/i }));

    expect(mockBulkPlace).toHaveBeenCalledTimes(1);
    expect(mockBulkPlace.mock.calls[0]![0].destination).toEqual({ existingLocationId: 'r-1a' });
  });
});
