import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const refreshMock = vi.fn();
const adjustStockActionMock = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: refreshMock }),
}));

vi.mock('@/server/actions/inventory', () => ({
  adjustStockAction: (...args: unknown[]) => adjustStockActionMock(...args),
}));

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

import { QuickAdjustPills } from './quick-adjust-pills';

describe('QuickAdjustPills', () => {
  beforeEach(() => {
    refreshMock.mockReset();
    adjustStockActionMock.mockReset();
    adjustStockActionMock.mockResolvedValue({ ok: true, data: undefined });
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('disables both pills when the user lacks permission', () => {
    render(<QuickAdjustPills itemId="i1" currentQuantity={5} canAdjust={false} />);
    const minus = screen.getByRole('button', { name: /decrease quantity by 1/i });
    const plus = screen.getByRole('button', { name: /increase quantity by 1/i });
    expect(minus).toBeDisabled();
    expect(plus).toBeDisabled();
  });

  it('disables the -1 pill when quantity is 0 (would go negative)', () => {
    render(<QuickAdjustPills itemId="i1" currentQuantity={0} canAdjust={true} />);
    const minus = screen.getByRole('button', { name: /decrease quantity by 1/i });
    const plus = screen.getByRole('button', { name: /increase quantity by 1/i });
    expect(minus).toBeDisabled();
    expect(plus).not.toBeDisabled();
  });

  it('calls adjustStockAction with +1 / movement type "add" on the + pill', () => {
    render(<QuickAdjustPills itemId="i1" currentQuantity={3} canAdjust={true} />);
    fireEvent.click(screen.getByRole('button', { name: /increase quantity by 1/i }));
    expect(adjustStockActionMock).toHaveBeenCalledWith({
      itemId: 'i1',
      quantityChange: 1,
      movementType: 'add',
    });
  });

  it('calls adjustStockAction with -1 / movement type "remove" on the - pill', () => {
    render(<QuickAdjustPills itemId="i1" currentQuantity={3} canAdjust={true} />);
    fireEvent.click(screen.getByRole('button', { name: /decrease quantity by 1/i }));
    expect(adjustStockActionMock).toHaveBeenCalledWith({
      itemId: 'i1',
      quantityChange: -1,
      movementType: 'remove',
    });
  });
});
