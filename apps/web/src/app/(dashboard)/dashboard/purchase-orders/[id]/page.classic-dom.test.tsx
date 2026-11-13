import { render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { classicDom, classicStructure, glassOnlyCount } from '@/test/classic-dom';

/**
 * CLASSIC IS SACRED (Liquid Glass stage 4, operations lane). The purchase
 * order page's own Classic DOM (Purchase-Order.dc.html in glass), normalised
 * as the classic proof normalises it (src/test/classic-dom.ts), pinned in
 * __classic__/ from the code BEFORE the glass composition and its glass-only
 * receiving summary were added. The page's child components are stood in for
 * as po-detail-layout.test.tsx does, so this pins exactly the markup the page
 * file itself writes. With the inert hooks stripped and every glass-only
 * element dropped, the page must render the pinned DOM under the `off`
 * rollout (with no glass-only element at all) and under `default`, and under
 * `default` no Classic element may change its place among its siblings
 * (classicStructure: a hidden glass-only sibling still counts for :last-child
 * and the like).
 */

const poGet = vi.fn();
const inventoryByIds = vi.fn();
const locationsList = vi.fn();
const listForPurchaseOrder = vi.fn(async () => ({ receipts: [], lines: [] }));
const attachmentsList = vi.fn(async () => []);
let role = 'owner';

// The page's own module is on: the page checks it before it reads (B66).
vi.mock('@/lib/modules/module-gate', () => ({
  checkModuleAccess: vi.fn(async () => ({ enabled: true, canManage: true })),
}));
vi.mock('@/lib/auth/session', () => ({
  requireOrgContext: vi.fn(async () => ({
    organizationId: 'org-1',
    userId: 'u1',
    role,
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

const NOW = new Date('2026-10-12T18:00:00.000Z');

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
  vi.clearAllMocks();
  role = 'owner';
  inventoryByIds.mockResolvedValue([
    { id: 'item-1', name: 'Polo, Navy', sku: 'POLO-M', tracking_type: 'none' },
  ]);
  locationsList.mockResolvedValue([
    { id: 'loc-1', name: 'North DC Building', warehouse_id: 'wh-1', kind: null },
  ]);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

async function classicOf(rollout: 'off' | 'default') {
  vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', rollout);
  const view = render(await PoDetailPage({ params: Promise.resolve({ id: PO_ID }) }));
  const out = {
    dom: classicDom(view.container),
    structure: classicStructure(view.container),
    glassOnly: glassOnlyCount(view.container),
  };
  view.unmount();
  return out;
}

function received() {
  const r = po('received');
  for (const l of r.lines) l.quantity_received = l.quantity_ordered;
  return r;
}

const SCENARIOS: Array<[string, () => void]> = [
  ['partial-owner', () => poGet.mockResolvedValue(po())],
  [
    'partial-staff',
    () => {
      role = 'staff';
      poGet.mockResolvedValue(po());
    },
  ],
  ['ordered', () => poGet.mockResolvedValue(po('ordered'))],
  ['received', () => poGet.mockResolvedValue(received())],
  ['cancelled', () => poGet.mockResolvedValue(po('cancelled'))],
  [
    'no-destination',
    () => {
      const r = po('ordered');
      (r.po as Record<string, unknown>).destination_location_id = null;
      poGet.mockResolvedValue(r);
    },
  ],
];

describe('Purchase order page: the Classic DOM is the pinned one', () => {
  for (const [name, setup] of SCENARIOS) {
    it(`${name}: off renders no glass-only part, off and default normalise to the pinned DOM, and default moves no Classic element among its siblings`, async () => {
      setup();
      const off = await classicOf('off');
      setup();
      const glassBuild = await classicOf('default');
      expect(off.glassOnly).toBe(0);
      expect(glassBuild.dom).toBe(off.dom);
      expect(glassBuild.structure).toBe(off.structure);
      await expect(off.dom).toMatchFileSnapshot(`./__classic__/purchase-order.${name}.txt`);
    });
  }
});
