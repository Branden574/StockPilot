import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * One passkey switch in the platform console (plan 2.6 H, section 4): its
 * state, its button, and a confirm step that asks for the typed word
 * PASSKEYS before the action is pressed. Pinned: the button arms only on
 * the exact word; each target calls its own action with what it shows; a
 * stale step-up asks for the code in place and presses again with the same
 * payload; the answers' words (already, off without its record, members
 * still holding passkeys); an error keeps the dialog open, and the open
 * dialog keeps the direction it was opened for when the page refreshes under
 * it.
 */

const ORG = '0b000000-0000-4000-8000-000000000001';

const h = vi.hoisted(() => ({
  kill: vi.fn(),
  adds: vi.fn(),
  org: vi.fn(),
  ensure: vi.fn(),
  refresh: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: h.refresh }) }));
vi.mock('sonner', () => ({ toast: h.toast }));
vi.mock('@/components/auth/step-up-modal', () => ({
  useStepUp: () => ({ ensure: h.ensure, modal: null }),
}));
vi.mock('@/server/actions/platform/passkeys', () => ({
  setPasskeysKillSwitchAction: (...a: unknown[]) => h.kill(...a),
  setNewPasskeysSwitchAction: (...a: unknown[]) => h.adds(...a),
  setOrganizationPasskeysAction: (...a: unknown[]) => h.org(...a),
}));

import { PasskeySwitchControl } from './passkey-switch-control';

const done = (data: Record<string, unknown>) => ({ ok: true, data });

beforeEach(() => {
  vi.clearAllMocks();
  h.kill.mockResolvedValue(done({ on: true, changed: true, recorded: true }));
  h.adds.mockResolvedValue(done({ on: true, changed: true, recorded: true }));
  h.org.mockResolvedValue(done({ on: true, changed: true, recorded: true }));
  h.ensure.mockResolvedValue(true);
});

async function openAndType(user: ReturnType<typeof userEvent.setup>, button: string, word: string) {
  await user.click(screen.getByRole('button', { name: button }));
  const box = screen.getByLabelText('Type PASSKEYS to confirm');
  if (word) await user.type(box, word);
  return box;
}

describe('PasskeySwitchControl', () => {
  it('shows the state and the button that changes it', () => {
    const { unmount } = render(
      <PasskeySwitchControl target={{ kind: 'platform', setting: 'passkeys_on' }} on={false} />,
    );
    expect(screen.getByText('Off')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Turn on' })).toBeInTheDocument();
    unmount();
    render(<PasskeySwitchControl target={{ kind: 'platform', setting: 'passkeys_on' }} on />);
    expect(screen.getByText('On')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Turn off' })).toBeInTheDocument();
  });

  it('arms only on the exact word PASSKEYS', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    render(
      <PasskeySwitchControl target={{ kind: 'platform', setting: 'passkeys_on' }} on={false} />,
    );
    const box = await openAndType(user, 'Turn on', 'passkeys');
    const go = screen.getByRole('button', { name: 'Turn on passkeys for everyone' });
    expect(go).toBeDisabled();
    await user.clear(box);
    await user.type(box, 'PASSKEY');
    expect(go).toBeDisabled();
    await user.type(box, 'S');
    expect(go).toBeEnabled();
    await user.click(go);
    expect(h.kill).not.toHaveBeenCalledWith(expect.objectContaining({ confirm: 'passkeys' }));
  });

  it('the kill switch: sends { on, confirm } to its action, then says so and refreshes', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    render(
      <PasskeySwitchControl target={{ kind: 'platform', setting: 'passkeys_on' }} on={false} />,
    );
    await openAndType(user, 'Turn on', 'PASSKEYS');
    await user.click(screen.getByRole('button', { name: 'Turn on passkeys for everyone' }));
    await waitFor(() => expect(h.kill).toHaveBeenCalledWith({ on: true, confirm: 'PASSKEYS' }));
    expect(h.adds).not.toHaveBeenCalled();
    expect(h.org).not.toHaveBeenCalled();
    await waitFor(() => expect(h.toast.success).toHaveBeenCalledWith('Passkeys for everyone: On.'));
    expect(h.refresh).toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('new passkeys: turning off sends { on: false } to its own action', async () => {
    h.adds.mockResolvedValue(done({ on: false, changed: true, recorded: true }));
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    render(<PasskeySwitchControl target={{ kind: 'platform', setting: 'passkey_adds_on' }} on />);
    await openAndType(user, 'Turn off', 'PASSKEYS');
    await user.click(screen.getByRole('button', { name: 'Turn off new passkeys' }));
    await waitFor(() => expect(h.adds).toHaveBeenCalledWith({ on: false, confirm: 'PASSKEYS' }));
    expect(h.kill).not.toHaveBeenCalled();
    await waitFor(() => expect(h.toast.success).toHaveBeenCalledWith('New passkeys: Off.'));
  });

  it('an organization: sends its id, and after turning off says how many members still hold passkeys', async () => {
    h.org.mockResolvedValue(
      done({ on: false, changed: true, recorded: true, membersWithPasskeys: 3 }),
    );
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    render(
      <PasskeySwitchControl
        target={{ kind: 'organization', organizationId: ORG, organizationName: 'Example Academy' }}
        on
      />,
    );
    await openAndType(user, 'Turn off', 'PASSKEYS');
    await user.click(screen.getByRole('button', { name: 'Turn off passkeys for Example Academy' }));
    await waitFor(() =>
      expect(h.org).toHaveBeenCalledWith({ organizationId: ORG, on: false, confirm: 'PASSKEYS' }),
    );
    await waitFor(() =>
      expect(h.toast.success).toHaveBeenCalledWith(
        'Passkeys for Example Academy: Off. 3 members still hold passkeys. They keep working until they are removed.',
      ),
    );
  });

  it('a stale step-up asks for the code in place, then presses again with the same payload', async () => {
    h.kill
      .mockResolvedValueOnce({
        ok: false,
        error: {
          code: 'forbidden',
          message: 'Re-authenticate with MFA to change passkeys.',
          details: { reason: 'aal2_required' },
        },
      })
      .mockResolvedValueOnce(done({ on: true, changed: true, recorded: true }));
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    render(
      <PasskeySwitchControl target={{ kind: 'platform', setting: 'passkeys_on' }} on={false} />,
    );
    await openAndType(user, 'Turn on', 'PASSKEYS');
    await user.click(screen.getByRole('button', { name: 'Turn on passkeys for everyone' }));
    await waitFor(() => expect(h.kill).toHaveBeenCalledTimes(2));
    expect(h.ensure).toHaveBeenCalledTimes(1);
    expect(h.kill.mock.calls[1]).toEqual(h.kill.mock.calls[0]);
    await waitFor(() => expect(h.toast.success).toHaveBeenCalled());
  });

  it('a step-up the operator cancels presses nothing more and keeps the dialog', async () => {
    h.ensure.mockResolvedValue(false);
    h.kill.mockResolvedValue({
      ok: false,
      error: {
        code: 'forbidden',
        message: 'Re-authenticate with MFA to change passkeys.',
        details: { reason: 'aal2_required' },
      },
    });
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    render(
      <PasskeySwitchControl target={{ kind: 'platform', setting: 'passkeys_on' }} on={false} />,
    );
    await openAndType(user, 'Turn on', 'PASSKEYS');
    await user.click(screen.getByRole('button', { name: 'Turn on passkeys for everyone' }));
    await waitFor(() => expect(h.ensure).toHaveBeenCalled());
    expect(h.kill).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(h.refresh).not.toHaveBeenCalled();
  });

  it('an error is shown and the dialog stays open', async () => {
    h.kill.mockResolvedValue({
      ok: false,
      error: {
        code: 'internal_error',
        message:
          'The change could not be recorded in the platform audit, so passkeys were left off. Try again.',
      },
    });
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    render(
      <PasskeySwitchControl target={{ kind: 'platform', setting: 'passkeys_on' }} on={false} />,
    );
    await openAndType(user, 'Turn on', 'PASSKEYS');
    await user.click(screen.getByRole('button', { name: 'Turn on passkeys for everyone' }));
    await waitFor(() =>
      expect(h.toast.error).toHaveBeenCalledWith(
        'The change could not be recorded in the platform audit, so passkeys were left off. Try again.',
      ),
    );
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    // The page is refreshed anyway: the switch may have moved.
    expect(h.refresh).toHaveBeenCalled();
  });

  it('an OFF that answered an error keeps asking to turn off when the refresh shows the switch off', async () => {
    h.kill.mockResolvedValue({
      ok: false,
      error: {
        code: 'internal_error',
        message:
          'Could not confirm whether this passkey switch is off. Reload the page to see its state, and turn it off again if it is still on.',
      },
    });
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const { rerender } = render(
      <PasskeySwitchControl target={{ kind: 'platform', setting: 'passkeys_on' }} on />,
    );
    await openAndType(user, 'Turn off', 'PASSKEYS');
    await user.click(screen.getByRole('button', { name: 'Turn off passkeys for everyone' }));
    await waitFor(() => expect(h.toast.error).toHaveBeenCalled());
    // The refresh after the answer: the OFF had landed, so the page now shows it off.
    rerender(
      <PasskeySwitchControl target={{ kind: 'platform', setting: 'passkeys_on' }} on={false} />,
    );
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('Turn off passkeys for everyone?')).toBeInTheDocument();
    expect(screen.queryByText('Turn on passkeys for everyone?')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Turn on passkeys for everyone' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Turn off passkeys for everyone' }));
    await waitFor(() => expect(h.kill).toHaveBeenCalledTimes(2));
    for (const call of h.kill.mock.calls)
      expect(call[0]).toEqual({ on: false, confirm: 'PASSKEYS' });
  });

  it('opened again after the switch moved, the dialog asks for the change from its new state', async () => {
    h.adds.mockResolvedValue(done({ on: false, changed: true, recorded: true }));
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const { rerender } = render(
      <PasskeySwitchControl target={{ kind: 'platform', setting: 'passkey_adds_on' }} on />,
    );
    await openAndType(user, 'Turn off', 'PASSKEYS');
    await user.click(screen.getByRole('button', { name: 'Turn off new passkeys' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    rerender(
      <PasskeySwitchControl target={{ kind: 'platform', setting: 'passkey_adds_on' }} on={false} />,
    );
    await openAndType(user, 'Turn on', '');
    expect(screen.getByText('Turn on new passkeys?')).toBeInTheDocument();
    expect(screen.getByLabelText('Type PASSKEYS to confirm')).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Turn on new passkeys' })).toBeDisabled();
  });

  it('a press refused because its record could not be written says so and claims nothing', async () => {
    h.kill.mockResolvedValue({
      ok: false,
      error: {
        code: 'internal_error',
        message:
          'Could not record the change in the platform audit, so nothing was switched. Try again.',
      },
    });
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    render(<PasskeySwitchControl target={{ kind: 'platform', setting: 'passkeys_on' }} on />);
    await openAndType(user, 'Turn off', 'PASSKEYS');
    await user.click(screen.getByRole('button', { name: 'Turn off passkeys for everyone' }));
    await waitFor(() =>
      expect(h.toast.error).toHaveBeenCalledWith(
        'Could not record the change in the platform audit, so nothing was switched. Try again.',
      ),
    );
    expect(h.toast.success).not.toHaveBeenCalled();
    expect(h.toast.warning).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('an OFF made without its record says it was made and that the record is missing, with the count', async () => {
    h.org.mockResolvedValue(
      done({ on: false, changed: true, recorded: false, membersWithPasskeys: 2 }),
    );
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    render(
      <PasskeySwitchControl
        target={{ kind: 'organization', organizationId: ORG, organizationName: 'Example Academy' }}
        on
      />,
    );
    await openAndType(user, 'Turn off', 'PASSKEYS');
    await user.click(screen.getByRole('button', { name: 'Turn off passkeys for Example Academy' }));
    await waitFor(() =>
      expect(h.toast.warning).toHaveBeenCalledWith(
        'Turned off. The change was made, but its record could not be written to the platform audit. 2 members still hold passkeys. They keep working until they are removed.',
      ),
    );
    expect(h.toast.success).not.toHaveBeenCalled();
  });

  it('a press that changed nothing says it already was', async () => {
    h.kill.mockResolvedValue(done({ on: true, changed: false, recorded: false }));
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    render(
      <PasskeySwitchControl target={{ kind: 'platform', setting: 'passkeys_on' }} on={false} />,
    );
    await openAndType(user, 'Turn on', 'PASSKEYS');
    await user.click(screen.getByRole('button', { name: 'Turn on passkeys for everyone' }));
    await waitFor(() =>
      expect(h.toast.info).toHaveBeenCalledWith('Passkeys for everyone is already on.'),
    );
  });

  it('an OFF that found the switch off (read again after the press) says it is off', async () => {
    h.kill.mockResolvedValue(done({ on: false, changed: false, recorded: false }));
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    render(<PasskeySwitchControl target={{ kind: 'platform', setting: 'passkeys_on' }} on />);
    await openAndType(user, 'Turn off', 'PASSKEYS');
    await user.click(screen.getByRole('button', { name: 'Turn off passkeys for everyone' }));
    await waitFor(() =>
      expect(h.toast.info).toHaveBeenCalledWith('Passkeys for everyone is already off.'),
    );
    expect(h.toast.success).not.toHaveBeenCalled();
  });

  it('Cancel closes and forgets the typed word', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    render(
      <PasskeySwitchControl target={{ kind: 'platform', setting: 'passkeys_on' }} on={false} />,
    );
    await openAndType(user, 'Turn on', 'PASSK');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await user.click(screen.getByRole('button', { name: 'Turn on' }));
    expect(screen.getByLabelText('Type PASSKEYS to confirm')).toHaveValue('');
    expect(h.kill).not.toHaveBeenCalled();
  });
});
