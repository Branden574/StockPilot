import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { requestFailedMessage, requestUnconfirmedMessage } from '@/lib/request-failure';
import { offline } from '@/test/rejected-request';

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
});
