'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { Loader2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PasswordInput } from '@/components/ui/password-input';
import { isControlFlow } from '@/lib/control-flow';
import { purgeInterruptedRuns } from '@/lib/interrupted-run';
import { completePasswordResetAction } from '@/server/actions/auth';

import { completePasswordResetSchema, type CompletePasswordResetInput } from '@stockpilot/core';

/** The step-up modal's words when the request itself never got an answer. */
const NO_ANSWER_COPY = 'Could not reach the server. Try again.';
const CODE_SHAPE_COPY = 'Enter the 6-digit code from your authenticator app.';

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

  React.useEffect(() => {
    if (focusCode > 0) codeRef.current?.focus();
  }, [focusCode]);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<CompletePasswordResetInput>({
    resolver: zodResolver(completePasswordResetSchema),
    mode: 'onBlur',
    reValidateMode: 'onChange',
    defaultValues: { password: '', confirmPassword: '' },
  });

  const onSubmit = handleSubmit(async (values) => {
    if (needsCode && !/^\d{6}$/.test(code)) {
      setError(CODE_SHAPE_COPY);
      setFocusCode((n) => n + 1);
      return;
    }
    // Setting the new password signs the account out everywhere, this tab
    // included: a sign-out on purpose, so what an interrupted run kept in this
    // tab (lib/interrupted-run) goes before the request does, the press that
    // carries the code included.
    purgeInterruptedRuns();
    setError(null);
    const codeSent = needsCode;
    let res: Awaited<ReturnType<typeof completePasswordResetAction>>;
    try {
      res = await completePasswordResetAction(codeSent ? { ...values, totpCode: code } : values);
    } catch (e) {
      // A redirect: the router is already on its way, so nothing is shown.
      if (isControlFlow(e)) return;
      // The request itself failed (a dropped connection, a deploy that no
      // longer has the action). Nothing changed, so the same press can be
      // made again.
      setError(NO_ANSWER_COPY);
      return;
    }
    if (!res.ok) {
      if (res.error.details?.reason === 'aal2_required') {
        // The account has an authenticator. Both passwords stay as typed.
        if (codeSent) {
          // The code was refused, or could not be checked: a new one is needed.
          setCode('');
          setError(res.error.message);
        } else {
          // The box appears and says what it is for.
          setNeedsCode(true);
          setCodeAsk(res.error.message);
        }
        setFocusCode((n) => n + 1);
        return;
      }
      // Anything else (a refused password, too many attempts, an expired
      // link) keeps the box and its code: once a code is accepted the session
      // is AAL2, and the server skips the code on the next press.
      toast.error(res.error.message);
      setError(res.error.message);
      return;
    }
    toast.success('Password updated.');
    router.replace(res.data.next);
    router.refresh();
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

      <Button
        type="submit"
        className="h-11 w-full text-[14px]"
        variant="gradient"
        size="lg"
        disabled={isSubmitting}
      >
        {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Update password'}
      </Button>
    </form>
  );
}
