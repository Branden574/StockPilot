'use client';

import { KeyRound, Loader2, ShieldCheck } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { challengeFactorAction } from '@/server/actions/mfa';
import { signOutAction } from '@/server/actions/auth';
import { consumeMfaRecoveryCodeAction } from '@/server/actions/mfa-recovery';

interface MfaChallengeFormProps {
  factorId: string;
}

export function MfaChallengeForm({ factorId }: MfaChallengeFormProps) {
  const router = useRouter();
  const params = useSearchParams();
  const redirect = params.get('redirect') ?? '/dashboard';
  const [code, setCode] = React.useState('');
  const [pending, setPending] = React.useState(false);
  const [recoveryOpen, setRecoveryOpen] = React.useState(false);
  const [recoveryCode, setRecoveryCode] = React.useState('');
  const [recoveryPending, setRecoveryPending] = React.useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (code.length !== 6) {
      toast.error('Enter the 6-digit code from your authenticator app.');
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

  async function recover(e: React.FormEvent) {
    e.preventDefault();
    if (!recoveryCode.trim()) {
      toast.error('Enter a recovery code.');
      return;
    }
    setRecoveryPending(true);
    const res = await consumeMfaRecoveryCodeAction({ code: recoveryCode.trim() });
    setRecoveryPending(false);
    if (!res.ok) {
      toast.error(res.error.message);
      return;
    }
    toast.success(
      `Recovery code accepted. ${res.data.unenrolled} factor${res.data.unenrolled === 1 ? '' : 's'} removed — re-enroll a new device on the next page.`,
    );
    setRecoveryOpen(false);
    router.replace('/dashboard/settings/security');
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
        className="text-muted-foreground hover:text-foreground flex w-full items-center justify-center gap-1.5 text-center text-xs"
        onClick={() => setRecoveryOpen(true)}
      >
        <KeyRound className="h-3 w-3" /> Lost your phone? Use a recovery code
      </button>

      <button
        type="button"
        className="w-full text-center text-xs text-muted-foreground hover:text-foreground"
        onClick={cancel}
      >
        Cancel and sign out
      </button>

      <Dialog open={recoveryOpen} onOpenChange={setRecoveryOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Use a recovery code</DialogTitle>
            <DialogDescription>
              Enter one of the recovery codes you saved when you set up
              two-factor authentication. The code will be consumed and your
              authenticator factor will be removed so you can re-enroll a new
              device.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={recover} className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="recovery-code">Recovery code</Label>
              <Input
                id="recovery-code"
                value={recoveryCode}
                onChange={(e) => setRecoveryCode(e.target.value.toUpperCase())}
                placeholder="XXXX-XXXX-XXXX-XXXX"
                className="font-mono tracking-widest"
                maxLength={32}
                autoFocus
              />
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setRecoveryOpen(false)}
                disabled={recoveryPending}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={recoveryPending}>
                {recoveryPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  'Use recovery code'
                )}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </form>
  );
}
