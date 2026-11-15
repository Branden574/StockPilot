import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeSupabaseStub, type QueryResult } from '@/test/supabase-mock';

/**
 * The approval threshold panel under the list is seeded from the purchase
 * orders settings, and its Save writes the amount shown, where blank or 0
 * turns approval off. Seeded with 0 because the read failed, a Save would turn
 * approval off. So a failed read shows the settings failed-read state with
 * Try again in the panel's place and no Save, and the list stays. No row still
 * means never configured: the panel shows approval off. The panel here is the
 * real one.
 */

const READ_ERROR = { message: 'connection reset', code: '08006' };

const read = vi.hoisted(() => ({
  current: { data: null, error: null } as { data: unknown; error: unknown },
}));

vi.mock('@/lib/modules/module-gate', () => ({
  checkModuleAccess: vi.fn(async () => ({ enabled: true, canManage: true })),
}));
vi.mock('@/lib/auth/session', () => ({
  requireOrgContext: vi.fn(async () => ({
    organizationId: 'org-1',
    userId: 'u1',
    role: 'owner',
    permissions: null,
  })),
}));
vi.mock('@/lib/nav-labels', () => ({
  effectiveNavLabel: vi.fn(async (_href: string, fallback: string) => fallback),
}));
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(
    async () =>
      makeSupabaseStub({ 'organization_modules.select': read.current as QueryResult }).client,
  ),
}));
vi.mock('@/lib/warehouse-filter', () => ({ getActiveWarehouseFilter: vi.fn(async () => null) }));
vi.mock('@/lib/dashboard/request-cache', () => ({
  getOrgRowForRequest: vi.fn(async () => ({ timezone: 'America/Los_Angeles' })),
}));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => {}) }));
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
      listOverdue: vi.fn(async () => ({ rows: [], asOf: '2026-10-01' })),
    })),
  },
}));
vi.mock('@/server/services/suppliers', () => ({
  SuppliersService: {
    forCurrentUser: vi.fn(async () => ({ listForLookups: vi.fn(async () => []) })),
  },
}));
vi.mock('@/server/actions/po-approval-settings', () => ({
  setPoApprovalSettingsAction: vi.fn(),
}));
vi.mock('next/link', async () => {
  const React = await import('react');
  return {
    default: ({ href, children }: { href: string; children: React.ReactNode }) =>
      React.createElement('a', { href }, children),
  };
});
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock('@/components/po/po-search', () => ({ PoSearch: () => <div data-testid="po-search" /> }));

import { reportError } from '@/lib/error-reporter';

import PurchaseOrdersPage from './page';

const FAILED = "We couldn't load the approval threshold";

async function renderList() {
  return render(await PurchaseOrdersPage({ searchParams: Promise.resolve({}) }));
}

beforeEach(() => {
  vi.clearAllMocks();
  read.current = { data: null, error: null };
});

describe('the purchase orders approval threshold panel', () => {
  it('shows the failed state with Try again and no Save when the read fails', async () => {
    read.current = { data: null, error: READ_ERROR };
    await renderList();

    expect(screen.getByText(FAILED)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Threshold ($)')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /save/i })).not.toBeInTheDocument();
    // The list itself still shows.
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Purchase orders');
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tag: 'purchase_orders.approval_threshold.read_failed',
        organizationId: 'org-1',
        extra: { code: '08006' },
      }),
    );
  });

  it('shows approval off when nothing is stored (never configured)', async () => {
    await renderList();

    expect(screen.queryByText(FAILED)).not.toBeInTheDocument();
    expect(screen.getByLabelText('Threshold ($)')).toHaveValue(null);
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
    expect(reportError).not.toHaveBeenCalled();
  });

  it('shows the stored amount when one is stored', async () => {
    read.current = { data: { settings: { approvalThresholdAmount: 250 } }, error: null };
    await renderList();

    expect(screen.queryByText(FAILED)).not.toBeInTheDocument();
    expect(screen.getByLabelText('Threshold ($)')).toHaveValue(250);
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
    expect(reportError).not.toHaveBeenCalled();
  });
});
