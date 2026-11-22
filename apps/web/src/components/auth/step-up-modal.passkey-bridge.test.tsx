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
 * server answers that the account has no app beside the bridge, the modal
 * asks for no code at all: its title and description say plainly that this
 * confirmation cannot be done here yet and what to do, never "No
 * authenticator is enrolled" (review 2-3 finding 9, review B finding 6).
 *
 * Fail closed: a factor with the reserved name is never offered for a code
 * here, whatever the server answered. When the server gives no answer, or
 * says the bridge record could not be read, the modal offers the account's
 * other apps only; with none left it says, in its own words for a list it
 * could not load, to try again, and no code can be sent.
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

async function openStepUp(title: RegExp = /confirm with your authenticator/i) {
  render(<Harness />);
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Do the dangerous thing' }));
  });
  return screen.findByRole('dialog', { name: title });
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

  it('when the server cannot answer, the app alone is offered: a reserved-name factor is never listed', async () => {
    const user = userEvent.setup();
    listFactors.mockResolvedValue({ data: { totp: [BRIDGE, APP] }, error: null });
    stepUpMethodsAction.mockResolvedValue({
      ok: false,
      error: { code: 'internal_error', message: 'x' },
    });
    await openStepUp();
    await waitFor(() => expect(stepUpMethodsAction).toHaveBeenCalledTimes(1));
    // One app: the code field alone, no Authenticator select.
    await waitFor(() => expect(screen.getByLabelText('Authentication code')).toBeInTheDocument());
    expect(screen.queryByLabelText('Authenticator')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    await user.type(screen.getByLabelText('Authentication code'), '123456');
    await user.click(screen.getByRole('button', { name: 'Verify' }));
    expect(challengeFactorAction.mock.calls).toEqual([[{ factorId: APP.id, code: '123456' }]]);
  });

  it('when the server cannot answer and two apps sit beside reserved-name factors, only the apps can be chosen', async () => {
    const SECOND = { ...APP, id: 'f-app-2', friendly_name: 'Tablet' };
    const STRAY = { ...BRIDGE, id: 'f-stray', friendly_name: 'sp-passkey-bridge-zzz' };
    listFactors.mockResolvedValue({ data: { totp: [BRIDGE, APP, STRAY, SECOND] }, error: null });
    stepUpMethodsAction.mockResolvedValue({
      ok: false,
      error: { code: 'rate_limited', message: 'x' },
    });
    await openStepUp();
    const select = await screen.findByLabelText('Authenticator');
    expect(Array.from((select as HTMLSelectElement).options).map((o) => o.value)).toEqual([
      APP.id,
      SECOND.id,
    ]);
  });

  it.each([
    [
      'the server cannot answer',
      () =>
        stepUpMethodsAction.mockResolvedValue({
          ok: false,
          error: { code: 'internal_error', message: 'x' },
        }),
    ],
    ['the request itself fails', () => stepUpMethodsAction.mockRejectedValue(new Error('network'))],
    [
      'the server says the bridge record could not be read',
      () =>
        stepUpMethodsAction.mockResolvedValue({
          ok: true,
          data: { apps: [], recordsUnread: true },
        }),
    ],
  ])(
    'only a reserved-name factor and %s: the try-again words, and no code can be sent',
    async (_name, arrange) => {
      listFactors.mockResolvedValue({ data: { totp: [BRIDGE] }, error: null });
      arrange();
      const dialog = await openStepUp();
      await waitFor(() => expect(stepUpMethodsAction).toHaveBeenCalledTimes(1));
      expect(await screen.findByRole('alert')).toHaveTextContent(
        'Could not load your authenticator. Try again.',
      );
      // Not the words of an account with nothing set up, nor of one whose
      // confirmation cannot be done here at all: this is a passing fault.
      expect(dialog.textContent).not.toMatch(/No authenticator is enrolled|can't be done here/);
      expect(dialog.textContent).not.toContain('sp-passkey-bridge');
      expect(screen.queryByLabelText('Authenticator')).not.toBeInTheDocument();
      // No factor is chosen, so Verify stays off whatever is typed.
      fireEvent.change(screen.getByLabelText('Authentication code'), {
        target: { value: '123456' },
      });
      expect(screen.getByRole('button', { name: 'Verify' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled();
      expect(challengeFactorAction).not.toHaveBeenCalled();
    },
  );

  it('the server says the bridge record could not be read, and names an app: the app is offered as usual', async () => {
    const user = userEvent.setup();
    listFactors.mockResolvedValue({ data: { totp: [BRIDGE, APP] }, error: null });
    stepUpMethodsAction.mockResolvedValue({
      ok: true,
      data: { apps: [{ id: APP.id, friendlyName: 'Phone' }], recordsUnread: true },
    });
    await openStepUp();
    await waitFor(() => expect(stepUpMethodsAction).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByLabelText('Authentication code')).toBeInTheDocument());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    await user.type(screen.getByLabelText('Authentication code'), '123456');
    await user.click(screen.getByRole('button', { name: 'Verify' }));
    expect(challengeFactorAction.mock.calls).toEqual([[{ factorId: APP.id, code: '123456' }]]);
  });

  it('only the bridge: no code asked anywhere, one plain sentence that says it cannot be done here yet and what to do', async () => {
    listFactors.mockResolvedValue({ data: { totp: [BRIDGE] }, error: null });
    stepUpMethodsAction.mockResolvedValue({ ok: true, data: { apps: [] } });
    const dialog = await openStepUp(/^confirm it's you$/i);
    await waitFor(() => expect(stepUpMethodsAction).toHaveBeenCalledTimes(1));
    expect(
      screen.getByText(
        "This confirmation can't be done here yet, so close this and ask your organization's owner or StockPilot support for help.",
      ),
    ).toBeInTheDocument();
    // Nothing on the dialog asks for a code: no title, description, field,
    // button or alert speaks of one, and no recovery code is offered.
    expect(dialog.textContent).not.toMatch(/code|authenticator app|6-digit|recovery/i);
    expect(screen.queryByText(/No authenticator is enrolled/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Authenticator')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Authentication code')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Verify' })).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled();
    expect(challengeFactorAction).not.toHaveBeenCalled();
  });

  it('when the request itself fails, the app alone is offered', async () => {
    listFactors.mockResolvedValue({ data: { totp: [BRIDGE, APP] }, error: null });
    stepUpMethodsAction.mockRejectedValue(new Error('network'));
    await openStepUp();
    await waitFor(() => expect(stepUpMethodsAction).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByLabelText('Authentication code')).toBeInTheDocument());
    expect(screen.queryByLabelText('Authenticator')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('with the server answering, its order is kept as it is', async () => {
    const SECOND = { ...APP, id: 'f-app-2', friendly_name: 'Tablet' };
    listFactors.mockResolvedValue({ data: { totp: [BRIDGE, APP, SECOND] }, error: null });
    stepUpMethodsAction.mockResolvedValue({
      ok: true,
      data: {
        apps: [
          { id: SECOND.id, friendlyName: 'Tablet' },
          { id: APP.id, friendlyName: 'Phone' },
        ],
      },
    });
    await openStepUp();
    const select = await screen.findByLabelText('Authenticator');
    expect(Array.from((select as HTMLSelectElement).options).map((o) => o.value)).toEqual([
      SECOND.id,
      APP.id,
    ]);
  });
});
