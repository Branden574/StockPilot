// @vitest-environment happy-dom
/**
 * Edit purchase order on a draft whose destination or supplier the form's
 * selects do not offer (small fixes slice 8, items A and D).
 *
 * The Destination select offers sites linked to a warehouse and the Supplier
 * select the active suppliers. A draft can hold something else: a staging
 * area or a location deleted since (production 2026-10-06: four Demo Co
 * purchase orders to Staging, three Learn4Life ones to deleted locations; no
 * draft among them today), or a supplier archived since. Radix shows a value
 * no option has as a blank box, and the form kept it, so the save sent it
 * back unseen.
 *
 * Same treatment as Make recurring (#334): the form keeps only a value it
 * offers. Otherwise the select opens on None / No supplier, and a note under
 * it names what the draft holds and why it cannot be picked; choosing an
 * option clears the note, and the save sends what the select shows.
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

vi.mock('@/server/actions/purchase-orders', () => ({
  createPoAction: vi.fn(),
  updatePoAction: vi.fn(),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), back: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { getUnsavedSources, resetUnsavedSourcesForTests } from '@/lib/unsaved-work';
import { createPoAction, updatePoAction } from '@/server/actions/purchase-orders';

import { PoForm, type InitialPoValues } from './po-form';

const ITEMS = [{ id: 'item-1', name: 'Laptop stand', sku: 'LS-1', unit_cost: 16 }];
const LOCATIONS = [
  { id: 'loc-main', name: 'Main Warehouse' },
  { id: 'loc-north', name: 'North Site' },
];
const SUPPLIERS = [
  { id: 'sup-1', name: 'TechSource Distributors' },
  { id: 'sup-2', name: 'Office Depot' },
];

function initial(over: Partial<InitialPoValues> = {}): InitialPoValues {
  return {
    supplierId: 'sup-1',
    locationId: 'loc-main',
    charterId: '',
    expectedAt: '',
    notes: '',
    poNumber: 'PO-001',
    lines: [{ itemId: 'item-1', quantityOrdered: 2, unitCost: 16 }],
    ...over,
  };
}

function renderEdit(props: Partial<React.ComponentProps<typeof PoForm>> = {}) {
  return render(
    <PoForm
      items={ITEMS}
      suppliers={SUPPLIERS}
      locations={LOCATIONS}
      charters={[]}
      poId="po-1"
      initial={initial()}
      {...props}
    />,
  );
}

const destination = () => screen.getByRole('combobox', { name: /Destination location/ });
const supplier = () => screen.getByRole('combobox', { name: /Supplier/ });

/** Presses Save changes and returns what the edit sent. */
async function save() {
  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
  await waitFor(() => expect(updatePoAction).toHaveBeenCalledTimes(1));
  return vi.mocked(updatePoAction).mock.calls[0]?.[1];
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(updatePoAction).mockResolvedValue({ ok: true, data: { id: 'po-1', poNumber: 'PO-001' } });
  vi.mocked(createPoAction).mockResolvedValue({ ok: true, data: { id: 'po-new' } });
});

describe('Edit purchase order: a destination the form does not offer', () => {
  it('a staging area: opens on None and names where the draft goes; saving sends none', async () => {
    renderEdit({
      initial: initial({ locationId: 'loc-staging' }),
      unoffered: { destination: { name: 'Staging', why: 'not_a_site' } },
    });

    const note = screen.getByText(
      'This purchase order goes to "Staging", which is not a site you can pick here, so choose a destination.',
    );
    expect(destination()).toHaveTextContent('None');
    expect(destination()).toHaveAttribute('aria-describedby', note.id);
    expect(await save()).toMatchObject({ destinationLocationId: null });
  });

  it('a deleted location: says it was deleted, by name', async () => {
    renderEdit({
      initial: initial({ locationId: 'loc-gone' }),
      unoffered: { destination: { name: 'Old Annex', why: 'deleted' } },
    });

    expect(
      screen.getByText('This purchase order goes to "Old Annex", which was deleted, so choose a destination.'),
    ).toBeInTheDocument();
    expect(destination()).toHaveTextContent('None');
    expect(await save()).toMatchObject({ destinationLocationId: null });
  });

  it('the page could not read it: still not kept, and the note says so without a name', async () => {
    renderEdit({ initial: initial({ locationId: 'loc-unknown' }) });

    expect(
      screen.getByText("This purchase order goes to a location you can't pick here, so choose a destination."),
    ).toBeInTheDocument();
    expect(destination()).toHaveTextContent('None');
    expect(await save()).toMatchObject({ destinationLocationId: null });
  });

  it('choosing a destination clears the note, and the save sends the one chosen', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderEdit({
      initial: initial({ locationId: 'loc-staging' }),
      unoffered: { destination: { name: 'Staging', why: 'not_a_site' } },
    });

    await user.click(destination());
    await user.click(within(await screen.findByRole('listbox')).getByRole('option', { name: 'North Site' }));

    expect(screen.queryByText(/so choose a destination/)).toBeNull();
    expect(destination()).toHaveTextContent('North Site');
    expect(destination()).not.toHaveAttribute('aria-describedby');
    expect(await save()).toMatchObject({ destinationLocationId: 'loc-north' });
  });

  it('a destination the form offers is kept, with no note', async () => {
    renderEdit();

    expect(screen.queryByText(/so choose a destination/)).toBeNull();
    expect(destination()).toHaveTextContent('Main Warehouse');
    expect(await save()).toMatchObject({ destinationLocationId: 'loc-main', supplierId: 'sup-1' });
  });
});

describe('Edit purchase order: a supplier the form does not offer', () => {
  it('an archived supplier: opens on No supplier and names it; saving sends none', async () => {
    renderEdit({
      initial: initial({ supplierId: 'sup-archived' }),
      unoffered: { supplier: { name: 'Acme Paper', why: 'archived' } },
    });

    const note = screen.getByText(
      'This purchase order\'s supplier, "Acme Paper", was archived, so choose a supplier.',
    );
    expect(supplier()).toHaveTextContent('No supplier');
    expect(supplier()).toHaveAttribute('aria-describedby', note.id);
    expect(await save()).toMatchObject({ supplierId: null, destinationLocationId: 'loc-main' });
  });

  it('choosing a supplier clears the note, and the save sends the one chosen', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderEdit({
      initial: initial({ supplierId: 'sup-archived' }),
      unoffered: { supplier: { name: 'Acme Paper', why: 'archived' } },
    });

    await user.click(supplier());
    await user.click(within(await screen.findByRole('listbox')).getByRole('option', { name: 'Office Depot' }));

    expect(screen.queryByText(/so choose a supplier/)).toBeNull();
    expect(await save()).toMatchObject({ supplierId: 'sup-2' });
  });
});

describe('Edit purchase order: unsaved work (CONFLICTS D30) with a value the form does not offer', () => {
  // The form opens on None / No supplier in place of what the draft holds.
  // Leaving then loses nothing anybody typed, so the one global "Refresh to
  // update" reload must not ask about it; a choice made after that must.
  it('is clean when it opens on the empty choice, and dirty once a destination is chosen', async () => {
    resetUnsavedSourcesForTests();
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderEdit({
      initial: initial({ locationId: 'loc-staging', supplierId: 'sup-archived' }),
      unoffered: {
        destination: { name: 'Staging', why: 'not_a_site' },
        supplier: { name: 'Acme Paper', why: 'archived' },
      },
    });
    expect(getUnsavedSources()).toEqual([]);

    await user.click(destination());
    await user.click(within(await screen.findByRole('listbox')).getByRole('option', { name: 'North Site' }));
    expect(getUnsavedSources()).toEqual([{ id: 'po-form-po-1', label: 'Editing PO-001' }]);
  });
});

describe('New purchase order: nothing to name', () => {
  it('opens on None and No supplier with no note', () => {
    render(<PoForm items={ITEMS} suppliers={SUPPLIERS} locations={LOCATIONS} charters={[]} />);
    expect(destination()).toHaveTextContent('None');
    expect(supplier()).toHaveTextContent('No supplier');
    expect(screen.queryByText(/so choose a/)).toBeNull();
  });
});
