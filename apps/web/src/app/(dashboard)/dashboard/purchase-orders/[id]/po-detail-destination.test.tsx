import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A PO whose destination is a STAGING location must still be receivable on the
 * web.
 *
 * The page derived its receiving warehouse from `locationsSvc.list({
 * excludeSystem: true })`, and `isUserFacingLocation` drops `kind = 'staging'`
 * and `kind = 'unplaced'`. So for any PO destined for staging — which is the
 * normal destination for the staging receive flow — `locations.find(...)` came
 * back undefined and the page concluded there was no warehouse:
 *
 *   - Destination rendered as an em-dash even though the column was set;
 *   - the Receive items button disappeared (`canReceive` needs a warehouse);
 *   - the "destination isn't linked to a warehouse" card appeared instead, and
 *     its own picker resolves back to the same staging location, so the
 *     suggested fix looped straight back into the dead end.
 *
 * Nothing was wrong in the database. The fix is confined to THIS page's
 * derivation: it reads the unfiltered list so a system location can still
 * resolve its `warehouse_id`. `isUserFacingLocation` and every PICKER that
 * uses it are deliberately unchanged — an operator must still never be offered
 * staging as a destination to choose.
 */

const poGet = vi.fn();
const suppliersList = vi.fn(async () => [{ id: 'sup-1', name: 'Acme' }]);
const locationsList = vi.fn();
const receivingList = vi.fn(async () => ({ receipts: [], lines: [] }));
const warehousesListNames = vi.fn(async () => [{ id: 'wh-1', name: 'Main DC' }]);
const attachmentsList = vi.fn(async () => []);
const inventoryByIds = vi.fn(async () => []);
const loadSizeRunGroups = vi.fn(async () => ({}));

vi.mock('@/lib/auth/session', () => ({
  requireOrgContext: vi.fn(async () => ({
    organizationId: 'org-1',
    userId: 'u1',
    role: 'owner',
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

// Client components: stubbed to identifiable markers. What this test asserts is
// WHICH of them the page decides to render, not what they look like.
vi.mock('@/components/po/po-receive-dialog', () => ({
  PoReceiveDialog: ({ warehouseId }: { warehouseId: string }) => (
    <div data-testid="receive-dialog" data-warehouse={warehouseId} />
  ),
}));
vi.mock('@/components/po/po-set-destination', () => ({
  PoSetDestination: () => <div data-testid="set-destination" />,
}));
vi.mock('@/components/po/make-recurring-button', () => ({
  MakeRecurringButton: () => null,
}));
vi.mock('@/components/po/po-rename-button', () => ({ PoRenameButton: () => null }));
vi.mock('@/components/po/po-notes-editor', () => ({ PoNotesEditor: () => null }));
vi.mock('@/components/po/po-actions', () => ({ PoActions: () => null }));
vi.mock('@/components/po/po-attachments-panel', () => ({
  PoFileActions: () => null,
  PoAttachmentsList: () => null,
}));
vi.mock('@/components/po/receipt-history', () => ({ ReceiptHistory: () => null }));
vi.mock('@/components/po/po-status-badge', () => ({ PoStatusBadge: () => null }));
vi.mock('@/components/po/po-access-denied', () => ({ PoAccessDenied: () => null }));
vi.mock('@/components/items/item-thumb', () => ({ ItemThumb: () => null }));

vi.mock('@/server/services/purchase-orders', () => ({
  PurchaseOrdersService: { forCurrentUser: vi.fn(async () => ({ get: poGet })) },
}));
vi.mock('@/server/services/suppliers', () => ({
  SuppliersService: { forCurrentUser: vi.fn(async () => ({ list: suppliersList })) },
}));
vi.mock('@/server/services/locations', () => ({
  LocationsService: { forCurrentUser: vi.fn(async () => ({ list: locationsList })) },
}));
vi.mock('@/server/services/receiving', () => ({
  ReceivingService: {
    forCurrentUser: vi.fn(async () => ({ listForPurchaseOrder: receivingList })),
  },
}));
vi.mock('@/server/services/warehouses', () => ({
  WarehousesService: { forCurrentUser: vi.fn(async () => ({ listNames: warehousesListNames })) },
}));
vi.mock('@/server/services/po-attachments', () => ({
  PoAttachmentsService: { forCurrentUser: vi.fn(async () => ({ list: attachmentsList })) },
}));
vi.mock('@/server/services/inventory', () => ({
  InventoryService: { forCurrentUser: vi.fn(async () => ({ byIds: inventoryByIds })) },
}));
vi.mock('@/server/services/size-run-display', () => ({
  loadSizeRunGroups: (...args: unknown[]) => loadSizeRunGroups(...(args as [])),
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

/** The staging bucket every warehouse has, and the dead end this test pins. */
const STAGING = {
  id: 'loc-staging',
  parent_id: null,
  name: 'Staging — Main DC',
  type: 'other',
  kind: 'staging',
  warehouse_id: 'wh-1',
  deleted_at: null,
};

/** A location that genuinely has no warehouse — the banner's real audience. */
const ORPHAN = {
  id: 'loc-orphan',
  parent_id: null,
  name: 'Unlinked room',
  type: 'room',
  kind: null,
  warehouse_id: null,
  deleted_at: null,
};

function poRow(destinationLocationId: string | null) {
  return {
    po: {
      po_number: 'PO-1785251481118',
      status: 'ordered',
      supplier_id: 'sup-1',
      destination_location_id: destinationLocationId,
      expected_at: null,
      subtotal: 0,
      total: 0,
      notes: null,
      created_at: new Date().toISOString(),
    },
    lines: [],
  };
}

async function renderPage() {
  return render(await PoDetailPage({ params: Promise.resolve({ id: 'po-1' }) }));
}

/**
 * The stub applies the REAL filtering `LocationsService.list` applies, so a
 * page that asks for `excludeSystem: true` genuinely loses the staging row
 * here — otherwise this file would pass against the broken page. Mirrors
 * `isUserFacingLocation` (kind staging/unplaced) and `isSiteLocation`.
 */
function listLocations(opts: { excludeSystem?: boolean; sitesOnly?: boolean } = {}) {
  const rows = [STAGING, ORPHAN];
  if (opts.sitesOnly) {
    return rows.filter(
      (l) => l.kind == null && ['warehouse', 'room', 'vehicle', 'jobsite'].includes(l.type),
    );
  }
  if (opts.excludeSystem) {
    return rows.filter((l) => l.kind !== 'staging' && l.kind !== 'unplaced');
  }
  return rows;
}

beforeEach(() => {
  vi.clearAllMocks();
  locationsList.mockImplementation(async (opts = {}) => listLocations(opts));
  loadSizeRunGroups.mockResolvedValue({});
  poGet.mockResolvedValue(poRow(STAGING.id));
});

describe('PO detail page — a staging destination is still receivable', () => {
  it('does not ask locations.list() to drop system locations (staging must resolve)', async () => {
    await renderPage();
    // Either no options at all or an explicit excludeSystem: false — what must
    // never happen again is excludeSystem: true, which hid the destination.
    for (const call of locationsList.mock.calls) {
      expect(call[0]?.excludeSystem).not.toBe(true);
    }
  });

  it('derives the warehouse from a staging destination and renders Receive items', async () => {
    const { queryByTestId } = await renderPage();
    expect(queryByTestId('receive-dialog')).not.toBeNull();
    expect(queryByTestId('receive-dialog')?.getAttribute('data-warehouse')).toBe('wh-1');
  });

  it('shows the staging destination by name instead of an em-dash', async () => {
    const { getByText } = await renderPage();
    expect(getByText('Staging — Main DC')).toBeTruthy();
  });

  it('does not show the "set a destination" card for a staging-destined PO', async () => {
    const { queryByTestId } = await renderPage();
    expect(queryByTestId('set-destination')).toBeNull();
  });

  it('still shows the card — and hides Receive — for a destination with no warehouse', async () => {
    poGet.mockResolvedValue(poRow(ORPHAN.id));
    const { queryByTestId } = await renderPage();
    expect(queryByTestId('set-destination')).not.toBeNull();
    expect(queryByTestId('receive-dialog')).toBeNull();
  });

  it('still shows the card when the PO has no destination at all', async () => {
    poGet.mockResolvedValue(poRow(null));
    const { queryByTestId } = await renderPage();
    expect(queryByTestId('set-destination')).not.toBeNull();
    expect(queryByTestId('receive-dialog')).toBeNull();
  });
});
