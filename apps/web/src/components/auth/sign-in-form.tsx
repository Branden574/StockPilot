'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { Loader2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import * as React from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PasswordInput } from '@/components/ui/password-input';
import { signInAction } from '@/server/actions/auth';

import { signInSchema, type SignInInput } from '@stockpilot/core';

export function SignInForm() {
  const router = useRouter();
  const params = useSearchParams();
  const redirect = params.get('redirect') ?? '/dashboard';

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
    const res = await signInAction(values);
    if (!res.ok) {
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
    toast.success('Welcome back');
    router.replace(redirect);
    router.refresh();
  });

  return (
    <form onSubmit={onSubmit} className="space-y-4" noValidate>
      <div className="space-y-2">
        <Label htmlFor="email">Email</Label>
        <Input
          id="email"
          type="email"
          autoComplete="email"
          placeholder="you@company.com"
          {...register('email')}
          aria-invalid={!!errors.email}
        />
        {errors.email && <p className="text-destructive text-xs">{errors.email.message}</p>}
      </div>

      <div className="space-y-2">
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
          aria-invalid={!!errors.password}
        />
        {errors.password && <p className="text-destructive text-xs">{errors.password.message}</p>}
      </div>

      <label className="text-muted-foreground flex items-center gap-2.5 text-sm">
        <input
          type="checkbox"
          className="border-border accent-foreground h-4 w-4 rounded"
          {...register('rememberMe')}
        />
        <span>Remember me on this device</span>
      </label>

      <Button type="submit" className="w-full" variant="gradient" size="lg" disabled={isSubmitting}>
        {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Sign in'}
      </Button>
    </form>
  );
}
