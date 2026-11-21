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

  it('a member with another second step keeps the old hint', () => {
    render(
      <PasskeysPanel data={panel({ aal2: false, passkeys: [{ ...KEY, unfinished: true }] })} />,
    );
    expect(screen.getByText(PASSKEYS_PANEL_WORDS.stepUp)).toBeTruthy();
    expect(screen.queryByText(PASSKEYS_PANEL_WORDS.onlyMethodUnfinished)).toBeNull();
  });
});
