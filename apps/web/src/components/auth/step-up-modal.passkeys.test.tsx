// @vitest-environment happy-dom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Stage 4: the step-up modal's passkey branch (plan section 4). Shown only
 * when the server's methods answer says the account's passkey answers here
 * (every condition of server/security/passkeys.ts passkeyGate and a healthy
 * bridge); a member without a passkey never reaches it (the four Classic pins
 * stay byte-identical, step-up-modal.classic-dom.test.tsx). The browser's
 * WebAuthn call is mocked here; the server's ceremony is passkeys.test.ts.
 */

const listFactors = vi.fn();
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({ auth: { mfa: { listFactors: () => listFactors() } } }),
}));
const challengeFactorAction = vi.fn();
const stepUpMethodsAction = vi.fn();
vi.mock('@/server/actions/mfa', () => ({
  challengeFactorAction: (...args: unknown[]) => challengeFactorAction(...args),
  stepUpMethodsAction: (...args: unknown[]) => stepUpMethodsAction(...args),
}));
const startSecondStepAction = vi.fn();
const finishSecondStepAction = vi.fn();
vi.mock('@/server/actions/passkeys', () => ({
  startSecondStepAction: (...a: unknown[]) => startSecondStepAction(...a),
  finishSecondStepAction: (...a: unknown[]) => finishSecondStepAction(...a),
}));
const startAuthentication = vi.fn();
vi.mock('@simplewebauthn/browser', () => ({
  browserSupportsWebAuthn: () => true,
  startAuthentication: (...a: unknown[]) => startAuthentication(...a),
}));

import { useStepUp } from './step-up-modal';

const APP = { id: 'app-1', friendly_name: 'Phone', status: 'verified' };
const BRIDGE = { id: 'bridge-1', friendly_name: 'sp-passkey-bridge-a1b2c3', status: 'verified' };

function Harness() {
  const stepUp = useStepUp();
  const [result, setResult] = React.useState('none');
  return (
    <>
      <p data-testid="result">{result}</p>
      <button type="button" onClick={() => void stepUp.ensure().then((ok) => setResult(String(ok)))}>
        Do the dangerous thing
      </button>
      {stepUp.modal}
    </>
  );
}

async function open() {
  render(<Harness />);
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Do the dangerous thing' }));
  });
  return screen.findByRole('dialog', { name: /confirm it's you/i });
}

beforeEach(() => {
  vi.clearAllMocks();
  listFactors.mockResolvedValue({ data: { totp: [BRIDGE] }, error: null });
  challengeFactorAction.mockResolvedValue({ ok: true, data: undefined });
  startSecondStepAction.mockResolvedValue({
    ok: true,
    data: { kind: 'options', challengeId: 'c-1', optionsJSON: { challenge: 'x' } },
  });
  startAuthentication.mockResolvedValue({ id: 'cred' });
  finishSecondStepAction.mockResolvedValue({ ok: true, data: undefined });
});

describe('StepUpModal with a passkey', () => {
  it('passkey only: "Confirm it\'s you", the passkey button, no code box and no Verify; a passed passkey resolves the step-up', async () => {
    stepUpMethodsAction.mockResolvedValue({ ok: true, data: { apps: [], passkey: true } });
    const dialog = await open();
    expect(dialog.textContent).toContain('This action needs a fresh check. Use your passkey.');
    expect(screen.queryByLabelText('Authentication code')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Verify' })).toBeNull();
    expect(dialog.textContent).not.toMatch(/6-digit/);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /use your passkey/i }));
    });
    await waitFor(() => expect(screen.getByTestId('result').textContent).toBe('true'));
    expect(finishSecondStepAction).toHaveBeenCalledWith({ challengeId: 'c-1', response: { id: 'cred' } });
    expect(challengeFactorAction).not.toHaveBeenCalled();
  });

  it('a passkey and an app: the button, then the code box for the app (never the bridge)', async () => {
    listFactors.mockResolvedValue({ data: { totp: [BRIDGE, APP] }, error: null });
    stepUpMethodsAction.mockResolvedValue({ ok: true, data: { apps: [{ id: APP.id, friendlyName: 'Phone' }], passkey: true } });
    const dialog = await open();
    expect(dialog.textContent).toContain(
      'This action needs a fresh check. Use your passkey, or enter the 6-digit code from your authenticator app.',
    );
    expect(screen.getByRole('button', { name: /use your passkey/i })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Authentication code'), { target: { value: '123456' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Verify' }));
    });
    expect(challengeFactorAction).toHaveBeenCalledWith({ factorId: APP.id, code: '123456' });
  });

  it('a refusal is shown in an alert next to the button, and the modal stays open', async () => {
    stepUpMethodsAction.mockResolvedValue({ ok: true, data: { apps: [], passkey: true } });
    finishSecondStepAction.mockResolvedValue({
      ok: false,
      error: { code: 'validation_error', message: 'That passkey answer was not accepted. Try again.' },
    });
    await open();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /use your passkey/i }));
    });
    await waitFor(() => expect(screen.getAllByRole('alert').some((a) => /not accepted/.test(a.textContent ?? ''))).toBe(true));
    expect(screen.getByTestId('result').textContent).toBe('none');
  });

  it('the device prompt starts only from a press, never on opening', async () => {
    stepUpMethodsAction.mockResolvedValue({ ok: true, data: { apps: [], passkey: true } });
    await open();
    expect(startSecondStepAction).not.toHaveBeenCalled();
    expect(startAuthentication).not.toHaveBeenCalled();
  });

  it('passkey false keeps stage 2 exactly: only the bridge gives the plain sentence, no button', async () => {
    stepUpMethodsAction.mockResolvedValue({ ok: true, data: { apps: [], passkey: false } });
    const dialog = await open();
    expect(dialog.textContent).toContain("This confirmation can't be done here yet");
    expect(screen.queryByRole('button', { name: /use your passkey/i })).toBeNull();
  });
});
