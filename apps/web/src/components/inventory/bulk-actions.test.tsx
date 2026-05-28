import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { BulkActions } from './bulk-actions';

import { bulkUpdateInventoryAction } from '@/server/actions/inventory';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/dashboard/inventory',
}));

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() } }));

vi.mock('@/server/actions/inventory', () => ({
  bulkUpdateInventoryAction: vi.fn(async () => ({
    ok: true as const,
    data: { ok: 3, skipped: 0 },
  })),
}));

vi.mock('@/server/actions/purchase-orders', () => ({
  createDraftPosFromItemsAction: vi.fn(),
}));

const categories = [
  { id: 'c1', name: 'Books' },
  { id: 'c2', name: 'Electronics' },
];
const suppliers = [{ id: 's1', name: 'Acme' }];
const tags = [
  { id: 't1', name: 'Fragile', color: '#f97316' },
  { id: 't2', name: 'Heavy', color: null },
];

beforeEach(() => {
  vi.clearAllMocks();
});

describe('BulkActions', () => {
  it('renders selected count and a Print labels link with selectedIds joined', () => {
    render(
      <BulkActions
        selectedIds={['a', 'b', 'c']}
        categories={categories}
        suppliers={suppliers}
        locations={[]}
        tags={[]}
        onClear={() => {}}
        onCycleCount={() => {}}
      />,
    );
    expect(screen.getByText('3 selected')).toBeInTheDocument();
    const link = screen.getByRole('link', { name: /Print labels/i });
    expect(link).toHaveAttribute('href', '/dashboard/inventory/labels?items=a,b,c');
  });

  it('shows Archive when selection is not archived', () => {
    render(
      <BulkActions
        selectedIds={['a']}
        categories={categories}
        suppliers={suppliers}
        locations={[]}
        tags={[]}
        onClear={() => {}}
        onCycleCount={() => {}}
      />,
    );
    expect(screen.getByRole('button', { name: /Archive/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Restore/i })).not.toBeInTheDocument();
  });

  it('shows Restore when selection has archived items', () => {
    render(
      <BulkActions
        selectedIds={['a']}
        categories={categories}
        suppliers={suppliers}
        locations={[]}
        tags={[]}
        onClear={() => {}}
        onCycleCount={() => {}}
        hasArchivedSelection
      />,
    );
    expect(screen.getByRole('button', { name: /Restore/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Archive$/i })).not.toBeInTheDocument();
  });

  it('opens an archive confirmation dialog with the count when Archive is clicked', async () => {
    const user = userEvent.setup();
    render(
      <BulkActions
        selectedIds={['a', 'b']}
        categories={categories}
        suppliers={suppliers}
        locations={[]}
        tags={[]}
        onClear={() => {}}
        onCycleCount={() => {}}
      />,
    );
    await user.click(screen.getByRole('button', { name: /Archive/i }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('Archive 2 items?')).toBeInTheDocument();
  });

  it('closes the dialog when Cancel is pressed', async () => {
    const user = userEvent.setup();
    render(
      <BulkActions
        selectedIds={['a']}
        categories={categories}
        suppliers={suppliers}
        locations={[]}
        tags={[]}
        onClear={() => {}}
        onCycleCount={() => {}}
      />,
    );
    await user.click(screen.getByRole('button', { name: /Archive/i }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: /Cancel/i }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('confirming archive triggers bulkUpdateInventoryAction', async () => {
    const user = userEvent.setup();
    const onClear = vi.fn();
    render(
      <BulkActions
        selectedIds={['a', 'b']}
        categories={categories}
        suppliers={suppliers}
        locations={[]}
        tags={[]}
        onClear={onClear}
        onCycleCount={() => {}}
      />,
    );
    await user.click(screen.getByRole('button', { name: /Archive/i }));
    const dialog = await screen.findByRole('dialog');
    // Confirm button is the destructive-styled "Archive" inside the dialog
    const buttons = within(dialog).getAllByRole('button', { name: /Archive/i });
    await user.click(buttons[buttons.length - 1]!);
    expect(bulkUpdateInventoryAction).toHaveBeenCalledWith({
      ids: ['a', 'b'],
      op: { kind: 'archive' },
    });
  });

  it('Set category dialog renders the provided categories', async () => {
    const user = userEvent.setup();
    render(
      <BulkActions
        selectedIds={['a']}
        categories={categories}
        suppliers={suppliers}
        locations={[]}
        tags={[]}
        onClear={() => {}}
        onCycleCount={() => {}}
      />,
    );
    await user.click(screen.getByRole('button', { name: /Set category/i }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('Set category on 1 item')).toBeInTheDocument();
  });

  it('Add tags dialog renders the provided tags and dispatches the bulk add op', async () => {
    const user = userEvent.setup();
    render(
      <BulkActions
        selectedIds={['a', 'b']}
        categories={categories}
        suppliers={suppliers}
        locations={[]}
        tags={tags}
        onClear={() => {}}
        onCycleCount={() => {}}
      />,
    );
    await user.click(screen.getByRole('button', { name: /^Add tags$/i }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Add tags on 2 items')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: /Fragile/i }));
    await user.click(within(dialog).getByRole('button', { name: /^Apply$/i }));
    expect(bulkUpdateInventoryAction).toHaveBeenCalledWith({
      ids: ['a', 'b'],
      op: { kind: 'add_tags', tagIds: ['t1'] },
    });
  });

  it('Remove tags dialog dispatches the bulk remove op', async () => {
    const user = userEvent.setup();
    render(
      <BulkActions
        selectedIds={['a']}
        categories={categories}
        suppliers={suppliers}
        locations={[]}
        tags={tags}
        onClear={() => {}}
        onCycleCount={() => {}}
      />,
    );
    await user.click(screen.getByRole('button', { name: /^Remove tags$/i }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: /Heavy/i }));
    await user.click(within(dialog).getByRole('button', { name: /^Apply$/i }));
    expect(bulkUpdateInventoryAction).toHaveBeenCalledWith({
      ids: ['a'],
      op: { kind: 'remove_tags', tagIds: ['t2'] },
    });
  });

  it('Clear button calls onClear', async () => {
    const user = userEvent.setup();
    const onClear = vi.fn();
    render(
      <BulkActions
        selectedIds={['a']}
        categories={categories}
        suppliers={suppliers}
        locations={[]}
        tags={[]}
        onClear={onClear}
        onCycleCount={() => {}}
      />,
    );
    await user.click(screen.getByRole('button', { name: /Clear/i }));
    expect(onClear).toHaveBeenCalledTimes(1);
  });
});
