// @vitest-environment happy-dom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The MFA step-up modal (useStepUp): one TOTP check in place, then the
 * caller retries its action. The redesign (P2.4) keeps every step and word;
 * it pins that the modal stacks above the dialog that opened it, and fixes
 * two dead ends found on the way.
 */

const listFactors = vi.fn();
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({ auth: { mfa: { listFactors: () => listFactors() } } }),
}));
const challengeFactorAction = vi.fn();
vi.mock('@/server/actions/mfa', () => ({
  challengeFactorAction: (...args: unknown[]) => challengeFactorAction(...args),
}));

import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';

import { useStepUp } from './step-up-modal';

const FACTOR = { id: 'factor-1', friendly_name: 'Phone', status: 'verified' };

function Harness({ inDialog = false }: { inDialog?: boolean }) {
  const stepUp = useStepUp();
  const [result, setResult] = React.useState<string>('none');
  const trigger = (
    <button type="button" onClick={() => void stepUp.ensure().then((ok) => setResult(String(ok)))}>
      Do the dangerous thing
    </button>
  );
  return (
    <>
      <p data-testid="result">{result}</p>
      {inDialog ? (
        <Dialog open>
          <DialogContent>
            <DialogTitle>Restore this snapshot?</DialogTitle>
            {trigger}
          </DialogContent>
        </Dialog>
      ) : (
        trigger
      )}
      {stepUp.modal}
    </>
  );
}

async function openStepUp(props: { inDialog?: boolean } = {}) {
  render(<Harness {...props} />);
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Do the dangerous thing' }));
  });
  return screen.findByRole('dialog', { name: /confirm with your authenticator/i });
}

beforeEach(() => {
  vi.clearAllMocks();
  listFactors.mockResolvedValue({ data: { totp: [FACTOR] }, error: null });
  challengeFactorAction.mockResolvedValue({ ok: true, data: undefined });
});

describe('StepUpModal', () => {
  it('asks for the 6-digit code; Verify waits for six digits; letters are dropped', async () => {
    const user = userEvent.setup();
    await openStepUp();
    const code = screen.getByLabelText('Authentication code');
    const verify = screen.getByRole('button', { name: 'Verify' });
    expect(verify).toBeDisabled();
    await user.type(code, '12a34');
    expect(code).toHaveValue('1234');
    expect(verify).toBeDisabled();
    await user.type(code, '56');
    expect(verify).toBeEnabled();
  });

  it('a good code steps up, closes and resolves true', async () => {
    const user = userEvent.setup();
    await openStepUp();
    await waitFor(() => expect(listFactors).toHaveBeenCalled());
    await user.type(screen.getByLabelText('Authentication code'), '123456');
    await user.click(screen.getByRole('button', { name: 'Verify' }));
    expect(challengeFactorAction).toHaveBeenCalledWith({ factorId: 'factor-1', code: '123456' });
    await waitFor(() => expect(screen.getByTestId('result')).toHaveTextContent('true'));
    expect(screen.queryByRole('dialog', { name: /authenticator/i })).not.toBeInTheDocument();
  });

  it('a refused code says why, clears the field and stays open', async () => {
    const user = userEvent.setup();
    challengeFactorAction.mockResolvedValue({ ok: false, error: { message: 'Invalid code' } });
    await openStepUp();
    await waitFor(() => expect(listFactors).toHaveBeenCalled());
    await user.type(screen.getByLabelText('Authentication code'), '123456');
    await user.click(screen.getByRole('button', { name: 'Verify' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid code');
    expect(screen.getByLabelText('Authentication code')).toHaveValue('');
  });

  it('Cancel resolves false', async () => {
    const user = userEvent.setup();
    await openStepUp();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.getByTestId('result')).toHaveTextContent('false'));
  });

  it('with no verified authenticator it says to add one', async () => {
    listFactors.mockResolvedValue({ data: { totp: [] }, error: null });
    await openStepUp();
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'No authenticator is enrolled. Add one in Settings → Security first.',
    );
  });

  it('offers a choice when there are several authenticators', async () => {
    listFactors.mockResolvedValue({
      data: { totp: [FACTOR, { id: 'factor-2', friendly_name: null, status: 'verified' }] },
      error: null,
    });
    await openStepUp();
    const select = await screen.findByLabelText('Authenticator');
    expect(select).toHaveValue('factor-1');
    expect(screen.getByRole('option', { name: 'Authenticator (factor)' })).toBeInTheDocument();
    // The shared text-field recipe (DESIGN-SPEC 2.4 item 3 and 6.3; P2.2's
    // Input, so the code field below it matches once P2.2 lands): the stronger
    // hairline (--line2) on the card fill, never the 1.26:1 input hairline
    // alone, and a visible focus ring.
    expect(select).toHaveClass('border-[var(--ed-line-strong)]', 'bg-card', 'focus-visible:ring-2');
    expect(select).not.toHaveClass('border-input');
  });

  // Mutation caught: an unreadable list (auth-js answers { data: null, error })
  // read as "No authenticator is enrolled", which tells an enrolled admin to
  // enrol again.
  it('an unreadable factor list says it could not be read, not that none is enrolled', async () => {
    listFactors.mockResolvedValue({ data: null, error: { message: 'gateway timeout' } });
    await openStepUp();
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not load your authenticator. Try again.',
    );
    expect(screen.queryByText(/No authenticator is enrolled/)).not.toBeInTheDocument();
  });

  // Mutation caught: no catch around the action. A request that never got an
  // answer left Verify spinning with Cancel disabled and the modal impossible
  // to close until a reload, and the caller's action hung behind it.
  it('a request that never gets an answer says so, and the modal can be retried or closed', async () => {
    const user = userEvent.setup();
    challengeFactorAction
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce({ ok: true, data: undefined });
    await openStepUp();
    await waitFor(() => expect(listFactors).toHaveBeenCalled());
    await user.type(screen.getByLabelText('Authentication code'), '123456');
    await user.click(screen.getByRole('button', { name: 'Verify' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not reach the server. Try again.',
    );
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled();
    // The code is kept, so Verify sends it again.
    await user.click(screen.getByRole('button', { name: 'Verify' }));
    expect(challengeFactorAction).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(screen.getByTestId('result')).toHaveTextContent('true'));
  });

  it('stacks above the dialog that opened it', async () => {
    const stepUp = await openStepUp({ inDialog: true });
    // The host is aria-hidden behind the step-up (Radix hides what is under
    // the top dialog), so it is found by its title.
    const host = screen.getByText('Restore this snapshot?').closest('[role="dialog"]')!;
    expect(host).not.toBeNull();
    expect(host).not.toBe(stepUp);
    const zOf = (el: Element) => {
      const m = /(?:^|\s)z-(?:\[(\d+)\]|(\d+))(?:\s|$)/.exec(el.className);
      return Number(m?.[1] ?? m?.[2] ?? 0);
    };
    expect(zOf(stepUp)).toBeGreaterThan(zOf(host));
    // And it comes after the host in the document, so its scrim covers it.
    expect(host.compareDocumentPosition(stepUp) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
