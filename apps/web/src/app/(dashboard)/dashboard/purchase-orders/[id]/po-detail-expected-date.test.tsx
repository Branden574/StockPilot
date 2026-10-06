import { render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The Summary card's Expected row prints a purchase order's expected date: the
 * DAY the buyer picked, stored as that day's midnight UTC (the PO form and both
 * PO imports). It printed `new Date(expected_at).toLocaleDateString()`, which is
 * the day in whatever zone the server runs in. Vercel runs in UTC, so
 * production showed the picked day, but in any other zone (a server west of
 * UTC, `next dev` on a Pacific laptop) it was the day before. It now reads the
 * day in UTC through @stockpilot/core's formatCalendarDate, the rule the phone
 * and the PO list use, whatever the server's zone.
 */

const poGet = vi.fn();

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
vi.mock('@/components/po/po-receive-dialog', () => ({ PoReceiveDialog: () => null }));
vi.mock('@/components/po/po-set-destination', () => ({ PoSetDestination: () => null }));
vi.mock('@/components/po/make-recurring-button', () => ({ MakeRecurringButton: () => null }));
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
  SuppliersService: {
    forCurrentUser: vi.fn(async () => ({
      listForLookups: vi.fn(async () => [{ id: 'sup-1', name: 'Acme' }]),
    })),
  },
}));
vi.mock('@/server/services/locations', () => ({
  LocationsService: { forCurrentUser: vi.fn(async () => ({ list: vi.fn(async () => []) })) },
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

function poWithExpected(expectedAt: string | null) {
  return {
    po: {
      po_number: 'PO-1785251481118',
      status: 'ordered',
      supplier_id: 'sup-1',
      destination_location_id: null,
      expected_at: expectedAt,
      subtotal: 0,
      total: 0,
      notes: null,
      created_at: '2026-10-01T16:00:00.000Z',
    },
    lines: [],
  };
}

async function expectedRowText(): Promise<string | null> {
  const { getByText } = render(await PoDetailPage({ params: Promise.resolve({ id: 'po-1' }) }));
  return getByText('Expected').nextElementSibling?.textContent ?? null;
}

describe("the PO page's Expected row is the day that was set, whatever the server's zone", () => {
  const previousZone = process.env.TZ;
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    if (previousZone === undefined) delete process.env.TZ;
    else process.env.TZ = previousZone;
  });

  it('a server in Los Angeles prints Oct 10 for a purchase order expected Oct 10, not Oct 9', async () => {
    process.env.TZ = 'America/Los_Angeles';
    poGet.mockResolvedValue(poWithExpected('2026-10-10T00:00:00.000Z'));
    expect(await expectedRowText()).toBe('10/10/2026');
  });

  it('a server in UTC (Vercel) prints the same day, in the same words as before', async () => {
    process.env.TZ = 'UTC';
    poGet.mockResolvedValue(poWithExpected('2026-10-10T00:00:00.000Z'));
    expect(await expectedRowText()).toBe('10/10/2026');
  });

  it('a purchase order with no expected date keeps its dash', async () => {
    process.env.TZ = 'America/Los_Angeles';
    poGet.mockResolvedValue(poWithExpected(null));
    expect(await expectedRowText()).toBe('—');
  });
});
