import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RECEIVING_CHECKLIST_COPY as C } from '@stockpilot/core';

/**
 * F4-1: where the receiving checklist is reached on the web. The Purchase
 * orders header links to it for managers where Receiving is on; Procedures
 * shows a card to anyone who can read purchase orders there. Neither appears
 * where Receiving is off.
 */

const session = vi.hoisted(() => ({
  value: {
    organizationId: 'org-1',
    userId: 'u1',
    role: 'manager',
    permissions: undefined as Set<string> | undefined,
  },
}));
const modules = vi.hoisted(() => ({
  value: new Set<string>(['purchase_orders', 'procedures', 'receiving']),
}));

vi.mock('@/lib/auth/session', () => ({ requireOrgContext: vi.fn(async () => session.value) }));
vi.mock('@/lib/modules/module-gate', () => ({
  checkModuleAccess: vi.fn(async (id: string) => ({
    enabled: modules.value.has(id),
    canManage: false,
  })),
}));
vi.mock('next/link', async () => {
  const React = await import('react');
  return {
    default: ({
      href,
      children,
      className,
    }: {
      href: string;
      children: React.ReactNode;
      className?: string;
    }) => React.createElement('a', { href, className }, children),
  };
});
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn(async () => ({})) }));
vi.mock('@/lib/warehouse-filter', () => ({ getActiveWarehouseFilter: vi.fn(async () => null) }));
vi.mock('@/server/services/purchase-orders', () => ({
  PurchaseOrdersService: {
    forCurrentUser: vi.fn(async () => ({
      listStats: vi.fn(async () => ({
        totalCount: 0,
        totalValue: 0,
        openCount: 0,
        committedValue: 0,
        openSupplierCount: 0,
        inboundCount: 0,
        nextEtaPoNumber: null,
        nextEtaExpectedAt: null,
        avgLeadDays: null,
      })),
      listPage: vi.fn(async () => ({ rows: [], total: 0 })),
    })),
  },
}));
vi.mock('@/server/services/suppliers', () => ({
  SuppliersService: {
    forCurrentUser: vi.fn(async () => ({ listForLookups: vi.fn(async () => []) })),
  },
}));
vi.mock('@/components/settings/po-approval-panel', () => ({ PoApprovalPanel: () => null }));
vi.mock('@/components/po/po-instant-table', () => ({ PoInstantTable: () => null }));
vi.mock('@/components/po/po-search', () => ({ PoSearch: () => null }));
vi.mock('@/server/services/procedures', () => ({
  ProceduresService: {
    forCurrentUser: vi.fn(async () => ({ list: vi.fn(async () => ({ rows: [], total: 0 })) })),
  },
}));
vi.mock('@/server/services/procedure-categories', () => ({
  ProcedureCategoriesService: {
    forCurrentUser: vi.fn(async () => ({ list: vi.fn(async () => []) })),
  },
}));
vi.mock('@/server/services/warehouses', () => ({
  WarehousesService: { forCurrentUser: vi.fn(async () => ({ listNames: vi.fn(async () => []) })) },
}));
vi.mock('@/components/procedures/procedure-card', () => ({ ProcedureCard: () => null }));
vi.mock('@/components/procedures/restore-button', () => ({ RestoreButton: () => null }));
vi.mock('@/components/ui/archive-view-toggle', () => ({ ArchiveViewToggle: () => null }));

import ProceduresListPage from './procedures/page';
import PurchaseOrdersPage from './purchase-orders/page';

const HREF = '/dashboard/purchase-orders/receiving-checklist';
const links = () => screen.queryAllByRole('link').filter((a) => a.getAttribute('href') === HREF);

beforeEach(() => {
  vi.clearAllMocks();
  modules.value = new Set(['purchase_orders', 'procedures', 'receiving']);
  session.value = {
    organizationId: 'org-1',
    userId: 'u1',
    role: 'manager',
    permissions: undefined,
  };
});

describe('the Purchase orders header', () => {
  const renderList = async () =>
    render(await PurchaseOrdersPage({ searchParams: Promise.resolve({}) }));

  it('links managers to the receiving checklist', async () => {
    await renderList();
    expect(links()).toHaveLength(1);
    expect(links()[0]!.textContent).toContain(C.editorTitle);
  });

  it('not for staff', async () => {
    session.value = { ...session.value, role: 'staff' };
    await renderList();
    expect(links()).toHaveLength(0);
  });

  it('not where Receiving is off', async () => {
    modules.value = new Set(['purchase_orders', 'procedures']);
    await renderList();
    expect(links()).toHaveLength(0);
  });
});

describe('the Procedures card', () => {
  const renderProcedures = async (view?: string) =>
    render(await ProceduresListPage({ searchParams: Promise.resolve(view ? { view } : {}) }));

  it('shows anyone who can read purchase orders the receiving checklist', async () => {
    session.value = { ...session.value, role: 'viewer' };
    await renderProcedures();
    expect(links()).toHaveLength(1);
    expect(screen.getByText(C.procedureCardBody)).toBeTruthy();
  });

  it('not without purchase_orders:read, not where Receiving is off, not in the archived view', async () => {
    session.value = { ...session.value, role: 'viewer', permissions: new Set(['items:read']) };
    const { unmount } = await renderProcedures();
    expect(links()).toHaveLength(0);
    unmount();
    session.value = { ...session.value, permissions: undefined };
    modules.value = new Set(['purchase_orders', 'procedures']);
    const second = await renderProcedures();
    expect(links()).toHaveLength(0);
    second.unmount();
    modules.value = new Set(['purchase_orders', 'procedures', 'receiving']);
    await renderProcedures('archived');
    expect(links()).toHaveLength(0);
  });
});
