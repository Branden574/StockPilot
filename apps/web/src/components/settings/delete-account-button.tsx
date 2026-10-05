'use client';

import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import { DELETE_ACCOUNT_DIALOG_COPY } from '@/components/settings/delete-account-copy';
import { Button } from '@/components/ui/button';
import { DestructiveConfirm } from '@/components/ui/destructive-confirm';
import { deleteOwnAccountAction } from '@/server/actions/profile';

/**
 * Button + critical-confirm dialog that lets a user delete their own
 * account. The user must type DELETE (case-sensitive) before the
 * confirm button enables. On success we navigate to /signin so the
 * dashboard layout doesn't briefly render with a now-deleted session.
 *
 * The last-owner and platform-admin refusals run server-side in
 * `deleteOwnAccountAction` (migration 0393); their sentence shows inside the
 * dialog, which stays open (L112). The last owner also gets "Open the Team
 * page" there, where ownership is transferred. A refusal raises no toast: an
 * open dialog takes every click outside it, so a toast's link or close could
 * not be pressed, and on a phone the toast covered the dialog's buttons.
 */
export function DeleteAccountButton() {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [pending, setPending] = React.useState(false);
  // The refusal, inside the dialog (L112): the toast alone sat behind the
  // dialog, which stays open. Cleared on open and on each try.
  const [refusal, setRefusal] = React.useState<{ message: string; lastOwner: boolean } | null>(
    null,
  );

  function openChange(next: boolean) {
    if (next) setRefusal(null);
    setOpen(next);
  }

  async function confirm() {
    setRefusal(null);
    setPending(true);
    const res = await deleteOwnAccountAction({ confirm: 'DELETE' });
    setPending(false);
    if (!res.ok) {
      const reason = (res.error.details as { reason?: unknown } | undefined)?.reason;
      setRefusal({ message: res.error.message, lastOwner: reason === 'last_owner' });
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
