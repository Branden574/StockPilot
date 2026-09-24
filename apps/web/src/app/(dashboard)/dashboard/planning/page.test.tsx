// @vitest-environment happy-dom
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeSupabaseStub } from '@/test/supabase-mock';

/**
 * The Planning table ranks at most PLANNING_MAX_ITEMS items. Past that the
 * plan is partial, and the page must say so: an urgent item can be missing
 * and the below-par count covers only the items shown. The draft button then
 * stays usable even at a count of 0, because the action it runs checks every
 * item.
 */

const { getReorderSuggestions } = vi.hoisted(() => ({ getReorderSuggestions: vi.fn() }));

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock('next/link', async () => {
  const React = await import('react');
  return {
    default: ({ href, children }: { href: string; children: React.ReactNode }) =>
      React.createElement('a', { href }, children),
  };
});
vi.mock('@/lib/modules/module-gate', () => ({
  checkModuleAccess: vi.fn(async () => ({ enabled: true, canManage: false })),
}));
vi.mock('@/lib/auth/session', () => ({
  requireOrgContext: vi.fn(async () => ({ organizationId: 'org-1', userId: 'u-1', role: 'manager' })),
}));
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => makeSupabaseStub({ 'organizations.select': { data: null, error: null } }).client),
}));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => {}) }));
vi.mock('@/server/services/auto-reorder', () => ({ readAutoReorderSettings: vi.fn(async () => ({})) }));
vi.mock('@/server/actions/purchase-orders', () => ({ createDraftPosFromReorderForecastAction: vi.fn() }));
vi.mock('@/components/settings/auto-reorder-panel', () => ({ AutoReorderPanel: () => null }));
vi.mock('@/components/settings/planning-params-panel', () => ({ PlanningParamsPanel: () => null }));
vi.mock('@/server/services/planning', () => ({
  PLANNING_MAX_ITEMS: 5_000,
  PlanningService: {
    forCurrentUser: vi.fn(async () => ({
      getReorderSuggestions,
      readParams: vi.fn(async () => ({ leadTimeDays: 14, safetyMultiplier: 1.5, velocityWindowDays: 90 })),
      itemIdsOnOpenPurchaseOrders: vi.fn(async () => new Set<string>()),
    })),
  },
}));

import PlanningPage from './page';

/** A ranked item that is not below par (on hand above its reorder point). */
const healthy = (id: string) => ({
  itemId: id,
  sku: id,
  name: `Item ${id}`,
  quantityOnHand: 10,
  currentReorderPoint: 2,
  suggestedReorderPoint: 2,
  suggestedReorderQty: 1,
  unitsPerDay: 0.1,
  daysOfStockRemaining: 100,
  supplierId: null,
  supplierName: null,
  unitCost: 1,
});

beforeEach(() => vi.clearAllMocks());

describe('Planning page coverage', () => {
  it('says the plan is partial when the catalog is past the cap, and keeps the draft button usable', async () => {
    getReorderSuggestions.mockResolvedValue({ suggestions: [healthy('a')], truncated: true });
    render(await PlanningPage());

    const note = screen.getByTestId('planning-coverage-note');
    expect(note).toHaveTextContent('more than 5,000 items to plan');
    expect(note).toHaveTextContent('an urgent item can be missing here');
    expect(note).toHaveTextContent('“Draft PO from suggestions” still checks every item.');
    // Nothing below par among the ranked items, but the action reads them all.
    expect(screen.getByRole('button', { name: /Draft PO from suggestions/i })).toBeEnabled();
  });

  it('shows no note for a complete plan, and a 0 count disables the button', async () => {
    getReorderSuggestions.mockResolvedValue({ suggestions: [healthy('a')], truncated: false });
    render(await PlanningPage());

    expect(screen.queryByTestId('planning-coverage-note')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Draft PO from suggestions/i })).toBeDisabled();
  });
});
