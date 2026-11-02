'use client';

import { Loader2, ShieldCheck, ShieldOff } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { DestructiveConfirm } from '@/components/ui/destructive-confirm';
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
  const [password, setPassword] = React.useState('');
  const [pending, setPending] = React.useState(false);
  const [disableTarget, setDisableTarget] = React.useState<string | null>(null);

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
    if (!password) {
      toast.error('Confirm your password to finish enrollment.');
      return;
    }
    setPending(true);
    const res = await verifyEnrollmentAction({
      factorId: enrollment.factorId,
      code,
      password,
    });
    setPending(false);
    if (!res.ok) {
      toast.error(res.error.message);
      return;
    }
    toast.success('Authenticator enabled.');
    setEnrollment(null);
    setCode('');
    setPassword('');
    setStep('idle');
    // Hard-navigate to clear the ?enroll=1 query and force a fresh
    // session-aware render of the layout — router.refresh() alone left
    // users on the same URL where the gate could fire again.
    if (typeof window !== 'undefined') {
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- deliberate HARD navigation (new 16.3 rule): enrollment changes the session's AAL, and only a full document load re-runs middleware + server layouts with the new session. router.push()/refresh() left users where the enroll gate re-fired.
      window.location.assign('/dashboard');
    } else {
      router.refresh();
    }
  }

  async function confirmDisable() {
    if (!disableTarget) return;
    setPending(true);
    const res = await unenrollFactorAction({ factorId: disableTarget });
    setPending(false);
    if (!res.ok) {
      toast.error(res.error.message);
      return;
    }
    setDisableTarget(null);
    toast.success('Authenticator disabled.');
    router.refresh();
  }

  if (verifiedFactors.length > 0) {
    return (
      <div className="space-y-3">
        <div className="border-success/30 bg-success-wash flex items-start gap-3 rounded-lg border p-4 text-[13px]">
          <ShieldCheck aria-hidden className="text-success mt-0.5 h-5 w-5 shrink-0" />
          <div className="min-w-0 flex-1">
            <p className="font-medium">Two-factor authentication is on</p>
            <p className="text-ink-2 mt-1 text-[12.5px]">
              You'll be asked for a 6-digit code from your authenticator app every time you sign in.
            </p>
          </div>
        </div>
        <ul className="space-y-2">
          {verifiedFactors.map((f) => (
            <li
              key={f.id}
              className="border-border bg-card flex min-h-11 items-center justify-between gap-3 rounded-lg border px-3 py-2"
            >
              <div className="flex min-w-0 items-center gap-2 text-[13px]">
                <ShieldCheck aria-hidden className="text-muted-foreground h-4 w-4 shrink-0" />
                <span>{f.friendlyName ?? 'Authenticator app'}</span>
              </div>
              {!policyRequired && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setDisableTarget(f.id)}
                  disabled={pending}
                >
                  <ShieldOff aria-hidden className="h-3.5 w-3.5" /> Disable
                </Button>
              )}
            </li>
          ))}
        </ul>
        {policyRequired && (
          <p className="text-muted-foreground text-[12px]">
            Your organization requires MFA. To disable your authenticator, an admin must lower the
            policy first.
          </p>
        )}
        <DestructiveConfirm
          open={disableTarget !== null}
          onOpenChange={(v) => {
            if (!v) setDisableTarget(null);
          }}
          title="Disable two-factor authentication?"
          description="You'll only need your password to sign in until you re-enroll. We strongly recommend keeping an authenticator app on your account."
          confirmLabel="Disable"
          pending={pending}
          onConfirm={confirmDisable}
        />
      </div>
    );
  }

  if (step === 'verify' && enrollment) {
    return (
      <div className="space-y-4">
        <div className="border-border bg-sunk rounded-lg border p-4">
          <p className="text-[13.5px] font-medium">Step 1 — scan with your authenticator app</p>
          <p className="text-muted-foreground mt-1 text-[12.5px]">
            Open Google Authenticator, 1Password, Authy, or any TOTP app and scan this code.
          </p>
          <div className="mt-3 flex justify-center">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={enrollment.qrCode}
              alt="Scan with your authenticator app"
              className="border-border h-44 w-44 rounded-md border bg-white p-2"
            />
          </div>
          <details className="text-muted-foreground mt-3 text-[12.5px]">
            <summary className="hover:text-foreground focus-visible:ring-ring inline-flex min-h-8 cursor-pointer items-center rounded-sm focus-visible:outline-none focus-visible:ring-2">
              Can't scan? Show secret key
            </summary>
            <p className="bg-card text-foreground mt-2 break-all rounded-md border px-2.5 py-1.5 font-mono text-[12px]">
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
            value={code}
            // Digits only, the first six. No maxLength: a browser cuts a pasted
            // "123 456" at six characters before this runs, leaving five digits.
            onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
            className="font-mono tracking-widest"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="mfa-verify-password">Step 3 — confirm your password</Label>
          <Input
            id="mfa-verify-password"
            type="password"
            autoComplete="current-password"
            placeholder="Your account password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <p className="text-muted-foreground text-[12px]">
            We re-check your password so a stolen session can't enroll an attacker's authenticator
            app.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            onClick={() => {
              setEnrollment(null);
              setCode('');
              setPassword('');
              setStep('idle');
            }}
            disabled={pending}
          >
            Cancel
          </Button>
          <Button onClick={verifyCode} disabled={pending || code.length !== 6 || !password}>
            {pending ? <Loader2 aria-hidden className="animate-spin" /> : null}
            Verify &amp; enable
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="border-warning/40 bg-warning-wash flex items-start gap-3 rounded-lg border p-4 text-[13px]">
        <ShieldOff aria-hidden className="text-warning mt-0.5 h-5 w-5 shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="font-medium">Two-factor authentication is off</p>
          <p className="text-ink-2 mt-1 text-[12.5px]">
            Add an authenticator app for an extra layer of sign-in security.
            {policyRequired &&
              ' Your organization requires MFA — please enroll to keep using StockPilot.'}
          </p>
        </div>
      </div>
      <Button onClick={startEnroll} disabled={pending}>
        {pending ? <Loader2 aria-hidden className="animate-spin" /> : null}
        Set up authenticator app
      </Button>
    </div>
  );
}
