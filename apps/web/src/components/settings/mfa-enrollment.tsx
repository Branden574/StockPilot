'use client';

import { Loader2, ShieldCheck, ShieldOff } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  enrollFactorAction,
  unenrollFactorAction,
  verifyEnrollmentAction,
} from '@/server/actions/mfa';

interface MfaFactor {
  id: string;
  status: 'verified' | 'unverified';
  friendlyName: string | null;
}

interface MfaEnrollmentProps {
  verifiedFactors: MfaFactor[];
  policyRequired: boolean;
}

export function MfaEnrollment({ verifiedFactors, policyRequired }: MfaEnrollmentProps) {
  const router = useRouter();
  const [step, setStep] = React.useState<'idle' | 'enroll' | 'verify'>('idle');
  const [enrollment, setEnrollment] = React.useState<{
    factorId: string;
    qrCode: string;
    secret: string;
  } | null>(null);
  const [code, setCode] = React.useState('');
  const [pending, setPending] = React.useState(false);

  async function startEnroll() {
    setPending(true);
    const res = await enrollFactorAction();
    setPending(false);
    if (!res.ok) {
      toast.error(res.error.message);
      return;
    }
    setEnrollment({
      factorId: res.data.factorId,
      qrCode: res.data.qrCode,
      secret: res.data.secret,
    });
    setStep('verify');
  }

  async function verifyCode() {
    if (!enrollment) return;
    setPending(true);
    const res = await verifyEnrollmentAction({ factorId: enrollment.factorId, code });
    setPending(false);
    if (!res.ok) {
      toast.error(res.error.message);
      return;
    }
    toast.success('Authenticator enabled');
    setEnrollment(null);
    setCode('');
    setStep('idle');
    router.refresh();
  }

  async function disableFactor(factorId: string) {
    if (
      !confirm(
        'Disable your authenticator? You will only need your password to sign in until you re-enroll.',
      )
    )
      return;
    setPending(true);
    const res = await unenrollFactorAction({ factorId });
    setPending(false);
    if (!res.ok) {
      toast.error(res.error.message);
      return;
    }
    toast.success('Authenticator disabled');
    router.refresh();
  }

  if (verifiedFactors.length > 0) {
    return (
      <div className="space-y-3">
        <div className="flex items-start gap-3 rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm dark:border-emerald-900/50 dark:bg-emerald-950/30">
          <ShieldCheck className="mt-0.5 h-5 w-5 text-emerald-700 dark:text-emerald-400" />
          <div className="flex-1">
            <p className="font-medium">Two-factor authentication is on</p>
            <p className="text-muted-foreground mt-1 text-xs">
              You'll be asked for a 6-digit code from your authenticator app every time you
              sign in.
            </p>
          </div>
        </div>
        <ul className="space-y-2">
          {verifiedFactors.map((f) => (
            <li
              key={f.id}
              className="flex items-center justify-between rounded-lg border border-border bg-card px-3 py-2"
            >
              <div className="flex items-center gap-2 text-sm">
                <ShieldCheck className="h-4 w-4 text-muted-foreground" />
                <span>{f.friendlyName ?? 'Authenticator app'}</span>
              </div>
              {!policyRequired && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => disableFactor(f.id)}
                  disabled={pending}
                >
                  <ShieldOff className="mr-1 h-3.5 w-3.5" /> Disable
                </Button>
              )}
            </li>
          ))}
        </ul>
        {policyRequired && (
          <p className="text-[11px] text-muted-foreground">
            Your organization requires MFA. To disable your authenticator, an admin must
            lower the policy first.
          </p>
        )}
      </div>
    );
  }

  if (step === 'verify' && enrollment) {
    return (
      <div className="space-y-4">
        <div className="rounded-lg border border-border bg-card p-4">
          <p className="text-sm font-medium">Step 1 — scan with your authenticator app</p>
          <p className="text-muted-foreground mt-1 text-xs">
            Open Google Authenticator, 1Password, Authy, or any TOTP app and scan this code.
          </p>
          <div className="mt-3 flex justify-center">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={enrollment.qrCode}
              alt="Scan with your authenticator app"
              className="h-44 w-44 rounded-md border border-border bg-white p-2"
            />
          </div>
          <details className="mt-3 text-xs text-muted-foreground">
            <summary className="cursor-pointer">Can't scan? Show secret key</summary>
            <p className="mt-2 break-all rounded bg-muted/40 px-2 py-1.5 font-mono text-[11px]">
              {enrollment.secret}
            </p>
          </details>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="mfa-verify-code">Step 2 — enter the 6-digit code</Label>
          <Input
            id="mfa-verify-code"
            inputMode="numeric"
            autoComplete="one-time-code"
            placeholder="123456"
            maxLength={6}
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
            className="font-mono tracking-widest"
          />
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            onClick={() => {
              setEnrollment(null);
              setCode('');
              setStep('idle');
            }}
            disabled={pending}
          >
            Cancel
          </Button>
          <Button onClick={verifyCode} disabled={pending || code.length !== 6}>
            {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Verify & enable'}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm dark:border-amber-900/50 dark:bg-amber-950/30">
        <ShieldOff className="mt-0.5 h-5 w-5 text-amber-700 dark:text-amber-400" />
        <div className="flex-1">
          <p className="font-medium">Two-factor authentication is off</p>
          <p className="text-muted-foreground mt-1 text-xs">
            Add an authenticator app for an extra layer of sign-in security.
            {policyRequired &&
              ' Your organization requires MFA — please enroll to keep using StockPilot.'}
          </p>
        </div>
      </div>
      <Button onClick={startEnroll} disabled={pending}>
        {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Set up authenticator app'}
      </Button>
    </div>
  );
}
