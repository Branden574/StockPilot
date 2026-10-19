/**
 * The redesign of the recurring templates panel (P4.C2): the enable box is the
 * shared checkbox and still saves at once; Delete asks first with the words the
 * browser's confirm() used, in the shared confirmation; the open form registers
 * as unsaved work (CONFLICTS D30); and every field is named for a screen
 * reader.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockSetEnabled = vi.fn(async (_id: string, _enabled: boolean) => ({
  ok: true as const,
  data: { id: 'tpl-1' },
}));
const mockDelete = vi.fn(
  async (
    _id: string,
  ): Promise<{ ok: true; data: undefined } | { ok: false; error: { message: string } }> => ({
    ok: true as const,
    data: undefined,
  }),
);

vi.mock('@/server/actions/recurring-pos', () => ({
  setRecurringTemplateEnabledAction: (id: string, enabled: boolean) => mockSetEnabled(id, enabled),
  createRecurringTemplateAction: vi.fn(async () => ({ ok: true as const, data: { id: 'n' } })),
  updateRecurringTemplateAction: vi.fn(async () => ({ ok: true as const, data: { id: 'tpl-1' } })),
  deleteRecurringTemplateAction: (id: string) => mockDelete(id),
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
}));

import { getUnsavedSources, resetUnsavedSourcesForTests } from '@/lib/unsaved-work';

import { RecurringTemplatesPanel, type RecurringTemplateRow } from './recurring-templates-panel';

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

const PROPS = {
  initial: [TEMPLATE],
  items: [{ id: 'item-1', name: 'Widget A', sku: 'WGT-A', unit_cost: 10 }],
  suppliers: [],
  locations: [],
  entitled: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  resetUnsavedSourcesForTests();
});
afterEach(() => resetUnsavedSourcesForTests());

describe('RecurringTemplatesPanel (redesign)', () => {
  it('the enable box is a keyboard-reachable checkbox that saves at once and is off while busy', async () => {
    let resolve: (v: { ok: true; data: { id: string } }) => void = () => {};
    mockSetEnabled.mockImplementationOnce(
      () => new Promise((r) => (resolve = r as typeof resolve)),
    );
    render(<RecurringTemplatesPanel {...PROPS} />);
    const box = screen.getByRole('checkbox', { name: 'Disable template' });
    expect(box).toHaveAttribute('data-testid', 'toggle-tpl-1');
    expect(box.tagName).toBe('BUTTON');
    fireEvent.click(box);
    expect(mockSetEnabled).toHaveBeenCalledWith('tpl-1', false);
    await waitFor(() => expect(box).toBeDisabled());
    await act(async () => resolve({ ok: true, data: { id: 'tpl-1' } }));
    await waitFor(() =>
      expect(screen.getByRole('checkbox', { name: 'Enable template' })).not.toBeChecked(),
    );
  });

  it('Delete asks first with the same words, and Cancel deletes nothing', async () => {
    // The browser's own confirm() is never asked any more.
    const confirmSpy = vi.fn(() => true);
    vi.stubGlobal('confirm', confirmSpy);
    render(<RecurringTemplatesPanel {...PROPS} />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete template' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Delete this recurring template?')).toBeInTheDocument();
    expect(within(dialog).getByText('This cannot be undone.')).toBeInTheDocument();
    expect(confirmSpy).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByText('Delete this recurring template?')).toBeNull());
    expect(mockDelete).not.toHaveBeenCalled();
    expect(screen.getByText('Weekly Supplies')).toBeInTheDocument();
    vi.unstubAllGlobals();
  });

  it('confirming deletes the template; a refusal stays inside the dialog', async () => {
    mockDelete.mockResolvedValueOnce({ ok: false, error: { message: 'Not allowed.' } });
    render(<RecurringTemplatesPanel {...PROPS} />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete template' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(mockDelete).toHaveBeenCalledWith('tpl-1'));
    expect(await within(dialog).findByText('Not allowed.')).toBeInTheDocument();
    expect(screen.getByText('Weekly Supplies')).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(screen.queryByText('Weekly Supplies')).toBeNull());
    expect(mockDelete).toHaveBeenCalledTimes(2);
  });

  it('the open form is unsaved work only once it differs from how it opened (D30)', () => {
    render(<RecurringTemplatesPanel {...PROPS} initial={[]} />);
    expect(getUnsavedSources()).toEqual([]);
    fireEvent.click(screen.getByText('New template'));
    expect(getUnsavedSources()).toEqual([]);
    fireEvent.change(screen.getByLabelText('Template name'), { target: { value: 'Weekly' } });
    expect(getUnsavedSources()).toEqual([
      { id: 'recurring-template-form', label: 'New recurring template' },
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(getUnsavedSources()).toEqual([]);
  });

  it('a form Make recurring filled in counts as unsaved work at once (the seed is taken once)', () => {
    render(
      <RecurringTemplatesPanel
        {...PROPS}
        initial={[]}
        seed={{
          supplierId: null,
          destinationLocationId: null,
          lineItems: [{ itemId: 'item-1', quantityOrdered: 3, unitCost: 10 }],
        }}
      />,
    );
    expect(screen.getByText('New recurring template')).toBeInTheDocument();
    expect(getUnsavedSources()).toEqual([
      { id: 'recurring-template-form', label: 'New recurring template' },
    ]);
  });

  it('editing names every field, including each line, for a screen reader', () => {
    render(<RecurringTemplatesPanel {...PROPS} />);
    fireEvent.click(screen.getByText('Edit'));
    expect(screen.getByText('Edit template')).toBeInTheDocument();
    expect(getUnsavedSources()).toEqual([]);
    expect(screen.getByLabelText(/^Supplier/)).toBeInTheDocument();
    expect(screen.getByLabelText(/^Destination location/)).toBeInTheDocument();
    expect(screen.getByLabelText(/^Notes/)).toBeInTheDocument();
    expect(screen.getByLabelText('Item')).toBeInTheDocument();
    expect(screen.getByLabelText('Qty')).toHaveValue(2);
    expect(screen.getByLabelText('Unit cost')).toHaveValue(10);
    expect(screen.getByRole('button', { name: 'Remove line 1' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeInTheDocument();
  });
});
