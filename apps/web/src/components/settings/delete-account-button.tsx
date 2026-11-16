'use client';

import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import {
  DELETE_ACCOUNT_CONFIRM_COPY,
  DELETE_ACCOUNT_DIALOG_COPY,
} from '@/components/settings/delete-account-copy';
import { forgetAppearanceAccount } from '@/components/theme/appearance-cookie';
import { Button } from '@/components/ui/button';
import { DestructiveConfirm } from '@/components/ui/destructive-confirm';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { purgeInterruptedRuns } from '@/lib/interrupted-run';
import { deleteOwnAccountAction, requestAccountDeletionCodeAction } from '@/server/actions/profile';

import { ACCOUNT_DELETE_CODE_RE } from '@stockpilot/core';

/**
 * Button + critical-confirm dialog that lets a user delete their own
 * account. The user must type DELETE (case-sensitive) before the
 * confirm button enables. On success we navigate to /signin so the
 * dashboard layout doesn't briefly render with a now-deleted session.
 *
 * `confirmWith` is how the page expects the account to confirm (the server
 * decides; this only chooses what to show first): 'authenticator' for an
 * account with a verified authenticator, whose session already entered its
 * code; 'password' for an account with none, which also types its password,
 * or asks for a six-digit code by email ("Email me a code instead") and types
 * that. When the server answers that a password or a code is needed, the
 * dialog shows the fields whatever the page expected.
 *
 * The last-owner and platform-admin refusals run server-side in
 * `deleteOwnAccountAction` (migration 0393); their sentence shows inside the
 * dialog, which stays open (L112). The last owner also gets "Open the Team
 * page" there, where ownership is transferred. A refusal raises no toast: an
 * open dialog takes every click outside it, so a toast's link or close could
 * not be pressed, and on a phone the toast covered the dialog's buttons.
 */
export function DeleteAccountButton({
  confirmWith = 'password',
}: {
  confirmWith?: 'password' | 'authenticator';
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [pending, setPending] = React.useState(false);
  // The refusal, inside the dialog (L112): the toast alone sat behind the
  // dialog, which stays open. Cleared on open and on each try.
  const [refusal, setRefusal] = React.useState<{ message: string; lastOwner: boolean } | null>(
    null,
  );
  // The confirmation fields: shown for an account with no authenticator, or
  // once the server asked for them.
  const [askCredential, setAskCredential] = React.useState(confirmWith === 'password');
  const [method, setMethod] = React.useState<'password' | 'code'>('password');
  const [password, setPassword] = React.useState('');
  const [code, setCode] = React.useState('');
  const [challenge, setChallenge] = React.useState<string | null>(null);
  const [sending, setSending] = React.useState(false);
  // Where keyboard focus goes once the answer is shown: the code field after
  // a code was sent or a code was refused, the password field after a
  // password was refused or asked for. The fields are disabled while a
  // request runs, so the focus waits for the render that enables them. Each
  // refusal is read out by the dialog's role="alert" line, which is removed
  // on every try and shown again with the answer.
  const passwordRef = React.useRef<HTMLInputElement>(null);
  const codeRef = React.useRef<HTMLInputElement>(null);
  const focusNext = React.useRef<'password' | 'code' | null>(null);

  function openChange(next: boolean) {
    if (next) {
      setRefusal(null);
      setAskCredential(confirmWith === 'password');
      setMethod('password');
      setPassword('');
      setCode('');
      setChallenge(null);
    }
    setOpen(next);
  }

  async function sendCode() {
    setRefusal(null);
    setSending(true);
    const res = await requestAccountDeletionCodeAction();
    setSending(false);
    if (!res.ok) {
      setRefusal({ message: res.error.message, lastOwner: false });
      return;
    }
    focusNext.current = 'code';
    setChallenge(res.data.challenge);
    setCode('');
    setMethod('code');
  }

  async function confirm() {
    setRefusal(null);
    setPending(true);
    // Deleting the account ends this browser's session on purpose (the action
    // signs it out, in every tab: the session cookies are the browser's, and
    // no revoke is sent), so what an interrupted run kept in this tab and in
    // the browser's other tabs (lib/interrupted-run) goes before the request
    // does.
    purgeInterruptedRuns();
    const credential = !askCredential
      ? {}
      : method === 'password'
        ? { password }
        : { code, challenge: challenge ?? '' };
    const res = await deleteOwnAccountAction({ confirm: 'DELETE', ...credential });
    setPending(false);
    if (!res.ok) {
      const reason = (res.error.details as { reason?: unknown } | undefined)?.reason;
      if (reason === 'credential_required') {
        setAskCredential(true);
        focusNext.current = method;
      }
      if (reason === 'password_refused') {
        setPassword('');
        focusNext.current = 'password';
      }
      if (reason === 'code_refused') {
        setCode('');
        focusNext.current = 'code';
      }
      setRefusal({ message: res.error.message, lastOwner: reason === 'last_owner' });
      return;
    }
    // Signed out, like every sign-out (Liquid Glass plan 3.3): the account's
    // appearance sync record goes and the appearance provider, which outlives
    // this soft navigation, forgets the account. Only after the deletion
    // succeeded: a refused one leaves the person signed in.
    forgetAppearanceAccount();
    setOpen(false);
    toast.success('Your account has been deleted.');
    // Hard navigation so cookies + session caches don't outlive the
    // deletion. The middleware will redirect / -> /signin anyway, but
    // we land directly to skip a flash.
    router.replace('/signin');
  }

  const credentialIncomplete =
    askCredential &&
    (method === 'password'
      ? password.length === 0
      : !ACCOUNT_DELETE_CODE_RE.test(code) || !challenge);
  const busy = pending || sending;

  React.useEffect(() => {
    if (busy || !focusNext.current) return;
    const field = focusNext.current === 'code' ? codeRef.current : passwordRef.current;
    if (!field) return;
    focusNext.current = null;
    field.focus();
  }, [busy, method, askCredential, refusal]);

  const credentialFields = !askCredential ? null : method === 'password' ? (
    <div className="space-y-1.5">
      <Label htmlFor="delete-account-password">{DELETE_ACCOUNT_CONFIRM_COPY.passwordLabel}</Label>
      <Input
        ref={passwordRef}
        id="delete-account-password"
        aria-describedby="delete-account-password-hint"
        type="password"
        autoComplete="current-password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        disabled={busy}
      />
      <p id="delete-account-password-hint" className="text-muted-foreground text-[12px]">
        {DELETE_ACCOUNT_CONFIRM_COPY.passwordHint}
      </p>
      <Button
        type="button"
        variant="link"
        size="sm"
        className="px-0"
        onClick={() => void sendCode()}
        disabled={busy}
      >
        {DELETE_ACCOUNT_CONFIRM_COPY.emailCode}
      </Button>
    </div>
  ) : (
    <div className="space-y-1.5">
      <Label htmlFor="delete-account-code">{DELETE_ACCOUNT_CONFIRM_COPY.codeLabel}</Label>
      <Input
        ref={codeRef}
        id="delete-account-code"
        aria-describedby="delete-account-code-hint"
        type="text"
        inputMode="numeric"
        autoComplete="one-time-code"
        maxLength={6}
        value={code}
        onChange={(e) => setCode(e.target.value.replace(/[^0-9]/g, '').slice(0, 6))}
        disabled={busy}
        className="font-mono"
      />
      <p id="delete-account-code-hint" className="text-muted-foreground text-[12px]">
        {DELETE_ACCOUNT_CONFIRM_COPY.codeSent}
      </p>
      <div className="flex flex-wrap gap-x-4">
        <Button
          type="button"
          variant="link"
          size="sm"
          className="px-0"
          onClick={() => void sendCode()}
          disabled={busy}
        >
          {DELETE_ACCOUNT_CONFIRM_COPY.sendAgain}
        </Button>
        <Button
          type="button"
          variant="link"
          size="sm"
          className="px-0"
          onClick={() => {
            setRefusal(null);
            setMethod('password');
          }}
          disabled={busy}
        >
          {DELETE_ACCOUNT_CONFIRM_COPY.usePassword}
        </Button>
      </div>
    </div>
  );

  return (
    <>
      <Button variant="destructive" onClick={() => openChange(true)} disabled={pending}>
        Delete my account
      </Button>
      <DestructiveConfirm
        open={open}
        onOpenChange={openChange}
        severity="critical"
        expectedConfirm="DELETE"
        title="Delete your account?"
        description={
          <div className="space-y-2">
            <p>
              {DELETE_ACCOUNT_DIALOG_COPY.kept} {DELETE_ACCOUNT_DIALOG_COPY.released}
            </p>
            <p>{DELETE_ACCOUNT_DIALOG_COPY.owner}</p>
          </div>
        }
        confirmLabel="Delete account"
        cancelLabel="Cancel"
        pending={busy}
        onConfirm={confirm}
        extra={credentialFields}
        confirmBlocked={credentialIncomplete}
        error={refusal?.message ?? null}
        errorAction={
          refusal?.lastOwner
            ? {
                label: 'Open the Team page',
                onClick: () => {
                  setOpen(false);
                  router.push('/dashboard/team');
                },
              }
            : null
        }
      />
    </>
  );
}
