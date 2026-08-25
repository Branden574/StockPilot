'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { Loader2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';

import { useStepUp } from '@/components/auth/step-up-modal';
import { Badge } from '@/components/ui/badge';
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
import { PasswordInput } from '@/components/ui/password-input';
import {
  cancelEmailChangeAction,
  requestEmailChangeAction,
  resendEmailChangeAction,
} from '@/server/actions/email-change';

import { changeEmailSchema, type ActionResult, type ChangeEmailInput } from '@stockpilot/core';

/**
 * Settings → Profile → Email. Three states, all driven by GoTrue's own
 * pending state (passed in by the server page — the client never decides
 * what is verified):
 *
 *   Normal   current@ · Verified · [Change email]
 *   Pending  current@ (Current) → new@ (Pending) · sent … · [Resend] [Cancel]
 *   Changed  a one-time "Email updated" panel after the second confirmation
 *
 * The change dialog asks for the new address and the current password. If the
 * account has an authenticator enrolled the action answers `aal2_required`
 * and the shared step-up modal asks for a code in place, then the request is
 * retried — no sign-out.
 */

export interface EmailSettingsCardProps {
  email: string;
  pendingEmail: string | null;
  sentAt: string | null;
  expiresAt: string | null;
  expired: boolean;
  justChanged: boolean;
}

interface PendingState {
  pendingEmail: string;
  sentAt: string;
  expiresAt: string;
}

function relativeTime(iso: string, now: number): string {
  const ms = now - new Date(iso).getTime();
  const min = Math.round(ms / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const hrs = Math.round(min / 60);
  return `${hrs} h ago`;
}

async function withStepUp<T>(
  ensure: () => Promise<boolean>,
  run: () => Promise<ActionResult<T>>,
): Promise<ActionResult<T>> {
  let res = await run();
  if (!res.ok && (res.error.details as { reason?: string } | undefined)?.reason === 'aal2_required') {
    if (await ensure()) res = await run();
  }
  return res;
}

export function EmailSettingsCard(props: EmailSettingsCardProps) {
  const router = useRouter();
  const stepUp = useStepUp();
  const [pending, setPending] = React.useState<PendingState | null>(
    props.pendingEmail && props.sentAt && props.expiresAt
      ? { pendingEmail: props.pendingEmail, sentAt: props.sentAt, expiresAt: props.expiresAt }
      : null,
  );
  const [busy, setBusy] = React.useState<'resend' | 'cancel' | null>(null);
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [cancelOpen, setCancelOpen] = React.useState(false);
  const [showChanged, setShowChanged] = React.useState(props.justChanged);
  // Times are rendered client-side only (after mount) so the server and the
  // browser never disagree on a locale-formatted string.
  const [now, setNow] = React.useState<number | null>(null);

  // Prop resync (same idiom as ProfileNameEditor): the server page re-reads
  // GoTrue on every render, so a router.refresh() must win over local state.
  React.useEffect(() => {
    if (busy) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- prop resync (same idiom as ProfileNameEditor): the server page re-reads GoTrue on every render and its answer must win over local optimistic state once a mutation has settled.
    setPending(
      props.pendingEmail && props.sentAt && props.expiresAt
        ? { pendingEmail: props.pendingEmail, sentAt: props.sentAt, expiresAt: props.expiresAt }
        : null,
    );
  }, [props.pendingEmail, props.sentAt, props.expiresAt, busy]);

  React.useEffect(() => {
    // First tick is deferred a frame so the server-rendered markup (no time
    // text) and the first client render agree; then a slow clock.
    const first = setTimeout(() => setNow(Date.now()), 0);
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, []);

  React.useEffect(() => {
    if (!props.justChanged) return;
    toast.success('Email updated.');
    // Strip the one-time flag so a reload does not re-announce it.
    router.replace('/dashboard/settings/profile');
  }, [props.justChanged, router]);

  const expired = pending && now !== null ? now > new Date(pending.expiresAt).getTime() : props.expired;

  const onResend = async () => {
    setBusy('resend');
    try {
      const res = await withStepUp(stepUp.ensure, () => resendEmailChangeAction());
      if (!res.ok) {
        toast.error(res.error.message);
        return;
      }
      setPending({ pendingEmail: res.data.pendingEmail, sentAt: res.data.sentAt, expiresAt: res.data.expiresAt });
      toast.success(`Verification re-sent to ${res.data.pendingEmail}.`);
      router.refresh();
    } finally {
      setBusy(null);
    }
  };

  const onCancel = async () => {
    setBusy('cancel');
    try {
      const res = await cancelEmailChangeAction();
      if (!res.ok) {
        toast.error(res.error.message);
        return;
      }
      setPending(null);
      setCancelOpen(false);
      toast.success('Email change cancelled.');
      router.refresh();
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-4">
      {showChanged ? (
        <div
          role="status"
          className="rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-sm"
        >
          <p className="font-medium">Email updated</p>
          <p className="text-muted-foreground">
            <span className="tabular-nums">{props.email}</span> is now your sign-in email. Use it
            next time you sign in.
          </p>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="mt-1 h-7 px-2"
            onClick={() => setShowChanged(false)}
          >
            Dismiss
          </Button>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <p className="text-sm tabular-nums">{props.email}</p>
        <Badge variant="secondary">{pending ? 'Current' : 'Verified'}</Badge>
      </div>

      {pending ? (
        <div
          role="status"
          aria-live="polite"
          className="space-y-2 rounded-md border px-3 py-2 text-sm"
        >
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-muted-foreground">Pending:</span>
            <span className="tabular-nums">{pending.pendingEmail}</span>
            <Badge variant={expired ? 'destructive' : 'secondary'}>
              {expired ? 'Expired' : 'Pending'}
            </Badge>
          </div>
          <p className="text-muted-foreground">
            {expired
              ? 'The verification links have expired. Resend them to continue.'
              : `Verification links sent${now ? ` ${relativeTime(pending.sentAt, now)}` : ''} to both addresses. Your account keeps using ${props.email} until both are confirmed.`}
          </p>
          <div className="flex flex-wrap gap-2 pt-1">
            <Button type="button" size="sm" variant="outline" disabled={busy !== null} onClick={onResend}>
              {busy === 'resend' ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Resend verification'}
            </Button>
            <Button type="button" size="sm" variant="outline" disabled={busy !== null} onClick={() => setDialogOpen(true)}>
              Use a different address
            </Button>
            <Button type="button" size="sm" variant="ghost" disabled={busy !== null} onClick={() => setCancelOpen(true)}>
              Cancel change
            </Button>
          </div>
        </div>
      ) : (
        <Button type="button" variant="outline" size="sm" onClick={() => setDialogOpen(true)}>
          Change email
        </Button>
      )}

      <ChangeEmailDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        currentEmail={props.email}
        ensureStepUp={stepUp.ensure}
        onRequested={(p) => {
          setPending(p);
          router.refresh();
        }}
      />

      <Dialog open={cancelOpen} onOpenChange={setCancelOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Cancel this email change?</DialogTitle>
            <DialogDescription>
              The verification links already sent will stop working and your sign-in email stays{' '}
              <span className="tabular-nums">{props.email}</span>.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setCancelOpen(false)} disabled={busy !== null}>
              Keep it
            </Button>
            <Button type="button" variant="destructive" onClick={onCancel} disabled={busy !== null}>
              {busy === 'cancel' ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Cancel change'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {stepUp.modal}
    </div>
  );
}

function ChangeEmailDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentEmail: string;
  ensureStepUp: () => Promise<boolean>;
  onRequested: (p: PendingState) => void;
}) {
  const {
    register,
    handleSubmit,
    reset,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<ChangeEmailInput>({
    resolver: zodResolver(changeEmailSchema),
    mode: 'onBlur',
    reValidateMode: 'onChange',
    defaultValues: { newEmail: '', currentPassword: '' },
  });

  const close = (open: boolean) => {
    if (!open) reset({ newEmail: '', currentPassword: '' });
    props.onOpenChange(open);
  };

  const onSubmit = handleSubmit(async (values) => {
    const res = await withStepUp(props.ensureStepUp, () => requestEmailChangeAction(values));
    if (!res.ok) {
      // Field-level where it belongs; toast for everything else.
      if (res.error.code === 'validation_error' || res.error.code === 'conflict') {
        setError('newEmail', { message: res.error.message });
      } else if (res.error.message.toLowerCase().includes('password')) {
        setError('currentPassword', { message: res.error.message });
      } else {
        toast.error(res.error.message);
      }
      return;
    }
    toast.success(`Verification sent to ${res.data.pendingEmail}.`);
    props.onRequested(res.data);
    close(false);
  });

  return (
    <Dialog open={props.open} onOpenChange={close}>
      <DialogContent>
        <form onSubmit={onSubmit} noValidate>
          <DialogHeader>
            <DialogTitle>Change your email</DialogTitle>
            <DialogDescription>
              We will send a confirmation link to the new address and an approval link to{' '}
              <span className="tabular-nums">{props.currentEmail}</span>. Your account keeps using
              the current email until both are confirmed.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="newEmail">New email</Label>
              <Input
                id="newEmail"
                type="email"
                inputMode="email"
                autoComplete="email"
                autoCapitalize="none"
                spellCheck={false}
                {...register('newEmail')}
                aria-invalid={!!errors.newEmail}
                aria-describedby={errors.newEmail ? 'newEmail-error' : undefined}
              />
              {errors.newEmail && (
                <p id="newEmail-error" className="text-destructive text-xs">
                  {errors.newEmail.message}
                </p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="currentPassword">Current password</Label>
              <PasswordInput
                id="currentPassword"
                autoComplete="current-password"
                {...register('currentPassword')}
                aria-invalid={!!errors.currentPassword}
                aria-describedby={errors.currentPassword ? 'currentPassword-error' : undefined}
              />
              {errors.currentPassword && (
                <p id="currentPassword-error" className="text-destructive text-xs">
                  {errors.currentPassword.message}
                </p>
              )}
            </div>
          </div>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => close(false)} disabled={isSubmitting}>
              Cancel
            </Button>
            <Button type="submit" variant="gradient" disabled={isSubmitting}>
              {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Send verification'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
