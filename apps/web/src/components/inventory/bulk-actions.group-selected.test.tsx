import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { GROUP_COPY } from '@stockpilot/core';

import { BulkActions } from './bulk-actions';

// Group selected and Remove from group in the Items and Books bulk bar
// (migration 0400): offered only for the records the table hands over (two
// or more distinct records of one type; the grouped ones), each opening its
// review for exactly those records; a change refreshes the page at once and
// clears the selection when the review closes; closing without a change
// clears nothing.

const h = vi.hoisted(() => ({
  refresh: vi.fn(),
  group: [] as Array<{
    itemIds: readonly string[];
    view: string;
    onDone: (o: { outcome: string }) => void;
    onOpenChange: (v: boolean) => void;
    onAddToSelection?: (ids: string[]) => void;
  }>,
  remove: [] as Array<{
    itemIds: readonly string[];
    onDone: (o: { outcome: string }) => void;
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
vi.mock('./display-group-dialogs', () => ({
  GroupSelectedDialog: (props: (typeof h.group)[number]) => {
    h.group.push(props);
    return <div data-testid="group-dialog">{`${props.view}:${props.itemIds.join(',')}`}</div>;
  },
  RemoveFromGroupDialog: (props: (typeof h.remove)[number]) => {
    h.remove.push(props);
    return <div data-testid="remove-dialog">{props.itemIds.join(',')}</div>;
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  h.group.length = 0;
  h.remove.length = 0;
});

function bar(p: {
  selectedIds: string[];
  groupItemIds?: string[];
  groupedItemIds?: string[];
  onClear?: () => void;
  onAddToSelection?: (ids: string[]) => void;
}) {
  return (
    <BulkActions
      selectedIds={p.selectedIds}
      groupItemIds={p.groupItemIds}
      groupedItemIds={p.groupedItemIds}
      groupingView="books"
      onAddToSelection={p.onAddToSelection}
      categories={[]}
      suppliers={[]}
      locations={[]}
      tags={[]}
      onClear={p.onClear ?? (() => {})}
      onCycleCount={() => {}}
    />
  );
}

describe('BulkActions: Group selected and Remove from group', () => {
  it('offers neither when the table hands over nothing', () => {
    render(bar({ selectedIds: ['a'] }));
    expect(screen.queryByRole('button', { name: new RegExp(GROUP_COPY.bulkAction) })).toBeNull();
    expect(screen.queryByRole('button', { name: new RegExp(GROUP_COPY.removeAction) })).toBeNull();
  });

  it("Group selected opens the review for exactly those records, in the table's view", async () => {
    render(bar({ selectedIds: ['a', 'b'], groupItemIds: ['a', 'b'] }));
    await userEvent.click(screen.getByRole('button', { name: new RegExp(GROUP_COPY.bulkAction) }));
    expect(screen.getByTestId('group-dialog')).toHaveTextContent('books:a,b');
  });

  it('a grouping refreshes at once and clears the selection on close; a no-op or a plain close clears nothing', async () => {
    const onClear = vi.fn();
    render(bar({ selectedIds: ['a', 'b'], groupItemIds: ['a', 'b'], onClear }));
    await userEvent.click(screen.getByRole('button', { name: new RegExp(GROUP_COPY.bulkAction) }));
    h.group.at(-1)!.onDone({ outcome: 'noop' });
    expect(h.refresh).not.toHaveBeenCalled();
    h.group.at(-1)!.onDone({ outcome: 'applied' });
    expect(h.refresh).toHaveBeenCalledTimes(1);
    expect(onClear).not.toHaveBeenCalled();
    h.group.at(-1)!.onOpenChange(false);
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it('"Add them to the selection" adds the records to the table\'s selection and to what the review covers', async () => {
    const onAddToSelection = vi.fn();
    render(bar({ selectedIds: ['a', 'b'], groupItemIds: ['a', 'b'], onAddToSelection }));
    await userEvent.click(screen.getByRole('button', { name: new RegExp(GROUP_COPY.bulkAction) }));
    h.group.at(-1)!.onAddToSelection!(['c']);
    expect(onAddToSelection).toHaveBeenCalledWith(['c']);
    expect(await screen.findByText('books:a,b,c')).toBeInTheDocument();
  });

  it('Remove from group reviews the grouped records only', async () => {
    const onClear = vi.fn();
    render(bar({ selectedIds: ['a', 'b'], groupedItemIds: ['a'], onClear }));
    await userEvent.click(
      screen.getByRole('button', { name: new RegExp(GROUP_COPY.removeAction) }),
    );
    expect(screen.getByTestId('remove-dialog')).toHaveTextContent('a');
    h.remove.at(-1)!.onDone({ outcome: 'applied' });
    h.remove.at(-1)!.onOpenChange(false);
    expect(h.refresh).toHaveBeenCalledTimes(1);
    expect(onClear).toHaveBeenCalledTimes(1);
  });
});
