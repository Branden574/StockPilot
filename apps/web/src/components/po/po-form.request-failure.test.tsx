import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { requestFailedMessage, requestUnconfirmedMessage } from '@/lib/request-failure';
import { offline, outOfDate } from '@/test/rejected-request';

// B40: Create PO and Save changes set `submitting`, awaited the action with no
// catch and cleared it only when it answered. A save that got no answer
// (offline, a server error, a deploy) left the button spinning and Cancel
// disabled for good, with no message, and on a create no way to know whether
// the purchase order now exists.

const { push } = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, back: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/server/actions/purchase-orders', () => ({
  createPoAction: vi.fn(),
  updatePoAction: vi.fn(),
}));

import { toast } from 'sonner';

import { createPoAction, updatePoAction } from '@/server/actions/purchase-orders';

import { PoForm } from './po-form';

const ITEMS = [{ id: 'item-1', name: 'Copy paper', sku: 'CP-1', unit_cost: 5 }];
const INITIAL = {
  supplierId: '',
  locationId: '',
  charterId: '',
  expectedAt: '',
  notes: '',
  poNumber: '',
  lines: [{ itemId: 'item-1', quantityOrdered: 2, unitCost: 5 }],
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('PoForm when the save gets no answer', () => {
  it('Create PO says to check Purchase orders before trying again, and works again', async () => {
    vi.mocked(createPoAction).mockRejectedValueOnce(offline());
    render(<PoForm items={ITEMS} suppliers={[]} locations={[]} charters={[]} initial={INITIAL} />);
    fireEvent.click(screen.getByRole('button', { name: 'Create PO' }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        requestUnconfirmedMessage(offline(), 'the purchase order was created', 'Purchase orders'),
      ),
    );
    expect(push).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Create PO' })).toBeEnabled();
  });

  it('Save changes says the purchase order was not saved, and works again', async () => {
    vi.mocked(updatePoAction).mockRejectedValueOnce(offline());
    render(
      <PoForm
        poId="po-1"
        items={ITEMS}
        suppliers={[]}
        locations={[]}
        charters={[]}
        initial={{ ...INITIAL, poNumber: 'PO-0001' }}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        requestFailedMessage(offline(), 'save the purchase order'),
      ),
    );
    expect(push).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeEnabled();
  });

  // A line typed as a new item becomes a new catalog item on every save
  // (PurchaseOrdersService.update -> resolveLines). If the first save went
  // through and only its answer was lost, saving again makes a second item and
  // leaves the first on no line, hidden as Expected: look first.
  it('Save changes with a new item line says to check the purchase order before trying again', async () => {
    vi.mocked(updatePoAction).mockRejectedValueOnce(offline());
    render(
      <PoForm
        poId="po-1"
        items={ITEMS}
        suppliers={[]}
        locations={[]}
        charters={[]}
        initial={{
          ...INITIAL,
          poNumber: 'PO-0001',
          lines: [
            { itemId: 'item-1', quantityOrdered: 2, unitCost: 5 },
            { newItemName: 'Sample binder', quantityOrdered: 1, unitCost: 3 },
          ],
        }}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        requestUnconfirmedMessage(offline(), 'the purchase order was saved', 'the purchase order'),
      ),
    );
    expect(vi.mocked(updatePoAction).mock.calls[0]?.[1]).toMatchObject({
      lines: [{ itemId: 'item-1' }, { newItemName: 'Sample binder' }],
    });
    expect(push).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeEnabled();
  });

  it('a page older than the server says nothing was changed and to reload, with a new item line', async () => {
    vi.mocked(updatePoAction).mockRejectedValueOnce(outOfDate());
    render(
      <PoForm
        poId="po-1"
        items={ITEMS}
        suppliers={[]}
        locations={[]}
        charters={[]}
        initial={{
          ...INITIAL,
          poNumber: 'PO-0001',
          lines: [{ newItemName: 'Sample binder', quantityOrdered: 1, unitCost: 3 }],
        }}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        'StockPilot was updated since this page was opened, so nothing was changed. Reload the page, then try again.',
      ),
    );
  });
});
