/**
 * Staging in the redesign (P4.A2, matrix W-BK-06 / 06b): the look moved onto
 * the shared patterns, and these pin what the restyle must keep.
 *
 * - The type filter is the shared segmented control, still a group named
 *   "Item type" of toggle buttons with aria-pressed, and its idle option no
 *   longer hovers in the accent (P2.1 hand-off: accent-foreground on the
 *   accent read 1.71:1 light / 1.66:1 dark; the neutral hover reads 17.13 /
 *   15.03, globals-tokens.test.ts).
 * - Row and header selection run through the shared Checkbox: the tour's
 *   `[role="checkbox"][aria-label="Select all placeable rows"]` and
 *   `main table` anchors still resolve, a selected row carries the selected
 *   tint, and a row without a warehouse cannot be ticked.
 * - The two empty states are the shared state panel, with their words.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => router,
  useSearchParams: () => new URLSearchParams('order=o-1&item=i-1'),
}));

import { StagingTable, type StagingTableProps } from './staging-table';

type Row = StagingTableProps['rows'][number];

function row(itemId: string, name: string, extra: Partial<Row> = {}): Row {
  return {
    itemId,
    name,
    sku: `SKU-${itemId}`,
    itemType: 'book',
    warehouseId: 'wh1',
    sourceLocationId: `stg-${itemId}`,
    sourceKind: 'staging',
    quantity: 3,
    sourceReceiptId: null,
    sourcePoNumber: 'PO-100',
    receiptNumber: null,
    receivedAt: null,
    ageDays: 9,
    barcode: null,
    modelNumber: null,
    bookStorage: null,
    ...extra,
  };
}

function renderTable(props: Partial<StagingTableProps> = {}) {
  return render(
    <StagingTable
      rows={[row('a', 'Book A'), row('b', 'Book B', { warehouseId: null })]}
      destinationsMap={{ wh1: [] }}
      warehouseNames={{ wh1: 'WH One' }}
      canPlace
      activeItemType="all"
      {...props}
    />,
  );
}

describe('Staging table, redesigned', () => {
  it('the type filter is a group of pressed toggles that pushes ?type= and keeps every other param', () => {
    router.push.mockReset();
    renderTable({ activeItemType: 'book' });
    const group = screen.getByRole('group', { name: 'Item type' });
    const books = within(group).getByRole('button', { name: 'Books' });
    const all = within(group).getByRole('button', { name: 'All' });
    expect(books).toHaveAttribute('aria-pressed', 'true');
    expect(all).toHaveAttribute('aria-pressed', 'false');
    // The idle option's hover is the neutral one, never the accent fill.
    expect(all.className).not.toMatch(/\bhover:bg-accent\b/);
    expect(all.className).not.toMatch(/\bhover:text-accent-foreground\b/);

    fireEvent.click(within(group).getByRole('button', { name: 'Items' }));
    expect(router.push).toHaveBeenCalledWith('?order=o-1&item=i-1&type=non-book');
  });

  it('keeps the tour anchors and draws selection with the shared checkbox', () => {
    const { container } = renderTable();
    expect(container.querySelector('table')).not.toBeNull();
    const header = container.querySelector(
      '[role="checkbox"][aria-label="Select all placeable rows"]',
    );
    expect(header).not.toBeNull();

    const a = screen.getByRole('checkbox', { name: 'Select Book A' });
    const b = screen.getByRole('checkbox', { name: 'Select Book B' });
    expect(b).toBeDisabled();

    fireEvent.click(a);
    expect(a).toHaveAttribute('aria-checked', 'true');
    expect(a).toHaveAttribute('data-state', 'checked');
    expect(a.closest('tr')).toHaveAttribute('data-state', 'selected');
    expect(b.closest('tr')).not.toHaveAttribute('data-state');
    expect(screen.getByText('1 selected')).toBeInTheDocument();
    // Select-all over the placeable rows only: the one row, so it is checked.
    expect(header).toHaveAttribute('aria-checked', 'true');

    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(screen.queryByText(/selected$/)).not.toBeInTheDocument();
    expect(a.closest('tr')).not.toHaveAttribute('data-state');
  });

  it('the bulk bar offers Place selected only with stock:transfer', () => {
    renderTable({ canPlace: false });
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.queryByText('Place selected')).not.toBeInTheDocument();
    // History stays for every reader.
    expect(screen.getAllByRole('button', { name: /View history for/ })).toHaveLength(2);
  });

  it('the empty worklist is the shared empty state with its words', () => {
    renderTable({ rows: [] });
    const panel = screen
      .getByText('Nothing to place — received (staged) or unplaced stock appears here.')
      .closest('[data-slot="state-panel"]');
    expect(panel).toHaveAttribute('data-state-kind', 'empty');
    // Not a heading: the page's only heading level 1 is the title.
    expect(screen.queryByRole('heading')).not.toBeInTheDocument();
  });

  it('a filter that hides every row is the shared no-match state with Clear filters', () => {
    renderTable();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search staging items' }), {
      target: { value: 'zzz-nothing' },
    });
    const panel = screen.getByTestId('staging-filtered-empty');
    expect(panel).toHaveAttribute('data-state-kind', 'no-match');
    expect(panel).toHaveTextContent('No staging items match these filters.');
    fireEvent.click(within(panel).getByRole('button', { name: 'Clear filters' }));
    expect(screen.queryByTestId('staging-filtered-empty')).not.toBeInTheDocument();
  });
});

describe('Staging files keep the neutral hover (P2.1 hand-off)', () => {
  // Accent hovers and focus fills outside components/ui read below 4.5:1 on
  // the redesign accent; every file of this screen uses the neutral bg-muted.
  const FILES = [
    'staging-table.tsx',
    'staging-table-section.tsx',
    'place-from-staging-dialog.tsx',
    'bulk-place-dialog.tsx',
    'item-history-dialog.tsx',
  ];
  it.each(FILES)('%s has no accent hover or focus fill', (file) => {
    const source = readFileSync(path.join(__dirname, file), 'utf8');
    expect(source).not.toMatch(/(hover|focus|focus-visible):bg-accent\b/);
    expect(source).not.toMatch(/(hover|focus|focus-visible):text-accent-foreground\b/);
  });
});
