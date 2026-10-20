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

import { setAutoDeleteArchivedSettingsAction } from '@/server/actions/inventory-cleanup-settings';

import { ArchiveCleanupPanel } from './archive-cleanup-panel';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('ArchiveCleanupPanel', () => {
  it('asks the same backlog question before saving and saves nothing when cancelled', async () => {
    const confirm = vi.fn(() => false);
    vi.stubGlobal('confirm', confirm);
    render(
      <ArchiveCleanupPanel
        initial={{ enabled: false, days: 90 }}
        archivedCount={12}
        windowedCounts={{ 30: 9, 60: 6, 90: 4, 180: 1, 365: 0 }}
      />,
    );
    const box = screen.getByRole('checkbox', { name: 'Automatically delete archived items' });
    expect(box).not.toBeChecked();
    fireEvent.click(box);
    expect(box).toBeChecked();

    const warning = screen.getByText(/already past this window/);
    expect(warning.textContent).toBe(
      '4 items are already past this window and would be removed on the next nightly run (recoverable from Settings → Recovery).',
    );
    expect(document.body.textContent).not.toContain('⚠');

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    });
    expect(confirm).toHaveBeenCalledWith(
      '4 items have already been archived longer than 90 days and will be removed on the next nightly run. They stay recoverable from Settings → Recovery. Continue?',
    );
    expect(setAutoDeleteArchivedSettingsAction).not.toHaveBeenCalled();

    confirm.mockReturnValue(true);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    });
    expect(setAutoDeleteArchivedSettingsAction).toHaveBeenCalledWith({ enabled: true, days: 90 });
  });
});
