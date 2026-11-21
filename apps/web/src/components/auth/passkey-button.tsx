'use client';

import { browserSupportsWebAuthn, startAuthentication } from '@simplewebauthn/browser';
import { KeyRound, Loader2 } from 'lucide-react';
import * as React from 'react';

import { Button } from '@/components/ui/button';
import { isControlFlow } from '@/lib/control-flow';
import { finishSecondStepAction, startSecondStepAction } from '@/server/actions/passkeys';

import type { ActionResult } from '@stockpilot/core';
import type { SecondStepStart } from '@/server/security/passkeys';

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
 *
 * The password reset (stage 5) brings its own `start` (purpose
 * password_reset) and `finish` (the reset itself, which carries the answer and
 * the new password, and answers the words to show here, or null when it
 * showed its own), `ready` (the form's own check before the device prompt)
 * and its words for a browser with no passkeys.
 */
export function PasskeyButton({
  onPassed,
  onRemovalFinished,
  showHint = true,
  start = startSecondStepAction,
  finish,
  ready,
  noSupportWords = PASSKEY_BUTTON_WORDS.noSupport,
}: {
  onPassed: () => void;
  onRemovalFinished?: () => void;
  showHint?: boolean;
  start?: () => Promise<ActionResult<SecondStepStart>>;
  finish?: (challengeId: string, response: unknown) => Promise<string | null>;
  ready?: () => Promise<boolean>;
  noSupportWords?: string;
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
      setError(noSupportWords);
      return;
    }
    setError(null);
    if (ready && !(await ready())) return;
    setPending(true);
    try {
      const started = await start();
      if (!started.ok) {
        setError(started.error.message);
        return;
      }
      if (started.data.kind === 'removal_finished') {
        onRemovalFinished?.();
        return;
      }
      let response: unknown;
      try {
        response = await startAuthentication({ optionsJSON: started.data.optionsJSON as never });
      } catch {
        // The member closed the prompt, or the device had no passkey for us.
        setError(PASSKEY_BUTTON_WORDS.cancelled);
        return;
      }
      if (finish) {
        const words = await finish(started.data.challengeId, response);
        if (words) setError(words);
        return;
      }
      const finished = await finishSecondStepAction({
        challengeId: started.data.challengeId,
        response,
      });
      if (!finished.ok) {
        setError(finished.error.message);
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
