'use client';

import { Loader2, ShieldCheck } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { challengeFactorAction } from '@/server/actions/mfa';
import { signOutAction } from '@/server/actions/auth';

interface MfaChallengeFormProps {
  factorId: string;
}

export function MfaChallengeForm({ factorId }: MfaChallengeFormProps) {
  const router = useRouter();
  const params = useSearchParams();
  const redirect = params.get('redirect') ?? '/dashboard';
  const [code, setCode] = React.useState('');
  const [pending, setPending] = React.useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (code.length !== 6) {
      toast.error('Enter the 6-digit code from your authenticator');
      return;
    }
    setPending(true);
    const res = await challengeFactorAction({ factorId, code });
    setPending(false);
    if (!res.ok) {
      toast.error(res.error.message);
      setCode('');
      return;
    }
    router.replace(redirect);
    router.refresh();
  }

  async function cancel() {
    await signOutAction();
    router.replace('/signin');
    router.refresh();
  }

  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      <div className="flex items-start gap-3 rounded-lg border border-border bg-card p-3 text-sm">
        <ShieldCheck className="mt-0.5 h-5 w-5 text-muted-foreground" />
        <p className="text-muted-foreground">
          Open your authenticator app and enter the 6-digit code for StockPilot.
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="mfa-code">Authentication code</Label>
        <Input
          id="mfa-code"
          inputMode="numeric"
          autoComplete="one-time-code"
          autoFocus
          placeholder="123456"
          maxLength={6}
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
          className="font-mono tracking-widest"
        />
      </div>

      <Button
        type="submit"
        className="w-full"
        variant="gradient"
        size="lg"
        disabled={pending || code.length !== 6}
      >
        {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Verify & continue'}
      </Button>

      <button
        type="button"
        className="w-full text-center text-xs text-muted-foreground hover:text-foreground"
        onClick={cancel}
      >
        Cancel and sign out
      </button>
    </form>
  );
}
