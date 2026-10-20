// @vitest-environment happy-dom
/**
 * The redesigned PO form (P4.C1, matrix W-PU-03 / W-PU-04):
 *
 * - CONFLICTS D30: the form registers with lib/unsaved-work.ts, so the one
 *   global "Refresh to update" reload asks before it discards typed lines.
 *   Clean when it opens (new or edit), dirty after any change, clean again
 *   after a successful save, and still dirty after a failed one (the input
 *   is kept).
 * - Every field keeps its words and is named by its label; each line's
 *   remove button has a name (it had none) and each line's Qty and Unit cost
 *   are named; the item picker keeps its own words as its name.
 * - Validation is unchanged: no lines, or a line without an item, still
 *   refuses with the same toasts and never calls the server.
 */
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { createPoAction, updatePoAction, push, toastError } = vi.hoisted(() => ({
  createPoAction: vi.fn(),
  updatePoAction: vi.fn(),
  push: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('@/server/actions/purchase-orders', () => ({ createPoAction, updatePoAction }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, back: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('sonner', () => ({ toast: { error: toastError, success: vi.fn() } }));

import { getUnsavedSources, resetUnsavedSourcesForTests } from '@/lib/unsaved-work';

import { PoForm, type InitialPoValues } from './po-form';

const ITEMS = [{ id: 'i1', name: 'Blue pens', sku: 'BP-1', unit_cost: 2.5 }];
const BASE = {
  items: ITEMS,
  suppliers: [{ id: 's1', name: 'Acme' }],
  locations: [{ id: 'l1', name: 'North DC' }],
  charters: [{ id: 'c1', name: 'Harbor Ridge' }],
};
const INITIAL: InitialPoValues = {
  supplierId: 's1',
  locationId: 'l1',
  charterId: '',
  expectedAt: '2026-11-02',
  notes: 'Leave at dock 3',
  poNumber: 'PO-2026-0042',
  lines: [{ itemId: 'i1', quantityOrdered: 4, unitCost: 2.5 }],
};

beforeEach(() => {
  resetUnsavedSourcesForTests();
  createPoAction.mockReset();
  updatePoAction.mockReset();
  push.mockReset();
  toastError.mockReset();
  // The by-id label resolution never runs for these items (all are known),
  // but a stray fetch must not reach the network.
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ items: [] }))),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('PoForm registers its unsaved work (CONFLICTS D30)', () => {
  it('a new PO is clean when it opens and dirty once a line or a note is typed', async () => {
    const user = userEvent.setup();
    render(<PoForm {...BASE} />);
    expect(getUnsavedSources()).toEqual([]);

    await user.click(screen.getByRole('button', { name: /add line/i }));
    expect(getUnsavedSources()).toEqual([{ id: 'po-form-new', label: 'New purchase order' }]);
  });

  it('an edit is clean while it matches the stored PO, dirty after a change', async () => {
    const user = userEvent.setup();
    render(<PoForm {...BASE} poId="po-42" initial={INITIAL} />);
    expect(getUnsavedSources()).toEqual([]);

    await user.type(screen.getByLabelText(/notes/i), ' please');
    expect(getUnsavedSources()).toEqual([{ id: 'po-form-po-42', label: 'Editing PO-2026-0042' }]);
  });

  it('keeps the work registered after a failed save and clears it after a successful one', async () => {
    const user = userEvent.setup();
    render(<PoForm {...BASE} poId="po-42" initial={INITIAL} />);
    await user.type(screen.getByLabelText(/notes/i), ' please');

    updatePoAction.mockResolvedValueOnce({ ok: false, error: { message: 'Nope' } });
    await user.click(screen.getByRole('button', { name: /save changes/i }));
    expect(toastError).toHaveBeenCalledWith('Nope');
    // The typed note is still there, and still protected.
    expect(screen.getByLabelText(/notes/i)).toHaveValue('Leave at dock 3 please');
    expect(getUnsavedSources()).toHaveLength(1);

    updatePoAction.mockResolvedValueOnce({ ok: true, data: { id: 'po-42' } });
    await user.click(screen.getByRole('button', { name: /save changes/i }));
    expect(push).toHaveBeenCalledWith('/dashboard/purchase-orders/po-42');
    expect(getUnsavedSources()).toEqual([]);
  });

  it('stops registering when the form unmounts', () => {
    const { unmount } = render(<PoForm {...BASE} poId="po-42" initial={INITIAL} />);
    unmount();
    act(() => {});
    expect(getUnsavedSources()).toEqual([]);
  });
});

describe('PoForm fields keep their words and get names', () => {
  it('names every header field by its label, with "(optional)" kept', () => {
    render(<PoForm {...BASE} />);
    expect(screen.getByRole('combobox', { name: 'Supplier (optional)' })).toBeInTheDocument();
    expect(
      screen.getByRole('combobox', { name: 'Destination location (optional)' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('combobox', { name: 'Bill to charter (optional)' }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('PO number (optional)')).toHaveAttribute('maxlength', '64');
    expect(screen.getByLabelText('Expected delivery (optional)')).toHaveAttribute('type', 'date');
    expect(screen.getByLabelText('Notes (optional)')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'PO details' })).toBeInTheDocument();
  });

  it('shows the empty line state with its words and disables Create PO', () => {
    render(<PoForm {...BASE} />);
    expect(screen.getByText('No lines yet. Click "Add line" to start.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create PO' })).toBeDisabled();
    expect(screen.queryByText(/^Total:/)).not.toBeInTheDocument();
  });

  it("names each line's fields and remove button, and the picker keeps its own words", async () => {
    const user = userEvent.setup();
    render(<PoForm {...BASE} poId="po-42" initial={INITIAL} />);
    await user.click(screen.getByRole('button', { name: /add line/i }));

    const lines = within(screen.getByRole('group', { name: 'Line items' })).getAllByRole(
      'listitem',
    );
    expect(lines).toHaveLength(2);
    // The picked item's "SKU · name" is the picker's name, as before.
    expect(within(lines[0]!).getByRole('button', { name: 'BP-1 · Blue pens' })).toBeInTheDocument();
    expect(within(lines[0]!).getByLabelText('Qty')).toHaveValue(4);
    expect(within(lines[0]!).getByLabelText('Unit cost')).toHaveValue(2.5);
    expect(
      within(lines[1]!).getByRole('button', { name: /pick or create an item/i }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Remove line 2' }));
    expect(
      within(screen.getByRole('group', { name: 'Line items' })).getAllByRole('listitem'),
    ).toHaveLength(1);
    // The total is the lines' sum, beside the form's buttons.
    expect(screen.getByText('Total:').parentElement).toHaveTextContent(/^Total:\s*\$10\.00$/);
  });

  it('still refuses a line without an item, with the same toast and no server call', async () => {
    const user = userEvent.setup();
    render(<PoForm {...BASE} />);
    await user.click(screen.getByRole('button', { name: /add line/i }));
    await user.click(screen.getByRole('button', { name: 'Create PO' }));
    expect(toastError).toHaveBeenCalledWith('Every line needs an item and a positive quantity.');
    expect(createPoAction).not.toHaveBeenCalled();
  });
});
