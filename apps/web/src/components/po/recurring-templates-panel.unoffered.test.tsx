// @vitest-environment happy-dom
/**
 * Recurring purchase orders: a template's destination or supplier the form's
 * selects do not offer (small fixes slice 8, items B and D).
 *
 * B. A template whose destination was deleted after it was saved opened in
 *    Edit with a blank Destination box (Radix shows a value no option has as
 *    blank), and its save was refused by that destination's name (#334), so
 *    the buyer was told a name the form never showed. Now the form names it
 *    and keeps none (the #334 treatment for Make recurring), and the list
 *    says the template creates no purchase order until it is changed (the
 *    daily run skips it: recurring-pos.run-skips.test.ts).
 * D. An archived supplier the same way: the Supplier box was blank in Edit
 *    and in Make recurring, the save sent it back unseen, and the list said
 *    "No supplier". Now it is named, and the form keeps none.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as React from 'react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

beforeAll(() => {
  // Radix Select needs pointer-capture APIs happy-dom doesn't implement.
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.setPointerCapture ??= () => {};
  Element.prototype.releasePointerCapture ??= () => {};
});

vi.mock('@/server/actions/recurring-pos', () => ({
  setRecurringTemplateEnabledAction: vi.fn(),
  createRecurringTemplateAction: vi.fn(),
  updateRecurringTemplateAction: vi.fn(),
  deleteRecurringTemplateAction: vi.fn(),
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
}));

import { createRecurringTemplateAction, updateRecurringTemplateAction } from '@/server/actions/recurring-pos';

import { RecurringTemplatesPanel, type RecurringTemplateRow } from './recurring-templates-panel';

const TEMPLATE: RecurringTemplateRow = {
  id: 'tpl-1',
  name: 'Weekly Supplies',
  supplier_id: 'sup-1',
  destination_location_id: 'loc-main',
  enabled: true,
  cadence: 'weekly',
  custom_days: null,
  send_mode: 'draft',
  max_auto_send_cents: null,
  line_items: [{ itemId: 'item-1', quantityOrdered: 2, unitCost: 10 }],
  notes: null,
  last_run_at: null,
  next_run_at: '2026-10-19T14:00:00.000Z',
};

const PROPS = {
  initial: [TEMPLATE],
  items: [{ id: 'item-1', name: 'Widget A', sku: 'WGT-A', unit_cost: 10 }],
  suppliers: [
    { id: 'sup-1', name: 'TechSource Distributors' },
    { id: 'sup-2', name: 'Office Depot' },
  ],
  locations: [
    { id: 'loc-main', name: 'Main Warehouse' },
    { id: 'loc-north', name: 'North Site' },
  ],
  entitled: true,
};

const destination = () => screen.getByRole('combobox', { name: /Destination location/ });
const supplier = () => screen.getByRole('combobox', { name: /Supplier/ });

function openEdit() {
  fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
}

async function saveEdit() {
  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
  await waitFor(() => expect(updateRecurringTemplateAction).toHaveBeenCalledTimes(1));
  return vi.mocked(updateRecurringTemplateAction).mock.calls[0]?.[1];
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(updateRecurringTemplateAction).mockResolvedValue({ ok: true, data: { id: 'tpl-1' } });
  vi.mocked(createRecurringTemplateAction).mockResolvedValue({ ok: true, data: { id: 'tpl-new' } });
});

describe('Edit a template whose destination was deleted after it was saved (B)', () => {
  const props = {
    ...PROPS,
    initial: [{ ...TEMPLATE, destination_location_id: 'loc-gone' }],
    unofferedDestinations: { 'loc-gone': { name: 'Old Annex', why: 'deleted' as const } },
  };

  it('the list says it creates no purchase order until its destination is changed', () => {
    render(<RecurringTemplatesPanel {...props} />);
    expect(
      screen.getByText(
        'Its destination, "Old Annex", was deleted, so it creates no purchase order. Edit it to choose another destination.',
      ),
    ).toBeInTheDocument();
  });

  it('the form names the deleted destination and opens on None; saving sends none', async () => {
    render(<RecurringTemplatesPanel {...props} />);
    openEdit();

    const note = screen.getByText('This template\'s destination, "Old Annex", was deleted, so choose a destination.');
    expect(destination()).toHaveTextContent('None');
    expect(destination()).toHaveAttribute('aria-describedby', note.id);
    expect(await saveEdit()).toMatchObject({ destinationLocationId: null, supplierId: 'sup-1' });
  });

  it('choosing a destination clears the note, and the save sends it', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    render(<RecurringTemplatesPanel {...props} />);
    openEdit();

    await user.click(destination());
    await user.click(within(await screen.findByRole('listbox')).getByRole('option', { name: 'North Site' }));

    expect(screen.queryByText(/so choose a destination/)).toBeNull();
    expect(await saveEdit()).toMatchObject({ destinationLocationId: 'loc-north' });
  });

  it('the page could not read it: still not kept, named without a name, and the list says nothing it does not know', () => {
    render(<RecurringTemplatesPanel {...PROPS} initial={[{ ...TEMPLATE, destination_location_id: 'loc-gone' }]} />);
    expect(screen.queryByText(/creates no purchase order/)).toBeNull();
    openEdit();
    expect(
      screen.getByText("This template's destination is a location you can't pick here, so choose a destination."),
    ).toBeInTheDocument();
    expect(destination()).toHaveTextContent('None');
  });
});

describe('An archived supplier (D)', () => {
  const props = {
    ...PROPS,
    initial: [{ ...TEMPLATE, supplier_id: 'sup-gone' }],
    unofferedSuppliers: { 'sup-gone': { name: 'Acme Paper', why: 'archived' as const } },
  };

  it('the list names it as archived instead of "No supplier"', () => {
    render(<RecurringTemplatesPanel {...props} />);
    expect(screen.getByText(/Acme Paper \(archived\)/)).toBeInTheDocument();
    expect(screen.queryByText(/No supplier/)).toBeNull();
  });

  it('Edit names it and opens on No supplier; saving sends none', async () => {
    render(<RecurringTemplatesPanel {...props} />);
    openEdit();

    const note = screen.getByText('This template\'s supplier, "Acme Paper", was archived, so choose a supplier.');
    expect(supplier()).toHaveTextContent('No supplier');
    expect(supplier()).toHaveAttribute('aria-describedby', note.id);
    expect(await saveEdit()).toMatchObject({ supplierId: null, destinationLocationId: 'loc-main' });
  });

  it('choosing a supplier clears the note', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    render(<RecurringTemplatesPanel {...props} />);
    openEdit();

    await user.click(supplier());
    await user.click(within(await screen.findByRole('listbox')).getByRole('option', { name: 'Office Depot' }));

    expect(screen.queryByText(/so choose a supplier/)).toBeNull();
    expect(await saveEdit()).toMatchObject({ supplierId: 'sup-2' });
  });

  it('Make recurring from a purchase order whose supplier was archived: names it and opens on No supplier', async () => {
    render(
      <RecurringTemplatesPanel
        {...props}
        initial={[]}
        seed={{ supplierId: 'sup-gone', destinationLocationId: 'loc-main', lineItems: TEMPLATE.line_items as never }}
      />,
    );

    expect(
      screen.getByText('This purchase order\'s supplier, "Acme Paper", was archived, so choose a supplier.'),
    ).toBeInTheDocument();
    expect(supplier()).toHaveTextContent('No supplier');
    fireEvent.change(screen.getByPlaceholderText('e.g. Weekly office supplies'), { target: { value: 'Monthly paper' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create template' }));
    await waitFor(() => expect(createRecurringTemplateAction).toHaveBeenCalledTimes(1));
    expect(vi.mocked(createRecurringTemplateAction).mock.calls[0]?.[0]).toMatchObject({
      supplierId: null,
      destinationLocationId: 'loc-main',
    });
  });
});

describe('Offered values are kept, with no note', () => {
  it('Edit of a template whose destination and supplier the form offers', async () => {
    render(<RecurringTemplatesPanel {...PROPS} />);
    expect(screen.getByText(/TechSource Distributors/)).toBeInTheDocument();
    openEdit();
    expect(screen.queryByText(/so choose a/)).toBeNull();
    expect(destination()).toHaveTextContent('Main Warehouse');
    expect(supplier()).toHaveTextContent('TechSource Distributors');
    expect(await saveEdit()).toMatchObject({ supplierId: 'sup-1', destinationLocationId: 'loc-main' });
  });
});
