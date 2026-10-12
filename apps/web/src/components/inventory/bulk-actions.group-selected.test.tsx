import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { toast } from 'sonner';

import { GROUP_COPY, GROUPING_ERROR_WORDS } from '@stockpilot/core';

import { BulkActions } from './bulk-actions';

// Group selected in the Items and Books bulk bar (migration 0400): offered
// only for the records the table hands over (two or more distinct records of
// one type; taking records out is Ungroup's since 2026-10-12), opening its
// review for exactly those records; a change refreshes the page at once and
// clears the selection when the review closes; closing without a change
// clears nothing.

const h = vi.hoisted(() => ({
  refresh: vi.fn(),
  group: [] as Array<{
    itemIds: readonly string[];
    view: string;
    onDone: (o: { outcome: string; group?: { id: string } | null }) => void;
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
  ungroupItemIds?: string[];
  onClear?: () => void;
  onAddToSelection?: (ids: string[]) => void;
  onGrouped?: (groupId: string) => void;
}) {
  return (
    <BulkActions
      selectedIds={p.selectedIds}
      groupItemIds={p.groupItemIds}
      ungroupItemIds={p.ungroupItemIds}
      groupingView="books"
      onAddToSelection={p.onAddToSelection}
      onGrouped={p.onGrouped}
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

  // PR #360 review (2026-10-12): one review takes at most 100 records, so a
  // larger selection is told so at the button, as on the phone
  // (display-groups.ts), instead of opening a review that refuses it.
  it('more than 100 records: says so at the button and opens no review; 100 opens it', async () => {
    const many = Array.from({ length: 101 }, (_, i) => `r${i}`);
    const { unmount } = render(bar({ selectedIds: many, groupItemIds: many }));
    await userEvent.click(screen.getByRole('button', { name: new RegExp(GROUP_COPY.bulkAction) }));
    expect(toast.error).toHaveBeenCalledWith(GROUPING_ERROR_WORDS.groupTooMany);
    expect(screen.queryByTestId('group-dialog')).toBeNull();
    unmount();
    vi.mocked(toast.error).mockClear();
    const hundred = many.slice(0, 100);
    render(bar({ selectedIds: hundred, groupItemIds: hundred }));
    await userEvent.click(screen.getByRole('button', { name: new RegExp(GROUP_COPY.bulkAction) }));
    expect(toast.error).not.toHaveBeenCalled();
    expect(screen.getByTestId('group-dialog')).toBeInTheDocument();
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

  // Completeness review C3 (design 5: on success the list opens the group):
  // after the review closes on a grouping, the table is told which group to
  // open; a no-op or a plain close tells it nothing.
  it('after a grouping, closing the review tells the table which group to open', async () => {
    const onGrouped = vi.fn();
    render(bar({ selectedIds: ['a', 'b'], groupItemIds: ['a', 'b'], onGrouped }));
    await userEvent.click(screen.getByRole('button', { name: new RegExp(GROUP_COPY.bulkAction) }));
    h.group.at(-1)!.onDone({ outcome: 'noop', group: { id: 'g0' } });
    h.group.at(-1)!.onOpenChange(false);
    expect(onGrouped).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: new RegExp(GROUP_COPY.bulkAction) }));
    h.group.at(-1)!.onDone({ outcome: 'applied', group: { id: 'g1' } });
    h.group.at(-1)!.onOpenChange(false);
    expect(onGrouped).toHaveBeenCalledWith('g1');
  });

  it('"Add them to the selection" adds the records to the table\'s selection and to what the review covers', async () => {
    const onAddToSelection = vi.fn();
    render(bar({ selectedIds: ['a', 'b'], groupItemIds: ['a', 'b'], onAddToSelection }));
    await userEvent.click(screen.getByRole('button', { name: new RegExp(GROUP_COPY.bulkAction) }));
    h.group.at(-1)!.onAddToSelection!(['c']);
    expect(onAddToSelection).toHaveBeenCalledWith(['c']);
    expect(await screen.findByText('books:a,b,c')).toBeInTheDocument();
  });

  // Re-pinned by Ungroup anything (owner 2026-10-12; was: "Remove from group
  // reviews the grouped records only", a third grouping button on the bar):
  // the bar offers Group selected and Ungroup, and Ungroup takes a record out
  // of the group it is shown under (bulk-actions.ungroup.test.tsx). Claim
  // kept: records in a group can be taken out of it from the bulk bar.
  it('offers no separate Remove from group: Ungroup takes the grouped records out', () => {
    render(bar({ selectedIds: ['a', 'b'], ungroupItemIds: ['a'] }));
    expect(screen.queryByRole('button', { name: new RegExp(GROUP_COPY.removeAction) })).toBeNull();
    expect(screen.getByRole('button', { name: /Ungroup/ })).toBeInTheDocument();
    expect(h.remove).toHaveLength(0);
  });
});
