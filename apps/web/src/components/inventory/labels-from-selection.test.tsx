// @vitest-environment happy-dom
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The labels page's ?selection= path: the ids the bulk bar stored in this tab
 * go to the server in a POST body, so 443 (or 500) selected items print instead
 * of a 431 from a 16 KB URL.
 */

const { loadLabelItemsAction } = vi.hoisted(() => ({ loadLabelItemsAction: vi.fn() }));
vi.mock('@/server/actions/labels', () => ({ loadLabelItemsAction }));
vi.mock('next/link', async () => {
  const React = await import('react');
  return {
    default: ({ href, children }: { href: string; children: React.ReactNode }) =>
      React.createElement('a', { href }, children),
  };
});
vi.mock('./label-sheet', () => ({
  LabelSheet: ({ items }: { items: unknown[] }) => <div data-testid="sheet">{items.length}</div>,
}));

import { writeLabelsSelection } from '@/lib/inventory/labels-selection';

import { LabelsFromSelection } from './labels-from-selection';

const uuid = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
const ids = (n: number) => Array.from({ length: n }, (_, i) => uuid(i));
const row = (id: string) => ({ id, name: id, sku: id, barcode: null });

function renderFor(key: string) {
  return render(
    <LabelsFromSelection selectionKey={key} copies={1} template="medium" format="barcode" />,
  );
}

beforeEach(() => {
  sessionStorage.clear();
  loadLabelItemsAction.mockReset();
});

describe('LabelsFromSelection', () => {
  it('prints all 443 selected items', async () => {
    const key = writeLabelsSelection(ids(443))!;
    loadLabelItemsAction.mockResolvedValue({ ok: true, data: ids(443).map(row) });

    renderFor(key);

    expect(await screen.findByText(/443 items selected · 1 copy each = 443 labels/)).toBeTruthy();
    expect(screen.getByTestId('sheet').textContent).toBe('443');
    expect(loadLabelItemsAction).toHaveBeenCalledWith({ ids: ids(443) });
  });

  it('sends at most 500 and says so when more were selected', async () => {
    const key = writeLabelsSelection(ids(700))!;
    loadLabelItemsAction.mockResolvedValue({ ok: true, data: ids(500).map(row) });

    renderFor(key);

    expect(await screen.findByText(/500 items selected/)).toBeTruthy();
    expect(loadLabelItemsAction).toHaveBeenCalledWith({ ids: ids(500) });
    expect(screen.getByRole('status').textContent).toContain('700 items were selected');
  });

  it('says the selection is gone, without asking the server, for a key this tab does not hold', async () => {
    renderFor(uuid(99));
    expect(await screen.findByText(/not available in this browser tab/)).toBeTruthy();
    expect(loadLabelItemsAction).not.toHaveBeenCalled();
  });

  it('a failed read is an error with a retry, never "No items selected"', async () => {
    const key = writeLabelsSelection(ids(3))!;
    loadLabelItemsAction
      .mockResolvedValueOnce({
        ok: false,
        error: { code: 'internal_error', message: 'An internal error occurred. Please try again.' },
      })
      .mockResolvedValueOnce({ ok: true, data: ids(3).map(row) });

    renderFor(key);

    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryByTestId('sheet')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.getByTestId('sheet').textContent).toBe('3'));
    expect(loadLabelItemsAction).toHaveBeenCalledTimes(2);
  });
});
