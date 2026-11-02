import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { requestUnconfirmedMessage } from '@/lib/request-failure';
import { offline } from '@/test/rejected-request';

/**
 * The Assemble dialog (matrix W-CA-11b): Quantity, Warehouse and Notes, the
 * warehouse locked to where the pre-assembled kits already are, and the
 * positive-quantity refusal. Redesign P4.D2 names the Warehouse picker by its
 * label and ties the lock note to it.
 */

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

const { mockAssemble, mockToast } = vi.hoisted(() => ({
  mockAssemble: vi.fn(),
  mockToast: { success: vi.fn(), error: vi.fn() },
}));
vi.mock('@/server/actions/bundles', () => ({ assembleBundleAction: mockAssemble }));
vi.mock('sonner', () => ({ toast: mockToast }));

import { AssembleBundleModal } from './assemble-bundle-modal';

const WAREHOUSES = [
  { id: 'w1', name: 'North DC' },
  { id: 'w2', name: 'South DC' },
];

beforeEach(() => {
  mockAssemble.mockReset();
  mockToast.success.mockReset();
  mockToast.error.mockReset();
});

function open(lockedWarehouseId: string | null) {
  render(
    <AssembleBundleModal
      bundleId="b-1"
      bundleName="Science Kit"
      warehouses={WAREHOUSES}
      lockedWarehouseId={lockedWarehouseId}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Assemble more' }));
}

describe('AssembleBundleModal', () => {
  it('locks the warehouse to the existing kits, says why, and assembles there', async () => {
    mockAssemble.mockResolvedValue({ ok: true, data: {} });
    open('w2');
    expect(screen.getByRole('heading', { name: 'Assemble Science Kit' })).toBeInTheDocument();
    const warehouse = screen.getByLabelText('Warehouse');
    expect(warehouse).toHaveTextContent('South DC');
    expect(warehouse).toBeDisabled();
    expect(warehouse).toHaveAccessibleDescription(
      'Locked — existing pre-assembled kits live at this warehouse.',
    );
    fireEvent.change(screen.getByLabelText('Quantity'), { target: { value: '2' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Assemble' }));
    });
    expect(mockAssemble).toHaveBeenCalledWith({
      id: 'b-1',
      quantity: 2,
      warehouseId: 'w2',
      notes: null,
    });
    expect(mockToast.success).toHaveBeenCalledWith('Pre-assembled 2 Science Kit kits.');
  });

  it('without kits yet the warehouse is free, defaults to the first, and has no lock note', () => {
    open(null);
    const warehouse = screen.getByLabelText('Warehouse');
    expect(warehouse).toHaveTextContent('North DC');
    expect(warehouse).toBeEnabled();
    expect(screen.queryByText(/^Locked/)).toBeNull();
  });

  it('refuses a quantity that is not positive', async () => {
    open(null);
    fireEvent.change(screen.getByLabelText('Quantity'), { target: { value: '0' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Assemble' }));
    });
    expect(mockToast.error).toHaveBeenCalledWith('Enter a positive quantity.');
    expect(mockAssemble).not.toHaveBeenCalled();
  });
});

// B40: an Assemble that got no answer (offline, a server error, a deploy) left
// the dialog spinning for good with nothing said. Kits may have been assembled
// before the answer was lost, so the message says to look before trying again.
describe('AssembleBundleModal when the request gets no answer', () => {
  it('stops the spinner, keeps the dialog and says to check the stock before trying again', async () => {
    mockAssemble.mockRejectedValueOnce(offline());
    open(null);
    fireEvent.change(screen.getByLabelText('Quantity'), { target: { value: '2' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Assemble' }));
    });
    expect(mockToast.error).toHaveBeenCalledWith(
      requestUnconfirmedMessage(
        offline(),
        'the kits were assembled',
        "the bundle's pre-assembled stock",
      ),
    );
    expect(screen.getByRole('button', { name: 'Assemble' })).toBeEnabled();
    expect(screen.getByLabelText('Quantity')).toHaveValue(2);
    expect(mockToast.success).not.toHaveBeenCalled();
  });
});
