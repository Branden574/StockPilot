/**
 * Focused tests for ItemSerialsPanel.
 *
 * 1. Renders serial rows with status badges, source labels (Manual vs
 *    PO receipt), and warehouse names.
 * 2. The delete button renders ONLY on manually-added rows
 *    (receiptLineId === null) — receipt-captured rows get no trash icon.
 * 3. Add dialog: a failed submit ({ok:false}) renders a persistent inline
 *    role="alert" error INSIDE the dialog (repo pattern #20), and the
 *    dialog stays open.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { requestFailedMessage } from '@/lib/request-failure';
import { hydrateAcrossClockShift } from '@/test/hydration';
import { offline } from '@/test/rejected-request';

// ── Mock server actions ──────────────────────────────────────────────────────
const mockList = vi.fn(async (_itemId: string, _page: number) => ({
  ok: true as const,
  data: { rows: [], total: 0, page: 1, pageSize: 50 },
}));
const mockAdd = vi.fn(async (_input: unknown) => ({ ok: true as const, data: { added: 1 } }));
const mockUpdate = vi.fn(async (_input: unknown) => ({
  ok: true as const,
  data: { id: 's1', serialNumber: 'SN-1', currentStatus: 'available' as const },
}));
const mockDelete = vi.fn(async (_input: unknown) => ({ ok: true as const, data: undefined }));

vi.mock('@/server/actions/serials', () => ({
  listItemSerialsAction: (itemId: string, page: number) => mockList(itemId, page),
  addItemSerialsAction: (input: unknown) => mockAdd(input),
  updateItemSerialAction: (input: unknown) => mockUpdate(input),
  deleteItemSerialAction: (input: unknown) => mockDelete(input),
}));

// ── Mock sonner + next/navigation ────────────────────────────────────────────
vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
}));

import { toast } from 'sonner';

import { ItemSerialsPanel, type SerialPanelRow } from './item-serials-panel';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const MANUAL_ROW: SerialPanelRow = {
  id: 'serial-manual',
  serialNumber: 'SN-MANUAL-1',
  currentStatus: 'available',
  warehouseId: 'wh-1',
  warehouseName: 'Main DC',
  receiptLineId: null,
  createdAt: new Date().toISOString(),
};

const RECEIPT_ROW: SerialPanelRow = {
  id: 'serial-receipt',
  serialNumber: 'SN-RECEIPT-1',
  currentStatus: 'sold',
  warehouseId: 'wh-1',
  warehouseName: 'Main DC',
  receiptLineId: 'rl-1',
  createdAt: new Date().toISOString(),
};

const WAREHOUSES = [{ id: 'wh-1', name: 'Main DC' }];

const BASE_PROPS = {
  itemId: 'item-1',
  canEditItems: true,
  warehouses: WAREHOUSES,
  initialRows: [MANUAL_ROW, RECEIPT_ROW],
  initialTotal: 2,
};

beforeEach(() => {
  vi.clearAllMocks();
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe('ItemSerialsPanel', () => {
  it('renders serial rows with status, source, and warehouse', () => {
    render(<ItemSerialsPanel {...BASE_PROPS} />);

    expect(screen.getByText('SN-MANUAL-1')).toBeInTheDocument();
    expect(screen.getByText('SN-RECEIPT-1')).toBeInTheDocument();

    // Status badges.
    expect(screen.getByText('Available')).toBeInTheDocument();
    expect(screen.getByText('Sold')).toBeInTheDocument();

    // Source column distinguishes manual from receipt-captured.
    expect(screen.getByText('Manual')).toBeInTheDocument();
    expect(screen.getByText('PO receipt')).toBeInTheDocument();

    // Warehouse names resolved.
    expect(screen.getAllByText('Main DC').length).toBeGreaterThanOrEqual(2);

    // Header count.
    expect(screen.getByText(/2 registered serial numbers/i)).toBeInTheDocument();
  });

  it('shows the delete button ONLY on manually-added rows', () => {
    render(<ItemSerialsPanel {...BASE_PROPS} />);

    // Exactly one delete affordance — for the manual serial.
    expect(screen.getByLabelText('Delete serial SN-MANUAL-1')).toBeInTheDocument();
    expect(screen.queryByLabelText('Delete serial SN-RECEIPT-1')).not.toBeInTheDocument();
  });

  it('hides all edit affordances (add / edit / delete) for read-only users', () => {
    render(<ItemSerialsPanel {...BASE_PROPS} canEditItems={false} />);

    expect(screen.queryByRole('button', { name: /add serials/i })).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/delete serial/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/edit serial/i)).not.toBeInTheDocument();
  });

  it('renders a persistent inline role="alert" in the add dialog on {ok:false}', async () => {
    mockAdd.mockResolvedValueOnce({
      ok: false,
      error: { code: 'conflict', message: 'Already registered for this item: SN-9.' },
    } as never);

    render(<ItemSerialsPanel {...BASE_PROPS} />);

    fireEvent.click(screen.getByRole('button', { name: /add serials/i }));
    await screen.findByText('Add serial numbers');

    // Single warehouse pre-selects itself; only the serials are needed. (The
    // serials table's scroll region shares the card heading's name.)
    fireEvent.change(screen.getByRole('textbox', { name: 'Serial numbers' }), {
      target: { value: 'SN-9\nSN-10' },
    });
    // Live count reflects the parsed lines.
    expect(screen.getByText(/2 serial numbers to add/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /add 2 serials/i }));

    await waitFor(() => {
      expect(mockAdd).toHaveBeenCalledWith({
        itemId: 'item-1',
        warehouseId: 'wh-1',
        serials: ['SN-9', 'SN-10'],
      });
    });

    // Inline, persistent error inside the dialog — not toast-only.
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Already registered for this item: SN-9.');
    // Dialog stayed open for correction.
    expect(screen.getByText('Add serial numbers')).toBeInTheDocument();
  });

  it('deletes a manual serial after confirm', async () => {
    render(<ItemSerialsPanel {...BASE_PROPS} />);

    fireEvent.click(screen.getByLabelText('Delete serial SN-MANUAL-1'));
    await screen.findByText('Delete serial number?');
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => {
      expect(mockDelete).toHaveBeenCalledWith({ id: 'serial-manual' });
    });
    // The list refreshes from the server after a delete.
    await waitFor(() => {
      expect(mockList).toHaveBeenCalledWith('item-1', 1);
    });
  });
});

// An item's page server-renders its serials (item-detail hands the first
// page in), and each row prints when it was added as a relative time. A
// minute between the server render and hydration changes the words and React
// throws error #418; the cell carries suppressHydrationWarning.
describe('ItemSerialsPanel hydrates across a clock tick', () => {
  it('the relative time rendered on the server and hydrated a minute later: no hydration error', async () => {
    const t0 = Date.parse('2026-10-05T21:00:00.000Z');
    const rows = [{ ...RECEIPT_ROW, createdAt: new Date(t0 - 210_000).toISOString() }];
    const run = await hydrateAcrossClockShift(
      () => (
        <ItemSerialsPanel
          {...BASE_PROPS}
          canEditItems={false}
          initialRows={rows}
          initialTotal={1}
        />
      ),
      { serverNow: t0, browserNow: t0 + 60_000 },
    );
    try {
      expect(run.html).toContain('3 minutes ago');
      expect(run.errors).toEqual([]);
    } finally {
      run.unmount();
    }
  });
});

// B40: every serial write set a busy flag, awaited the action with no catch
// and cleared the flag only when it answered. A call that got no answer
// (offline, a server error, a deploy) left the row's buttons spinning or the
// add dialog stuck, the delete confirm stuck open (it refuses to close while
// pending), and Prev/Next disabled, all with no message.
describe('ItemSerialsPanel when a request gets no answer', () => {
  beforeAll(() => {
    // Radix Select needs pointer-capture APIs happy-dom doesn't implement.
    Element.prototype.hasPointerCapture ??= () => false;
    Element.prototype.setPointerCapture ??= () => {};
    Element.prototype.releasePointerCapture ??= () => {};
    Element.prototype.scrollIntoView ??= () => {};
  });

  it('an edit says the serial number was not saved, on its row, and Save works again', async () => {
    mockUpdate.mockRejectedValueOnce(offline());
    render(<ItemSerialsPanel {...BASE_PROPS} />);
    fireEvent.click(screen.getByLabelText('Edit serial SN-MANUAL-1'));
    fireEvent.change(screen.getByLabelText('Serial number'), { target: { value: 'SN-MANUAL-2' } });
    fireEvent.click(screen.getByLabelText('Save serial number'));
    const row = screen.getByTestId('serial-row-serial-manual');
    expect(await within(row).findByRole('alert')).toHaveTextContent(
      requestFailedMessage('save the serial number'),
    );
    expect(within(row).getByLabelText('Save serial number')).toBeEnabled();
  });

  it('a status change says the status was not changed, on its row', async () => {
    mockUpdate.mockRejectedValueOnce(offline());
    const user = userEvent.setup();
    render(<ItemSerialsPanel {...BASE_PROPS} />);
    await user.click(screen.getByLabelText('Status for serial SN-MANUAL-1'));
    await user.click(await screen.findByRole('option', { name: 'Damaged' }));
    const row = screen.getByTestId('serial-row-serial-manual');
    expect(await within(row).findByRole('alert')).toHaveTextContent(
      requestFailedMessage('change the status'),
    );
    expect(within(row).getByLabelText('Status for serial SN-MANUAL-1')).toBeEnabled();
  });

  it('a delete closes the confirm and says the serial number was not deleted', async () => {
    mockDelete.mockRejectedValueOnce(offline());
    render(<ItemSerialsPanel {...BASE_PROPS} />);
    fireEvent.click(screen.getByLabelText('Delete serial SN-MANUAL-1'));
    await screen.findByText('Delete serial number?');
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    const row = screen.getByTestId('serial-row-serial-manual');
    expect(await within(row).findByRole('alert')).toHaveTextContent(
      requestFailedMessage('delete the serial number'),
    );
    await waitFor(() => expect(screen.queryByText('Delete serial number?')).toBeNull());
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('an add says the serial numbers were not added, in the dialog, and Add works again', async () => {
    mockAdd.mockRejectedValueOnce(offline());
    render(<ItemSerialsPanel {...BASE_PROPS} />);
    fireEvent.click(screen.getByRole('button', { name: /add serials/i }));
    await screen.findByText('Add serial numbers');
    fireEvent.change(screen.getByRole('textbox', { name: 'Serial numbers' }), {
      target: { value: 'SN-9' },
    });
    fireEvent.click(screen.getByRole('button', { name: /add 1 serial/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      requestFailedMessage('add the serial numbers'),
    );
    expect(screen.getByRole('button', { name: /add 1 serial/i })).toBeEnabled();
  });

  it('a page that gets no answer says so and leaves Next working', async () => {
    mockList.mockRejectedValueOnce(offline());
    render(<ItemSerialsPanel {...BASE_PROPS} initialTotal={120} />);
    fireEvent.click(screen.getByRole('button', { name: /next/i }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(requestFailedMessage('load the serial numbers')),
    );
    expect(screen.getByRole('button', { name: /next/i })).toBeEnabled();
    expect(screen.getByText('Page 1 of 3')).toBeInTheDocument();
  });
});
