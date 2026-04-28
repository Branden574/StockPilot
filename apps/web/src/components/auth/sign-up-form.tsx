'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { Loader2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { signUpAction } from '@/server/actions/auth';

import { signUpSchema, type SignUpInput } from '@stockpilot/core';

export function SignUpForm() {
  const router = useRouter();
  const [emailSent, setEmailSent] = React.useState(false);

  const {
    register,
    handleSubmit,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<SignUpInput>({
    resolver: zodResolver(signUpSchema),
    defaultValues: { email: '', password: '', fullName: '' },
  });

  const onSubmit = handleSubmit(async (values) => {
    const res = await signUpAction(values);
    if (!res.ok) {
      toast.error(res.error.message);
      return;
    }
    if (res.data.requiresEmailConfirm) {
      setEmailSent(true);
      return;
    }
    toast.success('Account created');
    router.replace('/onboarding');
    router.refresh();
  });

  if (emailSent) {
    return (
      <div className="space-y-3 text-center">
        <p className="text-sm">
          We sent a confirmation link to <strong>{watch('email')}</strong>. Click it to finish
          creating your account.
        </p>
        <p className="text-xs text-muted-foreground">
          Didn't get it? Check spam, or wait a minute and try again.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4" noValidate>
      <div className="space-y-2">
        <Label htmlFor="fullName">Full name</Label>
        <Input
          id="fullName"
          autoComplete="name"
          placeholder="Jane Doe"
          {...register('fullName')}
          aria-invalid={!!errors.fullName}
        />
        {errors.fullName && <p className="text-xs text-destructive">{errors.fullName.message}</p>}
      </div>

      <div className="space-y-2">
        <Label htmlFor="email">Work email</Label>
        <Input
          id="email"
          type="email"
          autoComplete="email"
          placeholder="you@company.com"
          {...register('email')}
          aria-invalid={!!errors.email}
        />
        {errors.email && <p className="text-xs text-destructive">{errors.email.message}</p>}
      </div>

      <div className="space-y-2">
        <Label htmlFor="password">Password</Label>
        <Input
          id="password"
          type="password"
          autoComplete="new-password"
          {...register('password')}
          aria-invalid={!!errors.password}
        />
        {errors.password ? (
          <p className="text-xs text-destructive">{errors.password.message}</p>
        ) : (
          <p className="text-xs text-muted-foreground">
            8+ characters with upper, lower, and a number.
          </p>
        )}
      </div>

      <Button type="submit" className="w-full" variant="gradient" size="lg" disabled={isSubmitting}>
        {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Create account'}
      </Button>
    </form>
  );
}
