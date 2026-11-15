// @vitest-environment happy-dom
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeSupabaseStub, type QueryResult } from '@/test/supabase-mock';

/**
 * The two settings panels under the suggestions table are seeded from stored
 * settings, and each Save sends its whole setting: the planning panel all
 * three numbers, the automatic reordering panel on or off, the mode and the
 * cap. A panel seeded from defaults because its read failed would write those
 * defaults over the stored values. So a failed read shows the settings
 * failed-read state with Try again in that panel's place and no Save. No row
 * still means never configured, and the panel shows the defaults. The
 * suggestions table does not depend on either panel and stays.
 *
 * The readers here are the real ones (PlanningService.readParamsWithStatus and
 * readAutoReorderSettings) over stubbed queries.
 */

const READ_ERROR = { message: 'connection reset', code: '08006' };

const reads = vi.hoisted(() => ({
  planning: { data: null, error: null } as { data: unknown; error: unknown },
  autoReorder: { data: null, error: null } as { data: unknown; error: unknown },
}));

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock('next/link', async () => {
  const React = await import('react');
  return {
    default: ({ href, children }: { href: string; children: React.ReactNode }) =>
      React.createElement('a', { href }, children),
  };
});
vi.mock('@/lib/modules/module-gate', () => ({
  checkModuleAccess: vi.fn(async () => ({ enabled: true, canManage: true })),
}));
vi.mock('@/lib/auth/session', () => ({
  requireOrgContext: vi.fn(async () => ({ organizationId: 'org-1', userId: 'u-1', role: 'owner' })),
}));
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(
    async () =>
      makeSupabaseStub({
        'organizations.select': { data: { plan: 'pro' }, error: null },
        'organization_modules.select': reads.autoReorder as QueryResult,
      }).client,
  ),
}));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => {}) }));
vi.mock('@/server/actions/purchase-orders', () => ({
  createDraftPosFromReorderForecastAction: vi.fn(),
}));
vi.mock('@/server/actions/planning-settings', () => ({ setPlanningParamsAction: vi.fn() }));
vi.mock('@/server/actions/auto-reorder-settings', () => ({
  setAutoReorderSettingsAction: vi.fn(),
}));
vi.mock('@/server/services/planning', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/services/planning')>();
  const { makeServiceContext, makeSupabaseStub: stub } = await import('@/test/supabase-mock');
  const { DEFAULT_MODULE_IDS } = await import('@stockpilot/core');
  /** The real settings read over a stubbed query; the plan itself is fixed. */
  class PlanningServiceForTest extends actual.PlanningService {
    static override async forCurrentUser() {
      const db = stub({ 'organization_modules.select': reads.planning as QueryResult });
      return new PlanningServiceForTest(
        makeServiceContext(db.client, {
          organizationId: 'org-1',
          enabledModules: new Set([...DEFAULT_MODULE_IDS, 'planning']),
        }),
      );
    }
    override async getReorderSuggestions() {
      return {
        suggestions: [
          {
            itemId: 'a',
            sku: 'SKU-A',
            name: 'Item a',
            quantityOnHand: 10,
            currentReorderPoint: 2,
            suggestedReorderPoint: 2,
            suggestedReorderQty: 1,
            unitsPerDay: 0.1,
            daysOfStockRemaining: 100,
            supplierId: null,
            supplierName: null,
            unitCost: 1,
          },
        ],
        truncated: false,
      };
    }
    override async itemIdsOnOpenPurchaseOrders() {
      return new Set<string>();
    }
  }
  return { ...actual, PlanningService: PlanningServiceForTest };
});

import { reportError } from '@/lib/error-reporter';

import PlanningPage from './page';

const PLANNING_FAILED = "We couldn't load the planning settings";
const AUTO_REORDER_FAILED = "We couldn't load the automatic reordering settings";

beforeEach(() => {
  vi.clearAllMocks();
  reads.planning = { data: null, error: null };
  reads.autoReorder = { data: null, error: null };
});

describe('Planning page settings panels when their reads fail', () => {
  it('shows the failed state in place of both panels, with Try again and no Save', async () => {
    reads.planning = { data: null, error: READ_ERROR };
    reads.autoReorder = { data: null, error: READ_ERROR };
    render(await PlanningPage());

    expect(screen.getByText(PLANNING_FAILED)).toBeInTheDocument();
    expect(screen.getByText(AUTO_REORDER_FAILED)).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Try again' })).toHaveLength(2);
    expect(screen.queryByRole('button', { name: /save/i })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Lead time (days)')).not.toBeInTheDocument();
    expect(screen.queryByText('Enable automatic reordering')).not.toBeInTheDocument();

    // The rest of the page still works.
    expect(screen.getByRole('heading', { name: 'Reorder suggestions' })).toBeInTheDocument();
    expect(screen.getByRole('row', { name: /Item a/ })).toBeInTheDocument();

    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tag: 'planning.settings.read_failed',
        organizationId: 'org-1',
        extra: { code: '08006' },
      }),
    );
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tag: 'planning.auto_reorder.read_failed',
        organizationId: 'org-1',
        extra: { code: '08006' },
      }),
    );
  });

  it('replaces only the planning panel when only its read fails', async () => {
    reads.planning = { data: null, error: READ_ERROR };
    reads.autoReorder = {
      data: { settings: { autoReorder: { enabled: true, mode: 'send', maxAutoSendCents: 50000 } } },
      error: null,
    };
    render(await PlanningPage());

    expect(screen.getByText(PLANNING_FAILED)).toBeInTheDocument();
    expect(screen.queryByLabelText('Lead time (days)')).not.toBeInTheDocument();
    expect(screen.queryByText(AUTO_REORDER_FAILED)).not.toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Enable automatic reordering' })).toBeChecked();
    expect(screen.getAllByRole('button', { name: 'Save settings' })).toHaveLength(1);
  });

  it('replaces only the automatic reordering panel when only its read fails', async () => {
    reads.planning = {
      data: { settings: { leadTimeDays: 21, safetyMultiplier: 2, velocityWindowDays: 60 } },
      error: null,
    };
    reads.autoReorder = { data: null, error: READ_ERROR };
    render(await PlanningPage());

    expect(screen.getByText(AUTO_REORDER_FAILED)).toBeInTheDocument();
    expect(screen.queryByText('Enable automatic reordering')).not.toBeInTheDocument();
    expect(screen.queryByText(PLANNING_FAILED)).not.toBeInTheDocument();
    expect(screen.getByLabelText('Lead time (days)')).toHaveValue(21);
    expect(screen.getAllByRole('button', { name: 'Save settings' })).toHaveLength(1);
  });
});

describe('Planning page settings panels when their reads work', () => {
  it('shows the defaults when nothing is stored (never configured)', async () => {
    render(await PlanningPage());

    expect(screen.queryByText(PLANNING_FAILED)).not.toBeInTheDocument();
    expect(screen.queryByText(AUTO_REORDER_FAILED)).not.toBeInTheDocument();
    expect(screen.getByLabelText('Lead time (days)')).toHaveValue(14);
    expect(screen.getByLabelText('Safety multiplier')).toHaveValue(1.5);
    expect(screen.getByLabelText('Velocity window (days)')).toHaveValue(90);
    expect(screen.getByRole('checkbox', { name: 'Enable automatic reordering' })).not.toBeChecked();
    expect(screen.getAllByRole('button', { name: 'Save settings' })).toHaveLength(2);
    expect(reportError).not.toHaveBeenCalled();
  });

  it('shows the stored values when a row is stored', async () => {
    reads.planning = {
      data: { settings: { leadTimeDays: 21, safetyMultiplier: 2, velocityWindowDays: 60 } },
      error: null,
    };
    reads.autoReorder = {
      data: { settings: { autoReorder: { enabled: true, mode: 'send', maxAutoSendCents: 50000 } } },
      error: null,
    };
    render(await PlanningPage());

    expect(screen.getByLabelText('Lead time (days)')).toHaveValue(21);
    expect(screen.getByLabelText('Safety multiplier')).toHaveValue(2);
    expect(screen.getByLabelText('Velocity window (days)')).toHaveValue(60);
    expect(screen.getByRole('checkbox', { name: 'Enable automatic reordering' })).toBeChecked();
    expect(screen.getByLabelText('When stock is low')).toHaveValue('send');
    expect(screen.getByLabelText('Auto-order cap ($, optional)')).toHaveValue(500);
    expect(screen.getAllByRole('button', { name: 'Save settings' })).toHaveLength(2);
    expect(reportError).not.toHaveBeenCalled();
  });
});
