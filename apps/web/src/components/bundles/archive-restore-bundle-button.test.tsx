import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { requestFailedMessage } from '@/lib/request-failure';
import { offline } from '@/test/rejected-request';

/**
 * B40: Archive and Restore on a bundle set `busy`, awaited the action with no
 * catch and cleared `busy` only when it answered. A call that got no answer
 * (offline, a server error, a deploy) left the confirm spinning, and the
 * confirm refuses to close while it is pending, so the page was stuck.
 */

const { refresh, mockArchive, mockRestore, mockToast } = vi.hoisted(() => ({
  refresh: vi.fn(),
  mockArchive: vi.fn(),
  mockRestore: vi.fn(),
  mockToast: { success: vi.fn(), error: vi.fn() },
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh }) }));
vi.mock('@/server/actions/bundles', () => ({
  archiveBundleAction: mockArchive,
  restoreBundleAction: mockRestore,
}));
vi.mock('sonner', () => ({ toast: mockToast }));

import { ArchiveBundleButton } from './archive-bundle-button';
import { RestoreBundleButton } from './restore-bundle-button';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('bundle Archive and Restore when the request gets no answer', () => {
  it('Archive stops its spinner, keeps the confirm open and says the bundle was not archived', async () => {
    mockArchive.mockRejectedValueOnce(offline());
    render(<ArchiveBundleButton bundleId="b-1" bundleName="Field Kit" />);
    fireEvent.click(screen.getByRole('button', { name: 'Archive' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Archive' }));
    await waitFor(() =>
      expect(mockToast.error).toHaveBeenCalledWith(
        requestFailedMessage(offline(), 'archive the bundle'),
      ),
    );
    expect(within(dialog).getByRole('button', { name: 'Archive' })).toBeEnabled();
    expect(mockToast.success).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('Restore stops its spinner, keeps the confirm open and says the bundle was not restored', async () => {
    mockRestore.mockRejectedValueOnce(offline());
    render(<RestoreBundleButton bundleId="b-1" bundleName="Field Kit" />);
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Restore' }));
    await waitFor(() =>
      expect(mockToast.error).toHaveBeenCalledWith(
        requestFailedMessage(offline(), 'restore the bundle'),
      ),
    );
    expect(within(dialog).getByRole('button', { name: 'Restore' })).toBeEnabled();
    expect(mockToast.success).not.toHaveBeenCalled();
  });
});
