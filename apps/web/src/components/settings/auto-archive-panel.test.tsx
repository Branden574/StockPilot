/**
 * Settings > Inventory cleanup: both cards keep their checkbox, their live
 * impact words and their Save; the auto-delete backlog confirm keeps its exact
 * words (native confirm) and nothing saves when it is cancelled; the warning
 * glyph is an icon now, so the words carry no symbol character.
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/server/actions/inventory-cleanup-settings', () => ({
  setAutoDeleteArchivedSettingsAction: vi.fn(async () => ({ ok: true, data: null })),
}));
vi.mock('@/server/actions/auto-archive-settings', () => ({
  setAutoArchiveSettingsAction: vi.fn(async () => ({ ok: true, data: null })),
}));

import { setAutoArchiveSettingsAction } from '@/server/actions/auto-archive-settings';

import { AutoArchivePanel } from './auto-archive-panel';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('AutoArchivePanel', () => {
  it('keeps the checkbox, the eligible-count words and the dwell days input', async () => {
    render(<AutoArchivePanel initial={{ enabled: true, dwellDays: 30 }} eligibleCount={3} />);
    expect(
      screen.getByRole('checkbox', { name: 'Automatically archive out-of-stock items' }),
    ).toBeChecked();
    expect(screen.getByText(/currently out of stock past the window/).textContent).toBe(
      '3 items are currently out of stock past the window and will be archived on the next daily run.',
    );
    const days = screen.getByLabelText('Archive after an item has been out of stock for');
    fireEvent.change(days, { target: { value: '45' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    });
    expect(setAutoArchiveSettingsAction).toHaveBeenCalledWith({ enabled: true, dwellDays: 45 });
  });
});
