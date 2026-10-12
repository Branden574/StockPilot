import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { toast } from 'sonner';

import { GROUPING_ERROR_WORDS } from '@stockpilot/core';

import { BulkActions } from './bulk-actions';

const h = vi.hoisted(() => ({
  refresh: vi.fn(),
  dialogProps: [] as Array<{
    open: boolean;
    itemIds: readonly string[];
    view: string;
    shownUnder?: ReadonlyMap<string, string>;
    onDone: (o: unknown) => void;
    onOpenChange: (v: boolean) => void;
  }>,
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: h.refresh, replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/dashboard/inventory',
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() } }));
vi.mock('@/server/actions/inventory', () => ({ bulkUpdateInventoryAction: vi.fn() }));
vi.mock('@/server/actions/purchase-orders', () => ({ createDraftPosFromItemsAction: vi.fn() }));
// Ungroup anything (owner 2026-10-12): the bar's Ungroup opens the one review
// for any ticked records (ungroup-selected-dialog.tsx).
vi.mock('./ungroup-selected-dialog', () => ({
  UngroupSelectedDialog: (props: (typeof h.dialogProps)[number]) => {
    h.dialogProps.push(props);
    return props.open ? <div data-testid="ungroup-dialog">{props.itemIds.join(',')}</div> : null;
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  h.dialogProps.length = 0;
});

function bar(props: {
  selectedIds: string[];
  ungroupItemIds?: string[];
  ungroupShownUnder?: ReadonlyMap<string, 'group' | 'sku' | 'family'>;
  onClear?: () => void;
}) {
  return (
    <BulkActions
      selectedIds={props.selectedIds}
      ungroupItemIds={props.ungroupItemIds}
      ungroupShownUnder={props.ungroupShownUnder}
      groupingView="books"
      categories={[]}
      suppliers={[]}
      locations={[]}
      tags={[]}
      onClear={props.onClear ?? (() => {})}
      onCycleCount={() => {}}
    />
  );
}

describe('BulkActions: Ungroup', () => {
  it('is not offered when no selected record shares its SKU with another loaded record', () => {
    render(bar({ selectedIds: ['a', 'b'] }));
    expect(screen.queryByRole('button', { name: /Ungroup/ })).toBeNull();
    render(bar({ selectedIds: ['a'], ungroupItemIds: [] }));
    expect(screen.queryByRole('button', { name: /Ungroup/ })).toBeNull();
  });

  // Re-pinned by Ungroup anything (owner 2026-10-12; was: "opens the review
  // dialog for exactly the records that share a SKU"): the review takes EVERY
  // ticked record and says what happens to each, the ones left out with the
  // reason. Claim kept: what it reviews is frozen while it is open.
  it('opens the one review for every ticked record, with where each is shown on the list, frozen while it is open', async () => {
    const shown = new Map([
      ['a', 'sku' as const],
      ['c', 'family' as const],
    ]);
    const { rerender } = render(
      bar({ selectedIds: ['a', 'b', 'c'], ungroupItemIds: ['a', 'c'], ungroupShownUnder: shown }),
    );
    await userEvent.click(screen.getByRole('button', { name: /Ungroup/ }));
    expect(screen.getByTestId('ungroup-dialog')).toHaveTextContent('a,b,c');
    const props = h.dialogProps.at(-1)!;
    expect(props.view).toBe('books');
    expect([...(props.shownUnder ?? [])]).toEqual([...shown]);
    // The selection changing under an open dialog does not change what it reviews.
    rerender(bar({ selectedIds: [], ungroupItemIds: [], ungroupShownUnder: new Map() }));
    expect(screen.getByTestId('ungroup-dialog')).toHaveTextContent('a,b,c');
    expect([...(h.dialogProps.at(-1)!.shownUnder ?? [])]).toEqual([...shown]);
  });

  // Re-pinned 2026-10-12 (PR #358): onDone now carries the answer, and the
  // selection clears only when something changed or a step applied.
  it('after a split it refreshes at once, and clears the selection when the dialog closes', async () => {
    const onClear = vi.fn();
    render(bar({ selectedIds: ['a'], ungroupItemIds: ['a'], onClear }));
    await userEvent.click(screen.getByRole('button', { name: /Ungroup/ }));
    const props = h.dialogProps.at(-1)!;
    props.onDone({
      complete: true,
      parts: [
        {
          kind: 'split',
          status: 'applied',
          changedItemIds: ['a'],
          notChangedItemIds: [],
          message: null,
          reason: null,
          retryable: false,
        },
      ],
    });
    expect(h.refresh).toHaveBeenCalledTimes(1);
    expect(onClear).not.toHaveBeenCalled();
    props.onOpenChange(false);
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  // PR #358 review (2026-10-12): an answer that was lost may have applied, so
  // the list re-reads, but the ticks stay for another try after Done.
  it('after a lost answer it refreshes, and keeps the selection when the dialog closes', async () => {
    const onClear = vi.fn();
    render(bar({ selectedIds: ['a'], ungroupItemIds: ['a'], onClear }));
    await userEvent.click(screen.getByRole('button', { name: /Ungroup/ }));
    const props = h.dialogProps.at(-1)!;
    props.onDone({
      complete: false,
      parts: [
        {
          kind: 'split',
          status: 'refused',
          changedItemIds: [],
          notChangedItemIds: ['a'],
          message: 'The answer was lost.',
          reason: 'unknown',
          retryable: true,
        },
      ],
    });
    expect(h.refresh).toHaveBeenCalledTimes(1);
    props.onOpenChange(false);
    expect(onClear).not.toHaveBeenCalled();
  });

  // G2 security review LOW (2026-10-12): one review takes at most 100
  // records, so a larger selection is told so at the button, as on the phone,
  // instead of opening a review that refuses it.
  it('more than 100 selected records: says so at the button and opens no review; 100 opens it', async () => {
    const many = Array.from({ length: 101 }, (_, i) => `r${i}`);
    const { unmount } = render(bar({ selectedIds: [...many, 'r0'], ungroupItemIds: ['r0'] }));
    await userEvent.click(screen.getByRole('button', { name: /Ungroup/ }));
    expect(toast.error).toHaveBeenCalledWith(GROUPING_ERROR_WORDS.tooMany);
    expect(screen.queryByTestId('ungroup-dialog')).toBeNull();
    unmount();
    vi.mocked(toast.error).mockClear();
    // Exactly 100 distinct records (a duplicate tick counts once) still opens.
    render(bar({ selectedIds: [...many.slice(0, 100), 'r0'], ungroupItemIds: ['r0'] }));
    await userEvent.click(screen.getByRole('button', { name: /Ungroup/ }));
    expect(toast.error).not.toHaveBeenCalled();
    expect(screen.getByTestId('ungroup-dialog')).toBeInTheDocument();
  });

  it('closing without a split clears nothing', async () => {
    const onClear = vi.fn();
    render(bar({ selectedIds: ['a'], ungroupItemIds: ['a'], onClear }));
    await userEvent.click(screen.getByRole('button', { name: /Ungroup/ }));
    h.dialogProps.at(-1)!.onOpenChange(false);
    expect(onClear).not.toHaveBeenCalled();
  });
});
