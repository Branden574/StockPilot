import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Remove organization (matrix W-AD-13e), restyled in P5.3. Pinned: the
 * "Also delete member accounts" box is the shared checkbox with the same
 * words, it sends what it shows, it resets when the dialog closes, and the
 * delete still needs the typed name and the passphrase before it arms.
 */

const h = vi.hoisted(() => ({
  remove: vi.fn(),
  ensure: vi.fn(),
  push: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: h.push, refresh: h.refresh }) }));
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));
vi.mock('@/components/auth/step-up-modal', () => ({
  useStepUp: () => ({ ensure: h.ensure, modal: null }),
}));
vi.mock('@/server/actions/platform-admin', () => ({
  removeOrgAction: (...a: unknown[]) => h.remove(...a),
}));

import { RemoveOrgDialog } from './remove-org-dialog';

beforeEach(() => {
  vi.clearAllMocks();
  h.remove.mockResolvedValue({ ok: true, data: { deletedUsers: 0, keptUsers: 0, failedUsers: 0 } });
});

const BOX = /Also delete member accounts that belong only to this org/;

describe('RemoveOrgDialog', () => {
  it('arms only with the name and passphrase, and sends the box as shown', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    render(<RemoveOrgDialog organizationId="org-1" orgName="Acme" />);
    await user.click(screen.getByRole('button', { name: 'Remove organization' }));
    const del = screen.getByRole('button', { name: 'Permanently delete' });
    expect(del).toBeDisabled();

    const box = screen.getByRole('checkbox', { name: BOX });
    expect(box).toHaveAttribute('aria-checked', 'false');
    await user.click(box);
    expect(box).toHaveAttribute('aria-checked', 'true');

    await user.type(screen.getByLabelText('Type the organization name to confirm'), 'Acme');
    await user.type(screen.getByLabelText('Deletion passphrase'), 'correct horse battery');
    expect(del).toBeEnabled();
    await user.click(del);
    await waitFor(() =>
      expect(h.remove).toHaveBeenCalledWith({
        orgId: 'org-1',
        passphrase: 'correct horse battery',
        confirmName: 'Acme',
        alsoDeleteOrphanedUsers: true,
      }),
    );
    await waitFor(() => expect(h.push).toHaveBeenCalledWith('/platform'));
  });

  it('resets the box and the fields when closed', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    render(<RemoveOrgDialog organizationId="org-1" orgName="Acme" />);
    await user.click(screen.getByRole('button', { name: 'Remove organization' }));
    await user.click(screen.getByRole('checkbox', { name: BOX }));
    await user.type(screen.getByLabelText('Type the organization name to confirm'), 'Ac');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    await user.click(screen.getByRole('button', { name: 'Remove organization' }));
    expect(screen.getByRole('checkbox', { name: BOX })).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByLabelText('Type the organization name to confirm')).toHaveValue('');
  });
});
