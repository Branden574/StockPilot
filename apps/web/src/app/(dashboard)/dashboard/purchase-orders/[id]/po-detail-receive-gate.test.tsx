import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RECEIVE_MANAGER_POSTS_COPY } from '@stockpilot/core';

/**
 * F4-1's Receive gating fix on the web PO page: Receive items shows only for
 * someone core receivingGate lets post (a manager with stock:adjust); staff
 * and viewers see "A manager posts receipts." in its place, and are never
 * offered Record checklist. The live checklist and the recorder flag reach
 * the dialog and the receipt history as the gate decides.
 */

const gate = vi.hoisted(() => ({
  value: {
    canPostReceipt: true,
    canRecordChecklist: true,
    canPublishChecklist: true,
    canAddPoFile: true,
  },
}));
const checks = vi.hoisted(() => ({
  value: { ok: true, versions: [] as unknown[], runs: [] as unknown[] } as {
    ok: boolean;
    versions?: unknown[];
    runs?: unknown[];
  },
}));
const dialogProps = vi.hoisted(() => ({ value: null as null | Record<string, unknown> }));
const historyProps = vi.hoisted(() => ({ value: null as null | Record<string, unknown> }));

vi.mock('@/lib/auth/session', () => ({
  requireOrgContext: vi.fn(async () => ({
    organizationId: 'org-1',
    userId: 'u1',
    role: 'staff',
    permissions: null,
  })),
}));
vi.mock('next/navigation', () => ({
  notFound: vi.fn(() => {
    throw new Error('notFound');
  }),
}));
vi.mock('next/link', async () => {
  const React = await import('react');
  return {
    default: ({ href, children }: { href: string; children: React.ReactNode }) =>
      React.createElement('a', { href }, children),
  };
});
vi.mock('@/components/po/po-receive-dialog', () => ({
  PoReceiveDialog: (props: Record<string, unknown>) => {
    dialogProps.value = props;
    return <div data-testid="receive-dialog" />;
  },
}));
vi.mock('@/components/po/receipt-history', () => ({
  ReceiptHistory: (props: Record<string, unknown>) => {
    historyProps.value = props;
    return null;
  },
}));
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
          status: 'ordered',
          supplier_id: null,
          destination_location_id: 'loc-st',
          expected_at: null,
          subtotal: 0,
          total: 0,
          notes: null,
          created_at: new Date().toISOString(),
        },
        lines: [],
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
  InventoryService: { forCurrentUser: vi.fn(async () => ({ byIds: vi.fn(async () => []) })) },
}));
vi.mock('@/server/services/size-run-display', () => ({
  loadSizeRunGroups: vi.fn(async () => ({})),
}));
vi.mock('@/server/services/receiving-checklist', () => ({
  ReceivingChecklistService: {
    forCurrentUser: vi.fn(async () => ({
      forPurchaseOrder: vi.fn(async () => checks.value),
      gate: () => gate.value,
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

import PoDetailPage from './page';

const LIVE = {
  id: 'v2',
  versionNumber: 2,
  title: 'Delivery checks',
  steps: [],
  publishedAt: '2026-10-01T00:00:00Z',
  retiredAt: null,
};

async function renderPage() {
  return render(await PoDetailPage({ params: Promise.resolve({ id: 'po-1' }) }));
}

beforeEach(() => {
  vi.clearAllMocks();
  dialogProps.value = null;
  historyProps.value = null;
  checks.value = { ok: true, versions: [LIVE], runs: [] };
});

describe('PO detail page: who is offered Receive', () => {
  it('someone below manager sees no Receive items, and is told who posts', async () => {
    gate.value = {
      canPostReceipt: false,
      canRecordChecklist: false,
      canPublishChecklist: false,
      canAddPoFile: false,
    };
    await renderPage();
    expect(screen.queryByTestId('receive-dialog')).toBeNull();
    expect(screen.getByText(RECEIVE_MANAGER_POSTS_COPY)).toBeTruthy();
    expect(historyProps.value?.canRecordChecklist).toBe(false);
  });

  it('a manager who can post sees Receive items, with the live checklist and the recorder flag', async () => {
    gate.value = {
      canPostReceipt: true,
      canRecordChecklist: true,
      canPublishChecklist: true,
      canAddPoFile: true,
    };
    await renderPage();
    expect(screen.getByTestId('receive-dialog')).toBeTruthy();
    expect(screen.queryByText(RECEIVE_MANAGER_POSTS_COPY)).toBeNull();
    expect(dialogProps.value?.checklist).toEqual({ versionNumber: 2, title: 'Delivery checks' });
    expect(dialogProps.value?.canRecordChecklist).toBe(true);
    expect(historyProps.value?.checklists).toEqual(checks.value);
    expect(historyProps.value?.poId).toBe('po-1');
  });

  it('no live checklist, or a checklist read that failed, offers no checklist in the dialog', async () => {
    gate.value = {
      canPostReceipt: true,
      canRecordChecklist: true,
      canPublishChecklist: true,
      canAddPoFile: true,
    };
    checks.value = { ok: false };
    await renderPage();
    expect(dialogProps.value?.checklist).toBeNull();
    expect(historyProps.value?.checklists).toEqual({ ok: false });
  });
});
