/**
 * Focused tests for RecurringTemplatesPanel.
 *
 * 1. Enabled toggle calls `setRecurringTemplateEnabledAction` with the correct
 *    id and negated `enabled` value.
 * 2. Form validates required fields: name (cannot be empty), and at least one
 *    line item must exist before the create action is called.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mock server action ───────────────────────────────────────────────────────
const mockSetEnabled = vi.fn(async (_id: string, _enabled: boolean) => ({
  ok: true as const,
  data: { id: 'tpl-1' },
}));
const mockCreate = vi.fn(async () => ({ ok: true as const, data: { id: 'new-tpl' } }));

vi.mock('@/server/actions/recurring-pos', () => ({
  setRecurringTemplateEnabledAction: (id: string, enabled: boolean) =>
    mockSetEnabled(id, enabled),
  createRecurringTemplateAction: (_input: unknown) => mockCreate(),
  updateRecurringTemplateAction: vi.fn(async () => ({ ok: true as const, data: { id: 'tpl-1' } })),
  deleteRecurringTemplateAction: vi.fn(async () => ({ ok: true as const, data: undefined })),
}));

// ── Mock sonner so toast calls don't throw ───────────────────────────────────
vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

// ── Mock next/navigation ─────────────────────────────────────────────────────
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
}));

// ── Mock @/lib/utils for deterministic output ────────────────────────────────
vi.mock('@/lib/utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/utils')>();
  return {
    ...actual,
    formatCurrency: (n: number) => `$${n.toFixed(2)}`,
    formatRelative: () => 'just now',
  };
});

import { RecurringTemplatesPanel, type RecurringTemplateRow } from './recurring-templates-panel';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const TEMPLATE: RecurringTemplateRow = {
  id: 'tpl-1',
  name: 'Weekly Supplies',
  supplier_id: null,
  destination_location_id: null,
  enabled: true,
  cadence: 'weekly',
  custom_days: null,
  send_mode: 'draft',
  max_auto_send_cents: null,
  line_items: [{ itemId: 'item-1', quantityOrdered: 2, unitCost: 10 }],
  notes: null,
  last_run_at: null,
  next_run_at: new Date().toISOString(),
};

const ITEMS = [{ id: 'item-1', name: 'Widget A', sku: 'WGT-A', unit_cost: 10 }];

const BASE_PROPS = {
  initial: [TEMPLATE],
  items: ITEMS,
  suppliers: [],
  locations: [],
  entitled: true,
  seed: null,
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('RecurringTemplatesPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Upgrade gate ──────────────────────────────────────────────────────────

  it('shows upgrade prompt for non-Pro orgs', () => {
    render(<RecurringTemplatesPanel {...BASE_PROPS} initial={[]} entitled={false} />);
    // The upgrade prompt renders at least one element containing "Pro".
    expect(screen.getAllByText(/Pro/).length).toBeGreaterThan(0);
    expect(screen.queryByText('New template')).toBeNull();
  });

  // ── Toggle enabled ────────────────────────────────────────────────────────

  it('calls setRecurringTemplateEnabledAction(id, false) when toggle is unchecked', async () => {
    render(<RecurringTemplatesPanel {...BASE_PROPS} />);

    // The template is enabled=true; unchecking it should call setEnabled(id, false).
    const checkbox = screen.getByTestId('toggle-tpl-1') as HTMLInputElement;
    expect(checkbox.checked).toBe(true);

    fireEvent.click(checkbox);

    await waitFor(() => {
      expect(mockSetEnabled).toHaveBeenCalledWith('tpl-1', false);
    });
  });

  it('calls setRecurringTemplateEnabledAction(id, true) when a disabled template is checked', async () => {
    render(
      <RecurringTemplatesPanel
        {...BASE_PROPS}
        initial={[{ ...TEMPLATE, enabled: false }]}
      />,
    );

    const checkbox = screen.getByTestId('toggle-tpl-1') as HTMLInputElement;
    expect(checkbox.checked).toBe(false);

    fireEvent.click(checkbox);

    await waitFor(() => {
      expect(mockSetEnabled).toHaveBeenCalledWith('tpl-1', true);
    });
  });

  // ── Form validation ───────────────────────────────────────────────────────

  it('does not call createRecurringTemplateAction when name is empty', async () => {
    render(<RecurringTemplatesPanel {...BASE_PROPS} initial={[]} />);

    // Open the new-template form.
    fireEvent.click(screen.getByText('New template'));

    // The name field is empty; click "Create template".
    const saveBtn = screen.getByText('Create template');
    fireEvent.click(saveBtn);

    // Action should NOT be called — form validation fires first.
    await waitFor(() => {
      expect(mockCreate).not.toHaveBeenCalled();
    });
  });

  it('does not call createRecurringTemplateAction when no line items are added', async () => {
    render(<RecurringTemplatesPanel {...BASE_PROPS} initial={[]} />);

    fireEvent.click(screen.getByText('New template'));

    // Fill in the name so that validation moves to the next gate (lines check).
    const nameInput = screen.getByPlaceholderText('e.g. Weekly office supplies');
    fireEvent.change(nameInput, { target: { value: 'Test Template' } });

    fireEvent.click(screen.getByText('Create template'));

    await waitFor(() => {
      expect(mockCreate).not.toHaveBeenCalled();
    });
  });
});
