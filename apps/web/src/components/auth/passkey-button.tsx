'use client';

import { browserSupportsWebAuthn, startAuthentication } from '@simplewebauthn/browser';
import { KeyRound, Loader2 } from 'lucide-react';
import * as React from 'react';

import { Button } from '@/components/ui/button';
import { isControlFlow } from '@/lib/control-flow';
import { finishSecondStepAction, startSecondStepAction } from '@/server/actions/passkeys';

/** The words of section 4 the browser says itself (the server's come in its answers). */
export const PASSKEY_BUTTON_WORDS = {
  label: 'Use your passkey',
  hint: 'Your device will ask for your face, fingerprint or PIN.',
  cancelled: 'No passkey was used. Try again when you are ready.',
  noSupport: "This browser can't use passkeys. Use another browser, or a recovery code.",
  noAnswer: 'Could not reach StockPilot. Check your connection and try again.',
} as const;

/**
 * "Use your passkey": the second step on the sign-in page and in the step-up
 * modal (plan section 4). The device prompt only ever starts from a press,
 * never on page load. Every error is shown in a role="alert" region next to
 * the button. `onPassed` runs once the server has raised this session;
 * `onRemovalFinished` when the server finished a removal the member started
 * instead (nothing is owed any more: the page refreshes).
 */
export function PasskeyButton({
  onPassed,
  onRemovalFinished,
  showHint = true,
}: {
  onPassed: () => void;
  onRemovalFinished?: () => void;
  showHint?: boolean;
}) {
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const supported = React.useMemo(() => {
    try {
      return browserSupportsWebAuthn();
    } catch {
      return false;
    }
  }, []);

  async function press() {
    if (!supported) {
      setError(PASSKEY_BUTTON_WORDS.noSupport);
      return;
    }
    setPending(true);
    setError(null);
    try {
      const start = await startSecondStepAction();
      if (!start.ok) {
        setError(start.error.message);
        return;
      }
      if (start.data.kind === 'removal_finished') {
        onRemovalFinished?.();
        return;
      }
      let response: unknown;
      try {
        response = await startAuthentication({ optionsJSON: start.data.optionsJSON as never });
      } catch {
        // The member closed the prompt, or the device had no passkey for us.
        setError(PASSKEY_BUTTON_WORDS.cancelled);
        return;
      }
      const finish = await finishSecondStepAction({ challengeId: start.data.challengeId, response });
      if (!finish.ok) {
        setError(finish.error.message);
        return;
      }
      onPassed();
    } catch (e) {
      if (isControlFlow(e)) return;
      setError(PASSKEY_BUTTON_WORDS.noAnswer);
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="space-y-2" data-passkey="second-step">
      <Button type="button" className="w-full" onClick={press} disabled={pending}>
        {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}
        {PASSKEY_BUTTON_WORDS.label}
      </Button>
      {showHint ? <p className="text-muted-foreground text-[12px]">{PASSKEY_BUTTON_WORDS.hint}</p> : null}
      <div role="alert" aria-live="assertive">
        {error ? <p className="text-destructive text-[12px]">{error}</p> : null}
      </div>
    </div>
  );
}
