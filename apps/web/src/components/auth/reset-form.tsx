'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { Loader2 } from 'lucide-react';
import * as React from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { requestPasswordResetAction } from '@/server/actions/auth';

import { requestPasswordResetSchema, type RequestPasswordResetInput } from '@stockpilot/core';

export function ResetForm() {
  const [submitted, setSubmitted] = React.useState(false);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<RequestPasswordResetInput>({
    resolver: zodResolver(requestPasswordResetSchema),
    mode: 'onBlur',
    reValidateMode: 'onChange',
    defaultValues: { email: '' },
  });

  const onSubmit = handleSubmit(async (values) => {
    await requestPasswordResetAction(values);
    setSubmitted(true);
    toast.success('If an account exists, we sent a reset link.');
  });

  if (submitted) {
    return (
      <p className="text-center text-sm text-muted-foreground">
        Check your inbox for a password reset link.
      </p>
    );
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4" noValidate>
      <div className="space-y-2">
        <Label htmlFor="email">Email</Label>
        <Input
          id="email"
          type="email"
          autoComplete="email"
          {...register('email')}
          aria-invalid={!!errors.email}
        />
        {errors.email && <p className="text-xs text-destructive">{errors.email.message}</p>}
      </div>
      <Button type="submit" className="w-full" variant="gradient" size="lg" disabled={isSubmitting}>
        {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Send reset link'}
      </Button>
    </form>
  );
}
