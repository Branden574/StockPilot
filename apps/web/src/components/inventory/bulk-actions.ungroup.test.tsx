import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { BulkActions } from './bulk-actions';

const h = vi.hoisted(() => ({
  refresh: vi.fn(),
  dialogProps: [] as Array<{
    open: boolean;
    itemIds: readonly string[];
    onDone: () => void;
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
vi.mock('./ungroup-dialog', () => ({
  UngroupDialog: (props: (typeof h.dialogProps)[number]) => {
    h.dialogProps.push(props);
    return props.open ? <div data-testid="ungroup-dialog">{props.itemIds.join(',')}</div> : null;
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  h.dialogProps.length = 0;
});

function bar(props: { selectedIds: string[]; ungroupItemIds?: string[]; onClear?: () => void }) {
  return (
    <BulkActions
      selectedIds={props.selectedIds}
      ungroupItemIds={props.ungroupItemIds}
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

  it('opens the review dialog for exactly the records that share a SKU, frozen while it is open', async () => {
    const { rerender } = render(bar({ selectedIds: ['a', 'b', 'c'], ungroupItemIds: ['a', 'c'] }));
    await userEvent.click(screen.getByRole('button', { name: /Ungroup/ }));
    expect(screen.getByTestId('ungroup-dialog')).toHaveTextContent('a,c');
    // The selection changing under an open dialog does not change what it reviews.
    rerender(bar({ selectedIds: [], ungroupItemIds: [] }));
    expect(screen.getByTestId('ungroup-dialog')).toHaveTextContent('a,c');
  });

  it('after a split it refreshes at once, and clears the selection when the dialog closes', async () => {
    const onClear = vi.fn();
    render(bar({ selectedIds: ['a'], ungroupItemIds: ['a'], onClear }));
    await userEvent.click(screen.getByRole('button', { name: /Ungroup/ }));
    const props = h.dialogProps.at(-1)!;
    props.onDone();
    expect(h.refresh).toHaveBeenCalledTimes(1);
    expect(onClear).not.toHaveBeenCalled();
    props.onOpenChange(false);
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it('closing without a split clears nothing', async () => {
    const onClear = vi.fn();
    render(bar({ selectedIds: ['a'], ungroupItemIds: ['a'], onClear }));
    await userEvent.click(screen.getByRole('button', { name: /Ungroup/ }));
    h.dialogProps.at(-1)!.onOpenChange(false);
    expect(onClear).not.toHaveBeenCalled();
  });
});
