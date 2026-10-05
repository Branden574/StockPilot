'use client';

import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import { DELETE_ACCOUNT_DIALOG_COPY } from '@/components/settings/delete-account-copy';
import { Button } from '@/components/ui/button';
import { DestructiveConfirm } from '@/components/ui/destructive-confirm';
import { deleteOwnAccountAction } from '@/server/actions/profile';

/**
 * How long the last-owner refusal stays up (A3 review): it is an instruction
 * to follow (transfer ownership on the Team page), and the default 4 s toast
 * vanished while the dialog stayed open.
 */
export const LAST_OWNER_TOAST_MS = 15_000;

/**
 * Show a refused deletion. The last-owner refusal stays up longer and links to
 * the Team page; every other refusal is a plain toast, as before.
 */
export function showDeleteAccountError(
  error: { message: string; details?: unknown },
  openTeam: () => void,
): void {
  const reason = (error.details as { reason?: unknown } | undefined)?.reason;
  if (reason === 'last_owner') {
    toast.error(error.message, {
      duration: LAST_OWNER_TOAST_MS,
      action: { label: 'Open the Team page', onClick: openTeam },
    });
    return;
  }
  toast.error(error.message);
}

/**
 * Button + critical-confirm dialog that lets a user delete their own
 * account. The user must type DELETE (case-sensitive) before the
 * confirm button enables. On success we navigate to /signin so the
 * dashboard layout doesn't briefly render with a now-deleted session.
 *
 * The last-owner and platform-admin refusals run server-side in
 * `deleteOwnAccountAction` (migration 0393); we surface their sentence inside
 * the dialog (L112) and via toast (showDeleteAccountError).
 */
export function DeleteAccountButton() {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [pending, setPending] = React.useState(false);
  // The refusal's reason, inside the dialog (L112): the toast alone sat
  // behind the dialog, which stays open. Cleared on open and on each try.
  const [error, setError] = React.useState<string | null>(null);

  function openChange(next: boolean) {
    if (next) setError(null);
    setOpen(next);
  }

  async function confirm() {
    setError(null);
    setPending(true);
    const res = await deleteOwnAccountAction({ confirm: 'DELETE' });
    setPending(false);
    if (!res.ok) {
      setError(res.error.message);
      showDeleteAccountError(res.error, () => {
        setOpen(false);
        router.push('/dashboard/team');
      });
      return;
    }
    setOpen(false);
    toast.success('Your account has been deleted.');
    // Hard navigation so cookies + session caches don't outlive the
    // deletion. The middleware will redirect / -> /signin anyway, but
    // we land directly to skip a flash.
    router.replace('/signin');
  }

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
        pending={pending}
        onConfirm={confirm}
        error={error}
      />
    </>
  );
}
