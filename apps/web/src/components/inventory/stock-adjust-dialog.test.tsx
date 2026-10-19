import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The item page's Adjust stock dialog (redesign P3.3). Pinned here:
 *   - every field is named by its label (before, the Quantity, Note and
 *     Internal notes fields had no accessible name and the Reason select was
 *     named by its value; a screen reader announced "spin button" alone);
 *   - Apply commits exactly what it always did (the signed change, the
 *     movement type, the note and the internal notes) and is refused at 0 or
 *     below zero, with the same words.
 */
const adjustStockAction = vi.hoisted(() =>
  vi.fn(async (_input: Record<string, unknown>) => ({ ok: true as const, data: {} })),
);
vi.mock('@/server/actions/inventory', () => ({ adjustStockAction }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

import { StockAdjustDialog } from './stock-adjust-dialog';

function open() {
  render(<StockAdjustDialog itemId="item-1" itemName="Copy paper" currentQuantity={10} />);
  fireEvent.click(screen.getByRole('button', { name: 'Adjust stock' }));
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('StockAdjustDialog', () => {
  it('names every field by its label', () => {
    open();
    expect(screen.getByLabelText('Reason')).toHaveAttribute('role', 'combobox');
    expect(screen.getByLabelText('Quantity')).toHaveValue(1);
    expect(screen.getByLabelText('Note (optional)')).toHaveAttribute(
      'placeholder',
      'Damaged in transit, customer return…',
    );
    expect(screen.getByLabelText('Internal notes').tagName).toBe('TEXTAREA');
  });

  it('Apply sends the signed change with the movement type, note and internal notes', async () => {
    open();
    fireEvent.change(screen.getByLabelText('Quantity'), { target: { value: '3' } });
    fireEvent.change(screen.getByLabelText('Note (optional)'), {
      target: { value: 'Found a case' },
    });
    fireEvent.change(screen.getByLabelText('Internal notes'), { target: { value: 'Back room' } });
    expect(screen.getByText('13')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(adjustStockAction).toHaveBeenCalledTimes(1));
    expect(adjustStockAction).toHaveBeenCalledWith({
      itemId: 'item-1',
      quantityChange: 3,
      movementType: 'add',
      reason: 'Found a case',
      notes: 'Back room',
    });
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Stock adjusted to 13.'));
  });

  it('Apply is refused at 0 and when the change would go below zero', async () => {
    const user = userEvent.setup();
    open();
    const apply = screen.getByRole('button', { name: 'Apply' });
    fireEvent.change(screen.getByLabelText('Quantity'), { target: { value: '0' } });
    expect(apply).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Quantity'), { target: { value: '5' } });
    expect(apply).toBeEnabled();
    // A removal of more than the 10 on hand.
    await user.click(screen.getByLabelText('Reason'));
    await user.click(await screen.findByRole('option', { name: 'Stock removed' }));
    fireEvent.change(screen.getByLabelText('Quantity'), { target: { value: '11' } });
    expect(screen.getByText('-1')).toBeInTheDocument();
    expect(apply).toBeDisabled();
    expect(adjustStockAction).not.toHaveBeenCalled();
  });
});
