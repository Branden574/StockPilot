'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { Loader2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';

import { PasskeyButton } from '@/components/auth/passkey-button';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PasswordInput } from '@/components/ui/password-input';
import { isControlFlow } from '@/lib/control-flow';
import { purgeInterruptedRuns } from '@/lib/interrupted-run';
import { completePasswordResetAction } from '@/server/actions/auth';
import { startPasswordResetPasskeyAction } from '@/server/actions/passkeys';

import { completePasswordResetSchema, type CompletePasswordResetInput } from '@stockpilot/core';

/** The step-up modal's words when the request itself never got an answer. */
const NO_ANSWER_COPY = 'Could not reach the server. Try again.';
const CODE_SHAPE_COPY = 'Enter the 6-digit code from your authenticator app.';

/** The reset's passkey words that only the browser says (stage 5; plan section 4). */
export const RESET_PASSKEY_WORDS = {
  orCode: 'Or enter the 6-digit code from your authenticator app.',
  noSupport:
    "This browser can't use passkeys. Use another browser: choose Forgot? on the sign-in page there to get a new link.",
  /** With an authenticator app too, the code box is right there. */
  noSupportWithApp:
    "This browser can't use passkeys. Enter the 6-digit code from your authenticator app instead.",
} as const;

type ResetPasskeyMethod = 'passkey' | 'both';
const passkeyMethodOf = (
  details: Record<string, unknown> | undefined,
): ResetPasskeyMethod | null =>
  details?.method === 'passkey' || details?.method === 'both' ? details.method : null;

export function ResetCompleteForm() {
  const router = useRouter();
  const codeRef = React.useRef<HTMLInputElement>(null);
  // The authenticator code (docket B50). GoTrue refuses a new password on a
  // reset link's session for an account with an authenticator until a code
  // raises that session to AAL2, so the action asks for one (details.reason
  // 'aal2_required') and takes it as `totpCode`. The code lives in its own
  // state, never in the form: zodResolver hands onSubmit the schema's parsed
  // output, and the schema drops keys it does not have, so a registered code
  // would never reach the action, which would ask for it forever.
  const [needsCode, setNeedsCode] = React.useState(false);
  const [code, setCode] = React.useState('');
  /** The server's request for the code: the box's description, not an error. */
  const [codeAsk, setCodeAsk] = React.useState<string | null>(null);
  /** A refusal, or a request that got no answer, stays on the form: a toast is
   *  gone in seconds. */
  const [error, setError] = React.useState<string | null>(null);
  // Each request to put the focus in the code box, once it is on screen: when
  // it first appears, and when a new code is needed.
  const [focusCode, setFocusCode] = React.useState(0);
  /**
   * Stage 5: the server offers the account's passkey ('passkey': the only way;
   * 'both': the passkey, or the code of an authenticator app). Kept once
   * offered. Only the server sets it: with passkeys not usable it never
   * does, and the form is the one of before.
   */
  const [passkeyMethod, setPasskeyMethod] = React.useState<ResetPasskeyMethod | null>(null);
  const [passkeyAsk, setPasskeyAsk] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (focusCode > 0) codeRef.current?.focus();
  }, [focusCode]);

  const {
    register,
    handleSubmit,
    getValues,
    trigger,
    formState: { errors, isSubmitting },
  } = useForm<CompletePasswordResetInput>({
    resolver: zodResolver(completePasswordResetSchema),
    mode: 'onBlur',
    reValidateMode: 'onChange',
    defaultValues: { password: '', confirmPassword: '' },
  });

  /**
   * One press of the reset: the passwords, with the code when the box is up,
   * or with the passkey's answer (stage 5). Answers the words to show next to
   * the passkey button, or null when the form showed its own (or moved on).
   */
  async function send(
    values: CompletePasswordResetInput,
    passkeyAnswer: { challengeId: string; response: unknown } | null,
  ): Promise<string | null> {
    // Setting the new password signs the account out everywhere, this tab
    // included: a sign-out on purpose, so what an interrupted run kept in this
    // tab (lib/interrupted-run) goes before the request does, the press that
    // carries the code (or the passkey's answer) included.
    purgeInterruptedRuns();
    setError(null);
    const codeSent = needsCode && !passkeyAnswer;
    let res: Awaited<ReturnType<typeof completePasswordResetAction>>;
    try {
      res = await completePasswordResetAction(
        passkeyAnswer
          ? { ...values, passkeyAnswer }
          : codeSent
            ? { ...values, totpCode: code }
            : values,
      );
    } catch (e) {
      // A redirect: the router is already on its way, so nothing is shown.
      if (isControlFlow(e)) return null;
      // The request itself failed (a dropped connection, a deploy that no
      // longer has the action). Nothing changed, so the same press can be
      // made again.
      setError(NO_ANSWER_COPY);
      return null;
    }
    if (!res.ok) {
      if (res.error.details?.secondStep === 'done') {
        // The session already passed the second step and the new password was
        // refused (the review of stage 5, finding 5): no second step is asked
        // again, so the passkey and the code box go, Update password shows,
        // and the next press sends the passwords alone, with no device prompt
        // the server would not read.
        setPasskeyMethod(null);
        setPasskeyAsk(null);
        setNeedsCode(false);
        setCode('');
        setCodeAsk(null);
        toast.error(res.error.message);
        setError(res.error.message);
        return null;
      }
      const method = passkeyMethodOf(res.error.details);
      if (method) {
        // The passkey is offered (stage 5): its button, and with an app the
        // code box too. A refused passkey answer is shown by the button.
        setPasskeyMethod(method);
        if (passkeyAnswer) return res.error.message;
        if (method === 'passkey') {
          setPasskeyAsk(res.error.message);
          return null;
        }
      }
      if (res.error.details?.reason === 'aal2_required') {
        // The account has an authenticator. Both passwords stay as typed.
        if (codeSent) {
          // The code was refused, could not be checked, or the code step
          // asked for a pause (too many code attempts): a new one is needed.
          setCode('');
          setError(res.error.message);
        } else {
          // The box appears and says what it is for.
          setNeedsCode(true);
          setCodeAsk(res.error.message);
        }
        setFocusCode((n) => n + 1);
        return null;
      }
      // Anything else (a refused password, too many presses from this
      // address, an expired link) keeps the box and its code: once a code is
      // accepted the session is AAL2, and the server skips the code on the
      // next press.
      toast.error(res.error.message);
      setError(res.error.message);
      return null;
    }
    toast.success('Password updated.');
    router.replace(res.data.next);
    router.refresh();
    return null;
  }

  const onSubmit = handleSubmit(async (values) => {
    if (needsCode && !/^\d{6}$/.test(code)) {
      setError(CODE_SHAPE_COPY);
      setFocusCode((n) => n + 1);
      return;
    }
    await send(values, null);
  });

  return (
    <form onSubmit={onSubmit} className="space-y-4" noValidate>
      <div className="space-y-2">
        <Label htmlFor="password">New password</Label>
        <PasswordInput
          id="password"
          autoComplete="new-password"
          className="sm:h-10"
          {...register('password')}
          aria-invalid={!!errors.password}
        />
        {errors.password && <p className="text-destructive text-xs">{errors.password.message}</p>}
      </div>

      <div className="space-y-2">
        <Label htmlFor="confirmPassword">Confirm password</Label>
        <PasswordInput
          id="confirmPassword"
          autoComplete="new-password"
          className="sm:h-10"
          {...register('confirmPassword')}
          aria-invalid={!!errors.confirmPassword}
        />
        {errors.confirmPassword && (
          <p className="text-destructive text-xs">{errors.confirmPassword.message}</p>
        )}
      </div>

      {passkeyMethod && (
        <div className="space-y-2" data-reset-passkey={passkeyMethod}>
          {passkeyMethod === 'passkey' && passkeyAsk ? (
            <p className="text-muted-foreground text-xs">{passkeyAsk}</p>
          ) : null}
          <PasskeyButton
            onPassed={() => {}}
            start={startPasswordResetPasskeyAction}
            // The passwords are checked before the device prompt, then sent
            // with the passkey's answer in one press.
            ready={() => trigger()}
            finish={(challengeId, response) => send(getValues(), { challengeId, response })}
            noSupportWords={
              passkeyMethod === 'both'
                ? RESET_PASSKEY_WORDS.noSupportWithApp
                : RESET_PASSKEY_WORDS.noSupport
            }
          />
          {passkeyMethod === 'both' ? (
            <p className="text-muted-foreground text-center text-xs">
              {RESET_PASSKEY_WORDS.orCode}
            </p>
          ) : null}
        </div>
      )}

      {needsCode && (
        <div className="space-y-2">
          <Label htmlFor="reset-code">Authentication code</Label>
          <Input
            ref={codeRef}
            id="reset-code"
            inputMode="numeric"
            autoComplete="one-time-code"
            placeholder="123456"
            value={code}
            // Digits only, the first six. No maxLength: a browser cuts a pasted
            // "123 456" at six characters before this runs, leaving five digits.
            onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
            aria-describedby={codeAsk ? 'reset-code-ask reset-code-help' : 'reset-code-help'}
            className="font-mono tracking-widest sm:h-10"
          />
          {codeAsk && (
            <p id="reset-code-ask" className="text-muted-foreground text-xs">
              {codeAsk}
            </p>
          )}
          {/* Support, not an administrator: no admin path removes another
              member's authenticator. */}
          <p id="reset-code-help" className="text-muted-foreground text-xs">
            Can&apos;t get a code?{' '}
            <Link href="/support" className="text-foreground font-medium hover:underline">
              Contact support
            </Link>
            .
          </p>
        </div>
      )}

      {error && (
        <p className="text-destructive text-xs" role="alert">
          {error}
        </p>
      )}

      {passkeyMethod === 'passkey' ? null : (
        <Button
          type="submit"
          className="h-11 w-full text-[14px]"
          variant="gradient"
          size="lg"
          disabled={isSubmitting}
        >
          {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Update password'}
        </Button>
      )}
    </form>
  );
}
