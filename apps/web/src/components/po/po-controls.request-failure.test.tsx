import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { requestFailedMessage, requestUnconfirmedMessage } from '@/lib/request-failure';
import type { PoAttachment } from '@/server/services/po-attachments';
import type { ReceiptLineRow, ReceiptRow } from '@/server/services/receiving';
import { offline } from '@/test/rejected-request';

// ---------------------------------------------------------------------------
// B40: the purchase order page's controls (Make recurring, Mark as ordered,
// Cancel PO, Attach file, Delete file, Notes, Edit PO number, Set destination,
// Reverse a receipt) each set a busy flag, awaited the action with no catch
// and cleared the flag only when it answered. A call that got no answer
// (offline, a server error, a deploy) left the control spinning or disabled
// for good, with no message.
// ---------------------------------------------------------------------------

const { push, refresh } = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push, refresh }) }));
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));
vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), message: vi.fn() },
}));
vi.mock('@/lib/analytics', () => ({ capture: vi.fn() }));
vi.mock('@/lib/supabase/client', () => ({ createClient: vi.fn() }));
vi.mock('@/server/actions/recurring-pos', () => ({ seedRecurringTemplateFromPoAction: vi.fn() }));
vi.mock('@/server/actions/purchase-orders', () => ({
  updatePoStatusAction: vi.fn(),
  updatePoNotesAction: vi.fn(),
  renamePoNumberAction: vi.fn(),
  setPoDestinationWarehouseAction: vi.fn(),
}));
vi.mock('@/server/actions/po-attachments', () => ({
  addPoAttachmentAction: vi.fn(),
  deletePoAttachmentAction: vi.fn(),
}));
vi.mock('@/server/actions/receiving', () => ({ reverseReceiptAction: vi.fn() }));

import { toast } from 'sonner';

import { createClient } from '@/lib/supabase/client';
import { addPoAttachmentAction, deletePoAttachmentAction } from '@/server/actions/po-attachments';
import {
  renamePoNumberAction,
  setPoDestinationWarehouseAction,
  updatePoNotesAction,
  updatePoStatusAction,
} from '@/server/actions/purchase-orders';
import { reverseReceiptAction } from '@/server/actions/receiving';
import { seedRecurringTemplateFromPoAction } from '@/server/actions/recurring-pos';

import { MakeRecurringButton } from './make-recurring-button';
import { PoActions } from './po-actions';
import { PoAttachmentsList, PoFileActions } from './po-attachments-panel';
import { PoNotesEditor } from './po-notes-editor';
import { PoRenameButton } from './po-rename-button';
import { PoSetDestination } from './po-set-destination';
import { ReceiptHistory } from './receipt-history';

beforeAll(() => {
  // Radix Select needs pointer-capture APIs happy-dom doesn't implement.
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.setPointerCapture ??= () => {};
  Element.prototype.releasePointerCapture ??= () => {};
  Element.prototype.scrollIntoView ??= () => {};
});

beforeEach(() => {
  vi.clearAllMocks();
});

const RECEIVED_AT = '2026-10-05T20:56:30.000Z';
const RECEIPT: ReceiptRow = {
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
  received_at: RECEIVED_AT,
  received_by_name: 'Receiver One',
  idempotency_key: null,
  created_at: RECEIVED_AT,
  updated_at: RECEIVED_AT,
};
const LINE: ReceiptLineRow = {
  id: 'rl-1',
  receipt_id: 'rcpt-1',
  purchase_order_line_id: 'pol-1',
  item_id: 'item-1',
  qty_received_base: 4,
  qty_accepted_base: 4,
  qty_rejected_base: 0,
  base_uom: 'each',
  unit_cost: 2,
  notes: null,
  created_at: RECEIVED_AT,
};

describe('purchase order controls when the request gets no answer', () => {
  it('Make recurring says the template could not be opened, stays put and works again', async () => {
    vi.mocked(seedRecurringTemplateFromPoAction).mockRejectedValueOnce(offline());
    render(<MakeRecurringButton poId="po-1" />);
    fireEvent.click(screen.getByRole('button', { name: /Make recurring/ }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(requestFailedMessage('open the recurring template')),
    );
    expect(push).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /Make recurring/ })).toBeEnabled();
  });

  it('Mark as ordered and Cancel PO say the status did not change, and work again', async () => {
    vi.mocked(updatePoStatusAction)
      .mockRejectedValueOnce(offline())
      .mockRejectedValueOnce(offline());
    render(<PoActions poId="po-1" status="draft" />);
    fireEvent.click(screen.getByRole('button', { name: /Mark as ordered/ }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        requestFailedMessage('mark the purchase order as ordered'),
      ),
    );
    expect(screen.getByRole('button', { name: /Mark as ordered/ })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: /Cancel PO/ }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        requestFailedMessage('mark the purchase order as cancelled'),
      ),
    );
    expect(screen.getByRole('button', { name: /Cancel PO/ })).toBeEnabled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("Attach file says to check the PO's files when the attach gets no answer, and leaves the page as it is", async () => {
    vi.mocked(createClient).mockReturnValue({
      storage: {
        from: () => ({
          upload: vi.fn(async () => ({ data: { path: 'p' }, error: null })),
          remove: vi.fn(),
        }),
      },
    } as never);
    vi.mocked(addPoAttachmentAction).mockRejectedValueOnce(offline());
    const { container } = render(
      <PoFileActions
        purchaseOrderId="po-1"
        organizationId="org-1"
        canManage
        hasAttachments={false}
      />,
    );
    fireEvent.change(container.querySelector('input[type="file"]') as HTMLInputElement, {
      target: { files: [new File(['%PDF'], 'invoice.pdf', { type: 'application/pdf' })] },
    });
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        requestUnconfirmedMessage('invoice.pdf was attached', "the PO's files"),
      ),
    );
    // A refresh with no connection becomes a full page load.
    expect(refresh).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /Attach file/ })).toBeEnabled();
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('Delete says the file was not deleted, and its Delete works again', async () => {
    vi.mocked(deletePoAttachmentAction).mockRejectedValueOnce(offline());
    const files = [
      { id: 'a1', fileName: 'packing-slip.pdf', url: 'https://files.test/a1' },
    ] as unknown as PoAttachment[];
    render(<PoAttachmentsList purchaseOrderId="po-1" attachments={files} canManage />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete packing-slip.pdf' }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(requestFailedMessage('delete the file')),
    );
    expect(screen.getByRole('button', { name: 'Delete packing-slip.pdf' })).toBeEnabled();
  });

  it('Notes Save says the notes were not saved and keeps the dialog open', async () => {
    vi.mocked(updatePoNotesAction).mockRejectedValueOnce(offline());
    render(<PoNotesEditor poId="po-1" currentNotes="Dock 2" />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit notes' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(requestFailedMessage('save the notes')),
    );
    expect(within(dialog).getByRole('button', { name: 'Save' })).toBeEnabled();
  });

  it('Edit PO number says the PO was not renamed and keeps the dialog open', async () => {
    vi.mocked(renamePoNumberAction).mockRejectedValueOnce(offline());
    render(<PoRenameButton poId="po-1" currentNumber="PO-0001" />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit PO number' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('PO number'), { target: { value: 'PO-0002' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(requestFailedMessage('rename the purchase order')),
    );
    expect(within(dialog).getByRole('button', { name: 'Save' })).toBeEnabled();
  });

  it('Set destination says the destination was not set, and works again', async () => {
    vi.mocked(setPoDestinationWarehouseAction).mockRejectedValueOnce(offline());
    const user = userEvent.setup();
    render(<PoSetDestination poId="po-1" warehouses={[{ id: 'wh-1', name: 'Main DC' }]} />);
    await user.click(screen.getByRole('combobox'));
    await user.click(await screen.findByRole('option', { name: 'Main DC' }));
    await user.click(screen.getByRole('button', { name: /Set destination/ }));
    expect(toast.error).toHaveBeenCalledWith(requestFailedMessage('set the destination'));
    expect(screen.getByRole('button', { name: /Set destination/ })).toBeEnabled();
  });

  it('Confirm reversal says the receipt was not reversed and keeps the dialog open', async () => {
    vi.mocked(reverseReceiptAction).mockRejectedValueOnce(offline());
    render(
      <ReceiptHistory
        receipts={[RECEIPT]}
        lines={[LINE]}
        items={{ 'item-1': { name: 'Laptop stand', sku: 'LS-1' } }}
        canReverse
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Reverse/ }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: 'Miscount' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /Confirm reversal/ }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(requestFailedMessage('reverse the receipt')),
    );
    expect(within(dialog).getByRole('button', { name: /Confirm reversal/ })).toBeEnabled();
  });
});
