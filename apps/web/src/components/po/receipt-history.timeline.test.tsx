import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ReceiptLineRow, ReceiptRow } from '@/server/services/receiving';

const reverseReceiptAction = vi.fn();
const refresh = vi.fn();

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh }) }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/server/actions/receiving', () => ({
  reverseReceiptAction: (...args: unknown[]) => reverseReceiptAction(...args),
}));

import { ReceiptHistory } from './receipt-history';

/**
 * The receipts drawn as a timeline keep each receipt's number, status word,
 * time, receiver, lines (Item, Received, Accepted, Rejected), notes, reversal
 * reason and totals, the empty sentence, and Reverse only on a posted receipt
 * for someone who may reverse it, with its reason rule.
 */

const AT = '2026-10-05T20:56:30.000Z';

function receipt(over: Partial<ReceiptRow> = {}): ReceiptRow {
  return {
    id: 'rcpt-1',
    organization_id: 'org-1',
    purchase_order_id: 'po-1',
    warehouse_id: 'wh-1',
    receipt_number: 'RCV-000123',
    status: 'posted',
    reversed_receipt_id: null,
    reversal_reason: null,
    notes: null,
    received_by: 'u-1',
    received_at: AT,
    received_by_name: 'Dana Lee',
    idempotency_key: null,
    created_at: AT,
    updated_at: AT,
    ...over,
  };
}

function line(over: Partial<ReceiptLineRow> = {}): ReceiptLineRow {
  return {
    id: 'rl-1',
    receipt_id: 'rcpt-1',
    purchase_order_line_id: 'pol-1',
    item_id: 'item-1',
    qty_received_base: 6,
    qty_accepted_base: 5,
    qty_rejected_base: 1,
    base_uom: 'each',
    unit_cost: 2,
    notes: null,
    created_at: AT,
    ...over,
  };
}

const ITEMS = { 'item-1': { name: 'Laptop stand', sku: 'LS-1' } };

beforeEach(() => {
  vi.clearAllMocks();
  reverseReceiptAction.mockResolvedValue({ ok: true, data: null });
});

describe('ReceiptHistory', () => {
  it('says there are no receipts yet, in its own words', () => {
    render(<ReceiptHistory receipts={[]} lines={[]} items={{}} canReverse />);
    expect(
      screen.getByText(
        'No receipts yet. Use the "Receive items" button on the line items above to record what was received — partial deliveries are fine.',
      ),
    ).toBeInTheDocument();
  });

  it('lists each receipt with its status word, receiver, lines and totals', () => {
    render(
      <ReceiptHistory
        receipts={[receipt({ notes: 'Two boxes crushed' })]}
        lines={[line()]}
        items={ITEMS}
        canReverse={false}
      />,
    );
    const entry = screen.getByRole('listitem');
    expect(within(entry).getByText('RCV-000123')).toBeInTheDocument();
    expect(within(entry).getByText('posted')).toBeInTheDocument();
    expect(entry.textContent).toContain(' · by Dana Lee');
    expect(entry.querySelector('time')).toHaveAttribute('datetime', AT);
    const headers = within(entry)
      .getAllByRole('columnheader')
      .map((th) => th.textContent);
    expect(headers).toEqual(['Item', 'Received', 'Accepted', 'Rejected']);
    const cells = within(entry)
      .getAllByRole('cell')
      .map((td) => td.textContent);
    expect(cells).toEqual(['Laptop standLS-1', '6', '5', '1']);
    expect(entry.textContent).toContain('Notes: Two boxes crushed');
    expect(entry.textContent).toContain('Total accepted: 5 · Rejected: 1');
  });

  it('names a since-deleted item as before and shows a reversal’s reason', () => {
    render(
      <ReceiptHistory
        receipts={[receipt({ status: 'reversed', reversal_reason: 'Wrong items' })]}
        lines={[line({ item_id: 'item-gone' })]}
        items={ITEMS}
        canReverse
      />,
    );
    expect(screen.getByText('Unknown item')).toBeInTheDocument();
    expect(screen.getByText('reversed')).toBeInTheDocument();
    expect(screen.getByRole('listitem').textContent).toContain('Reversed: Wrong items');
    // Only a posted receipt can be reversed.
    expect(screen.queryByRole('button', { name: /reverse/i })).toBeNull();
  });

  it('offers Reverse on a posted receipt only to someone who may reverse it', () => {
    const allowed = render(
      <ReceiptHistory receipts={[receipt()]} lines={[line()]} items={ITEMS} canReverse />,
    );
    expect(screen.getByRole('button', { name: /reverse/i })).toBeInTheDocument();
    allowed.unmount();
    render(
      <ReceiptHistory receipts={[receipt()]} lines={[line()]} items={ITEMS} canReverse={false} />,
    );
    expect(screen.queryByRole('button', { name: /reverse/i })).toBeNull();
  });

  it('Reverse asks for a reason of 3 or more characters, then reverses and refreshes', async () => {
    const { toast } = await import('sonner');
    const user = userEvent.setup();
    render(<ReceiptHistory receipts={[receipt()]} lines={[line()]} items={ITEMS} canReverse />);
    await user.click(screen.getByRole('button', { name: /reverse/i }));
    const dialog = await screen.findByRole('dialog', { name: 'Reverse RCV-000123?' });

    await user.type(within(dialog).getByLabelText('Reason'), 'no');
    await user.click(within(dialog).getByRole('button', { name: 'Confirm reversal' }));
    expect(toast.error).toHaveBeenCalledWith('Enter a reason (3+ characters) for the reversal.');
    expect(reverseReceiptAction).not.toHaveBeenCalled();

    await user.type(within(dialog).getByLabelText('Reason'), 't these  ');
    await user.click(within(dialog).getByRole('button', { name: 'Confirm reversal' }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(reverseReceiptAction).toHaveBeenCalledWith({
      receiptId: 'rcpt-1',
      reason: 'not these',
    });
    expect(toast.success).toHaveBeenCalledWith('Receipt reversed.');
  });
});
