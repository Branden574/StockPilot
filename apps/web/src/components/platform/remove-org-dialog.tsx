'use client';

import { Loader2, Trash2, TriangleAlert } from 'lucide-react';
import { useRouter } from 'next/navigation';
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
import { PasswordInput } from '@/components/ui/password-input';
import { removeOrgAction } from '@/server/actions/platform-admin';

/**
 * Danger zone — hard-delete an organization (cascade, irreversible). The server
 * action re-gates on platform-admin + a fresh MFA step-up, verifies the global
 * deletion passphrase, and requires the operator to retype the org's exact name.
 * We layer the same confirmations in the UI so a fat-fingered click can't wipe a
 * tenant.
 *
 * `aal2_required` is surfaced with the same toast the rest of the platform
 * console uses (act-as, billing, restore) — the operator re-authenticates with
 * MFA and retries. All other errors are toasted and the dialog stays open so the
 * operator can correct the passphrase / name and retry without re-entering.
 */
export function RemoveOrgDialog({
  organizationId,
  orgName,
}: {
  organizationId: string;
  orgName: string;
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [confirmName, setConfirmName] = React.useState('');
  const [passphrase, setPassphrase] = React.useState('');
  const [alsoDeleteOrphanedUsers, setAlsoDeleteOrphanedUsers] = React.useState(false);
  const [pending, start] = React.useTransition();

  const canConfirm =
    confirmName.trim().length > 0 && passphrase.length > 0 && !pending;

  function reset() {
    setConfirmName('');
    setPassphrase('');
    setAlsoDeleteOrphanedUsers(false);
  }

  function onOpenChange(next: boolean) {
    if (pending) return; // don't let the dialog close mid-delete
    setOpen(next);
    if (!next) reset();
  }

  function onConfirm() {
    if (!canConfirm) return;
    start(async () => {
      const res = await removeOrgAction({
        orgId: organizationId,
        passphrase,
        confirmName,
        alsoDeleteOrphanedUsers,
      });
      if (res.ok) {
        const { deletedUsers } = res.data;
        toast.success(
          deletedUsers > 0
            ? `Deleted “${orgName}” and ${deletedUsers} orphaned account${deletedUsers === 1 ? '' : 's'}.`
            : `Deleted “${orgName}”.`,
        );
        setOpen(false);
        reset();
        router.push('/platform');
        router.refresh();
      } else if (res.error.details?.reason === 'aal2_required') {
        toast.error('Re-authenticate with MFA, then try again.');
      } else {
        // Keep the dialog open so the operator can fix the passphrase / name.
        toast.error(res.error.message);
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <Button type="button" variant="destructive" onClick={() => setOpen(true)}>
        <Trash2 className="h-4 w-4" />
        Remove organization
      </Button>

      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <TriangleAlert className="h-5 w-5 text-destructive" strokeWidth={2} />
            Remove “{orgName}”
          </DialogTitle>
          <DialogDescription>
            This permanently deletes the organization and its database records — items, orders,
            movements, members, and so on. This cannot be undone. (Uploaded files in storage are
            not swept and may remain as orphaned objects.)
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="remove-org-name">
              Type the organization name to confirm
            </Label>
            <Input
              id="remove-org-name"
              autoComplete="off"
              placeholder={orgName}
              value={confirmName}
              onChange={(e) => setConfirmName(e.target.value)}
              disabled={pending}
            />
            <p className="text-[11.5px] text-muted-foreground">
              Must exactly match <span className="font-medium text-foreground">{orgName}</span>.
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="remove-org-passphrase">Deletion passphrase</Label>
            <PasswordInput
              id="remove-org-passphrase"
              autoComplete="off"
              placeholder="Global org-deletion passphrase"
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
              disabled={pending}
            />
          </div>

          <label className="flex items-start gap-2 text-[13px]">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={alsoDeleteOrphanedUsers}
              onChange={(e) => setAlsoDeleteOrphanedUsers(e.target.checked)}
              disabled={pending}
            />
            <span>
              Also delete member accounts that belong <span className="font-medium">only</span> to
              this org (their sign-in is removed too).
            </span>
          </label>
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={pending}
          >
            Cancel
          </Button>
          <Button type="button" variant="destructive" onClick={onConfirm} disabled={!canConfirm}>
            {pending ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Deleting…
              </>
            ) : (
              'Permanently delete'
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
