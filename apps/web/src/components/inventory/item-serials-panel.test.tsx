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
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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

    // Single warehouse pre-selects itself; only the serials are needed.
    fireEvent.change(screen.getByLabelText('Serial numbers'), {
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
