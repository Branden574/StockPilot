'use client';

import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { DestructiveConfirm } from '@/components/ui/destructive-confirm';
import { deleteOwnAccountAction } from '@/server/actions/profile';

/**
 * Button + critical-confirm dialog that lets a user delete their own
 * account. The user must type DELETE (case-sensitive) before the
 * confirm button enables. On success we navigate to /signin so the
 * dashboard layout doesn't briefly render with a now-deleted session.
 *
 * The owner-of-a-shared-org guard runs server-side in
 * `deleteOwnAccountAction`; we surface its error via toast.
 */
export function DeleteAccountButton() {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [pending, setPending] = React.useState(false);

  async function confirm() {
    setPending(true);
    const res = await deleteOwnAccountAction({ confirm: 'DELETE' });
    setPending(false);
    if (!res.ok) {
      toast.error(res.error.message);
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
      <Button variant="destructive" onClick={() => setOpen(true)} disabled={pending}>
        Delete my account
      </Button>
      <DestructiveConfirm
        open={open}
        onOpenChange={setOpen}
        severity="critical"
        expectedConfirm="DELETE"
        title="Delete your account?"
        description={
          <div className="space-y-2">
            <p>
              This deletes your account and removes your access immediately.
              Orders you placed stay with your organization, with “Deleted
              user” as the requester. If your account is linked to records
              your organization must keep, such as received stock, you will
              be told and nothing will change.
            </p>
            <p>
              If you own a workspace with other members, transfer ownership
              first — you can&apos;t delete an account that still owns an
              active org.
            </p>
          </div>
        }
        confirmLabel="Delete account"
        cancelLabel="Cancel"
        pending={pending}
        onConfirm={confirm}
      />
    </>
  );
}
