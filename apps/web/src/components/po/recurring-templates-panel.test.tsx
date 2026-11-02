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
  setRecurringTemplateEnabledAction: (id: string, enabled: boolean) => mockSetEnabled(id, enabled),
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

import { shouldAutoSend } from '@/server/services/auto-reorder';

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
    // The shared checkbox (role="checkbox", aria-checked) replaced the native
    // box in the redesign (P4.C2): toBeChecked reads either, same strength.
    const checkbox = screen.getByTestId('toggle-tpl-1');
    expect(checkbox).toBeChecked();
    expect(checkbox).toHaveAccessibleName('Disable template');

    fireEvent.click(checkbox);

    await waitFor(() => {
      expect(mockSetEnabled).toHaveBeenCalledWith('tpl-1', false);
    });
  });

  it('calls setRecurringTemplateEnabledAction(id, true) when a disabled template is checked', async () => {
    render(<RecurringTemplatesPanel {...BASE_PROPS} initial={[{ ...TEMPLATE, enabled: false }]} />);

    const checkbox = screen.getByTestId('toggle-tpl-1');
    expect(checkbox).not.toBeChecked();
    expect(checkbox).toHaveAccessibleName('Enable template');

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

  // ── Saved lines whose item the picker does not list ───────────────────────

  it('an edited template line pointing at a deleted item or a kit says what it is (not blank)', async () => {
    render(
      <RecurringTemplatesPanel
        {...BASE_PROPS}
        initial={[
          {
            ...TEMPLATE,
            line_items: [
              { itemId: 'item-1', quantityOrdered: 2, unitCost: 10 },
              { itemId: 'item-gone', quantityOrdered: 1, unitCost: 1 },
              { itemId: 'item-kit', quantityOrdered: 1, unitCost: 1 },
              { itemId: 'item-unknown', quantityOrdered: 1, unitCost: 1 },
            ],
          },
        ]}
        lineLabels={[
          { id: 'item-gone', name: 'Blue pens', sku: 'BP-1', deleted: true, kitStock: false },
          {
            id: 'item-kit',
            name: 'Reading Kit',
            sku: '__BUNDLE__0a000000',
            deleted: false,
            kitStock: true,
          },
        ]}
      />,
    );

    fireEvent.click(screen.getByText('Edit'));

    // The save refuses the deleted item and the kit BY NAME; the line that
    // holds each now reads so, and one the page could not resolve says that.
    await waitFor(() =>
      expect(screen.getAllByText('Deleted: Blue pens (BP-1)').length).toBeGreaterThan(0),
    );
    expect(
      screen.getAllByText('Pre-assembled kit: Reading Kit (__BUNDLE__0a000000)').length,
    ).toBeGreaterThan(0);
    expect(screen.getAllByText('Item not available').length).toBeGreaterThan(0);
  });

  // ── Mark as ordered automatically (B105) ──────────────────────────────────

  // The page said "opt-in auto-send requires a $ cap" and the form "Without
  // a cap, it falls back to draft.", but the run decides with shouldAutoSend,
  // which it calls with a null cap: a template with no cap is marked as
  // ordered whenever its total is under the organization's PO approval
  // threshold. And "Auto-send to supplier" promised a send: the run only
  // marks the purchase order as ordered (updateStatus 'ordered'), and nothing
  // is sent to anyone.
  it('a template that marks its PO as ordered with a blank cap says the approval threshold decides, and that nothing is sent', () => {
    // The rule the words state, as the run applies it (in dollars).
    expect(shouldAutoSend(50, null, 500)).toBe(true); // no cap, under the threshold
    expect(shouldAutoSend(500, null, 500)).toBe(false); // no cap, at the threshold
    expect(shouldAutoSend(50, null, null)).toBe(false); // neither: a draft
    expect(shouldAutoSend(100, 100, null)).toBe(true); // within the cap
    expect(shouldAutoSend(101, 100, null)).toBe(false); // over the cap
    expect(shouldAutoSend(90, 100, 80)).toBe(false); // within the cap, over the threshold

    render(
      <RecurringTemplatesPanel
        {...BASE_PROPS}
        initial={[{ ...TEMPLATE, send_mode: 'send', max_auto_send_cents: null }]}
      />,
    );
    const intro = screen.getByText(/^Templates that create a PO automatically on a cadence\./);
    expect(intro).toHaveTextContent(
      'Draft by default; a template can instead mark its PO as ordered automatically, under a cap or your PO approval threshold. Nothing is sent to the supplier.',
    );
    expect(intro).not.toHaveTextContent('requires a $ cap');
    // The list names the mode for what it does.
    expect(screen.getByText(/· Auto-order/)).toBeInTheDocument();

    fireEvent.click(screen.getByText('Edit'));
    expect(screen.getByRole('combobox', { name: 'When the PO is created' })).toHaveTextContent(
      'Mark as ordered automatically',
    );
    const help = screen.getByText(/^Mark as ordered automatically marks the PO as ordered/);
    expect(help).toHaveTextContent(
      'Mark as ordered automatically marks the PO as ordered when its total is within the cap and under your PO approval threshold, if you have one. With no cap, it is marked as ordered whenever its total is under your approval threshold. With neither, it stays a draft. Nothing is sent to the supplier. Send them the purchase order yourself.',
    );
    expect(help).not.toHaveTextContent('Without a cap, it falls back to draft');
    // The cap is optional, and says what is left a draft.
    expect(screen.getByLabelText('Auto-order cap ($, optional)')).toHaveValue(null);
    expect(
      screen.getByText(
        'A PO over this cap stays a draft for review instead of being marked as ordered.',
      ),
    ).toBeInTheDocument();
    // Nothing on the page says the purchase order is sent.
    expect(document.body).not.toHaveTextContent(/auto-?sen[dt]/i);
  });
});
