// @vitest-environment happy-dom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Security invariant: the step-up modal never asks for the code of a
 * passkey's bridge factor (plan 3.1 #3).
 *
 * The browser's factor list cannot tell the bridge from an app: only the
 * server knows the recorded bridge (lib/auth/passkey-bridge.ts). So when the
 * browser lists a factor with the reserved name, the modal asks the server
 * once (stepUpMethodsAction) for the account's apps, and offers those. With no
 * reserved-name factor nothing new happens (the Classic pins in
 * __classic__/step-up-modal.*.txt hold that DOM byte for byte). When the
 * server cannot answer, the browser's list is used as it is: nothing is
 * hidden, and challengeFactorAction still refuses the bridge.
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

import { useStepUp } from './step-up-modal';

const APP = { id: 'app-1', friendly_name: 'Phone', status: 'verified' };
const BRIDGE = { id: 'bridge-1', friendly_name: 'sp-passkey-bridge-a1b2c3', status: 'verified' };

function Harness() {
  const stepUp = useStepUp();
  const [result, setResult] = React.useState('none');
  return (
    <>
      <p data-testid="result">{result}</p>
      <button
        type="button"
        onClick={() => void stepUp.ensure().then((ok) => setResult(String(ok)))}
      >
        Do the dangerous thing
      </button>
      {stepUp.modal}
    </>
  );
}

async function openStepUp() {
  render(<Harness />);
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Do the dangerous thing' }));
  });
  return screen.findByRole('dialog', { name: /confirm with your authenticator/i });
}

beforeEach(() => {
  vi.clearAllMocks();
  challengeFactorAction.mockResolvedValue({ ok: true, data: undefined });
  stepUpMethodsAction.mockResolvedValue({
    ok: true,
    data: { apps: [{ id: APP.id, friendlyName: 'Phone' }] },
  });
});

describe('StepUpModal and the passkey bridge', () => {
  it('with no reserved-name factor listed, the server is not asked', async () => {
    listFactors.mockResolvedValue({ data: { totp: [APP] }, error: null });
    await openStepUp();
    await waitFor(() => expect(listFactors).toHaveBeenCalled());
    expect(screen.getByLabelText('Authentication code')).toBeInTheDocument();
    expect(stepUpMethodsAction).not.toHaveBeenCalled();
  });

  it('with the bridge listed first, the server’s apps are offered and the app’s code is checked', async () => {
    const user = userEvent.setup();
    listFactors.mockResolvedValue({ data: { totp: [BRIDGE, APP] }, error: null });
    await openStepUp();
    await waitFor(() => expect(stepUpMethodsAction).toHaveBeenCalledTimes(1));
    // One app: the code field alone, no Authenticator select.
    await waitFor(() => expect(screen.queryByLabelText('Authenticator')).not.toBeInTheDocument());
    await user.type(screen.getByLabelText('Authentication code'), '123456');
    await user.click(screen.getByRole('button', { name: 'Verify' }));
    expect(challengeFactorAction).toHaveBeenCalledWith({ factorId: APP.id, code: '123456' });
    await waitFor(() => expect(screen.getByTestId('result')).toHaveTextContent('true'));
  });

  it('when the server cannot answer, the browser’s list is used as it is', async () => {
    listFactors.mockResolvedValue({ data: { totp: [BRIDGE, APP] }, error: null });
    stepUpMethodsAction.mockResolvedValue({
      ok: false,
      error: { code: 'internal_error', message: 'x' },
    });
    await openStepUp();
    await waitFor(() => expect(stepUpMethodsAction).toHaveBeenCalledTimes(1));
    const select = await screen.findByLabelText('Authenticator');
    expect(Array.from((select as HTMLSelectElement).options).map((o) => o.value)).toEqual([
      BRIDGE.id,
      APP.id,
    ]);
  });

  it('when the request itself fails, the browser’s list is used as it is', async () => {
    listFactors.mockResolvedValue({ data: { totp: [BRIDGE, APP] }, error: null });
    stepUpMethodsAction.mockRejectedValue(new Error('network'));
    await openStepUp();
    await waitFor(() => expect(stepUpMethodsAction).toHaveBeenCalledTimes(1));
    expect(await screen.findByLabelText('Authenticator')).toBeInTheDocument();
  });
});
