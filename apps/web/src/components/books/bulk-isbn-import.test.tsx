/**
 * Bulk ISBN import (P4.A2, matrix W-BK-05). The redesign moved the form onto
 * one card with list rows; these pin what it must keep doing:
 * - the 200 cap and the no-ISBN refusal, before any lookup is sent;
 * - parse, de-duplicate, look up, then the status line and the editable rows;
 * - Remove <isbn>, and Import N books creating only the ready rows;
 * - CONFLICTS D20: the pasted list and looked-up rows register as unsaved
 *   work (lib/unsaved-work.ts), so "Refresh to update" asks before a reload.
 * - Each lookup answer lands on the row with its own ISBN. Removing a row
 *   while lookups ran used to shift the rows under the answers still on the
 *   way, so one book's title landed on the next ISBN's row (and was created
 *   under that ISBN on Import).
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getUnsavedSources, resetUnsavedSourcesForTests } from '@/lib/unsaved-work';

const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));

const toast = vi.hoisted(() => ({
  error: vi.fn(),
  success: vi.fn(),
  warning: vi.fn(),
}));
vi.mock('sonner', () => ({ toast }));

const bulkCreate = vi.hoisted(() => vi.fn());
vi.mock('@/server/actions/books-bulk-import', () => ({ bulkCreateBooksAction: bulkCreate }));

import { BulkIsbnImport } from './bulk-isbn-import';

const ISBN_A = '9780306406157';
const ISBN_B = '9781861972712';

const fetchMock = vi.fn();

beforeEach(() => {
  resetUnsavedSourcesForTests();
  router.push.mockReset();
  toast.error.mockReset();
  toast.success.mockReset();
  bulkCreate.mockReset();
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: string) => {
    const isbn = new URL(url, 'http://x').searchParams.get('isbn');
    if (isbn === ISBN_B) return { ok: true, json: async () => ({ title: null }) };
    return {
      ok: true,
      json: async () => ({ title: `Book ${isbn}`, authors: ['A. Writer'], grade: '5' }),
    };
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderImport() {
  return render(
    <BulkIsbnImport
      warehouses={[{ id: 'wh-1', name: 'North DC' }]}
      charters={[]}
      warehouseCharters={[]}
      forcedWarehouseId={null}
      warehouseLabel="Warehouse"
      charterLabel="Charter"
    />,
  );
}

const list = () => screen.getByLabelText('ISBNs');

describe('BulkIsbnImport', () => {
  it('labels its settings: the warehouse picker and the default quantity are named', () => {
    renderImport();
    expect(screen.getByRole('combobox', { name: 'Warehouse' })).toBeInTheDocument();
    expect(screen.getByLabelText('Default qty per book')).toHaveValue(1);
    // No charter picker when the warehouse has no charters.
    expect(screen.queryByRole('combobox', { name: 'Charter' })).not.toBeInTheDocument();
  });

  it('refuses an empty list and more than 200 ISBNs without looking anything up', () => {
    renderImport();
    fireEvent.click(screen.getByRole('button', { name: 'Look up' }));
    expect(toast.error).toHaveBeenCalledWith(
      'Paste at least one valid ISBN-10 or ISBN-13 to look up.',
    );

    const many = Array.from({ length: 201 }, (_, i) => String(9780000000000 + i)).join('\n');
    fireEvent.change(list(), { target: { value: many } });
    fireEvent.click(screen.getByRole('button', { name: 'Look up' }));
    expect(toast.error).toHaveBeenLastCalledWith(
      'Limit is 200 ISBNs per batch. Split your list into smaller groups.',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('looks up each distinct ISBN once, then shows the status line and the editable rows', async () => {
    renderImport();
    fireEvent.change(list(), {
      target: { value: `${ISBN_A}, 978-0-306-40615-7\n${ISBN_B}` },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Look up' }));
    });

    await waitFor(() =>
      expect(screen.getByTestId('isbn-import-status')).toHaveTextContent('1 ready · 1 failed'),
    );
    // The dashed duplicate collapsed into the first: two lookups, not three.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.getByLabelText(`Title for ${ISBN_A}`)).toHaveValue(`Book ${ISBN_A}`);
    expect(screen.getByLabelText(`Author for ${ISBN_A}`)).toHaveValue('A. Writer');
    expect(screen.getByText('No metadata found across sources')).toBeInTheDocument();
    // The progress bar shows only while lookups run.
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Import 1 book' })).toBeEnabled();

    fireEvent.click(screen.getByRole('button', { name: `Remove ${ISBN_B}` }));
    expect(screen.queryByText(ISBN_B)).not.toBeInTheDocument();
    expect(screen.getByTestId('isbn-import-status')).toHaveTextContent('1 ready · 0 failed');
  });

  it('imports only the ready rows and returns to the Books list', async () => {
    bulkCreate.mockResolvedValue({ ok: true, data: { created: 1, skipped: 0, errors: [] } });
    renderImport();
    fireEvent.change(list(), { target: { value: `${ISBN_A}\n${ISBN_B}` } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Look up' }));
    });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Import 1 book' })).toBeEnabled(),
    );

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Import 1 book' }));
    });
    expect(bulkCreate).toHaveBeenCalledTimes(1);
    const input = bulkCreate.mock.calls[0]![0] as {
      warehouseId: string;
      charterId: string | null;
      books: Array<{ isbn: string; quantityOnHand: number }>;
    };
    expect(input.warehouseId).toBe('wh-1');
    expect(input.charterId).toBeNull();
    expect(input.books.map((b) => [b.isbn, b.quantityOnHand])).toEqual([[ISBN_A, 1]]);
    expect(toast.success).toHaveBeenCalledWith('Created 1 book.');
    expect(router.push).toHaveBeenCalledWith('/dashboard/books');
  });

  it('registers the pasted list as unsaved work (D20), and nothing while it is empty', async () => {
    const { unmount } = renderImport();
    expect(getUnsavedSources()).toEqual([]);

    fireEvent.change(list(), { target: { value: ISBN_A } });
    expect(getUnsavedSources()).toEqual([{ id: 'bulk-isbn-import', label: 'Bulk ISBN import' }]);

    // Clearing the box with rows still looked up keeps it dirty.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Look up' }));
    });
    await waitFor(() =>
      expect(screen.getByTestId('isbn-import-status')).toHaveTextContent('1 ready'),
    );
    fireEvent.change(list(), { target: { value: '' } });
    expect(getUnsavedSources()).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: `Remove ${ISBN_A}` }));
    expect(getUnsavedSources()).toEqual([]);

    unmount();
    expect(getUnsavedSources()).toEqual([]);
  });

  it('keeps the remove control on every row, named by its ISBN', async () => {
    renderImport();
    fireEvent.change(list(), { target: { value: `${ISBN_A}\n${ISBN_B}` } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Look up' }));
    });
    await waitFor(() =>
      expect(screen.getByTestId('isbn-import-status')).toHaveTextContent('1 ready · 1 failed'),
    );
    const rows = screen.getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByRole('button', { name: `Remove ${ISBN_A}` })).toBeInTheDocument();
    expect(within(rows[1]!).getByRole('button', { name: `Remove ${ISBN_B}` })).toBeInTheDocument();
  });
});

describe('BulkIsbnImport lookups that finish after a row is removed', () => {
  const ISBN_C = '9780140449136';

  it('keeps each answer on its own ISBN: a removed row’s late answer is dropped, not written onto the next row', async () => {
    let answerA: (value: { ok: boolean; json: () => Promise<unknown> }) => void = () => {};
    fetchMock.mockImplementation((url: string) => {
      const isbn = new URL(url, 'http://x').searchParams.get('isbn');
      if (isbn === ISBN_A) {
        return new Promise((resolve) => {
          answerA = resolve;
        });
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({ title: `Book ${isbn}`, authors: [`Author ${isbn}`], grade: '3' }),
      });
    });
    bulkCreate.mockResolvedValue({ ok: true, data: { created: 2, skipped: 0, errors: [] } });

    renderImport();
    fireEvent.change(list(), { target: { value: `${ISBN_A}\n${ISBN_B}\n${ISBN_C}` } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Look up' }));
    });
    // B and C have answered; A is still being looked up.
    await waitFor(() =>
      expect(screen.getByTestId('isbn-import-status')).toHaveTextContent(
        '2 ready · 0 failed · 1 pending',
      ),
    );
    expect(screen.getByText('looking up')).toBeInTheDocument();

    // The person removes A while its lookup is still on the way...
    fireEvent.click(screen.getByRole('button', { name: `Remove ${ISBN_A}` }));
    expect(screen.queryByText(ISBN_A)).not.toBeInTheDocument();

    // ...and then A's answer arrives.
    await act(async () => {
      answerA({ ok: true, json: async () => ({ title: 'The Wrong Book', authors: ['Nobody'] }) });
    });

    // B and C keep their own titles and authors; A's answer went nowhere.
    expect(screen.getByLabelText(`Title for ${ISBN_B}`)).toHaveValue(`Book ${ISBN_B}`);
    expect(screen.getByLabelText(`Author for ${ISBN_B}`)).toHaveValue(`Author ${ISBN_B}`);
    expect(screen.getByLabelText(`Title for ${ISBN_C}`)).toHaveValue(`Book ${ISBN_C}`);
    expect(screen.queryByDisplayValue('The Wrong Book')).not.toBeInTheDocument();
    expect(screen.getByTestId('isbn-import-status')).toHaveTextContent('2 ready · 0 failed');

    // Import creates each ISBN under its own title.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Import 2 books' }));
    });
    const input = bulkCreate.mock.calls[0]![0] as {
      books: Array<{ isbn: string; title: string; author: string | null }>;
    };
    expect(input.books.map((b) => [b.isbn, b.title, b.author])).toEqual([
      [ISBN_B, `Book ${ISBN_B}`, `Author ${ISBN_B}`],
      [ISBN_C, `Book ${ISBN_C}`, `Author ${ISBN_C}`],
    ]);
  });
});

describe('BulkIsbnImport covers', () => {
  it('shows the missing-photo hatch while a row has no cover, and the cover once it has one', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      const isbn = new URL(url, 'http://x').searchParams.get('isbn');
      return {
        ok: true,
        json: async () =>
          isbn === ISBN_A
            ? { title: 'With cover', thumbnailUrl: 'https://covers.example/a.jpg' }
            : { title: 'No cover' },
      };
    });
    renderImport();
    fireEvent.change(list(), { target: { value: `${ISBN_A}\n${ISBN_B}` } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Look up' }));
    });
    await waitFor(() =>
      expect(screen.getByTestId('isbn-import-status')).toHaveTextContent('2 ready'),
    );
    const [withCover, without] = screen.getAllByRole('listitem');
    expect(withCover!.querySelector('img')).toHaveAttribute('src', 'https://covers.example/a.jpg');
    expect(withCover!.querySelector('[data-slot="missing-photo"]')).toBeNull();
    expect(without!.querySelector('img')).toBeNull();
    expect(without!.querySelector('[data-slot="missing-photo"]')).not.toBeNull();
  });
});
