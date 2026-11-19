import { render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  dbPermissionRefusedCopy,
  effectivePermissions,
  RECEIVE_MANAGER_ONLY_COPY,
  type PermissionOverride,
  type Role,
} from '@stockpilot/core';

/**
 * Receive items on a purchase order ready to receive is offered only to a
 * member the database lets post a receipt (core canPostReceipt: manager or
 * above with stock:adjust). A member with stock:adjust below
 * manager reads who receives; a member without stock:adjust reads the
 * missing permission, as before.
 */

const poGet = vi.fn();
const inventoryByIds = vi.fn();
const locationsList = vi.fn();
const listForPurchaseOrder = vi.fn(async () => ({ receipts: [], lines: [] }));
const attachmentsList = vi.fn(async () => []);
let role = 'owner';
let permissions: Set<string> | null = null;

// The page's own module is on: the page checks it before it reads (B66).
vi.mock('@/lib/modules/module-gate', () => ({
  checkModuleAccess: vi.fn(async () => ({ enabled: true, canManage: true })),
}));
vi.mock('@/lib/auth/session', () => ({
  requireOrgContext: vi.fn(async () => ({
    organizationId: 'org-1',
    userId: 'u1',
    role,
    permissions,
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
    default: ({
      href,
      children,
      prefetch: _prefetch,
      ...rest
    }: {
      href: string;
      children: React.ReactNode;
      prefetch?: unknown;
    }) => React.createElement('a', { href, ...rest }, children),
  };
});

vi.mock('@/components/po/po-receive-dialog', () => ({
  PoReceiveDialog: () => <button type="button">Receive items</button>,
}));
vi.mock('@/components/po/po-set-destination', () => ({
  PoSetDestination: () => <div data-testid="set-destination" />,
}));
vi.mock('@/components/po/make-recurring-button', () => ({
  MakeRecurringButton: () => <button type="button">Make recurring</button>,
}));
vi.mock('@/components/po/po-rename-button', () => ({
  PoRenameButton: () => <button type="button" aria-label="Edit PO number" />,
}));
vi.mock('@/components/po/po-notes-editor', () => ({
  PoNotesEditor: () => <div data-testid="notes-editor" />,
}));
vi.mock('@/components/po/po-actions', () => ({
  PoActions: ({ part }: { part?: string }) => <span data-testid={`po-actions-${part ?? 'all'}`} />,
}));
vi.mock('@/components/po/po-attachments-panel', () => ({
  PoFileActions: () => <span data-testid="file-actions" />,
  PoAttachmentsList: () => <section data-testid="attachments" />,
}));
vi.mock('@/components/po/receipt-history', () => ({
  ReceiptHistory: () => <div data-testid="receipt-history" />,
}));
vi.mock('@/components/po/po-status-badge', () => ({
  PoStatusBadge: ({ status }: { status: string }) => <span data-testid="status">{status}</span>,
}));
vi.mock('@/components/po/po-access-denied', () => ({ PoAccessDenied: () => null }));
vi.mock('@/components/items/item-thumb', () => ({
  ItemThumb: ({ alt, imageUrl, size }: { alt: string; imageUrl: string | null; size?: string }) => (
    <span data-testid="thumb" data-alt={alt} data-src={imageUrl ?? ''} data-size={size ?? ''} />
  ),
}));

vi.mock('@/server/services/purchase-orders', () => ({
  PurchaseOrdersService: { forCurrentUser: vi.fn(async () => ({ get: poGet })) },
}));
vi.mock('@/server/services/suppliers', () => ({
  SuppliersService: {
    forCurrentUser: vi.fn(async () => ({
      listForLookups: vi.fn(async () => [{ id: 'sup-1', name: 'Lantern Peak School Supply' }]),
    })),
  },
}));
vi.mock('@/server/services/locations', () => ({
  LocationsService: { forCurrentUser: vi.fn(async () => ({ list: locationsList })) },
}));
vi.mock('@/server/services/receiving', () => ({
  ReceivingService: { forCurrentUser: vi.fn(async () => ({ listForPurchaseOrder })) },
}));
vi.mock('@/server/services/warehouses', () => ({
  WarehousesService: {
    forCurrentUser: vi.fn(async () => ({
      listNames: vi.fn(async () => [{ id: 'wh-1', name: 'North DC' }]),
    })),
  },
}));
vi.mock('@/server/services/po-attachments', () => ({
  PoAttachmentsService: { forCurrentUser: vi.fn(async () => ({ list: attachmentsList })) },
}));
vi.mock('@/server/services/inventory', () => ({
  InventoryService: { forCurrentUser: vi.fn(async () => ({ byIds: inventoryByIds })) },
}));
vi.mock('@/server/services/size-run-display', () => ({
  loadSizeRunGroups: vi.fn(async () => ({})),
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

const PO_ID = '5eed0000-0000-4000-8000-0000000000f1';

function po(status = 'partially_received') {
  return {
    po: {
      po_number: 'PO-2026-0018',
      status,
      supplier_id: 'sup-1',
      destination_location_id: 'loc-1',
      expected_at: '2026-10-09T00:00:00.000Z',
      subtotal: 3860,
      total: 3910,
      notes: null,
      created_at: '2026-10-01T16:00:00.000Z',
    },
    lines: [
      {
        id: 'pol-1',
        item_id: 'item-1',
        quantity_ordered: 200,
        quantity_received: 120,
        unit_cost: 18,
        line_total: 3600,
        imageUrl: 'https://img.test/polo-thumb.jpg',
        previewUrl: 'https://img.test/polo.jpg',
      },
      {
        id: 'pol-2',
        item_id: 'item-gone',
        quantity_ordered: 400,
        quantity_received: 0,
        unit_cost: 0.65,
        line_total: 260,
        imageUrl: null,
        previewUrl: null,
      },
    ],
  };
}

async function renderAs(r: Role, userOverrides: PermissionOverride[] = []) {
  role = r;
  permissions = effectivePermissions(r, [], userOverrides) as Set<string>;
  return render(await PoDetailPage({ params: Promise.resolve({ id: PO_ID }) }));
}

function lineItems() {
  return screen.getByRole('heading', { name: 'Line items' }).closest('section')!;
}

beforeEach(() => {
  vi.clearAllMocks();
  role = 'owner';
  permissions = null;
  poGet.mockResolvedValue(po());
  inventoryByIds.mockResolvedValue([
    { id: 'item-1', name: 'Polo, Navy', sku: 'POLO-M', tracking_type: 'none' },
  ]);
  locationsList.mockResolvedValue([
    { id: 'loc-1', name: 'North DC Building', warehouse_id: 'wh-1', kind: null },
  ]);
});

const OFFERED: Array<[string, Role, PermissionOverride[]]> = [
  ['an owner', 'owner', []],
  ['an admin', 'admin', []],
  ['a manager', 'manager', []],
  [
    'a manager without purchase_orders:manage',
    'manager',
    [{ permission: 'purchase_orders:manage', granted: false }],
  ],
];

const NOT_OFFERED: Array<[string, Role, PermissionOverride[], string]> = [
  ['a staff member', 'staff', [], RECEIVE_MANAGER_ONLY_COPY],
  [
    'a staff member granted purchase_orders:manage',
    'staff',
    [{ permission: 'purchase_orders:manage', granted: true }],
    RECEIVE_MANAGER_ONLY_COPY,
  ],
  [
    'a viewer granted stock:adjust',
    'viewer',
    [{ permission: 'stock:adjust', granted: true }],
    RECEIVE_MANAGER_ONLY_COPY,
  ],
  ['a viewer', 'viewer', [], dbPermissionRefusedCopy('receipt_post')],
  [
    'a manager without stock:adjust',
    'manager',
    [{ permission: 'stock:adjust', granted: false }],
    dbPermissionRefusedCopy('receipt_post'),
  ],
];

describe('Receive items follows the rule the database applies', () => {
  for (const [name, r, overrides] of OFFERED) {
    it(`${name}: Receive items and the receiving hint`, async () => {
      await renderAs(r, overrides);
      const lines = lineItems();
      expect(within(lines).getByRole('button', { name: 'Receive items' })).toBeInTheDocument();
      expect(lines.textContent).toContain(
        'Items arrived? Use “Receive items” to record what was received.',
      );
      expect(lines.textContent).not.toContain(RECEIVE_MANAGER_ONLY_COPY);
    });
  }

  for (const [name, r, overrides, note] of NOT_OFFERED) {
    it(`${name}: no Receive items, and "${note}"`, async () => {
      await renderAs(r, overrides);
      const lines = lineItems();
      expect(within(lines).queryByRole('button', { name: 'Receive items' })).toBeNull();
      expect(lines.textContent).toContain(note);
      expect(lines.textContent).not.toContain('Items arrived?');
    });
  }

  it('says nothing about receiving on a received purchase order, whoever reads it', async () => {
    const received = po('received');
    for (const l of received.lines) l.quantity_received = l.quantity_ordered;
    poGet.mockResolvedValue(received);
    await renderAs('staff');
    const lines = lineItems();
    expect(within(lines).queryByRole('button', { name: 'Receive items' })).toBeNull();
    expect(lines.textContent).not.toContain(RECEIVE_MANAGER_ONLY_COPY);
  });
});
