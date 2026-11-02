import { render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModuleId } from '@stockpilot/core';
import { DEFAULT_MODULE_IDS } from '@stockpilot/core';

/**
 * A purchase order's page with Receiving off, and with a receipts read that
 * fails (B67).
 *
 * Receiving is an optional module that depends on Purchase orders, and an
 * owner or admin can switch it off alone in Settings, Modules. The page read
 * the PO's receipts with `listForPurchaseOrder`, which refuses with
 * `module_disabled` when Receiving is off, inside the one Promise.all that
 * also reads the PO. So every purchase order's page was "Something broke
 * loading this page", and a failed receipts read with Receiving on was the
 * same. The page now reads `historyForPurchaseOrder`: with Receiving off it
 * leaves the receipts out, as the PO's PDF already did, and offers no
 * receiving; a failed read says so in Receipts and the rest of the page works.
 *
 * The REAL ReceivingService and the REAL module gate (`@/server/services/
 * context` is not mocked here, unlike the other PO page tests): mocking either
 * would hide the refusal this file is about.
 */

const h = vi.hoisted(() => ({
  org: '0a000000-0000-4000-8000-0000000000a1',
  ctx: null as unknown,
  poGet: vi.fn(),
  locationsList: vi.fn(),
  inventoryByIds: vi.fn(async () => [] as unknown[]),
  reportError: vi.fn(async () => {}),
  role: 'owner',
}));

vi.mock('@/lib/auth/session', () => ({
  requireOrgContext: vi.fn(async () => ({
    organizationId: h.org,
    userId: 'u1',
    role: h.role,
    permissions: null,
  })),
}));
vi.mock('next/navigation', () => ({
  notFound: vi.fn(() => {
    throw new Error('notFound');
  }),
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('next/link', async () => {
  const React = await import('react');
  return {
    default: ({ href, children }: { href: string; children: React.ReactNode }) =>
      React.createElement('a', { href }, children),
  };
});
vi.mock('@/lib/error-reporter', () => ({ reportError: h.reportError }));
vi.mock('@/server/services/audit', () => ({
  audit: vi.fn(async () => {}),
  auditMany: vi.fn(async () => ({})),
}));
vi.mock('@/server/services/integration-events', () => ({
  dispatchEvent: vi.fn(async () => undefined),
}));
vi.mock('@/server/services/lib/inventory-list-cache', () => ({
  invalidateInventoryListAfterWrite: vi.fn(),
}));
// ReceiptHistory is the real one (so "No receipts yet" would show if a failed
// read were shown as an empty list); its Reverse action is not under test.
vi.mock('@/server/actions/receiving', () => ({ reverseReceiptAction: vi.fn() }));

// The other client components: markers. What matters is which ones render.
vi.mock('@/components/po/po-receive-dialog', () => ({
  PoReceiveDialog: () => <button type="button">Receive items</button>,
}));
vi.mock('@/components/po/po-set-destination', () => ({
  PoSetDestination: () => <div data-testid="set-destination" />,
}));
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
  PurchaseOrdersService: { forCurrentUser: vi.fn(async () => ({ get: h.poGet })) },
}));
vi.mock('@/server/services/suppliers', () => ({
  SuppliersService: {
    forCurrentUser: vi.fn(async () => ({ listForLookups: vi.fn(async () => []) })),
  },
}));
vi.mock('@/server/services/locations', () => ({
  LocationsService: { forCurrentUser: vi.fn(async () => ({ list: h.locationsList })) },
}));
vi.mock('@/server/services/warehouses', () => ({
  WarehousesService: {
    forCurrentUser: vi.fn(async () => ({
      listNames: vi.fn(async () => [{ id: 'wh-1', name: 'Sample DC' }]),
    })),
  },
}));
vi.mock('@/server/services/po-attachments', () => ({
  PoAttachmentsService: { forCurrentUser: vi.fn(async () => ({ list: vi.fn(async () => []) })) },
}));
vi.mock('@/server/services/inventory', () => ({
  InventoryService: { forCurrentUser: vi.fn(async () => ({ byIds: h.inventoryByIds })) },
}));
vi.mock('@/server/services/size-run-display', () => ({
  loadSizeRunGroups: vi.fn(async () => ({})),
}));
// The real service, built on the context each test sets.
vi.mock('@/server/services/receiving', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/services/receiving')>();
  return {
    ...actual,
    ReceivingService: {
      forCurrentUser: vi.fn(
        async () =>
          new actual.ReceivingService(
            h.ctx as ConstructorParameters<typeof actual.ReceivingService>[0],
          ),
      ),
    },
  };
});

import { effectiveModules } from '@/lib/modules/effective-modules';
import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

import PoDetailPage from './page';

const ORG = h.org;
const PO_ID = '0a000000-0000-4000-8000-0000000000b1';
const RECEIPT_ID = '0a000000-0000-4000-8000-0000000000c1';
const FAILED_COPY = 'Receipts could not be loaded. Reload the page to try again.';

const RECEIVABLE = { id: 'loc-1', name: 'Sample DC Dock', warehouse_id: 'wh-1', kind: null };
const NO_WAREHOUSE = { id: 'loc-2', name: 'Unlinked room', warehouse_id: null, kind: null };

const RECEIPT_ROWS = {
  'receipts.select': {
    data: [
      {
        id: RECEIPT_ID,
        receipt_number: 'RCV-0001',
        status: 'posted',
        received_at: '2026-10-20T16:00:00.000Z',
        received_by: null,
        deleted_users: null,
      },
    ],
    error: null,
  },
  'receipt_lines.select': {
    data: [
      {
        id: 'rl-1',
        receipt_id: RECEIPT_ID,
        item_id: 'item-1',
        qty_accepted_base: 4,
        qty_rejected_base: 0,
      },
    ],
    error: null,
  },
};

function poRow(destinationLocationId: string) {
  return {
    po: {
      po_number: 'PO-0000-0001',
      status: 'ordered',
      supplier_id: null,
      destination_location_id: destinationLocationId,
      expected_at: null,
      subtotal: 0,
      total: 0,
      notes: null,
      created_at: '2026-10-01T16:00:00.000Z',
    },
    lines: [
      {
        id: 'pol-1',
        item_id: 'item-1',
        quantity_ordered: 10,
        quantity_received: 4,
        unit_cost: 1,
        line_total: 10,
        imageUrl: null,
        previewUrl: null,
      },
    ],
  };
}

/** The modules a member's context carries: every default, Purchase orders on,
 *  and Receiving as asked. */
function modules(receivingOn: boolean): Set<ModuleId> {
  const set = new Set<ModuleId>(DEFAULT_MODULE_IDS);
  set.add('purchase_orders');
  if (receivingOn) set.add('receiving');
  else set.delete('receiving');
  return set;
}

function signIn(
  enabledModules: Set<ModuleId>,
  results: Parameters<typeof makeSupabaseStub>[0] = RECEIPT_ROWS,
) {
  const stub = makeSupabaseStub(results);
  h.ctx = makeServiceContext(stub.client, { organizationId: ORG, role: 'owner', enabledModules });
  return stub;
}

async function renderPage() {
  return render(await PoDetailPage({ params: Promise.resolve({ id: PO_ID }) }));
}

function receiptsSection(): HTMLElement | null {
  return screen.queryByRole('heading', { name: 'Receipts' })?.closest('section') ?? null;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.role = 'owner';
  h.poGet.mockResolvedValue(poRow(RECEIVABLE.id));
  h.locationsList.mockResolvedValue([RECEIVABLE, NO_WAREHOUSE]);
  h.inventoryByIds.mockResolvedValue([{ id: 'item-1', name: 'Sample notebook', sku: 'NB-1' }]);
});

describe('PO page with Purchase orders on and Receiving off', () => {
  it('opens, with no Receipts section, no Receive items and no receiving hint, and reads no receipts', async () => {
    const stub = signIn(modules(false));
    await renderPage();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('PO-0000-0001');
    // The line items and what was received against what was ordered stay.
    expect(screen.getByRole('heading', { name: 'Line items' })).toBeInTheDocument();
    expect(screen.getByText('Sample notebook')).toBeInTheDocument();
    expect(receiptsSection()).toBeNull();
    expect(screen.queryByRole('button', { name: 'Receive items' })).toBeNull();
    expect(screen.queryByText(/Use “Receive items”/)).toBeNull();
    expect(stub.fromCalls).not.toContain('receipts');
    expect(h.reportError).not.toHaveBeenCalled();
  });

  it('a member without Adjust on-hand is not told why they cannot receive', async () => {
    h.role = 'viewer';
    signIn(modules(false));
    await renderPage();
    expect(screen.queryByText(/Receiving stock needs the Adjust on-hand permission/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Receive items' })).toBeNull();
  });

  it('a PO whose destination has no warehouse shows no card asking for one to receive into', async () => {
    h.poGet.mockResolvedValue(poRow(NO_WAREHOUSE.id));
    signIn(modules(false));
    await renderPage();
    expect(screen.queryByTestId('set-destination')).toBeNull();
    expect(screen.getByText('Unlinked room')).toBeInTheDocument();
  });
});

describe('PO page with Receiving on', () => {
  it('a failed receipts read: the page opens, Receipts says so, never "No receipts yet", and it is reported', async () => {
    signIn(modules(true), {
      ...RECEIPT_ROWS,
      'receipts.select': {
        data: null,
        error: { message: 'canceling statement due to statement timeout' },
      },
    });
    await renderPage();
    const receipts = receiptsSection();
    expect(receipts).not.toBeNull();
    expect(within(receipts!).getByText(FAILED_COPY)).toBeInTheDocument();
    expect(screen.queryByText(/No receipts yet/)).toBeNull();
    expect(screen.queryByText(/statement timeout/)).toBeNull();
    // Receiving itself still works.
    expect(screen.getByRole('button', { name: 'Receive items' })).toBeInTheDocument();
    expect(h.reportError).toHaveBeenCalledTimes(1);
    expect(h.reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tag: 'receiving.po_history',
        level: 'warning',
        organizationId: ORG,
      }),
    );
  });

  it('the receipts show in Receipts, with Receive items, as before', async () => {
    signIn(modules(true));
    await renderPage();
    const receipts = receiptsSection();
    expect(receipts).not.toBeNull();
    expect(within(receipts!).getByText('RCV-0001')).toBeInTheDocument();
    expect(screen.queryByText(FAILED_COPY)).toBeNull();
    expect(screen.getByRole('button', { name: 'Receive items' })).toBeInTheDocument();
    expect(screen.getByText(/Use “Receive items”/)).toBeInTheDocument();
  });

  it('no receipts yet: the empty Receipts section as before', async () => {
    signIn(modules(true), {
      'receipts.select': { data: [], error: null },
    });
    await renderPage();
    expect(within(receiptsSection()!).getByText(/No receipts yet/)).toBeInTheDocument();
  });

  it('a destination with no warehouse still shows the card asking for one', async () => {
    h.poGet.mockResolvedValue(poRow(NO_WAREHOUSE.id));
    signIn(modules(true));
    await renderPage();
    expect(screen.getByTestId('set-destination')).toBeInTheDocument();
  });
});

describe('PO page in a comped organization whose Receiving row is off', () => {
  it('renders as with Receiving on: the comp turns every module on', async () => {
    signIn(effectiveModules([{ module_id: 'purchase_orders' }], true));
    await renderPage();
    expect(within(receiptsSection()!).getByText('RCV-0001')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Receive items' })).toBeInTheDocument();
  });
});
