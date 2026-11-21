import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

/**
 * Decision A on the page: the panel shows what the server allows. With
 * `listOnly` (the kill switch off, or passkeys unavailable here) the member's
 * passkeys with Remove and one sentence, nothing else; Add only when the
 * server says a passkey can be added; Finish only when it says a setup can
 * be finished.
 */

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
const toastSuccess = vi.hoisted(() => vi.fn());
vi.mock('sonner', () => ({ toast: { success: toastSuccess, error: vi.fn() } }));
vi.mock('@simplewebauthn/browser', () => ({
  browserSupportsWebAuthn: () => true,
  startAuthentication: vi.fn(),
  startRegistration: vi.fn(),
}));
vi.mock('@/server/actions/mfa-recovery', () => ({
  generateMfaRecoveryCodesAction: vi.fn(),
  consumeMfaRecoveryCodeAction: vi.fn(async () => ({ ok: true, data: { unenrolled: 1 } })),
}));
vi.mock('@/server/actions/passkeys', () => ({
  finishAddPasskeyAction: vi.fn(),
  finishPasskeySetupAction: vi.fn(),
  removePasskeyAction: vi.fn(),
  renamePasskeyAction: vi.fn(),
  startAddPasskeyAction: vi.fn(),
  startConfirmAddAction: vi.fn(),
  startPasskeySetupAction: vi.fn(),
}));

import { consumeMfaRecoveryCodeAction } from '@/server/actions/mfa-recovery';

import { PasskeysPanel } from './passkeys-panel';
import { PASSKEYS_PANEL_WORDS } from './passkeys-copy';

import type { PasskeysPanel as PanelData } from '@/server/security/passkeys';

const KEY = {
  id: 'p-1',
  name: 'Work laptop',
  createdAt: '2026-11-01T00:00:00Z',
  lastUsedAt: null,
  backedUp: true,
  unfinished: false,
};

function panel(extra: Partial<PanelData> = {}): PanelData {
  return {
    passkeys: [KEY],
    listOnly: null,
    canAdd: true,
    canFinish: false,
    atLimit: false,
    hasApp: true,
    proof: 'passkey_or_code',
    apps: [{ id: 'app-1', friendlyName: 'Phone' }],
    phoneConfirmation: false,
    aal2: true,
    onlyMethodUnfinished: false,
    addBlocked: false,
    ...extra,
  };
}

const buttons = () => screen.queryAllByRole('button').map((b) => b.textContent?.trim());

describe('the Passkeys panel (decision A)', () => {
  it('the whole panel: Rename, Remove and Add', () => {
    render(<PasskeysPanel data={panel()} />);
    expect(buttons()).toEqual(['Rename', 'Remove', PASSKEYS_PANEL_WORDS.add]);
    expect(screen.queryByText(PASSKEYS_PANEL_WORDS.turnedOff)).toBeNull();
  });

  it('the kill switch off: the list with Remove and one sentence, nothing else', () => {
    const { container } = render(
      <PasskeysPanel data={panel({ listOnly: 'turned_off', canAdd: false })} />,
    );
    expect(buttons()).toEqual(['Remove']);
    expect(screen.getByText(PASSKEYS_PANEL_WORDS.turnedOff)).toBeTruthy();
    expect(container.textContent).toContain('Work laptop');
  });

  it('passkeys unavailable here: the same, with its own sentence', () => {
    render(<PasskeysPanel data={panel({ listOnly: 'unavailable', canAdd: false })} />);
    expect(buttons()).toEqual(['Remove']);
    expect(screen.getByText(PASSKEYS_PANEL_WORDS.unavailable)).toBeTruthy();
  });

  it('list only never shows Add or the limit line, even if the data says a passkey could be added', () => {
    render(<PasskeysPanel data={panel({ listOnly: 'turned_off', canAdd: true, atLimit: true })} />);
    expect(buttons()).toEqual(['Remove']);
    expect(screen.queryByText(PASSKEYS_PANEL_WORDS.atLimit)).toBeNull();
  });

  it('list only hides Finish too, whatever the setup', () => {
    render(
      <PasskeysPanel
        data={panel({
          listOnly: 'turned_off',
          canAdd: false,
          canFinish: true,
          passkeys: [{ ...KEY, unfinished: true }],
        })}
      />,
    );
    expect(buttons()).toEqual(['Remove']);
  });

  it('an organization off (no Add): the list with Rename and Remove, no Add and no limit line', () => {
    render(<PasskeysPanel data={panel({ canAdd: false, atLimit: true })} />);
    expect(buttons()).toEqual(['Rename', 'Remove']);
    expect(screen.queryByText(PASSKEYS_PANEL_WORDS.atLimit)).toBeNull();
  });

  it('a setup not finished: Finish only when the server says it can be finished', () => {
    const unfinished = [{ ...KEY, unfinished: true }];
    const { unmount } = render(
      <PasskeysPanel data={panel({ passkeys: unfinished, canFinish: false, canAdd: false })} />,
    );
    expect(buttons()).toEqual(['Remove']);
    unmount();
    render(<PasskeysPanel data={panel({ passkeys: unfinished, canFinish: true, canAdd: false })} />);
    expect(buttons()).toEqual(['Finish', 'Remove']);
  });
});

describe('the second lab walk, FAIL 2: no Add can finish', () => {
  const blocked = () =>
    panel({
      passkeys: [],
      hasApp: false,
      apps: [],
      proof: 'code',
      addBlocked: true,
    });

  it('says why and offers the recovery code, never Add (so no code box for a code nobody has)', () => {
    render(<PasskeysPanel data={blocked()} />);
    expect(screen.getByText(PASSKEYS_PANEL_WORDS.addBlocked)).toBeTruthy();
    expect(buttons()).toEqual([PASSKEYS_PANEL_WORDS.useRecoveryCode]);
    expect(screen.queryByText(PASSKEYS_PANEL_WORDS.code)).toBeNull();
  });

  it('the recovery code dialog opens from it', () => {
    render(<PasskeysPanel data={blocked()} />);
    fireEvent.click(screen.getByRole('button', { name: PASSKEYS_PANEL_WORDS.useRecoveryCode }));
    expect(screen.getByLabelText('Recovery code')).toBeTruthy();
  });
});

describe('review 4 finding 4: an unfinished passkey that is the only method', () => {
  const onlyMethod = () =>
    panel({
      passkeys: [{ ...KEY, unfinished: true }],
      canAdd: false,
      canFinish: false,
      hasApp: false,
      apps: [],
      aal2: false,
      onlyMethodUnfinished: true,
    });

  it('says the two ways out instead of "sign in again with your second step", and offers the recovery code', () => {
    render(<PasskeysPanel data={onlyMethod()} />);
    expect(screen.getByText(PASSKEYS_PANEL_WORDS.onlyMethodUnfinished)).toBeTruthy();
    expect(screen.queryByText(PASSKEYS_PANEL_WORDS.stepUp)).toBeNull();
    expect(buttons()).toEqual(['Remove', PASSKEYS_PANEL_WORDS.useRecoveryCode]);
  });

  it('the recovery code is spent with the password, then the page is read again', async () => {
    render(<PasskeysPanel data={onlyMethod()} />);
    fireEvent.click(screen.getByRole('button', { name: PASSKEYS_PANEL_WORDS.useRecoveryCode }));
    fireEvent.change(screen.getByLabelText('Recovery code'), { target: { value: 'sample-code' } });
    fireEvent.change(screen.getByLabelText('Your password'), {
      target: { value: 'sample-password-not-real' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Use recovery code' }));
    await waitFor(() =>
      expect(consumeMfaRecoveryCodeAction).toHaveBeenCalledWith({
        code: 'SAMPLE-CODE',
        password: 'sample-password-not-real',
      }),
    );
  });

  it('stage 5: the dialog says the other devices are signed out, and a used code says what happened', async () => {
    render(<PasskeysPanel data={onlyMethod()} />);
    fireEvent.click(screen.getByRole('button', { name: PASSKEYS_PANEL_WORDS.useRecoveryCode }));
    expect(screen.getByRole('dialog')).toHaveTextContent(
      'Enter one of the recovery codes you saved and your password. The code is used up, every second step of your account is removed, passkeys included, and your other devices are signed out. You stay signed in here. Then set up a new one.',
    );
    fireEvent.change(screen.getByLabelText('Recovery code'), { target: { value: 'sample-code' } });
    fireEvent.change(screen.getByLabelText('Your password'), {
      target: { value: 'sample-password-not-real' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Use recovery code' }));
    await waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith(
        'Your sign-in methods were removed and your other devices were signed out. Set up a new one now.',
      ),
    );
  });

  it('a member with another second step keeps the old hint', () => {
    render(
      <PasskeysPanel data={panel({ aal2: false, passkeys: [{ ...KEY, unfinished: true }] })} />,
    );
    expect(screen.getByText(PASSKEYS_PANEL_WORDS.stepUp)).toBeTruthy();
    expect(screen.queryByText(PASSKEYS_PANEL_WORDS.onlyMethodUnfinished)).toBeNull();
  });
});

describe('the Add dialog’s warnings (the lab walk of stage 4, finding 1)', () => {
  const FIRST_SIGNS_OUT = 'Adding your first passkey signs you out on your other devices.';
  const PHONE =
    "The StockPilot phone app can't use passkeys yet: to keep using the app, keep or add an authenticator app too.";

  function openAdd(data: PanelData) {
    render(<PasskeysPanel data={data} />);
    fireEvent.click(screen.getByRole('button', { name: PASSKEYS_PANEL_WORDS.add }));
    return screen.getByRole('dialog').textContent ?? '';
  }

  it('a member with no other method is told the first passkey signs them out on their other devices', () => {
    const words = openAdd(
      panel({ passkeys: [], hasApp: false, apps: [], proof: 'password', aal2: false }),
    );
    expect(words).toContain(FIRST_SIGNS_OUT);
    expect(words).toContain(PHONE);
    expect(words).toContain('use a passkey only on a device that only you unlock');
    expect(words).toContain('Save your recovery codes');
  });

  it('an authenticator-app holder is told nothing about their other devices (they stay signed in)', () => {
    const words = openAdd(panel({ passkeys: [], hasApp: true, proof: 'code' }));
    expect(words).not.toContain(FIRST_SIGNS_OUT);
    expect(words).not.toMatch(/other devices/);
    // The phone-app warning stays as decided.
    expect(words).toContain(PHONE);
  });

  it.each([
    ['a passkey holder adding another', { proof: 'passkey' as const, hasApp: false, apps: [] }],
    ['a holder of both', { proof: 'passkey_or_code' as const }],
  ])('%s is told nothing about other devices', (_who, extra) => {
    const words = openAdd(panel(extra));
    expect(words).not.toMatch(/other devices/);
    expect(words).toContain(PHONE);
  });
});
