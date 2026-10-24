// @vitest-environment happy-dom
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RECEIVING_CHECKLIST_COPY as C } from '@stockpilot/core';

/**
 * F4-1 desk check F1: the web Posted panel must survive the post that
 * completes the purchase order. The post refreshes the page (and the realtime
 * nudge would refresh it anyway); the refreshed PO reads 'received', which is
 * not receivable. The page keeps the receive dialog mounted for a poster, so
 * the panel it holds stays until Done or Record checklist, and only its
 * Receive items button goes. A toast says the receipt posted on this path too.
 *
 * The page renders here with the REAL dialog (po-detail-receive-gate.test.tsx
 * mocks it), and the "refresh" is a re-render of the page with the PO's new
 * status, as the server would send it.
 */

const po = vi.hoisted(() => ({ status: 'ordered', received: 0 }));
const postReceiptAction = vi.hoisted(() => vi.fn());
const startReceivingCheckAction = vi.hoisted(() => vi.fn());
const router = vi.hoisted(() => ({ refresh: vi.fn(), push: vi.fn() }));
const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));

vi.mock('@/lib/auth/session', () => ({
  requireOrgContext: vi.fn(async () => ({
    organizationId: 'org-1',
    userId: 'u1',
    role: 'manager',
    permissions: null,
  })),
}));
vi.mock('next/navigation', () => ({
  notFound: vi.fn(() => {
    throw new Error('notFound');
  }),
  useRouter: () => router,
}));
vi.mock('next/link', async () => {
  const React = await import('react');
  return {
    default: ({ href, children }: { href: string; children: React.ReactNode }) =>
      React.createElement('a', { href }, children),
  };
});
vi.mock('sonner', () => ({ toast }));
vi.mock('@/server/actions/receiving', () => ({ postReceiptAction }));
vi.mock('@/server/actions/receiving-checklist', () => ({ startReceivingCheckAction }));
vi.mock('@/components/po/receipt-history', () => ({ ReceiptHistory: () => null }));
vi.mock('@/components/po/po-set-destination', () => ({ PoSetDestination: () => null }));
vi.mock('@/components/po/make-recurring-button', () => ({ MakeRecurringButton: () => null }));
vi.mock('@/components/po/po-rename-button', () => ({ PoRenameButton: () => null }));
vi.mock('@/components/po/po-notes-editor', () => ({ PoNotesEditor: () => null }));
vi.mock('@/components/po/po-actions', () => ({ PoActions: () => null }));
vi.mock('@/components/po/po-attachments-panel', () => ({
  PoFileActions: () => null,
  PoAttachmentsList: () => null,
}));
vi.mock('@/components/po/po-status-badge', () => ({ PoStatusBadge: () => null }));
vi.mock('@/components/po/po-access-denied', () => ({ PoAccessDenied: () => null }));
vi.mock('@/components/items/item-thumb', () => ({ ItemThumb: () => null }));
vi.mock('@/server/services/purchase-orders', () => ({
  PurchaseOrdersService: {
    forCurrentUser: vi.fn(async () => ({
      get: vi.fn(async () => ({
        po: {
          po_number: 'PO-1',
          status: po.status,
          supplier_id: null,
          destination_location_id: 'loc-st',
          expected_at: null,
          subtotal: 2,
          total: 2,
          notes: null,
          created_at: new Date().toISOString(),
        },
        lines: [
          {
            id: 'l1',
            item_id: 'it1',
            quantity_ordered: 2,
            quantity_received: po.received,
            unit_cost: 1,
            line_total: 2,
          },
        ],
      })),
    })),
  },
}));
vi.mock('@/server/services/suppliers', () => ({
  SuppliersService: {
    forCurrentUser: vi.fn(async () => ({ listForLookups: vi.fn(async () => []) })),
  },
}));
vi.mock('@/server/services/locations', () => ({
  LocationsService: {
    forCurrentUser: vi.fn(async () => ({
      list: vi.fn(async () => [
        {
          id: 'loc-st',
          name: 'Staging',
          kind: 'staging',
          type: 'other',
          warehouse_id: 'wh-1',
          parent_id: null,
          deleted_at: null,
        },
      ]),
    })),
  },
}));
vi.mock('@/server/services/receiving', () => ({
  ReceivingService: {
    forCurrentUser: vi.fn(async () => ({
      listForPurchaseOrder: vi.fn(async () => ({ receipts: [], lines: [] })),
    })),
  },
}));
vi.mock('@/server/services/warehouses', () => ({
  WarehousesService: { forCurrentUser: vi.fn(async () => ({ listNames: vi.fn(async () => []) })) },
}));
vi.mock('@/server/services/po-attachments', () => ({
  PoAttachmentsService: { forCurrentUser: vi.fn(async () => ({ list: vi.fn(async () => []) })) },
}));
vi.mock('@/server/services/inventory', () => ({
  InventoryService: {
    forCurrentUser: vi.fn(async () => ({
      byIds: vi.fn(async () => [
        {
          id: 'it1',
          name: 'Shirt',
          sku: 'S1',
          tracking_type: 'none',
          group_id: null,
          variant_size: null,
        },
      ]),
    })),
  },
}));
vi.mock('@/server/services/size-run-display', () => ({
  loadSizeRunGroups: vi.fn(async () => ({})),
}));
vi.mock('@/server/services/receiving-checklist', () => ({
  ReceivingChecklistService: {
    forCurrentUser: vi.fn(async () => ({
      forPurchaseOrder: vi.fn(async () => ({
        ok: true,
        versions: [
          {
            id: 'v1',
            versionNumber: 1,
            title: 'Delivery checks',
            steps: [],
            publishedAt: '2026-10-01T00:00:00Z',
            retiredAt: null,
          },
        ],
        runs: [],
      })),
      gate: () => ({
        canPostReceipt: true,
        canRecordChecklist: true,
        canPublishChecklist: true,
        canAddPoFile: true,
      }),
    })),
  },
}));
vi.mock('@/server/services/context', () => ({
  ServiceError: class ServiceError extends Error {
    constructor(
      public code: string,
      message: string,
    ) {
      super(message);
    }
  },
}));

import { getUnsavedSources, resetUnsavedSourcesForTests } from '@/lib/unsaved-work';

import PoDetailPage from './page';

const page = () => PoDetailPage({ params: Promise.resolve({ id: 'po-1' }) });

beforeEach(() => {
  vi.clearAllMocks();
  resetUnsavedSourcesForTests();
  po.status = 'ordered';
  po.received = 0;
  postReceiptAction.mockResolvedValue({
    ok: true,
    data: { receiptId: 'rcpt-1', receiptNumber: 'R-1' },
  });
  startReceivingCheckAction.mockResolvedValue({
    ok: true,
    data: { runId: 'run-1', created: true, versionNumber: 1 },
  });
});

/** Receive everything on the PO through the real dialog, and see the panel. */
async function receiveEverything() {
  const user = userEvent.setup();
  const view = render(await page());
  await user.click(screen.getByRole('button', { name: /receive items/i }));
  await user.type(screen.getAllByRole('spinbutton')[0]!, '2');
  await user.click(screen.getByRole('button', { name: /post receipt/i }));
  expect(await screen.findByText(C.postedTitle('R-1'))).toBeTruthy();
  return { user, view };
}

describe('PO detail page: the Posted panel outlives the post that completes the PO', () => {
  // Mutation caught (desk check F1): the dialog mounted only while the PO is
  // receivable; the refresh unmounted it and took the panel with it.
  it('the refreshed page reads received, and the panel stays with Record checklist', async () => {
    const { view } = await receiveEverything();
    expect(router.refresh).toHaveBeenCalled();
    // The refresh lands: the PO is fully received now.
    po.status = 'received';
    po.received = 2;
    view.rerender(await page());
    expect(screen.getByText(C.postedTitle('R-1'))).toBeTruthy();
    expect(screen.getByText(C.postedBody)).toBeTruthy();
    expect(screen.getByRole('button', { name: C.recordChecklist })).toBeTruthy();
    // Nothing is left to receive: no Receive items button.
    expect(screen.queryByRole('button', { name: /receive items/i })).toBeNull();
    // The receipt is saved: a reload loses nothing.
    expect(getUnsavedSources()).toEqual([]);
  });

  it('Record checklist still starts the run and opens it after the refresh', async () => {
    const { user, view } = await receiveEverything();
    po.status = 'received';
    po.received = 2;
    view.rerender(await page());
    await user.click(screen.getByRole('button', { name: C.recordChecklist }));
    expect(startReceivingCheckAction).toHaveBeenCalledWith('rcpt-1', 'po-1');
    await waitFor(() =>
      expect(router.push).toHaveBeenCalledWith('/dashboard/purchase-orders/receiving-checks/run-1'),
    );
  });

  it('Done closes the panel, and a received PO offers no Receive items', async () => {
    const { user, view } = await receiveEverything();
    po.status = 'received';
    po.received = 2;
    view.rerender(await page());
    await user.click(screen.getByRole('button', { name: C.done }));
    await waitFor(() => expect(screen.queryByText(C.postedTitle('R-1'))).toBeNull());
    expect(screen.queryByRole('button', { name: /receive items/i })).toBeNull();
  });

  // Desk check F1: the panel path says the receipt posted too, so a person
  // who looks away still learns it.
  it('a toast says the receipt posted on the panel path too', async () => {
    await receiveEverything();
    expect(toast.success).toHaveBeenCalledWith('Receipt R-1 posted against PO-1.');
  });
});
