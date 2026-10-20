import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const postReceiptAction = vi.fn();

vi.mock('@/server/actions/receiving', () => ({
  postReceiptAction: (...args: unknown[]) => postReceiptAction(...args),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { PoReceiveDialog } from './po-receive-dialog';

/**
 * The receive dialog in the redesign keeps its fields, words and rules, and
 * now names its fields: "Received now" and Notes were labels tied to nothing,
 * so a screen reader announced bare fields. The variance captions, the
 * posting state, lot capture and serial capture behave as before.
 */

type TrackingType = 'none' | 'lot' | 'serial' | 'serial_optional';

function line(id: string, ordered: number, trackingType: TrackingType = 'none', received = 0) {
  return {
    id,
    name: `Item ${id}`,
    sku: `SKU-${id}`,
    quantityOrdered: ordered,
    quantityReceived: received,
    trackingType,
  };
}

async function open(lines: ReturnType<typeof line>[]) {
  const user = userEvent.setup();
  render(<PoReceiveDialog poId="po-1" poNumber="PO-0001" warehouseId="wh-1" lines={lines} />);
  await user.click(screen.getByRole('button', { name: /receive items/i }));
  return { user, dialog: await screen.findByRole('dialog', { name: 'Receive PO-0001' }) };
}

beforeEach(() => {
  postReceiptAction.mockReset();
  postReceiptAction.mockResolvedValue({ ok: true, data: { receiptNumber: 'RC-1' } });
});

describe('PoReceiveDialog fields', () => {
  it('names each line’s quantity "Received now" and the receipt notes "Notes", and posts both', async () => {
    const { user, dialog } = await open([line('a', 10), line('b', 4)]);
    const fields = within(dialog).getAllByRole('spinbutton', { name: 'Received now' });
    expect(fields).toHaveLength(2);
    await user.type(fields[1]!, '2');
    await user.type(within(dialog).getByRole('textbox', { name: 'Notes' }), 'Extras in box 3');
    await user.click(within(dialog).getByRole('button', { name: 'Post receipt' }));
    await waitFor(() => expect(postReceiptAction).toHaveBeenCalledTimes(1));
    const payload = postReceiptAction.mock.calls[0]![0] as {
      notes?: string;
      lines: Array<{ poLineId: string; qtyReceived: number }>;
    };
    expect(payload.notes).toBe('Extras in box 3');
    expect(payload.lines).toEqual([expect.objectContaining({ poLineId: 'b', qtyReceived: 2 })]);
  });

  it('draws the "Received now" label as a block box so its column lines up with Variance (review fix)', async () => {
    // The Label primitive is an inline <label>; inline, its line box took the
    // parent's strut and sat about 6 px below the block Variance caption. It
    // also needs its own leading-none: cn() drops the primitive's leading-none
    // when text-[11px] follows it, and a 1.5 line height left the field 4 px low.
    const { dialog } = await open([line('a', 10)]);
    const label = within(dialog).getByText('Received now', { selector: 'label' });
    expect(label).toHaveClass('block', 'leading-none');
    expect(within(dialog).getByText('Variance').tagName).toBe('P');
  });

  it('says what is still to come, what is over ordered, and when the line is fully received', async () => {
    const { user, dialog } = await open([line('a', 10, 'none', 2)]);
    expect(within(dialog).getByText('Ordered 10 · Already received 2')).toBeInTheDocument();
    expect(within(dialog).getByText('8 still to come')).toBeInTheDocument();
    const field = within(dialog).getByRole('spinbutton', { name: 'Received now' });
    await user.type(field, '3');
    expect(within(dialog).getByText('5 still to come')).toBeInTheDocument();
    await user.clear(field);
    await user.type(field, '11');
    expect(within(dialog).getByText('3 over ordered')).toBeInTheDocument();
    expect(within(dialog).getByText('-3')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'All' }));
    expect(within(dialog).getByText('Fully received')).toBeInTheDocument();
    expect(field).toHaveValue(8);
  });

  it('keeps the button’s name and disables it while the receipt posts', async () => {
    let resolve: ((value: unknown) => void) | undefined;
    postReceiptAction.mockImplementation(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    const { user, dialog } = await open([line('a', 5)]);
    await user.click(within(dialog).getByRole('button', { name: 'All' }));
    await user.click(within(dialog).getByRole('button', { name: 'Post receipt' }));
    const posting = within(dialog).getByRole('button', { name: 'Post receipt' });
    expect(posting).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeDisabled();
    resolve?.({ ok: true, data: { receiptNumber: 'RC-2' } });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('asks for lots on a lot-tracked line: Single lot of N, the running sum and Remove lot', async () => {
    const { user, dialog } = await open([line('a', 5, 'lot')]);
    expect(within(dialog).queryByText('Lot capture')).toBeNull();
    await user.click(within(dialog).getByRole('button', { name: 'All' }));
    expect(within(dialog).getByText('Lot capture')).toBeInTheDocument();
    expect(within(dialog).getByText('0 / 5')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Single lot of 5' }));
    expect(within(dialog).getByText('5 / 5')).toBeInTheDocument();
    expect(within(dialog).getByPlaceholderText('Lot #')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: '+ Add lot' }));
    expect(within(dialog).getAllByPlaceholderText('Lot #')).toHaveLength(2);
    await user.click(within(dialog).getAllByRole('button', { name: 'Remove lot' })[1]!);
    expect(within(dialog).getAllByPlaceholderText('Lot #')).toHaveLength(1);
  });

  it('moves to the next serial on Enter, and counts the serials filled', async () => {
    const { user, dialog } = await open([line('a', 2, 'serial')]);
    await user.click(within(dialog).getByRole('button', { name: 'All' }));
    expect(within(dialog).getByText('Serial capture')).toBeInTheDocument();
    const [first, second] = within(dialog).getAllByPlaceholderText(/^Serial #/);
    await user.click(first!);
    await user.keyboard('SN-1{Enter}');
    expect(second).toHaveFocus();
    expect(within(dialog).getByText('1 / 2')).toBeInTheDocument();
  });

  it('marks a serial-optional line as optional and explains it', async () => {
    const { user, dialog } = await open([line('a', 1, 'serial_optional')]);
    await user.click(within(dialog).getByRole('button', { name: 'All' }));
    expect(within(dialog).getByText('Serial capture (optional)')).toBeInTheDocument();
    expect(
      within(dialog).getByText(
        'Serials are optional for this item. Fill in only the units that carry one and leave the rest blank — never enter a placeholder.',
      ),
    ).toBeInTheDocument();
  });
});
