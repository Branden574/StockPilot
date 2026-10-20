import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('@/server/actions/movements', () => ({ editMovementNoteAction: vi.fn() }));

import {
  MovementsExportButton,
  MovementsInstantFiltersProvider,
  movementsExportHref,
} from './movements-export';
import { MovementsInstantTable } from './movements-instant-table';
import type { MovementDisplayRow } from './movements-table';

const EMPTY = { q: '', type: '', from: '', to: '' };

function rows(): MovementDisplayRow[] {
  return [
    {
      id: 'm-1',
      movementType: 'adjust',
      quantityChange: -1,
      newQuantity: 9,
      movedQuantity: null,
      reason: null,
      reasonHref: null,
      note: null,
      noteEditable: true,
      createdAt: '2026-09-01T12:00:00.000Z',
      itemName: 'Lanyard',
      itemSku: 'LAN-01',
      actorLabel: 'Avery Stone',
      actorEmail: null,
    },
  ];
}

function exportLinks() {
  return screen.getAllByRole('link', { name: 'Export movements to CSV' });
}

describe('movementsExportHref', () => {
  it('is the bare export route with no filters', () => {
    expect(movementsExportHref(EMPTY)).toBe('/api/movements/export.csv');
  });

  it('carries the four filters in the shape the server pager uses', () => {
    expect(
      movementsExportHref({ q: ' tape ', type: 'loss', from: '2026-09-01', to: '2026-09-30' }),
    ).toBe('/api/movements/export.csv?q=tape&type=loss&from=2026-09-01&to=2026-09-30');
  });
});

describe('MovementsExportButton', () => {
  it('is a download link named "Export movements to CSV" that reads "Export CSV"', () => {
    render(<MovementsExportButton href="/api/movements/export.csv?type=add" />);
    const link = exportLinks()[0]!;
    expect(link).toHaveAttribute('href', '/api/movements/export.csv?type=add');
    expect(link).toHaveAttribute('download');
    expect(link).toHaveTextContent('Export CSV');
  });

  it('without an href and outside the instant provider, exports the whole ledger', () => {
    render(<MovementsExportButton />);
    expect(exportLinks()[0]).toHaveAttribute('href', '/api/movements/export.csv');
  });
});

describe('Instant ledger inside the page provider', () => {
  // The page header carries Export CSV (where the reference puts Export). In
  // instant mode the filters live in the browser, so the header's link must
  // follow the table's chips, search and dates through the provider.
  it('the header Export follows the type chip and the search the ledger applies', async () => {
    const user = userEvent.setup();
    render(
      <MovementsInstantFiltersProvider>
        <header>
          <MovementsExportButton />
        </header>
        <MovementsInstantTable rows={rows()} canEditNotes />
      </MovementsInstantFiltersProvider>,
    );

    // One Export on the page: the table does not draw its own beside the pager.
    expect(exportLinks()).toHaveLength(1);
    const header = screen.getByRole('banner');
    const link = within(header).getByRole('link', { name: 'Export movements to CSV' });
    expect(link).toHaveAttribute('href', '/api/movements/export.csv');

    const types = screen.getByRole('group', { name: 'Filter by movement type' });
    await user.click(within(types).getByRole('button', { name: 'Adjust' }));
    expect(link).toHaveAttribute('href', '/api/movements/export.csv?type=adjust');

    await user.type(screen.getByLabelText('Search stock movements'), 'lan');
    await waitFor(() =>
      expect(link).toHaveAttribute('href', '/api/movements/export.csv?q=lan&type=adjust'),
    );
    // The rows follow the same filters.
    expect(screen.getByText('Lanyard')).toBeInTheDocument();
  });
});

describe('Instant ledger on its own (no provider)', () => {
  it('keeps its own Export CSV beside the pager, following its filters', async () => {
    const user = userEvent.setup();
    render(<MovementsInstantTable rows={rows()} />);

    const link = exportLinks()[0]!;
    expect(exportLinks()).toHaveLength(1);
    expect(link).toHaveAttribute('href', '/api/movements/export.csv');

    const types = screen.getByRole('group', { name: 'Filter by movement type' });
    await user.click(within(types).getByRole('button', { name: 'Transfer' }));
    expect(link).toHaveAttribute('href', '/api/movements/export.csv?type=transfer');
    // Nothing transferred: the no-match state, with the filters still on screen.
    expect(screen.getByText('No movements match')).toBeInTheDocument();
  });
});
