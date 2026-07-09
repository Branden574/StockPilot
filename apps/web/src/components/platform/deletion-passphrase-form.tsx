'use client';

import { KeyRound, Loader2 } from 'lucide-react';
import * as React from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { PasswordInput } from '@/components/ui/password-input';
import { useStepUp } from '@/components/auth/step-up-modal';
import { setOrgDeletionPassphraseAction } from '@/server/actions/platform-admin';

/**
 * Danger zone — set/rotate the GLOBAL org-deletion passphrase. This is a second
 * factor beyond the platform-admin allowlist + AAL2: no organization can be
 * hard-deleted without it. It is stored as a scrypt hash and is never
 * retrievable, so if it's lost it must be rotated here.
 *
 * The action re-gates on platform-admin + a fresh MFA step-up. When the step-up
 * has lapsed it returns `aal2_required`; instead of bouncing the operator to
 * re-login, we prompt for the authenticator code in-place (no sign-out) and
 * retry the save with the identical payload.
 */
export function DeletionPassphraseForm({ isConfigured }: { isConfigured: boolean }) {
  const stepUp = useStepUp();
  const [current, setCurrent] = React.useState('');
  const [passphrase, setPassphrase] = React.useState('');
  const [confirm, setConfirm] = React.useState('');
  const [pending, start] = React.useTransition();

  const tooShort = passphrase.length > 0 && passphrase.length < 12;
  const mismatch = confirm.length > 0 && confirm !== passphrase;
  // Rotating an existing passphrase requires the current one (server-enforced).
  const needsCurrent = isConfigured && current.length === 0;
  const canSave = passphrase.length >= 12 && confirm === passphrase && !needsCurrent && !pending;

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!canSave) return;
    start(async () => {
      const payload = {
        passphrase,
        currentPassphrase: isConfigured ? current : undefined,
      };
      let res = await setOrgDeletionPassphraseAction(payload);
      // Fresh MFA step-up needed → prompt for the authenticator code in-place
      // (no sign-out) and retry with the identical payload.
      if (!res.ok && res.error.details?.reason === 'aal2_required') {
        if (!(await stepUp.ensure())) return;
        res = await setOrgDeletionPassphraseAction(payload);
      }
      if (res.ok) {
        toast.success(
          isConfigured ? 'Org-deletion passphrase rotated.' : 'Org-deletion passphrase set.',
        );
        setCurrent('');
        setPassphrase('');
        setConfirm('');
      } else {
        toast.error(res.error.message);
      }
    });
  }

  return (
    <>
      {stepUp.modal}
      <div className="border-destructive/40 bg-card rounded-[10px] border p-4 sm:p-5">
        <div className="flex items-center gap-2">
          <KeyRound className="text-destructive h-4 w-4" strokeWidth={1.75} />
          <h2 className="font-display text-[15px] font-medium">Org-deletion passphrase</h2>
        </div>
        <p className="mt-1.5 max-w-2xl text-[12.5px] text-[var(--ed-ink-3)]">
          A second factor required to hard-delete <span className="font-medium">any</span>{' '}
          organization — on top of the platform-admin allowlist and a fresh MFA step-up. It is
          stored hashed (scrypt) and is <span className="font-medium">never retrievable</span>; if
          it is lost, rotate it here. Saving requires a fresh MFA step-up and is recorded in the
          platform audit log.
        </p>

        <form onSubmit={onSubmit} className="mt-4 max-w-md space-y-4">
          {isConfigured ? (
            <div className="space-y-1.5">
              <Label htmlFor="deletion-passphrase-current">Current passphrase</Label>
              <PasswordInput
                id="deletion-passphrase-current"
                autoComplete="current-password"
                placeholder="Enter the current passphrase to change it"
                value={current}
                onChange={(e) => setCurrent(e.target.value)}
              />
            </div>
          ) : null}
          <div className="space-y-1.5">
            <Label htmlFor="deletion-passphrase">
              {isConfigured ? 'New passphrase' : 'Passphrase'}
            </Label>
            <PasswordInput
              id="deletion-passphrase"
              autoComplete="new-password"
              placeholder="At least 12 characters"
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
            />
            {tooShort ? (
              <p className="text-destructive text-[11.5px]">Must be at least 12 characters.</p>
            ) : null}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="deletion-passphrase-confirm">Confirm passphrase</Label>
            <PasswordInput
              id="deletion-passphrase-confirm"
              autoComplete="new-password"
              placeholder="Re-type it"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
            />
            {mismatch ? (
              <p className="text-destructive text-[11.5px]">Passphrases don&apos;t match.</p>
            ) : null}
          </div>

          <Button type="submit" variant="destructive" disabled={!canSave}>
            {pending ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Saving…
              </>
            ) : (
              'Save passphrase'
            )}
          </Button>
        </form>
      </div>
    </>
  );
}
