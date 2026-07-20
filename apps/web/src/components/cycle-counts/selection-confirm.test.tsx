// @vitest-environment happy-dom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useCountSelection } from '@/lib/cycle-counts/use-count-selection';

import { SelectionConfirm } from './selection-confirm';

const { routerMock, startActionMock } = vi.hoisted(() => ({
  routerMock: { push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() },
  startActionMock: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => routerMock,
}));
vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    ...rest
  }: { href: string; children: React.ReactNode } & React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), message: vi.fn() },
}));
vi.mock('@/server/actions/cycle-counts', () => ({
  startCycleCountAction: startActionMock,
}));

const NO_MEMBERS: Array<{ id: string; name: string; email: string }> = [];
const WAREHOUSES = [{ id: 'w1', name: 'Main DC' }];

describe('SelectionConfirm (embedded picker flow)', () => {
  const fetchSpy = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    useCountSelection.getState().clear();
    vi.stubGlobal('fetch', fetchSpy);
    // The embedded picker's browse fetch — an empty org keeps these
    // tests focused on the confirm form; picker behavior has its own
    // suite (count-item-picker.test.tsx).
    fetchSpy.mockResolvedValue({
      ok: true,
      json: async () => ({ items: [], total: 0 }),
    } as Response);
  });

  it('renders the embedded picker instead of the old go-to-Inventory dead end', async () => {
    render(<SelectionConfirm members={NO_MEMBERS} canAssign={false} warehouses={WAREHOUSES} />);

    // The picker's surface is in-flow…
    expect(screen.getByRole('button', { name: 'Inventory' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Books' })).toBeInTheDocument();
    expect(
      screen.getByRole('textbox', { name: /search items to count/i }),
    ).toBeInTheDocument();
    // …and the eject-to-Items instructions are gone.
    expect(screen.queryByText(/Open Inventory or Books/)).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Go to Inventory' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Go to Books' })).not.toBeInTheDocument();
  });

  it('Start count is disabled at 0 picks with helper text', () => {
    render(<SelectionConfirm members={NO_MEMBERS} canAssign={false} warehouses={WAREHOUSES} />);

    expect(screen.getByRole('button', { name: 'Start count' })).toBeDisabled();
    expect(
      screen.getByText('Pick at least one item above to start a count.'),
    ).toBeInTheDocument();
  });

  it('starts a scope=selection count with the picked itemIds (store-driven, both entry paths)', async () => {
    const user = userEvent.setup();
    // Seed the store the same way BOTH entry paths do — the embedded
    // picker and the legacy Items-page select-mode "Cycle count" action.
    useCountSelection.getState().add([
      { id: 'a', sku: 'SP-A', name: 'Alpha Charger', itemType: 'product' },
      { id: 'b1', sku: 'BK-1', name: 'Algebra I', itemType: 'book' },
    ]);
    startActionMock.mockResolvedValue({
      ok: true,
      data: { id: 'cc-9', lineCount: 2, skipped: 0 },
    });

    render(<SelectionConfirm members={NO_MEMBERS} canAssign={false} warehouses={WAREHOUSES} />);

    // Review groups show the mixed selection.
    expect(screen.getByText('Products · 1')).toBeInTheDocument();
    expect(screen.getByText('Books · 1')).toBeInTheDocument();

    const startBtn = screen.getByRole('button', { name: 'Start count' });
    expect(startBtn).toBeEnabled();
    await user.click(startBtn);

    expect(startActionMock).toHaveBeenCalledWith({
      scope: 'selection',
      warehouseId: null,
      itemIds: ['a', 'b1'],
      notes: null,
      assignedTo: null,
    });
    // Store cleared + navigated to the new count.
    await vi.waitFor(() => {
      expect(routerMock.push).toHaveBeenCalledWith('/dashboard/cycle-counts/cc-9');
    });
    expect(useCountSelection.getState().picks).toEqual({});
  });

  it('removing a pick from the review list updates the store', async () => {
    const user = userEvent.setup();
    useCountSelection
      .getState()
      .add([{ id: 'a', sku: 'SP-A', name: 'Alpha Charger', itemType: 'product' }]);
    render(<SelectionConfirm members={NO_MEMBERS} canAssign={false} warehouses={WAREHOUSES} />);

    await user.click(screen.getByRole('button', { name: 'Remove Alpha Charger' }));
    expect(useCountSelection.getState().picks['a']).toBeUndefined();
    expect(screen.getByRole('button', { name: 'Start count' })).toBeDisabled();
  });
});
