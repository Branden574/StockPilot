'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { Check, Loader2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import * as React from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { publishAuthState } from '@/components/auth/auth-state';
import { safeRedirectPath } from '@/lib/auth/safe-redirect';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PasswordInput } from '@/components/ui/password-input';
import { signInAction } from '@/server/actions/auth';

import { ACCOUNT_DISABLED_PATH, signInSchema, type SignInInput } from '@stockpilot/core';

export function SignInForm() {
  const router = useRouter();
  const params = useSearchParams();
  const redirect = safeRedirectPath(params.get('redirect'));

  // Cosmetic only — drives the panel beside the form. Never read by any
  // authentication decision, and the flow is identical if it is ignored.
  const [succeeded, setSucceeded] = React.useState(false);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<SignInInput>({
    resolver: zodResolver(signInSchema),
    mode: 'onBlur',
    reValidateMode: 'onChange',
    defaultValues: { email: '', password: '', rememberMe: true },
  });

  const onSubmit = handleSubmit(async (values) => {
    publishAuthState('submitting');
    const res = await signInAction(values);
    if (!res.ok) {
      publishAuthState('idle');
      // A disabled account gets the dedicated screen, not a toast: the message
      // is not something a user can act on from the form, and a toast vanishes
      // before it can be read.
      if (res.error.code === 'account_disabled') {
        router.replace(ACCOUNT_DISABLED_PATH);
        return;
      }
      toast.error(res.error.message);
      return;
    }
    // If the action returns next='/signin/mfa', the user has MFA enrolled
    // and needs to complete the second factor before reaching the dashboard.
    if (res.data.next === '/signin/mfa') {
      const params = new URLSearchParams();
      if (redirect && redirect !== '/dashboard') params.set('redirect', redirect);
      const qs = params.toString();
      router.replace(`/signin/mfa${qs ? `?${qs}` : ''}`);
      router.refresh();
      return;
    }
    // The confirmation rides the navigation that was already happening. There
    // is deliberately no await, no timeout and no "continue" step between this
    // and router.replace — a success animation must never cost the user time.
    publishAuthState('success');
    setSucceeded(true);
    toast.success('Signed in.');
    router.replace(redirect);
    router.refresh();
  });

  return (
    <form onSubmit={onSubmit} className="space-y-4" noValidate>
      <div className="auth-field space-y-2">
        <Label htmlFor="email">Email</Label>
        <Input
          id="email"
          type="email"
          autoComplete="email"
          placeholder="you@company.com"
          {...register('email')}
          onFocus={() => publishAuthState('email')}
          onBlur={(e) => {
            register('email').onBlur(e);
            publishAuthState('idle');
          }}
          aria-invalid={!!errors.email}
        />
        <p className="auth-msg text-destructive text-xs" role="alert">
          {errors.email?.message ?? ''}
        </p>
      </div>

      <div className="auth-field space-y-2">
        <div className="flex items-center justify-between">
          <Label htmlFor="password">Password</Label>
          <Link href="/reset" className="text-muted-foreground hover:text-foreground text-xs">
            Forgot?
          </Link>
        </div>
        <PasswordInput
          id="password"
          autoComplete="current-password"
          {...register('password')}
          onFocus={() => publishAuthState('password')}
          onBlur={(e) => {
            register('password').onBlur(e);
            publishAuthState('idle');
          }}
          aria-invalid={!!errors.password}
        />
        <p className="auth-msg text-destructive text-xs" role="alert">
          {errors.password?.message ?? ''}
        </p>
      </div>

      <label className="text-muted-foreground flex items-center gap-2.5 text-sm">
        <input
          type="checkbox"
          className="border-border accent-foreground h-4 w-4 rounded"
          {...register('rememberMe')}
        />
        <span>Remember me on this device</span>
      </label>

      <Button
        type="submit"
        className="w-full"
        variant="gradient"
        size="lg"
        disabled={isSubmitting || succeeded}
      >
        {succeeded ? (
          <span className="auth-submit-done">
            <Check className="h-4 w-4" aria-hidden />
            Welcome back
          </span>
        ) : isSubmitting ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          'Sign in'
        )}
      </Button>
    </form>
  );
}
